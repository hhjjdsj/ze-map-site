# Fetch Steam Workshop item details in bulk (no API key needed).
#
#   POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/
#
# Why PowerShell: Node's fetch is blocked in this environment, Invoke-RestMethod works.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-workshop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-workshop.ps1 -Mode 2001
#
# Output: data/workshop/<id>.json  (existing files are skipped, safe to resume)
# NOTE: keep this file ASCII-only - Windows PowerShell 5.1 reads .ps1 as ANSI when it has no BOM.
param(
  [string]$Mode = '',
  [string]$Id = '',
  [string]$IdsFile = '',
  [string]$Proxy = '',
  [int]$Batch = 80,
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$catalogPath = Join-Path $Root 'public/entity/catalog.json'
$outDir = Join-Path $Root 'data/workshop'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$catalog = Get-Content $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($IdsFile) {
  # -IdsFile：直接点名要抓哪些工坊 ID。给「还没有实体分片、因此进不了 catalog」的图用 ——
  # 典型是**已下架**的图（工坊接口返回 result=9，仍要落一份 data/workshop/<id>.json，
  # 生成器靠它标 workshopMissing，页面才能解释「为什么没有实体预览」）。
  $ids = @(Get-Content $IdsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
} else {
  $maps = $catalog.maps | Where-Object { (-not $Mode -or $_.a -eq $Mode) -and (-not $Id -or [string]$_.f -eq $Id) }
  $ids = $maps | ForEach-Object { [string]$_.f } | Where-Object { $_ } | Select-Object -Unique
}
$cached = @(Get-ChildItem $outDir -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName })
$todo = @($ids | Where-Object { $cached -notcontains $_ })

Write-Host ("workshop items: {0} | cached: {1} | to fetch: {2}" -f $ids.Count, ($ids.Count - $todo.Count), $todo.Count)

function Save-Json([string]$path, $obj) {
  # Write UTF-8 WITHOUT BOM: JSON.parse() in Node chokes on a leading BOM.
  $json = $obj | ConvertTo-Json -Depth 5 -Compress
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Clean-Text([string]$s) {
  if (-not $s) { return '' }
  $t = $s -replace '\[img\][\s\S]*?\[/img\]', ' '
  $t = $t -replace '\[/?[^\]]{0,40}\]', ' '
  $t = $t -replace 'https?://\S+', ' '
  $t = $t -replace "`r", ''
  $t = $t -replace '[ \t]+', ' '
  $t = $t -replace "(`n){3,}", "`n`n"
  return $t.Trim()
}

$ok = 0; $missing = 0; $failed = 0
$batches = [math]::Ceiling($todo.Count / $Batch)
for ($b = 0; $b -lt $batches; $b++) {
  $slice = @($todo | Select-Object -Skip ($b * $Batch) -First $Batch)
  $body = @{ itemcount = $slice.Count }
  for ($i = 0; $i -lt $slice.Count; $i++) { $body["publishedfileids[$i]"] = $slice[$i] }

  try {
    # 国内网络直连 api.steampowered.com 时通时不通（同一个接口几分钟前还通），
    # 所以：-Proxy 可指定本地代理；失败自动重试 3 次、间隔递增。
    $req = @{
      Uri        = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
      Method     = 'Post'
      Body       = $body
      TimeoutSec = 60
    }
    if ($Proxy) { $req.Proxy = $Proxy }
    $r = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try { $r = Invoke-RestMethod @req; break }
      catch {
        if ($attempt -eq 3) { throw }
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  } catch {
    Write-Warning ("  batch {0} failed: {1}" -f ($b + 1), $_.Exception.Message)
    $failed += $slice.Count
    Start-Sleep -Seconds 2
    continue
  }

  $seen = @{}
  foreach ($d in $r.response.publishedfiledetails) {
    $id = [string]$d.publishedfileid
    $seen[$id] = $true
    $desc = Clean-Text $d.description
    if ($desc.Length -gt 6000) { $desc = $desc.Substring(0, 6000) }
    $created = ''
    if ($d.time_created) { $created = ([DateTimeOffset]::FromUnixTimeSeconds([int64]$d.time_created)).ToString('yyyy-MM-dd') }
    $updated = ''
    if ($d.time_updated) { $updated = ([DateTimeOffset]::FromUnixTimeSeconds([int64]$d.time_updated)).ToString('yyyy-MM-dd') }
    $rec = [ordered]@{
      id            = $id
      result        = [int]$d.result
      title         = [string]$d.title
      description   = $desc
      creator       = [string]$d.creator
      timeCreated   = $created
      timeUpdated   = $updated
      subscriptions = [int]$d.subscriptions
      views         = [int]$d.views
      fileSize      = [int64]$d.file_size
      tags          = @($d.tags | ForEach-Object { [string]$_.tag })
      filename      = [string]$d.filename
    }
    Save-Json (Join-Path $outDir "$id.json") $rec
    if ([int]$d.result -eq 1) { $ok++ } else { $missing++ }
  }
  foreach ($id in $slice) {
    if (-not $seen.ContainsKey($id)) {
      Save-Json (Join-Path $outDir "$id.json") ([ordered]@{ id = $id; result = 9; missing = $true })
      $missing++
    }
  }
  Write-Host ("  batch {0}/{1} done (ok {2} | missing {3})" -f ($b + 1), $batches, $ok, $missing)
  Start-Sleep -Milliseconds 350
}

Write-Host ("`ndone: ok {0} | not found {1} | failed {2}" -f $ok, $missing, $failed)
Write-Host ("output: data/workshop ({0} files)" -f (Get-ChildItem $outDir -Filter *.json).Count)
