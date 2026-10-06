#!/usr/bin/env node
/**
 * 把 `bake/gallery/<slug>/05-workshop.<ext>`（作者的工坊预览图）传到 R2（`gallery/<slug>/...`），
 * 并写出清单 `data/gallery/<slug>.json`。
 *
 * 图片集的全貌（见 src/lib/gallery.ts）：
 *   · workshop —— 工坊预览图，本脚本负责；
 *   · user     —— 玩家投稿，由 Worker 审核通过后写进 R2 + 清单（worker/gallery.ts）。
 * **本脚本只动本地生成的那一条**：重跑时清单里其它条目原样保留（按 src 去重），
 * 所以不会把玩家投稿冲掉 —— 这是「重跑安全」的前提，改这段时务必小心。
 *
 * 为什么图片放 R2、不进仓库：546 张地图 × 若干张图，塞进 git 会重演 terr 那次的体积事故
 * （见 docs/r2-migration.md）。入库的只有几 KB 的清单，页面按清单去 R2 取图。
 *
 * 用法：
 *   node scripts/gallery/upload-gallery.mjs --dry          # 只列清单
 *   node scripts/gallery/upload-gallery.mjs                # 增量上传 + 写清单
 *   node scripts/gallery/upload-gallery.mjs --all          # 全量重传
 *   node scripts/gallery/upload-gallery.mjs --only=slug1,slug2
 *
 * 凭证同 terr：.env.r2 里的 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.join(ROOT, 'bake/gallery');
const DATA_DIR = path.join(ROOT, 'data/gallery');
const STATE_FILE = path.join(ROOT, '.r2-gallery-state.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').filter(Boolean)) : null;

/* ⚠️ 值里不能有空格：Windows 下走 shell，带空格的值会被拆成多个参数（见 upload-terr.mjs） */
const CACHE_CONTROL = 'public,max-age=31536000,immutable';
const CONCURRENCY = 4;

/** 扩展名 → content-type：工坊预览图 jpg 居多，也可能是 png / webp（按实际字节判断，见 fetch 脚本） */
const CONTENT_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

const isImage = (f) => Object.prototype.hasOwnProperty.call(CONTENT_TYPES, f.split('.').pop()?.toLowerCase() ?? '');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env.r2'));
const BUCKET = process.env.R2_BUCKET || 'ze-map-terr';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

if (!fs.existsSync(SRC_DIR)) {
  console.error(`✗ 找不到图片目录：${path.relative(ROOT, SRC_DIR)}（先跑 fetch-workshop-previews.mjs）`);
  process.exit(1);
}

/**
 * 文件名（去掉扩展名）→ 说明。顺序即页面展示顺序：作者的原图放第一张（最像"真图"）。
 *
 * ⚠️ 这里**只列本脚本管的文件**。以前还有 01-iso / 02-top / 03-side / 04-close 四张
 *    本站用真实地形渲染的机位图，2026-10-06 连同渲染脚本一起删掉了 ——
 *    图片集只放真实图片（工坊预览图 + 玩家投稿）。
 *    表外的文件一律忽略（不报错、不入清单），所以 bake 目录里残留的旧渲染图也不会被传上去。
 */
const CAPTIONS = {
  '05-workshop': { kind: 'workshop', caption: '工坊预览图（作者上传）', order: 0 },
};

/** 本脚本管的文件（表里列了、且确实是图片格式） */
const managedFiles = (slug) =>
  fs
    .readdirSync(path.join(SRC_DIR, slug))
    .filter(isImage)
    .filter((f) => CAPTIONS[f.replace(/\.[^.]+$/, '')]);

const slugs = fs
  .readdirSync(SRC_DIR)
  .filter((d) => fs.statSync(path.join(SRC_DIR, d)).isDirectory())
  .sort()
  .filter((s) => !ONLY || ONLY.has(s))
  .filter((s) => managedFiles(s).length > 0);
