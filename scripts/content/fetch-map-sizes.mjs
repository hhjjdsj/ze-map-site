#!/usr/bin/env node
/**
 * 抓地图**体积**（每张图下载要多少 MB）→ data/map-sizes.json
 *
 *   npm run data:sizes            # 抓一次，写进仓库
 *   npm run data:sizes -- --dry    # 只看覆盖率，不写
 *
 * 数据来源：s2ze.com（Ruby Bot）的公开数据 https://api.s2ze.com/site/data/maps.json
 * 字段是 `height`（名字起得怪，但值就是「142.424 MB」这种体积）。
 *
 * 为什么要落成仓库里的文件、而不是构建时现抓：
 *   构建依赖第三方接口是隐患（对方改版/挂掉/被墙 → 整站构建红，而且只影响我们）。
 *   体积这种数据一天也不会变几次，人工跑一次提交即可 —— 和 data/map-dates.json 一个思路。
 *
 * 匹配方式：先按工坊 ID（我们 frontmatter 的 workshopId ↔ 他们的 addon），
 * 再按地图名兜底（大小写不敏感）。两边都对不上就留空，页面侧栏不显示这一行。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const OUT_FILE = path.join(ROOT, 'data/map-sizes.json');
const API = 'https://api.s2ze.com/site/data/maps.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ze-map.cn size fetch';

const DRY = process.argv.includes('--dry');

/** 他们的体积字符串 → MB 数值（"142.424 MB" / "1.123 GB"） */
function toMb(v) {
  const m = String(v ?? '').match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  return Math.round((unit === 'GB' ? n * 1024 : unit === 'KB' ? n / 1024 : n) * 10) / 10;
}

console.log('  抓 ' + API);
let raw;
try {
  raw = execFileSync('curl.exe', ['-sS', '--max-time', '60', '-A', UA, API], { maxBuffer: 1 << 26 }).toString('utf8');
} catch (e) {
  console.error('  ✗ 抓取失败：' + String(e.message).split('\n')[0]);
  process.exit(1);
}
const theirs = JSON.parse(raw.replace(/^\uFEFF/, ''));
if (!Array.isArray(theirs) || !theirs.length) {
  console.error('  ✗ 返回的不是数组，可能接口变了');
  process.exit(1);
}
const byAddon = new Map();
const byName = new Map();
for (const r of theirs) {
  if (r.addon) byAddon.set(String(r.addon), r);
  if (r.name) byName.set(String(r.name).toLowerCase(), r);
}

const sizes = {};
let byId = 0, byNm = 0, miss = 0;
const missing = [];
for (const f of fs.readdirSync(MAPS_DIR).filter((x) => x.endsWith('.mdx')).sort()) {
  const slug = f.replace(/\.mdx$/, '');
  const t = fs.readFileSync(path.join(MAPS_DIR, f), 'utf8');
  const id = (/^workshopId:\s*"?(\d+)"?/m.exec(t) || [])[1] ?? null;
  const hit = (id && byAddon.get(id)) || byName.get(slug.toLowerCase());
  if (!hit) {
    miss++;
    missing.push(slug);
    continue;
  }
  const mb = toMb(hit.height);
  if (mb === null) {
    miss++;
    missing.push(slug + '（对方没给体积）');
    continue;
  }
  sizes[slug] = mb;
  if (id && byAddon.get(id) === hit) byId++;
  else byNm++;
}
console.log(`  条目 ${byId + byNm + miss} 张：按工坊 ID 命中 ${byId}，按名字命中 ${byNm}，没匹配上 ${miss}`);
if (missing.length) console.log('    未匹配：' + missing.slice(0, 12).join('、') + (missing.length > 12 ? ' …' : ''));

const out = {
  _说明:
    '地图体积（MB）。数据来自 s2ze.com / Ruby Bot 的公开地图数据（api.s2ze.com/site/data/maps.json），' +
    '由 npm run data:sizes 抓取；只用于详情页侧栏显示下载体积，页面上的数字带「~」表示近似值。',
  _抓取时间: new Date().toISOString().slice(0, 10),
  sizes,
};
if (DRY) {
  const vals = Object.values(sizes).sort((a, b) => a - b);
  console.log(`  最小 ${vals[0]} MB　中位 ${vals[Math.floor(vals.length / 2)]} MB　最大 ${vals.at(-1)} MB（dry run，未写）`);
} else {
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(`  ✓ 已写 ${path.relative(ROOT, OUT_FILE)}（${Object.keys(sizes).length} 条）`);
}
