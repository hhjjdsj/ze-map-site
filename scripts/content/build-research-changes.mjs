#!/usr/bin/env node
/**
 * 生成 data/research-changes.json —— 「哪张图的哪一部分改过」的逐条记录（来自 git 历史）。
 *
 *   node scripts/content/build-research-changes.mjs
 *
 * 这份清单只覆盖**本站整理的资料**（data/research/*.json 与 data/gallery/*.json）。
 * 社区投稿那部分不在这里 —— 它写在 data/community/<slug>.json 的 log[] 里，
 * 构建期直接读文件就有（连作者和投稿编号都在），不需要 git，也就不会受浅克隆影响。
 * 两边在 src/lib/update-feed.ts 里合并成首页底部那份「最近改动」。
 *
 * 为什么必须把结果**提交进仓库**（和 data/map-dates.json 一个道理）：
 *   线上（Cloudflare Workers Builds）的克隆深度不确定，浅克隆读不到历史，
 *   现算会把整站历史都说成「今天」。所以本地生成 → 提交 → 线上沿用；
 *   线上如果也是完整克隆，它会自己再算一遍，结果一致。
 *
 * 口径（与 build-map-dates.mjs 保持一致，别各写一套）：
 *   · 只看 data/research / data/gallery 的文件改动；src/content/maps/*.mdx 是打印稿，
 *     它变了只说明「重新生成过」，不代表有人改了内容 —— 但它参与「批量提交」的判定。
 *   · 单次提交动了几百个文件（整批导入 / 生成器改版）→ 整条丢弃，否则一次改版会把
 *     几百张图塞满首页。判定阈值 BULK = 20，与 build-map-dates 相同。
 *   · 字段级：从 diff 里取 JSON 的**顶层键**（缩进正好两格的那种行），
 *     映射成人话（difficulty → 难度、relicIntros → 神器说明…）。
 *   · 只改了不看重的键（_说明 / slug）→ 不记。
 *
 * ⚠️ 分隔提交的标记用 `%x01`（不可打印字符）而不是 `@@`：带 `-p` 时 diff 的块头
 *    `@@ -1,3 +1,4 @@` 也以 `@@` 开头，第一版就是栽在这上面（解析全乱、结果是 0 条）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/research-changes.json');
/** 一次提交里相关文件超过这个数 = 批量操作（导入 / 整批刷新 / 生成器改版），不算内容改动 */
const BULK = 20;
/** 清单最多留这么多条（更早的翻不到了，文件大小也就封顶了） */
const MAX_ITEMS = 400;

/** 顶层键 → 人话。「不记」的键（纯标识 / 台账字段 / 格式）值为 null。 */
const KEY_LABELS = {
  slug: null,
  _说明: null,
  /* 台账字段：资料可信度、是否核对过、待建条目笔记 —— 改它们不是内容变化 */
  confidence: null,
  verified: null,
  _待建条目: null,
  _来源: null,
  document: '正文（旧写法）',
  title: '标题',
  titleEn: '英文名',
  summary: '简介',
  sections: '正文小节',
  guides: '神器 / 关卡教程',
  relicIntros: '神器说明',
  difficulty: '难度',
  tags: '标签',
  author: '作者',
  awthor: '作者',
  authorNote: '署名详情',
  version: '版本',
  players: '人数',
  duration: '时长',
  stages: '关卡数',
  game: '游戏',
  featured: '首页精选',
  maps: '关联实体',
  sources: '资料来源',
  videoUrls: '攻略视频',
  cover: '封面',
};

