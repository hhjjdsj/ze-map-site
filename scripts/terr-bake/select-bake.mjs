#!/usr/bin/env node
/**
 * 增量烘焙选择器。
 *
 * 目的：只挑出「需要(重新)烘焙」的图，避免每次全量重烘导致仓库历史线性膨胀。
 *
 * 判定「需要烘焙」：
 *   1) 产物缺失：bake/terr/<id>.bin（仓库外，见 docs/r2-migration.md）或 public/entity/data/*-<id>.bin 不存在；
 *   2) 工坊已更新：Steam 的 time_updated 晚于 bake-manifest.json 里记录的版本；
 *   3) 从未由本站烘焙过（不在 done.txt）且没有版本记录 —— 视为待烘焙（历史遗留产物）。
 *
 * 用法：
 *   node select-bake.mjs                 # 选出待烘焙 ID，写入 incremental.txt
 *   node select-bake.mjs --out X.txt     # 指定输出文件
 *   node select-bake.mjs --seed          # 基线：只补登「已完成但无记录」的图（不覆盖已有记录）
 *   node select-bake.mjs --record X.txt  # 把 X.txt 里的 ID 记录为当前工坊版本（本批刚烘好的图）
 *   node select-bake.mjs --json          # 额外打印 JSON 摘要
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(root, '..', '..');
const dataDir = path.join(root, 'data');

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(n);
const optVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const cappedFile = path.join(dataDir, 'capped.txt');
const doneFile = path.join(dataDir, 'done.txt');
const manifestFile = path.join(dataDir, 'bake-manifest.json');
const outFile = optVal('--out', path.join(root, 'incremental.txt'));

const readIds = (f) => fs.existsSync(f)
  ? [...new Set(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))]
  : [];

const capped = readIds(cappedFile);
const done = new Set(readIds(doneFile));

let manifest = { version: 1, maps: {} };
if (fs.existsSync(manifestFile)) {
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* ignore */ }
}
if (!manifest.maps) manifest.maps = {};

/* 地形分片在仓库外的 bake/terr（2026-10-04 起，见 bake-all.ps1 的说明）；
   entity 分片仍在 public/entity/data —— 它是生成器的输入，留在仓库里。 */
const terrDir = process.env.TERR_OUT || path.join(project, 'bake', 'terr');
const entDir = path.join(project, 'public', 'entity', 'data');
const hasTerr = (id) => fs.existsSync(path.join(terrDir, `${id}.bin`));
const entFiles = fs.existsSync(entDir) ? fs.readdirSync(entDir) : [];
const entSet = new Set(entFiles.map((f) => (f.match(/-(\d+)\.bin$/) || [])[1]).filter(Boolean));
const hasEnt = (id) => entSet.has(String(id));

async function fetchDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const body = new URLSearchParams();
    body.set('itemcount', String(slice.length));
    slice.forEach((id, j) => body.append(`publishedfileids[${j}]`, id));
    let res;
    try {
      res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', { method: 'POST', body });
    } catch (e) {
      console.log(`[warn] Steam API 不可达：${e.message}`);
      return null;
    }
    if (!res.ok) { console.log(`[warn] Steam API HTTP ${res.status}`); return null; }
    const j = await res.json();
    for (const d of (j?.response?.publishedfiledetails || [])) {
      if (d.result === 1) out.set(String(d.publishedfileid), d);
    }
  }
  return out;
}

const writeManifest = () => {
  manifest.updated = new Date().toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
};

async function recordIds(ids, label) {
  if (!ids.length) { console.log(`${label}: 无 ID，跳过`); return; }
  const details = await fetchDetails(ids);
  if (!details) { console.log(`${label}: Steam API 不可达，未更新 manifest`); process.exit(1); }
  const now = new Date().toISOString();
  let n = 0;
  for (const id of ids) {
    const info = details.get(id);
    if (!info) continue;
    const prev = manifest.maps[id] || {};
    manifest.maps[id] = { timeUpdated: info.time_updated, bakedAt: prev.bakedAt || now, recordedAt: now };
    n++;
  }
  writeManifest();
  console.log(`${label}: 记录 ${n}/${ids.length} 个 ID`);
}

// ---- --seed：只补登「已完成但无记录」的图（不覆盖已有记录，避免掩盖更新）----
if (hasFlag('--seed')) {
  const missing = [...done].filter((id) => !manifest.maps[id]);
  await recordIds(missing, 'seed');
  process.exit(0);
}

// ---- --record <file>：把指定文件里的 ID 记录为当前工坊版本（本批刚烘好的图）----
const recFile = optVal('--record', '');
if (recFile) {
  const ids = readIds(recFile);
  await recordIds(ids, 'record');
  process.exit(0);
}

// ---- 默认：选择待烘焙 ----
const details = await fetchDetails(capped);
const bucket = { missing: [], updated: [], backlog: [] };
const todo = [];
for (const id of capped) {
  if (!hasTerr(id) || !hasEnt(id)) { bucket.missing.push(id); todo.push(id); continue; }
  const rec = manifest.maps[id];
  const info = details?.get(id);
  if (rec) {
    if (info && info.time_updated && info.time_updated > rec.timeUpdated) { bucket.updated.push(id); todo.push(id); }
  } else if (!done.has(id)) {
    // 有产物但非本站烘焙且无记录 → 历史遗留，纳入（可用 --record 先把已有的登记掉）
    bucket.backlog.push(id); todo.push(id);
  }
}

fs.writeFileSync(outFile, todo.length ? todo.join('\n') + '\n' : '');
console.log(`select: total=${capped.length} todo=${todo.length} (缺失=${bucket.missing.length} 工坊更新=${bucket.updated.length} 历史遗留=${bucket.backlog.length})`);
console.log(`已写出: ${path.relative(project, outFile)}`);
if (!details) console.log('注意：Steam API 不可达，"工坊更新" 检测本次不可用');

if (hasFlag('--json')) {
  console.log(JSON.stringify({ todo: todo.length, ...Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, v.length])), ids: todo }, null, 2));
}