if (!slugs.length) {
  console.error(`没有可上传的图片目录（${path.relative(ROOT, SRC_DIR)}/<slug>/05-workshop.*）`);
  process.exit(1);
}

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { files: {} };
const pending = [];
let totalBytes = 0;
for (const slug of slugs) {
  for (const f of managedFiles(slug).sort()) {
    const full = path.join(SRC_DIR, slug, f);
    const st = fs.statSync(full);
    totalBytes += st.size;
    const key = `${slug}/${f}`;
    const prev = state.files?.[key];
    if (!ALL && prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    pending.push({ slug, name: f, key, full, size: st.size, mtimeMs: st.mtimeMs });
  }
}
console.log(
  `图片：${slugs.length} 张地图 / ${(totalBytes / 1048576).toFixed(1)} MB；待上传 ${pending.length} 个${DRY ? '（dry run）' : ''}`
);

/**
 * 清单：入库的那份，页面靠它渲染图片集。
 *
 * **合并而不是重建**：从本地 bake 目录只能生成 workshop 那一条，而玩家投稿（kind: 'user'）
 * 只存在于清单和 R2 里 —— 直接覆盖就等于把玩家投的图全删了。
 */
function writeManifest(slug) {
  const local = managedFiles(slug)
    .map((f) => {
      const meta = CAPTIONS[f.replace(/\.[^.]+$/, '')];
      return { file: f, ...meta };
    })
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file))
    .map(({ file, kind, caption }) => ({
      src: `https://terr.ze-map.cn/gallery/${slug}/${encodeURIComponent(file)}`,
      kind,
      caption,
    }));

  const manifestPath = path.join(DATA_DIR, `${slug}.json`);
  let prev = [];
  if (fs.existsSync(manifestPath)) {
    try {
      prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.images ?? [];
    } catch {
      prev = []; // 坏文件：这次重写成合法结构（下面的 filter 会把垃圾条目滤掉）
    }
  }
  const localSrcs = new Set(local.map((i) => i.src));
  const kept = prev.filter(
    (i) =>
      i &&
      typeof i === 'object' &&
      typeof i.src === 'string' &&
      i.src &&
      !localSrcs.has(i.src) &&
      /* 本站渲染的 3D 机位图已废弃（2026-10-06）：重写清单时顺手清掉历史遗留 */
      i.kind !== 'render'
  );

  const images = [...local, ...kept].map(({ src, kind, caption, by }) => ({
    src,
    kind,
    caption,
    ...(by ? { by } : {}),
  }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ slug, count: images.length, images }, null, 2) + '\n');
  return images.length;
}

if (DRY) {
  for (const p of pending.slice(0, 12)) console.log(`  + ${p.key}  ${Math.round(p.size / 1024)} KB`);
  if (pending.length > 12) console.log(`  …另外 ${pending.length - 12} 个`);
  for (const slug of slugs) {
    const kept = fs.existsSync(path.join(DATA_DIR, `${slug}.json`))
      ? (JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${slug}.json`), 'utf8'))?.images?.length ?? 0)
      : 0;
    console.log(`  清单 ${slug}: 本地 ${managedFiles(slug).length} 张（现有清单 ${kept} 条）`);
  }
  process.exit(0);
}

if (!ACCOUNT || !TOKEN) {
  console.error('✗ 缺少凭证：仓库根目录的 .env.r2 需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

function put({ key, full, name }) {
  const isWin = process.platform === 'win32';
  const type = CONTENT_TYPES[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
  return new Promise((resolve) => {
    execFile(
      isWin ? 'npx.cmd' : 'npx',
      ['--yes', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/gallery/${key}`, '--file', full,
       '--content-type', type, '--cache-control', CACHE_CONTROL, '--remote'],
      { cwd: ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024, shell: isWin },
      (err, stdout, stderr) => resolve({ key, name, err, out: String(stdout || '') + String(stderr || '') })
    );
  });
}

const failed = [];
let done = 0;
for (let i = 0; i < pending.length; i += CONCURRENCY) {
  const batch = pending.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(put));
  for (const r of results) {
    if (r.err) { failed.push(r); console.error(`  ✗ ${r.key}: ${r.out.slice(0, 160)}`); continue; }
    done++;
    const item = batch.find((b) => b.key === r.key);
    state.files[r.key] = { size: item.size, mtimeMs: item.mtimeMs };
    process.stdout.write(`\r  已上传 ${done}/${pending.length}   `);
  }
}
process.stdout.write('\n');
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 0) + '\n');

let manifestTotal = 0;
let userTotal = 0;
for (const slug of slugs) {
  const n = writeManifest(slug);
  manifestTotal += n;
  userTotal += n - managedFiles(slug).length; // 清单里非本脚本管的条目 = 玩家投稿
}
console.log(
  `✓ 上传 ${done} 个（失败 ${failed.length}），清单写入 ${path.relative(ROOT, DATA_DIR)}/` +
    `（${slugs.length} 份 / ${manifestTotal} 条，其中保留玩家投稿 ${userTotal} 条）`
);
