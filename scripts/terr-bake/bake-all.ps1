param(
  [int]$MaxMaps = 0,
  [int]$Parallel = 4,
  [switch]$Random,
  [switch]$RetryFailed,
  [switch]$KeepDownloaded,
  [string]$ToolsRoot = '',
  [string]$SteamCmd = '',
  [string]$Source2Viewer = '',
  [string]$LocalCache = '',
  [int]$ErrorTolerance = 4,
  [string]$IdsFile = '',
  [switch]$IgnoreDone
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent (Split-Path -Parent $root)

# Repo-local toolchain, populated by setup.ps1. Override with -ToolsRoot or explicit paths.
if (-not $ToolsRoot) { $ToolsRoot = Join-Path $root '.tools' }
$steam = if ($SteamCmd) { $SteamCmd } else { Join-Path $ToolsRoot 'steamcmd\steamcmd.exe' }
$cli = if ($Source2Viewer) { $Source2Viewer } else { Join-Path $ToolsRoot 's2v\Source2Viewer-CLI.exe' }
$bake = Join-Path $root 'bake-terrain.mjs'
$entity = Join-Path $root 'extract-entities.mjs'
$localCache = $LocalCache
if (-not $localCache) {
  $candidates = @()
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\workshop\content\730') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Steam\steamapps\workshop\content\730') }
  foreach ($c in $candidates) { if (Test-Path $c) { $localCache = $c; break } }
}
$dlCache = Join-Path (Split-Path $steam -Parent) 'steamapps\workshop\content\730'
$work = Join-Path $root 'work'
# 地形分片不再写进仓库（2026-10-04 起）：322 MB / 546 个文件占了仓库体积的 97%，
# 每轮重烘焙都会让 git 历史再涨 ~320 MB。现在写到仓库外的 bake\terr，由
# `npm run terr:upload` 传到 R2，页面从 https://terr.ze-map.cn 取。
# 想换位置就设 $env:TERR_OUT。
$terr = if ($env:TERR_OUT) { $env:TERR_OUT } else { Join-Path $project 'bake\terr' }
$entityDir = Join-Path $project 'public\entity\data'
$boundsDir = Join-Path $root 'bounds'
$one = Join-Path $root 'bake-one.ps1'
$dataDir = Join-Path $root 'data'
$doneFile = Join-Path $dataDir 'done.txt'
$failFile = Join-Path $dataDir 'failed.txt'
$logFile = Join-Path $root 'bake.log'
$idsFile = if ($IdsFile) { $IdsFile } else { Join-Path $dataDir 'capped.txt' }
$ERR = $ErrorTolerance

if ($Parallel -lt 1) { throw 'Parallel must be at least 1' }
New-Item -ItemType Directory -Force -Path $root, $dataDir, $work, $terr, $entityDir, $boundsDir | Out-Null
if (-not (Test-Path $idsFile)) { throw "missing $idsFile" }
foreach ($dep in @($steam, $cli, $bake, (Join-Path $project 'node_modules\meshoptimizer'))) {
  if (-not (Test-Path $dep)) { throw "missing dependency: $dep`nRun .\setup.ps1 first (installs steamcmd, Source2Viewer CLI and npm packages)." }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found on PATH; install Node.js 18+.' }

function Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content $logFile $line
  Write-Output $line
}

$done = @(); if (-not $IgnoreDone -and (Test-Path $doneFile)) { $done = @(Get-Content $doneFile | Where-Object { $_ }) }
$ids = @(Get-Content $idsFile | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
if ($RetryFailed -and (Test-Path $failFile)) {
  $ids = @(Get-Content $failFile | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
}
$todo = @($ids | Where-Object { $done -notcontains $_ })
if ($Random -and $MaxMaps -gt 0) { $todo = @(Get-Random -InputObject $todo -Count ([math]::Min($MaxMaps, $todo.Count))) }
elseif ($MaxMaps -gt 0) { $todo = @($todo | Select-Object -First $MaxMaps) }
Log "START total=$($ids.Count) todo=$($todo.Count) parallel=$Parallel"

# Download missing Workshop items serially; all cached maps can then be processed safely in parallel.
foreach ($id in $todo) {
  if (($localCache -and (Test-Path (Join-Path $localCache $id))) -or (Test-Path (Join-Path $dlCache $id))) { continue }
  Log "DOWNLOAD $id"
  & $steam +login anonymous +workshop_download_item 730 $id +quit 2>&1 | Out-Null
  if (-not (Test-Path (Join-Path $dlCache $id))) {
    Add-Content $failFile $id
    Log "FAIL $id stage=download download failed"
  }
}

$queue = [Collections.Queue]::new()
foreach ($id in $todo) {
  if (($localCache -and (Test-Path (Join-Path $localCache $id))) -or (Test-Path (Join-Path $dlCache $id))) { [void]$queue.Enqueue($id) }
}
$active = @{}

while ($queue.Count -gt 0 -or $active.Count -gt 0) {
  while ($queue.Count -gt 0 -and $active.Count -lt $Parallel) {
    $id = [string]$queue.Dequeue()
    $job = Start-Job -Name "terr-$id" -ArgumentList $one,$id,$work,$terr,$localCache,$dlCache,$cli,$bake,$entity,$entityDir,$boundsDir,$ERR,([bool]$KeepDownloaded) -ScriptBlock {
      param($script,$map,$workDir,$terrDir,$cache,$downloads,$viewer,$baker,$entityScript,$entityOut,$boundsOut,$err,$keep)
      $extra = if ($keep) { @('-KeepDownloaded') } else { @() }
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -MapId $map -WorkDir $workDir -TerrDir $terrDir -LocalCache $cache -DownloadCache $downloads -Cli $viewer -Bake $baker -Entity $entityScript -EntityDir $entityOut -BoundsDir $boundsOut -ErrorTolerance $err @extra
    }
    $active[$job.Id] = $job
    Log "START $id"
  }

  foreach ($key in @($active.Keys)) {
    $job = $active[$key]
    if ($job.State -in @('Completed','Failed','Stopped')) {
      $raw = @(Receive-Job $job -ErrorAction SilentlyContinue)
      Remove-Job $job -Force -ErrorAction SilentlyContinue
      $active.Remove($key)
      $json = ($raw | Where-Object { $_ -is [string] } | Select-Object -Last 1)
      if ($json) {
        $r = $json | ConvertFrom-Json
        if ($r.ok) {
          Add-Content $doneFile $r.id
          Log ("OK   {0} nt={1} src={2}MB {3}s" -f $r.id,$r.nt,$r.srcMB,$r.seconds)
        } else {
          Add-Content $failFile $r.id
          Log ("FAIL {0} stage={1} {2}" -f $r.id,$r.stage,$r.error)
        }
      } else {
        Log "FAIL job-$key stage=worker no result"
      }
    }
  }
  if ($active.Count -gt 0) { Start-Sleep -Milliseconds 300 }
}

Log 'BATCH END'
$catalog = Join-Path $project 'scripts\entity-data\build-catalog.mjs'
& node $catalog
if ($LASTEXITCODE -ne 0) { throw "catalog update failed (exit $LASTEXITCODE)" }
