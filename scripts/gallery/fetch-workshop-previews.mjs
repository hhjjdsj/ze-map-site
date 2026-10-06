#!/usr/bin/env node
/**
 * 抓地图的**工坊预览图**（作者自己在创意工坊上传的那张），作为图片集里的第一张真图。
 *
 * 为什么只有这一件事了：以前这个脚本还会用 headless 浏览器 + CDP 把本站 3D 预览
 * 渲染成 4 个机位的图（iso/top/side/close）。2026-10-06 站长决定图片集**只放真实图片**，
 * 于是整条截图链路（Edge CDP / sharp / 机位参数）一起删掉了 ——
 * 现在的图片集 = 工坊预览图（本脚本）+ 玩家投稿（/submit/ 的「图片集图片」）。
 *
 * 产物写到仓库外的 `bake/gallery/<slug>/05-workshop.<ext>`（bake/ 已 gitignore），
 * 再由 upload-gallery.mjs 传到 R2（`gallery/` 前缀）并写出清单 data/gallery/<slug>.json。
 * 图片不进仓库：546 张 × 十几 KB 也是十几 MB，塞进 git 会重演 terr 那次的体积事故。
 *
 * 用法：
 *   node scripts/gallery/fetch-workshop-previews.mjs --all          # 全部有工坊 ID 的图
 *   node scripts/gallery/fetch-workshop-previews.mjs ze_2012_p      # 指定几张
 *   node scripts/gallery/fetch-workshop-previews.mjs --all --force  # 重下已有的
 *   node scripts/gallery/fetch-workshop-previews.mjs --all --dry    # 只看有多少张能拿到
 *
 * 不需要任何 key：ISteamRemoteStorage/GetPublishedFileDetails 是公开接口
 * （一次最多 100 个 ID，脚本自己分批）。没有工坊 ID 的图直接跳过。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageFormat } from '../../shared/image-size.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const OUT_DIR = path.join(ROOT, 'bake/gallery');
/** 工坊预览图在清单里的固定名（角标 05 是历史遗留：以前它排在 4 张渲染图后面） */
const NAME = '05-workshop';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ALL = args.includes('--all');
const DRY = args.includes('--dry');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').filter(Boolean)) : null;
let slugs = args.filter((a) => !a.startsWith('--'));

if (!slugs.length && !ALL) {
  console.error('用法：node scripts/gallery/fetch-workshop-previews.mjs <slug...> | --all');
  process.exit(1);
}
if (ALL) {
  slugs = fs
    .readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\.mdx$/, ''))
    .sort();
}
if (ONLY) slugs = slugs.filter((s) => ONLY.has(s));

/** 地图条目 frontmatter 里的工坊 ID */
function workshopIdOf(slug) {
  const p = path.join(MAPS_DIR, `${slug}.mdx`);
  if (!fs.existsSync(p)) return null;
  const m = /^workshopId:\s*"?(\d+)"?\s*$/m.exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1] : null;
}

/** 本地已有的那张（任意扩展名）—— 换过格式时不重复下 */
function existingLocal(slug) {
  const dir = path.join(OUT_DIR, slug);
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(NAME + '.'));
  return hit ? path.join(dir, hit) : null;
}

/** 批量查 preview_url；一次别塞太多，按 100 个一批 */
function fetchPreviewUrls(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = [`itemcount=${chunk.length}`, ...chunk.map((id, k) => `publishedfileids[${k}]=${id}`)].join('&');
    try {
      const out = execFileSync(
        'curl.exe',
        [
          '-sS', '--max-time', '60', '-X', 'POST', '-d', body,
          'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
        ],
        { maxBuffer: 32 * 1024 * 1024 }
      ).toString('utf8');
      const json = JSON.parse(out.replace(/^\uFEFF/, ''));
      for (const d of json?.response?.publishedfiledetails ?? []) {
        if (d?.preview_url) map.set(String(d.publishedfileid), d.preview_url);
      }
    } catch (e) {
      console.error(`  工坊接口这一批失败（${chunk.length} 个）：${e.message}`);
    }
  }
  return map;
}

const withId = slugs.map((slug) => ({ slug, id: workshopIdOf(slug) })).filter((x) => x.id);
console.log(
  `${slugs.length} 张地图，其中 ${withId.length} 张有工坊 ID` +
    `　→ ${path.relative(ROOT, OUT_DIR)}/<slug>/${NAME}.<ext>${DRY ? '（dry run）' : ''}`
);

const previews = fetchPreviewUrls([...new Set(withId.map((x) => x.id))]);
console.log(`工坊接口返回预览图：${previews.size} / ${new Set(withId.map((x) => x.id)).size} 张`);

let saved = 0;
let skipped = 0;
let missing = 0;
let failed = 0;
let bytes = 0;

for (const { slug, id } of withId) {
  const url = previews.get(id);
  if (!url) {
    missing++;
    continue;
  }
  if (!FORCE && existingLocal(slug)) {
    skipped++;
    continue;
  }
  if (DRY) {
    saved++;
    continue;
  }
  try {
    const buf = execFileSync('curl.exe', ['-sS', '--max-time', '45', url], { maxBuffer: 32 * 1024 * 1024 });
    const format = detectImageFormat(buf);
    if (!format) throw new Error('不是 webp/jpg/png（可能下到了占位图）');
    const dir = path.join(OUT_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    /* 换过格式时先清掉旧的同名文件，免得同一个 slug 下留两份 */
    const prev = existingLocal(slug);
    if (prev && path.basename(prev) !== `${NAME}.${format}`) fs.rmSync(prev, { force: true });
    fs.writeFileSync(path.join(dir, `${NAME}.${format}`), buf);
    saved++;
    bytes += buf.length;
    if (saved % 25 === 0) process.stdout.write(`\r  已保存 ${saved} 张   `);
  } catch (e) {
    failed++;
    if (failed <= 5) console.error(`  ${slug}: ${e.message}`);
  }
}
process.stdout.write('\n');
console.log(
  `✓ 保存 ${saved} 张（${(bytes / 1048576).toFixed(1)} MB）` +
    `，跳过已有 ${skipped}，工坊没给图 ${missing}，失败 ${failed}`
);
if (!DRY && saved) {
  console.log('接着跑：node scripts/gallery/upload-gallery.mjs　（传到 R2 并写清单）');
}
