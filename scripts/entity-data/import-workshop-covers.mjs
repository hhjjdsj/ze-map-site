#!/usr/bin/env node
/**
 * 把**作者上传的工坊预览图**导入成地图封面（`public/images/covers/workshop/<slug>.<ext>`）。
 *
 * 为什么要这一层（2026-10-07 站长的提议）：
 *   没有人工封面的地图，现在用的是 render-covers.mjs 画的密度雷达底图 ——
 *   那东西是本站算出来的示意图，跟「地图长什么样」差得远。
 *   而工坊预览图是**作者自己的真实截图**（抓取见 scripts/gallery/fetch-workshop-previews.mjs），
 *   同一张图本来就进了图片集，拿来当封面既真实又不用额外下载。
 *
 * 封面优先级（见 scripts/content/generate-map-entries.mjs）：
 *   1. custom/    —— 人工挑的（88 张，最高优先级，谁都不能盖）
 *   2. workshop/  —— 作者工坊图（本脚本的产物）
 *   3. /images/covers/<分片名>.webp —— 实体数据渲染的兜底
 *
 * 为什么复制进仓库、而不是直接引 R2 的 `terr.ze-map.cn/gallery/...`：
 *   那个域名在国内部分网络下不通（正因如此 /terr/* 才有同源回退）。
 *   封面是**每个卡片都要加载**的东西，一旦那个域挂了整站列表会全是破图；
 *   所以封面必须跟其它封面一样走本站同源。
 *
 * 用量（约 8~9 MB，图片本身是 555×312 webp，平均 20 KB）：
 *   node scripts/entity-data/import-workshop-covers.mjs --dry
 *   node scripts/entity-data/import-workshop-covers.mjs
 *   node scripts/entity-data/import-workshop-covers.mjs --prune    # 有人工封面的，把多余的那张删掉
 *   node scripts/entity-data/import-workshop-covers.mjs --force    # 全部重拷
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.join(ROOT, 'bake/gallery');
const CUSTOM_DIR = path.join(ROOT, 'public/images/covers/custom');
const DEST_DIR = path.join(ROOT, 'public/images/covers/workshop');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const PRUNE = args.includes('--prune');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').filter(Boolean)) : null;

/** 与 generate-map-entries.mjs 的取图顺序保持一致（同一张图有多个格式时取靠前的） */
const EXTS = ['webp', 'png', 'jpg', 'jpeg'];

/** 目录里 `<slug>.<ext>` 形式的文件 → slug 小写 → 真实文件名 */
function indexDir(dir) {
  const idx = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return idx;
  }
  for (const f of files.slice().sort()) {
    if (f.startsWith('.')) continue;
    const ext = path.extname(f).slice(1).toLowerCase();
    if (!EXTS.includes(ext)) continue;
    const slug = path.basename(f, path.extname(f)).toLowerCase();
    if (!idx.has(slug)) idx.set(slug, f);
  }
  return idx;
}

const customIdx = indexDir(CUSTOM_DIR);
const destIdx = indexDir(DEST_DIR);

if (!fs.existsSync(SRC_DIR)) {
  console.error(`✗ 找不到工坊图目录：${path.relative(ROOT, SRC_DIR)}（先跑 npm run gallery:fetch）`);
  process.exit(1);
}

let slugs = fs
  .readdirSync(SRC_DIR)
  .filter((d) => fs.statSync(path.join(SRC_DIR, d)).isDirectory())
  .sort()
  .filter((s) => !ONLY || ONLY.has(s));

const plan = [];
const skippedCustom = [];
let bytes = 0;

for (const slug of slugs) {
  /* 工坊图的真实文件名（可能是 .webp / .jpg / .png） */
  const dir = path.join(SRC_DIR, slug);
  let src = null;
  for (const ext of EXTS) {
    const p = path.join(dir, `05-workshop.${ext}`);
    if (fs.existsSync(p)) {
      src = p;
      break;
    }
  }
  if (!src) continue;

  if (customIdx.has(slug)) {
    skippedCustom.push(slug);
    continue;
  }

  const ext = path.extname(src).slice(1).toLowerCase();
  /* ⚠️ 目标文件名必须是 `<地图内部名>.<ext>` —— 生成器就是按地图名找封面的；
     沿用源文件的 `05-workshop.webp` 会「文件在仓库里但页面永远不显示」（2026-10-07 差点踩）。 */
  const name = `${slug}.${ext}`;
  const dest = path.join(DEST_DIR, name);
  if (!FORCE && destIdx.get(slug) === name) continue;
  plan.push({ slug, src, dest, name, size: fs.statSync(src).size });
  bytes += fs.statSync(src).size;
}

/* --prune：有人工封面的地图，workshop/ 里那张永远不会生效，是纯占地方 */
const prune = [];
if (PRUNE) {
  for (const [slug, file] of destIdx) {
    if (customIdx.has(slug)) prune.push(path.join(DEST_DIR, file));
  }
}

console.log(`工坊图可用：${slugs.length} 张地图`);
console.log(`  有人工封面、跳过：${skippedCustom.length} 张`);
console.log(`  待导入：${plan.length} 张（${(bytes / 1048576).toFixed(1)} MB）${DRY ? '  —— dry run' : ''}`);
if (PRUNE) console.log(`  待清理（有人工封面）：${prune.length} 张`);
console.log(`  导入后封面构成：人工 ${customIdx.size} · 工坊 ${destIdx.size + plan.length} · 渲染兜底见构建日志`);

if (DRY) {
  for (const p of plan.slice(0, 10)) console.log(`   + ${p.name}  ${Math.round(p.size / 1024)} KB`);
  if (plan.length > 10) console.log(`   …另外 ${plan.length - 10} 张`);
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
let done = 0;
for (const p of plan) {
  fs.copyFileSync(p.src, p.dest);
  done++;
  if (done % 50 === 0) process.stdout.write(`\r  已导入 ${done}/${plan.length}   `);
}
if (plan.length) process.stdout.write('\n');

let removed = 0;
for (const f of prune) {
  fs.rmSync(f, { force: true });
  removed++;
}

console.log(`✓ 导入 ${done} 张 → ${path.relative(ROOT, DEST_DIR)}${removed ? `，清理 ${removed} 张` : ''}`);
if (done || removed) {
  console.log('接着跑：npm run maps:generate && npm run cover:verify　（重新生成条目并核对封面）');
}
