#!/usr/bin/env node
/**
 * 校验人工封面目录 public/images/covers/custom/。
 *
 *   node scripts/content/verify-covers.mjs
 *
 * 为什么需要单独校验：
 * 这个目录里的图是**按文件名**生效的 —— 生成器只会去找
 * `public/images/covers/custom/<地图英文名>.<webp|png|jpg|jpeg>`，
 * 名字差一个字符（比如把 ze_obj_abyss_v2 写成 ze_obj_abyss、或者用了 Steam 分片名
 * 2001-ze_obj_abyss_v2-3779264454）这张图就**永远不会出现**，
 * 而构建、CI、页面全部正常 —— 又是一次「改动静默消失」。
 * 所以这里第一个检查就是：文件名对不对得上某张真实存在的地图。
 *
 * 2026-09-25 补两条与「大小写」有关的检查：生成器改成**大小写不敏感**找图之后，
 * 大写扩展名不再静默失效（这里只提醒统一小写），但「仅大小写不同的两个同名文件」
 * 必须按错误拦下 —— 那种情况不同系统上表现不一致（见下方注释）。
 *
 * 尺寸读取不引第三方库：sharp 只是 astro 的传递依赖，校验脚本不该依赖它
 * （哪天 astro 换了实现，CI 就会莫名其妙挂掉）。解析逻辑现在是
 * shared/image-size.mjs —— Worker 端上传封面时用的是同一份，避免两处漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from '../../shared/image-size.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/images/covers/custom');
/** 工坊预览图当封面用的目录（import-workshop-covers.mjs 的产物，机器生成、不走人工提交流程） */
const WORKSHOP_DIR = path.join(ROOT, 'public/images/covers/workshop');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const RESEARCH_DIR = path.join(ROOT, 'data/research');

const ALLOWED_EXT = ['webp', 'png', 'jpg', 'jpeg'];
/** 生成器取图的顺序，同一张图有多个格式时只有第一个生效 */
const PICK_ORDER = ['webp', 'png', 'jpg', 'jpeg'];

const MAX_BYTES = 800 * 1024; // 超过就是仓库负担，且页面加载会变慢
const WARN_BYTES = 300 * 1024;
const MIN_WIDTH = 640; // 详情页顶部当满宽背景用，太小会糊
const RATIO_TOLERANCE = 0.15; // 与 16:9 的偏差超过 15% 提醒一下

const errors = [];
const warns = [];

/* 尺寸解析在 shared/image-size.mjs（Worker 上传封面时用同一份） */

if (!fs.existsSync(DIR)) {
  console.log('人工封面目录还不存在（public/images/covers/custom/）——没事，没有人工封面而已');
  process.exit(0);
}

/*
 * 说明文件跟封面放在同一个目录，是故意的：GitHub 浏览目录时会把该目录的 README.md
 * 渲染在文件列表下面，正好拦住「想换封面 → 点进渲染目录 → 换错地方」这个常见误会。
 * 所以校验时要跳过它们，不能当成「不支持的格式」。
 */
const isDoc = (f) => /\.(md|txt)$/i.test(f);
const files = fs.readdirSync(DIR).filter((f) => !f.startsWith('.') && !isDoc(f));
const bySlug = new Map(); // slug 小写 → Set(扩展名小写)，用于「同一张图存了多种格式」的提醒
const byKey = new Map(); // `<slug 小写>.<扩展名小写>` → 真实文件名[]，用于抓「仅大小写不同」的重名

