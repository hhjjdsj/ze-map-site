#!/usr/bin/env node
/**
 * 规划下一批要接入的图：算出 s2ze 上有、我们还没有的 ZE 图，并分成「可下载 / 已下架」两份清单。
 *
 * 为什么要单独一步：扩图是**成批**做的（一次几十上百张），而「哪些图还没有」这件事有三个坑：
 *   1. s2ze 的清单里有**重复条目**（同一工坊 ID 出现多次），不去重会把批次算大；
 *   2. 有些图**工坊已下架**，源文件永远拿不到 —— 它们只能出「没有实体预览」的资料页，
 *      不该混进烘焙队列里白等失败；
 *   3. 体积必须问 Steam 要真实字节数（`file_size`），s2ze 的 height 只覆盖一部分图。
 * 判定「还能不能下载」用 GetPublishedFileDetails 的 `result` 字段（1=在售，9=已删除）。
 *
 * 产物（都在 .gitignore 覆盖的 data/ 下，不进仓库）：
 *   data/bootstrap-live.txt      可下载，按体积升序
 *   data/bootstrap-dead.txt      已下架
 * 用法：
 *   node scripts/content/plan-new-maps.mjs
 *   node scripts/content/plan-new-maps.mjs --all    # 连非 ze_ 的也列出来（默认只收 ze_）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://api.s2ze.com/site/data/maps.json';
const STEAM = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const ONLY_ZE = !process.argv.includes('--all');

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/entity/catalog.json'), 'utf8'));
const have = new Set(catalog.maps.map((m) => String(m.f)));
const pages = new Set(
  fs.readdirSync(path.join(ROOT, 'src/content/maps')).filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, ''))
);

const s2ze = await (await fetch(API)).json();
const candidates = new Map(); // id -> name（同一 ID 只留一条）
for (const r of s2ze) {
  const id = String(r.addon || '');
  const name = String(r.name || '').trim();
  if (!id || !name || have.has(id) || pages.has(name)) continue;
  if (ONLY_ZE && !/^ze_/i.test(name)) continue;
  candidates.set(id, name);
}
console.log(`s2ze ${s2ze.length} 条 → 我们还没有的 ${candidates.size} 个工坊条目`);

/* Steam：真实的字节数 + 在售状态（一次最多 100 个，失败重试 3 次） */
const details = new Map();
const ids = [...candidates.keys()];
for (let i = 0; i < ids.length; i += 100) {
  const slice = ids.slice(i, i + 100);
  const body = new URLSearchParams();
  body.set('itemcount', String(slice.length));
  slice.forEach((id, n) => body.set(`publishedfileids[${n}]`, id));
  let json = null;
  for (let attempt = 1; attempt <= 3 && !json; attempt++) {
    try {
      const r = await fetch(STEAM, { method: 'POST', body });
      json = await r.json();
    } catch (err) {
      if (attempt === 3) console.warn(`⚠ 第 ${i / 100 + 1} 批失败：${err.message}`);
      else await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
  for (const d of json?.response?.publishedfiledetails ?? []) details.set(String(d.publishedfileid), d);
  process.stdout.write(`  已问 Steam ${Math.min(i + 100, ids.length)}/${ids.length}\r`);
}
console.log('');

const live = [];
const dead = [];
for (const [id, name] of candidates) {
  const d = details.get(id);
  const size = Number(d?.file_size || 0);
  if (Number(d?.result) === 1 && size > 0) live.push({ id, name, mb: size / 1048576 });
  else dead.push({ id, name });
}
live.sort((a, b) => a.mb - b.mb);

fs.writeFileSync(path.join(ROOT, 'data/bootstrap-live.txt'), live.map((x) => x.id).join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'data/bootstrap-dead.txt'), dead.map((x) => x.id).join('\n') + '\n');

const gb = live.reduce((a, x) => a + x.mb, 0) / 1024;
console.log(`\n可下载 ${live.length} 张 / ${gb.toFixed(1)} GB    已下架 ${dead.length} 张`);
if (live.length) console.log(`  最小 ${live[0].mb.toFixed(0)} MB · 中位 ${live[Math.floor(live.length / 2)].mb.toFixed(0)} MB · 最大 ${live.at(-1).mb.toFixed(0)} MB`);
for (const n of [50, 100, 200, 300]) {
  if (n > live.length) break;
  console.log(`  最小的 ${n} 张 = ${(live.slice(0, n).reduce((a, x) => a + x.mb, 0) / 1024).toFixed(1)} GB`);
}
console.log(`\n已写 data/bootstrap-live.txt 与 data/bootstrap-dead.txt（.gitignore 内，不进仓库）`);
console.log('下一步：scripts/terr-bake/bake-all.ps1 -IdsFile data/bootstrap-live.txt -MaxMaps 100 -Parallel 2');
