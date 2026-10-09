#!/usr/bin/env node
/**
 * 批量生成「资料待补充」条目原稿：data/research/<地图英文名>.json
 *
 * 为什么需要它：站点扩图是一批一批来的（一次几十上百张），而原稿是**人工稿** ——
 * 逐张手写标题/难度/攻略不现实。这个脚本只造**最小可用**的原稿：
 * 标题（工坊标题有中日文就用它，否则用地图英文名）、空摘要、空标签、confidence=low，
 * 难度不写（生成器会落成「未知」）→ 页面自动标「资料待补充」，等社区补。
 *
 * 它**只补缺失的**：同名原稿已存在就直接跳过，绝不覆盖任何人工内容。
 *
 * 地图英文名从哪来（不猜）：
 *   1. 已烘好的实体分片 public/entity/data/2001-<英文名>-<工坊ID>.bin —— 最可靠
 *   2. s2ze / Ruby Bot 的公开地图数据 api.s2ze.com/site/data/maps.json 的 name 字段
 *
 * 用法：
 *   node scripts/content/scaffold-entries.mjs --ids data/bootstrap-live.txt
 *   node scripts/content/scaffold-entries.mjs --ids a.txt --ids b.txt --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S2ZE_URL = 'https://api.s2ze.com/site/data/maps.json';
const ENTITY_DIR = path.join(ROOT, 'public/entity/data');
const WORKSHOP_DIR = path.join(ROOT, 'data/workshop');
const RESEARCH_DIR = path.join(ROOT, 'data/research');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const idFiles = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ids' && args[i + 1]) idFiles.push(args[i + 1]);
}
if (!idFiles.length) {
  console.error('用法：node scripts/content/scaffold-entries.mjs --ids <ID 清单文件> [--ids ...] [--dry]');
  process.exit(1);
}

const ids = new Set();
for (const f of idFiles) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const id = line.trim();
    if (/^\d+$/.test(id)) ids.add(id);
  }
}
console.log(`待处理工坊 ID：${ids.size} 个（来自 ${idFiles.length} 份清单）`);

/* 工坊 ID → 已烘分片里的地图英文名 */
const nameFromShard = new Map();
for (const file of fs.readdirSync(ENTITY_DIR)) {
  const m = /^\d+-(.+?)-(\d+)\.bin$/.exec(file);
  if (m) nameFromShard.set(m[2], m[1]);
}

/* s2ze：补上还没有分片的图（下架图永远不会有分片） */
let s2ze = new Map();
try {
  const res = await fetch(S2ZE_URL);
  const list = await res.json();
  s2ze = new Map((Array.isArray(list) ? list : []).map((r) => [String(r.addon), r]));
  console.log(`s2ze 数据：${s2ze.size} 条`);
} catch (err) {
  console.warn(`⚠ 拉不到 s2ze 数据（${err.message}）—— 没有实体分片的图会被跳过`);
}

const hasCJK = (s) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const created = [];
const skippedExisting = [];
const skippedNoName = [];
const skippedBadName = [];
const skippedNotZe = [];

for (const id of ids) {
  const mapName =
    nameFromShard.get(id) ??
    (() => {
      const raw = clean(s2ze.get(id)?.name);
      return /^[A-Za-z0-9_]+$/.test(raw) ? raw : '';
    })();
  if (!mapName) {
    skippedNoName.push(id);
    continue;
  }
  if (!/^[A-Za-z0-9_]+$/.test(mapName) || mapName.length > 64) {
    skippedBadName.push(`${id}(${mapName})`);
    continue;
  }
  /* 站点只收僵尸逃跑图 —— 和 scripts/content/add-map.mjs 同一条规矩：内部名必须是 ze_ 开头 */
  if (!/^ze_/i.test(mapName)) {
    skippedNotZe.push(`${id}(${mapName})`);
    continue;
  }
  const target = path.join(RESEARCH_DIR, `${mapName}.json`);
  if (fs.existsSync(target)) {
    skippedExisting.push(mapName);
    continue;
  }
  /*
   * 标题：工坊标题里有中日韩文字才用它（作者自己写的中文名往往比英文名有用），
   * 否则用地图英文名 —— 不编中文名，缺的等社区补。
   */
  let wsTitle = '';
  const wsFile = path.join(WORKSHOP_DIR, `${id}.json`);
  if (fs.existsSync(wsFile)) {
    try {
      wsTitle = clean(JSON.parse(fs.readFileSync(wsFile, 'utf8')).title);
    } catch { /* 坏文件就当没有 */ }
  }
  const title = hasCJK(wsTitle) && wsTitle.length <= 60 ? wsTitle : mapName;

  const record = {
    slug: `2001-${mapName}-${id}`,
    title,
    summary: null,
    tags: [],
    videoUrls: [],
    sources: [],
    confidence: 'low',
  };
  if (!DRY) fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n');
  created.push(`${mapName}${title === mapName ? '' : `（${title}）`}`);
}

console.log(`\n${DRY ? '[dry-run] ' : ''}新建原稿 ${created.length} 份`);
if (created.length) console.log(`  ${created.slice(0, 8).join('、')}${created.length > 8 ? ` …共 ${created.length}` : ''}`);
console.log(`已存在、跳过 ${skippedExisting.length} 份（不动人工稿）`);
if (skippedNotZe.length) console.log(`非 ze_ 图、跳过 ${skippedNotZe.length} 个：${skippedNotZe.slice(0, 6).join(', ')}`);
if (skippedNoName.length) console.log(`⚠ 拿不到地图英文名、跳过 ${skippedNoName.length} 个：${skippedNoName.slice(0, 6).join(', ')}`);
if (skippedBadName.length) console.log(`⚠ 地图名不合规（含空格/符号）、需人工定名 ${skippedBadName.length} 个：${skippedBadName.slice(0, 6).join(', ')}`);
