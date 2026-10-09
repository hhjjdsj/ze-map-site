#!/usr/bin/env node
/**
 * 下架图的封面来源：s2ze / Ruby Bot 的公开地图数据里**还留着原工坊预览图的 Steam CDN 地址**。
 *
 * 工坊条目下架后，`images.steamusercontent.com` 上的那张图通常还在（实测 2026-10-09 仍可访问），
 * 而 Steam 的 GetPublishedFileDetails 已经查不到这条目了（result=9）—— 所以别指望走工坊那条路。
 *
 * 产物写到仓库外的 `bake/gallery/<地图英文名>/05-workshop.<ext>`，**和 fetch-workshop-previews.mjs
 * 完全同一个位置** —— 这样 `npm run cover:workshop` 一条命令就能把两种来源一起导成封面，
 * 不需要在导入脚本里再加分支。
 *
 * 用法：
 *   node scripts/gallery/fetch-s2ze-covers.mjs --ids data/bootstrap-dead-ze.txt --dry
 *   node scripts/gallery/fetch-s2ze-covers.mjs --ids data/bootstrap-dead-ze.txt
 *   node scripts/gallery/fetch-s2ze-covers.mjs --ids a.txt --force     # 已有也重下
 *
 * 数据来源要署名：图片是各图作者的工坊预览图，**「哪张图对应哪张地图」这份聚合来自 s2ze / Ruby Bot**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S2ZE_URL = 'https://api.s2ze.com/site/data/maps.json';
const OUT_DIR = path.join(ROOT, 'bake/gallery');
const NAME = '05-workshop';
const EXTS = ['webp', 'png', 'jpg', 'jpeg'];

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const skipArg = args.find((a) => a.startsWith('--skip='));
const SKIP = skipArg ? new Set(skipArg.split('=')[1].split(',').filter(Boolean)) : new Set();
const files = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--ids' && args[i + 1]) files.push(args[i + 1]);
if (!files.length) {
  console.error('用法：node scripts/gallery/fetch-s2ze-covers.mjs --ids <ID 清单> [--ids ...] [--dry] [--force]');
  process.exit(1);
}

const ids = new Set();
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) if (/^\d+$/.test(line.trim())) ids.add(line.trim());

/* 工坊 ID → 地图英文名：优先用已烘分片的内部名，其次 s2ze 的 name */
const nameFromShard = new Map();
for (const file of fs.readdirSync(path.join(ROOT, 'public/entity/data'))) {
  const m = /^\d+-(.+?)-(\d+)\.bin$/.exec(file);
  if (m) nameFromShard.set(m[2], m[1]);
}

const res = await fetch(S2ZE_URL);
const s2ze = new Map((await res.json()).map((r) => [String(r.addon), r]));
console.log(`清单 ${ids.size} 个 ID，s2ze ${s2ze.size} 条`);

const extOf = (type) => (/png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : /jpe?g/i.test(type) ? 'jpg' : '');

let saved = 0;
let skipped = 0;
const failed = [];
for (const id of ids) {
  const rec = s2ze.get(id);
  const mapName = nameFromShard.get(id) ?? String(rec?.name ?? '').trim();
  if (!mapName || !/^[A-Za-z0-9_]+$/.test(mapName)) {
    failed.push(`${id} 拿不到合规的地图名`);
    continue;
  }
  const dir = path.join(OUT_DIR, mapName);
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => EXTS.some((e) => f === `${NAME}.${e}`)) : null;
  if (existing && !FORCE) {
    skipped++;
    continue;
  }
  const url = String(rec?.image ?? '');
  if (!/^https?:\/\//.test(url)) {
    failed.push(`${mapName} 没有图片地址`);
    continue;
  }
  if (DRY) {
    saved++;
    continue;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ext = extOf(r.headers.get('content-type') || '') || 'jpg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error(`图片太小（${buf.length} B）`);
    fs.mkdirSync(dir, { recursive: true });
    for (const e of EXTS) fs.rmSync(path.join(dir, `${NAME}.${e}`), { force: true });
    fs.writeFileSync(path.join(dir, `${NAME}.${ext}`), buf);
    saved++;
  } catch (err) {
    failed.push(`${mapName}：${err.message}`);
  }
}

console.log(`\n${DRY ? '[dry-run] ' : ''}下载 ${saved} 张，跳过已有 ${skipped} 张，失败 ${failed.length} 张`);
if (failed.length) for (const f of failed.slice(0, 10)) console.log(`  ✗ ${f}`);
console.log('下一步：npm run cover:workshop（把这些图导成 public/images/covers/workshop/<地图名>.<ext>）');
