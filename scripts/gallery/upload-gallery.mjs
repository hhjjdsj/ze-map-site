#!/usr/bin/env node
/**
 * 把 `bake/gallery/<slug>/*.webp` 传到 R2（`gallery/<slug>/...`），并写出入库的清单
 * `data/gallery/<slug>.json`。
 *
 * 为什么图片也放 R2、不进仓库：546 张地图 × 5 张图 ≈ 200 MB，
 * 塞进 git 会重演 terr 那次体积事故（见 docs/r2-migration.md）。
 * 入库的只有几 KB 的清单，页面按清单去 R2 取图。
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
  console.error(`✗ 找不到图片目录：${path.relative(ROOT, SRC_DIR)}（先跑 render-gallery.mjs）`);
  process.exit(1);
}

/* 文件名 → 说明。顺序即页面展示顺序：作者的原图放第一张（最像"真图"）。 */
const CAPTIONS = {
  '05-workshop': { kind: 'workshop', caption: '工坊预览图（作者上传）', order: 0 },
  '01-iso': { kind: 'render', caption: '本站渲染 · 斜视', order: 1 },
  '02-top': { kind: 'render', caption: '本站渲染 · 俯视', order: 2 },
  '03-side': { kind: 'render', caption: '本站渲染 · 侧视', order: 3 },
  '04-close': { kind: 'render', caption: '本站渲染 · 近景', order: 4 },
};

const slugs = fs.readdirSync(SRC_DIR).filter((d) => fs.statSync(path.join(SRC_DIR, d)).isDirectory()).sort()
  .filter((s) => !ONLY || ONLY.has(s));
if (!slugs.length) { console.error('没有可上传的图片目录'); process.exit(1); }

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { files: {} };
const pending = [];
let totalBytes = 0;
for (const slug of slugs) {
  for (const f of fs.readdirSync(path.join(SRC_DIR, slug)).filter((x) => x.endsWith('.webp')).sort()) {
    const full = path.join(SRC_DIR, slug, f);
    const st = fs.statSync(full);
    totalBytes += st.size;
    const key = `${slug}/${f}`;
    const prev = state.files?.[key];
    if (!ALL && prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    pending.push({ slug, name: f, key, full, size: st.size, mtimeMs: st.mtimeMs });
  }
}
console.log(`图片：${slugs.length} 张地图 / ${(totalBytes / 1048576).toFixed(1)} MB；待上传 ${pending.length} 个${DRY ? '（dry run）' : ''}`);

/* 清单：入库的那份，页面靠它渲染图片集 */
function writeManifest(slug) {
  const dir = path.join(SRC_DIR, slug);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp'));
  const images = files
    .map((f) => {
      const base = f.replace(/\.webp$/, '');
      const meta = CAPTIONS[base] ?? { kind: 'other', caption: base, order: 9 };
      return { file: f, ...meta };
    })
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file))
    .map(({ file, kind, caption }) => ({
      src: `https://terr.ze-map.cn/gallery/${slug}/${encodeURIComponent(file)}`,
      kind,
      caption,
    }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, `${slug}.json`),
    JSON.stringify({ slug, count: images.length, images }, null, 2) + '\n'
  );
  return images.length;
}

if (DRY) {
  for (const p of pending.slice(0, 12)) console.log(`  + ${p.key}  ${Math.round(p.size / 1024)} KB`);
  if (pending.length > 12) console.log(`  …另外 ${pending.length - 12} 个`);
  for (const slug of slugs) console.log(`  清单 ${slug}: ${fs.readdirSync(path.join(SRC_DIR, slug)).filter((f) => f.endsWith('.webp')).length} 张`);
  process.exit(0);
}

if (!ACCOUNT || !TOKEN) {
  console.error('✗ 缺少凭证：仓库根目录的 .env.r2 需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

function put({ key, full, name }) {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      isWin ? 'npx.cmd' : 'npx',
      ['--yes', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/gallery/${key}`, '--file', full,
       '--content-type', 'image/webp', '--cache-control', CACHE_CONTROL, '--remote'],
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
for (const slug of slugs) manifestTotal += writeManifest(slug);
console.log(`✓ 上传 ${done} 个（失败 ${failed.length}），清单写入 ${path.relative(ROOT, DATA_DIR)}/（${slugs.length} 份 / ${manifestTotal} 张图）`);