/** 找 git：线上是 Linux 直接在 PATH 里；Windows 本地可能只有 GitHub Desktop 自带的那份 */
function findGit() {
  const candidates = [
    'git',
    'C:/Users/LENOVO/AppData/Local/GitHubDesktop/app-3.6.6/resources/app/git/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { cwd: ROOT, encoding: 'utf8', shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

const git = findGit();
if (!git) {
  console.warn('[changes] 找不到 git，保留现有 data/research-changes.json 不动');
  process.exit(0);
}
const run = (args) => spawnSync(git, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

if (run(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
  console.warn('[changes] 当前不在 git 仓库里，保留现有 data/research-changes.json 不动');
  process.exit(0);
}
if (run(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') {
  console.warn('[changes] ⚠️ 这是浅克隆（没有完整历史），跳过生成，沿用现有的 data/research-changes.json');
  process.exit(0);
}

/* ---------- 1. 提交清单：算「批量提交」+ 谁是新增文件 ---------- */
const log = run([
  'log',
  '--name-status',
  '--format=%x01%H|%aI',
  '--',
  'src/content/maps',
  'data/research',
  'data/gallery',
  'data/community',
]);
if (log.status !== 0) {
  console.warn('[changes] git log 失败，保留现有 data/research-changes.json 不动');
  process.exit(0);
}

const commits = [];
let cur = null;
for (const raw of log.stdout.split('\n')) {
  const line = raw.trimEnd();
  if (line.startsWith('\x01')) {
    const [sha, at] = line.slice(1).split('|');
    cur = { sha, at, files: [] };
    commits.push(cur);
    continue;
  }
  const m = /^([A-Z])\d*\t(.+)$/.exec(line);
  if (!m || !cur) continue;
  cur.files.push({ status: m[1], path: m[2] });
}

const relevant = (p) =>
  /^src\/content\/maps\/.+\.mdx$/.test(p) ||
  /^data\/(?:research|gallery|community)\/.+\.json$/.test(p);
const skipCommit = new Set();
let bulkCount = 0;
for (const c of commits) {
  const f = c.files.filter((x) => relevant(x.path) && !/^data\/research\/priority\.json$/.test(x.path));
  if (f.length > BULK) {
    skipCommit.add(c.sha);
    bulkCount++;
  }
}
const dateOf = new Map(commits.map((c) => [c.sha, c.at]));
const addedFiles = new Set();
for (const c of commits) {
  if (skipCommit.has(c.sha)) continue;
  for (const f of c.files) if (f.status === 'A') addedFiles.add(`${c.sha}|${f.path}`);
}

/* ---------- 2. 补丁：从 diff 里取顶层键 ---------- */
const patches = run([
  'log',
  '-U0',
  '-p',
  '--format=%x01%H|%aI',
  '--',
  'data/research',
  'data/gallery',
]);
if (patches.status !== 0) {
  console.warn('[changes] git log -p 失败，保留现有 data/research-changes.json 不动');
  process.exit(0);
}

/** sha → slug → { keys:Set, gallery:number, added:boolean } */
const byCommit = new Map();
let sha = null;
let file = null;
let isNew = false;
const bucket = (s, slug) => {
  if (!byCommit.has(s)) byCommit.set(s, new Map());
  const m = byCommit.get(s);
  if (!m.has(slug)) m.set(slug, { keys: new Set(), gallery: 0, added: false });
  return m.get(slug);
};

for (const raw of patches.stdout.split('\n')) {
  const line = raw.trimEnd();
  if (line.startsWith('\x01')) {
    sha = line.slice(1).split('|')[0];
    file = null;
    isNew = false;
    continue;
  }
  if (!sha || skipCommit.has(sha)) continue;
  if (line.startsWith('diff --git ')) {
    file = null;
    isNew = false;
    continue;
  }
  if (line.startsWith('--- /dev/null')) {
    isNew = true;
    continue;
  }
  const plus = /^\+\+\+ b\/(.+)$/.exec(line);
  if (plus) {
    file = plus[1];
    isNew = isNew || addedFiles.has(`${sha}|${file}`);
    if (file && !/^data\/(research|gallery)\/.+\.json$/.test(file)) file = null;
    if (file && /^data\/research\/priority\.json$/.test(file)) file = null;
    if (file) {
      const slug = file.replace(/^data\/(research|gallery)\//, '').replace(/\.json$/, '');
      const b = bucket(sha, slug);
      if (isNew) b.added = true;
    }
    continue;
  }
  if (!file) continue;
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) continue;
  if (!/^[+-]/.test(line)) continue;
  const slug = file.replace(/^data\/(research|gallery)\//, '').replace(/\.json$/, '');
  const b = bucket(sha, slug);
  if (file.startsWith('data/gallery/')) {
    /* 图片集清单：数一下新增了几个 "src"（每个条目一个），比解析键名更准 */
    if (line.startsWith('+') && /^\+\s*"src":/.test(line)) b.gallery++;
    continue;
  }
  const key = /^[+-] {2}"([^"]+)":/.exec(line);
  if (key) b.keys.add(key[1]);
}

/* ---------- 3. 组装条目 ---------- */
const items = [];
for (const [s, m] of byCommit) {
  const at = dateOf.get(s);
  if (!at) continue;
  for (const [slug, b] of m) {
    const parts = [];
    for (const k of b.keys) {
      const label = Object.prototype.hasOwnProperty.call(KEY_LABELS, k) ? KEY_LABELS[k] : k;
      if (label && !parts.includes(label)) parts.push(label);
    }
    if (!parts.length && !b.gallery) continue; // 只动了 slug / 说明这类，不记
    items.push({
      at,
      slug,
      parts,
      ...(b.gallery ? { gallery: b.gallery } : {}),
      ...(b.added ? { first: true } : {}),
    });
  }
}

items.sort((a, b) => (a.at === b.at ? a.slug.localeCompare(b.slug) : a.at < b.at ? 1 : -1));
const kept = items.slice(0, MAX_ITEMS);

const next = {
  _说明:
    '本站整理资料的逐条改动记录（data/research 与 data/gallery），由 scripts/content/build-research-changes.mjs ' +
    '从 git 历史生成，别手改。社区投稿那部分不在这里 —— 构建期直接读 data/community/<slug>.json 的 log。',
  version: 1,
  items: kept,
};
const text = JSON.stringify(next, null, 1) + '\n';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (prev === text) {
  console.log(`[changes] 无变化（${kept.length} 条，跳过了 ${bulkCount} 次批量提交）`);
  process.exit(0);
}
fs.writeFileSync(OUT, text, 'utf8');
console.log(
  `[changes] 已写入 data/research-changes.json：${kept.length} 条` +
    `（共 ${items.length} 条，留最近 ${MAX_ITEMS} 条；跳过 ${bulkCount} 次批量提交）`
);