for (const file of files) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const slug = path.basename(file, path.extname(file));
  const full = path.join(DIR, file);
  const size = fs.statSync(full).size;
  const kb = (size / 1024).toFixed(0);

  if (!ALLOWED_EXT.includes(ext)) {
    errors.push(`${file}: 不支持的格式 .${ext}（只能用 ${ALLOWED_EXT.join(' / ')}）`);
    continue;
  }

  /* 扩展名大小写：生成器现在按大小写不敏感找图，所以大写**不会**再静默失效
     （以前会：文件在仓库里、页面永远不显示，而这里把扩展名转小写后照样判它合法）。
     因此只提醒、不报错；线上构建在 Linux 上、文件名大小写敏感，小写最不容易出错。 */
  const rawExt = path.extname(file).slice(1);
  if (rawExt !== ext) {
    warns.push(`${file}: 扩展名建议改成小写（.${ext}）—— 构建在 Linux 上，文件名大小写敏感，小写最稳`);
  }

  // 第一条也是最重要的一条：文件名必须是一张真实存在的地图
  if (!fs.existsSync(path.join(MAPS_DIR, `${slug}.mdx`)) && !fs.existsSync(path.join(RESEARCH_DIR, `${slug}.json`))) {
    const looksLikeEntity = /^\d+-[a-zA-Z0-9_]+-\d+$/.test(slug);
    errors.push(
      `${file}: 找不到叫「${slug}」的地图，这张图永远不会显示。` +
        (looksLikeEntity
          ? '（这是 Steam 分片名，文件名要用地图英文名，例如 ze_obj_abyss_v2）'
          : '（文件名必须正好等于地图英文名，拼错一个字符就不生效）')
    );
  }

  if (size > MAX_BYTES) {
    errors.push(
      `${file}: ${kb} KB，太大了（上限 ${MAX_BYTES / 1024} KB）。` +
        `截图存成 PNG 往往就是这么肥（同一张图转 webp 通常只有 1/10）。` +
        `本机有仓库的话跑 npm run cover:set -- <地图英文名> <这张图> 会自动压好；` +
        `或者用看图工具另存为 JPG（画质 80 左右）再传。`
    );
  } else if (size > WARN_BYTES) {
    warns.push(`${file}: ${kb} KB，偏大（建议 300 KB 以内）`);
  }

  const dim = imageSize(fs.readFileSync(full));
  if (!dim) {
    warns.push(`${file}: 读不出尺寸，跳过了比例检查`);
  } else {
    const ratio = dim.w / dim.h;
    const target = 16 / 9;
    const off = Math.abs(ratio - target) / target;
    if (off > RATIO_TOLERANCE) {
      const shape = ratio < target ? '偏竖' : '偏宽';
      warns.push(
        `${file}: ${dim.w}×${dim.h}（${ratio.toFixed(2)}:1，${shape}，标准是 16:9）——` +
          `卡片和顶部背景会按 16:9 裁切，主体太靠边可能被切掉`
      );
    }
    if (dim.w < MIN_WIDTH) {
      warns.push(`${file}: 宽度只有 ${dim.w}px（建议 ${MIN_WIDTH}px 以上），详情页顶部当大图用会糊`);
    }
  }

  const slugKey = slug.toLowerCase();
  if (!bySlug.has(slugKey)) bySlug.set(slugKey, new Set());
  bySlug.get(slugKey).add(ext);
  const key = `${slugKey}.${ext}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(file);
}

// 同一张图存了多种格式：只有靠前的那个生效，其余的纯属占仓库
for (const [slug, exts] of bySlug) {
  if (exts.size > 1) {
    const winner = PICK_ORDER.find((e) => exts.has(e));
    warns.push(`${slug}: 同时有 ${[...exts].join(' / ')}，实际只用 .${winner}，其余的可以删掉`);
  }
}

/* 仅大小写不同的同名文件必须拦下来：Linux 上这是两个文件、Windows / macOS 上会互相覆盖，
   而线上取哪个取决于构建平台（现在是 Linux）—— 结果就是「本地看着对、线上是另一张」。
   生成器虽然会确定性地挑一个（取排序靠前的），但贡献者显然不是这个意思，按错误处理。 */
for (const [key, names] of byKey) {
  if (names.length > 1) {
    errors.push(
      `${key}: 有 ${names.length} 个仅大小写不同的文件（${names.join(' / ')}）—— 只保留一个，` +
        `否则不同系统上表现不一致（Windows / macOS 会互相覆盖，Linux 上是两个文件）`
    );
  }
}

const total = files.length;
console.log(`人工封面 ${total} 张${total ? `（${[...bySlug.keys()].slice(0, 5).join('、')}${bySlug.size > 5 ? ' 等' : ''}）` : ''}`);
console.log(`  → 其中会覆盖渲染图的：${bySlug.size} 张`);

/*
 * 工坊封面（public/images/covers/workshop/）：机器从 bake/gallery 导进来的作者预览图，
 * 是**封面优先级第 2 层**（人工封面 > 工坊图 > 渲染图）。
 * 规矩比人工封面简单，但也得拦两件事：文件名对不上地图（永远不会生效）、
 * 以及有人工封面时那张纯属占地方。
 * wsSlugs 在外面声明：下面核「封面有没有真的落到页面上」要用同一份名单。
 */
const wsSlugs = new Set();
if (fs.existsSync(WORKSHOP_DIR)) {
  const wsFiles = fs.readdirSync(WORKSHOP_DIR).filter((f) => !f.startsWith('.') && !isDoc(f));
  for (const file of wsFiles) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const slug = path.basename(file, path.extname(file));
    if (!ALLOWED_EXT.includes(ext)) {
      errors.push(`workshop/${file}: 不支持的格式 .${ext}`);
      continue;
    }
    if (!fs.existsSync(path.join(MAPS_DIR, `${slug}.mdx`))) {
      errors.push(`workshop/${file}: 找不到叫「${slug}」的地图，这张封面永远不会生效`);
      continue;
    }
    const wsSlug = slug.toLowerCase();
    if (wsSlugs.has(wsSlug)) errors.push(`workshop/${file}: 同一个 slug 出现了两次`);
    wsSlugs.add(wsSlug);
    if (bySlug.has(wsSlug)) {
      warns.push(
        `workshop/${file}: 这张图有人工封面（custom/），工坊图不会生效，可以删掉（--prune 会清）`
      );
    }
  }
  console.log(`工坊封面 ${wsFiles.length} 张（作者上传的预览图，555×312 为主）`);
  console.log(`  → 封面构成：人工 ${bySlug.size} · 工坊 ${wsSlugs.size} · 其余用渲染图`);
}

/*
 * 封面层级到底有没有落到页面上。
 * 2026-10-08 的教训：手写正文的三张图（魔晄炉 / 米纳斯 / 黑珍珠号）frontmatter 是写正文那天
 * 冻结的，生成器当时只补正文、不补 cover —— 于是「仓库里有作者工坊图 / 有人工封面」和
 * 「页面上挂着黑底密度点图」同时成立；那张兜底图叠在详情页顶部只有 22% 透明度，
 * 看上去就是「这张图没有封面」，而构建、CI、这个脚本当时全是绿的。
 * 现在生成器每轮都按层级重写这三页的 cover 行，这里再独立核一遍：
 * 指向的封面文件必须在，且**磁盘上有更好的那层时不能还指着渲染图**。
 */
const coverTierOf = (rel) =>
  rel.includes('/covers/custom/') ? 'custom'
  : rel.includes('/covers/workshop/') ? 'workshop'
  : rel.includes('/covers/') ? 'render'
  : 'other';
const tierCount = { custom: 0, workshop: 0, render: 0, other: 0, none: 0 };
const staleCovers = [];
const fallbackOnly = [];
for (const f of fs.readdirSync(MAPS_DIR).filter((x) => x.endsWith('.mdx'))) {
  const slug = f.replace(/\.mdx$/, '');
  const rel = (/^cover:\s*"?([^"\r\n]+?)"?\s*$/m.exec(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8')) || [])[1];
  if (!rel) {
    tierCount.none++;
    fallbackOnly.push(slug);
    continue;
  }
  const tier = coverTierOf(rel);
  tierCount[tier]++;
  if (!fs.existsSync(path.join(ROOT, 'public', rel))) {
    errors.push(`${f}: cover 指的 ${rel} 不存在（页面会没有封面图）`);
  }
  const lower = slug.toLowerCase();
  const better = bySlug.has(lower) ? '人工封面' : wsSlugs.has(lower) ? '工坊预览图' : null;
  if (tier === 'render' && better) {
    staleCovers.push(`${slug}: cover 还指着渲染图（${rel}），但 public/images/covers/ 里已经有${better}了`);
  }
  if (tier === 'render' || tier === 'none') fallbackOnly.push(slug);
}
if (staleCovers.length) {
  errors.push(
    ...staleCovers.map((s) => `${s} —— 跑 npm run maps:generate 让它按层级重算（手写正文条目的 cover 行由生成器改写）`)
  );
}
console.log(
  `页面封面：人工 ${tierCount.custom} · 工坊 ${tierCount.workshop} · 渲染兜底 ${tierCount.render}` +
    (tierCount.none ? ` · 没有 cover 行 ${tierCount.none}` : '')
);
/* 渲染兜底图是**黑底彩色点**的俯视密度图，当封面约等于没有。这些图基本是工坊条目
   已被作者删除（Steam 接口 result=9），拿不到作者截图，属于已知的、无害的短板：
   只在有人真去补图时才需要看这份名单，所以按提醒列出、不判错。 */
if (fallbackOnly.length) {
  warns.push(
    `仍在用渲染兜底图的 ${fallbackOnly.length} 张（黑底点位图，视觉上≈没有封面，多为工坊条目已被删除）：` +
      fallbackOnly.slice(0, 24).join('、') +
      (fallbackOnly.length > 24 ? ` 等 ${fallbackOnly.length} 张` : '')
  );
}

if (warns.length) {
  console.log(`\n⚠️  提醒 ${warns.length} 条：`);
  for (const w of warns.slice(0, 20)) console.log('   - ' + w);
  if (warns.length > 20) console.log(`   … 另有 ${warns.length - 20} 条`);
}

if (errors.length) {
  console.log(`\n❌ 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 30)) console.log('   - ' + e);
  console.log('\n人工封面放在 public/images/covers/custom/，文件名 = <地图英文名>.<webp|png|jpg>');
  console.log('地图英文名 = 地图页副标题那串（例如 ze_obj_abyss_v2），不是 Steam 分片名。');
  process.exit(1);
}

console.log('\n✅ 人工封面校验通过');
