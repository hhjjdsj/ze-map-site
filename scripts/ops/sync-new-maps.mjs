#!/usr/bin/env node
/**
 * 每周新图收录：从 MapTracking-CS2 的 manifest 里发现站内没有的工坊条目，
 * 通过 Steam 公开 API 拉详情，建立「无实体」资料页。
 *
 * 为什么不用 Steam 工坊网页：页面抓取在数据中心网络经常被挡/超时；
 * manifest 已经在每天同步日期时用到，稳定且自带 publishFileId + publishDate。
 *
 * 用法：
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/fyscs/MapTracking-CS2 _mt
 *   git -C _mt sparse-checkout set --no-cone '2001/<map>/<version>/manifest.json'
 *   node scripts/ops/sync-new-maps.mjs --repo _mt [--dry] [--all]
 *
 * 产物：data/workshop/<id>.json + data/research/<slug>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESEARCH = path.join(ROOT, 'data/research');
const WORKSHOP = path.join(ROOT, 'data/workshop');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const all = argv.includes('--all');
const s2zeArg = argv.indexOf('--s2ze-days');
const s2zeDays = s2zeArg >= 0 ? Number(argv[s2zeArg + 1]) || 45 : 0;
const repoArg = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : process.env.MAPTRACK_DIR;
if (!repoArg) {
  console.error('用法：node scripts/ops/sync-new-maps.mjs --repo _mt [--dry] [--all]');
  process.exit(1);
}
const repo = path.resolve(repoArg);
const modeDir = path.join(repo, '2001');
if (!fs.existsSync(modeDir)) {
  console.error(`找不到 ${modeDir}：先 sparse-checkout manifest`);
  process.exit(1);
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\[\/?[a-z0-9*=]+\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* 站内已知：研究文件的 workshopId / slug 尾号 / 地图名，以及工坊快照文件名 */
const knownIds = new Set();
const knownNames = new Set();
for (const f of fs.readdirSync(RESEARCH)) {
  if (!f.endsWith('.json') || f === 'priority.json') continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RESEARCH, f), 'utf8'));
    if (j.workshopId) knownIds.add(String(j.workshopId));
    if (j.slug) {
      knownNames.add(String(j.slug).toLowerCase());
      const m = /^(\d+)-([A-Za-z0-9_]+)-(\d+)$/.exec(String(j.slug));
      if (m) { knownIds.add(m[3]); knownNames.add(m[2].toLowerCase()); }
    }
    for (const m of j.maps ?? []) knownNames.add(String(m).toLowerCase());
  } catch {}
}
for (const f of fs.readdirSync(WORKSHOP)) {
  if (f.endsWith('.json')) knownIds.add(f.replace(/\.json$/, ''));
}

/* 扫 manifest */
const found = new Map();
for (const mapName of fs.readdirSync(modeDir)) {
  const mapDir = path.join(modeDir, mapName);
  if (!fs.statSync(mapDir).isDirectory()) continue;
  for (const versionDir of fs.readdirSync(mapDir)) {
    const file = path.join(mapDir, versionDir, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const id = String(m.publishFileId ?? '');
      if (!id || knownIds.has(id)) continue;
      if (!all && knownNames.has(String(mapName).toLowerCase())) continue;
      if (!found.has(id)) found.set(id, { id, map: String(mapName), publishDate: String(m.publishDate ?? '').slice(0, 10), src: 'manifest' });
    } catch {}
  }
}

if (s2zeDays > 0) {
  try {
    const r = await fetch('https://api.s2ze.com/site/data/maps.json');
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.maps || j.data || []);
    for (const m of arr) {
      const name = String(m.name || m.map || '');
      const id = String(m.addon || m.id || '');
      if (!/^ze[_-]/i.test(name) || !id || knownIds.has(id)) continue;
      if (!all && knownNames.has(name.toLowerCase())) continue;
      if (!found.has(id)) found.set(id, { id, map: name, publishDate: '', src: 's2ze' });
    }
    console.log('s2ze 候选并入后：' + found.size);
  } catch (e) {
    console.log('s2ze 拉取失败，跳过：' + String((e && e.message) || e));
  }
}

const fresh = [...found.values()];
console.log(`manifest 命中新条目：${fresh.length}`);
if (!fresh.length || dry) {
  for (const x of fresh.slice(0, 20)) console.log('  ', x.id, x.map, x.publishDate);
  process.exit(0);
}

/* 拉详情 → 写快照 + 资料页 */
let added = 0;
for (const item of fresh) {
  if (!/^ze[_-]/i.test(item.map)) continue;
  const body = new URLSearchParams();
  body.set('itemcount', '1');
  body.set('publishedfileids[0]', item.id);
  const r = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  const f = j?.response?.publishedfiledetails?.[0];
  if (!f || Number(f.result) !== 1) { console.log('跳过（详情取不到）', item.id); continue; }

  const title = String(f.title ?? item.map).trim();
  const created = f.time_created ? new Date(Number(f.time_created) * 1000).toISOString().slice(0, 10) : item.publishDate || null;
  if (item.src === 's2ze' && created) {
    const age = (Date.now() - Date.parse(created)) / 86400000;
    if (age > s2zeDays) { console.log('跳过（过旧）', title, created); continue; }
  }
  const desc = clean(f.description);

  fs.writeFileSync(
    path.join(WORKSHOP, `${item.id}.json`),
    JSON.stringify(
      {
        id: item.id,
        result: 1,
        title,
        description: desc.slice(0, 2000),
        creator: String(f.creator ?? ''),
        timeCreated: created,
        timeUpdated: f.time_updated ? new Date(Number(f.time_updated) * 1000).toISOString().slice(0, 10) : null,
        subscriptions: Number(f.subscriptions ?? 0),
        views: Number(f.views ?? 0),
        fileSize: String(f.file_size ?? ''),
        tags: Array.isArray(f.tags) ? f.tags.map((t) => String(t.tag ?? '')) : [],
        filename: String(f.filename ?? ''),
      },
      null,
      2
    ) + '\n'
  );

  const mapName = /^(ze[_-][A-Za-z0-9_]+)/i.exec(title)?.[1] ?? item.map;
  const slug = `2001-${mapName}-${item.id}`;
  if (fs.existsSync(path.join(RESEARCH, `${slug}.json`))) { console.log('已存在，跳过', slug); continue; }
  const doc = {
    slug,
    title: mapName,
    titleEn: mapName,
    difficulty: '未知',
    tags: [],
    summary: desc
      ? `${desc}\n\n> 新图自动收录，暂无实体数据与人工整理；欢迎在编辑页补充难度、标签、玩法与视频。`
      : '> 新图自动收录，暂无实体数据与人工整理；欢迎在编辑页补充资料。',
    videoUrls: [],
    sources: [`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`],
    workshopId: item.id,
    confidence: 'low',
  };
  fs.writeFileSync(path.join(RESEARCH, `${slug}.json`), JSON.stringify(doc, null, 2) + '\n');
  knownIds.add(item.id);
  added++;
  console.log(`收录 ${mapName} ← ${title}（${created}）`);
}
console.log(`完成：新增 ${added} 张`);
