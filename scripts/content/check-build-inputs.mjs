#!/usr/bin/env node
/**
 * 构建输入守卫：构建要读的文件，一个都不能被 .gitignore 挡掉。
 *
 * 为什么需要它（2026-10-09 线上构建红叉的根因）：
 *   详情页 `src/pages/maps/[...slug].astro` 里 `import entityStatus from '../../../data/entity-status.json'`，
 *   而 `data/entity-status.json` 被 `.gitignore` 的 `data/*` 规则挡住了 —— **本机有这个文件，仓库里没有**。
 *   于是本地 `npm run build` 全绿、Cloudflare 一构建就挂：
 *     [UNRESOLVED_IMPORT] Could not resolve '../../../data/entity-status.json'
 *   这类错误在任何环境都不该靠运气发现，所以在构建第一步就查。
 *
 * 判定只有一条：**这个路径会不会被 git 忽略**。
 *   - 新文件「还没提交」是正常的（下一步就提交），不报错；
 *   - 被 ignore 的文件永远提交不上去，构建时必然缺失 → 报错。
 *
 * 用法：node scripts/content/check-build-inputs.mjs（npm run build 的第一步）
 * 没装 git / 跑不了 git 时只警告，不让构建失败（CI 与 Cloudflare 都有 git，本机可能没有）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GIT = process.env.GIT_BIN || 'git';

/* 构建脚本直接读的数据文件/目录（不在 src 的 import 图里，所以单独列） */
const REQUIRED_PATHS = [
  'data/map-sizes.json',
  'data/map-dates.json',
  'data/terr-manifest.json',
  'data/entity-status.json',
  'data/research',
  'data/community',
  'data/workshop',
  'data/gallery',
  'public/entity/catalog.json',
  'public/entity/data',
  'public/images/covers',
];

/** 路径是否被 git 忽略（拿不到 git 就返回 null，调用方只警告） */
function ignored(file) {
  try {
    execFileSync(GIT, ['check-ignore', '-q', file], { cwd: ROOT, stdio: 'ignore' });
    return true; // exit 0 = 被忽略
  } catch (err) {
    if (err.status === 1) return false; // exit 1 = 没被忽略
    if (err.status === 128) return null; // 不在 git 仓库里
    if (err.code === 'ENOENT') return null; // 没装 git
    return null;
  }
}

function ignoreRule(file) {
  try {
    return execFileSync(GIT, ['check-ignore', '-v', file], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const checked = new Set();
const offenders = [];
let gitMissing = false;

function check(rel) {
  const abs = path.join(ROOT, rel);
  if (checked.has(rel) || !fs.existsSync(abs)) return;
  checked.add(rel);
  const state = ignored(rel);
  if (state === null) gitMissing = true;
  else if (state) offenders.push(rel);
}

/* 1) 源码里 import / readFile 的仓库内文件 */
const SRC_DIRS = ['src', 'scripts', 'shared'];
const CODE_EXT = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs', '.mdx', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'bake', '.tools', 'work']);
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|readFileSync\(\s*|readFile\(\s*)['"]([^'"]+)['"]/g;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full);
      continue;
    }
    if (!CODE_EXT.has(path.extname(e.name))) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('data/')) continue; // 只查仓库内的相对路径 / data 路径
      const resolved = spec.startsWith('.') ? path.resolve(path.dirname(full), spec) : path.join(ROOT, spec);
      const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue; // 仓库外，不归我们管（例如 bake/terr 走 R2）
      check(rel);
    }
  }
}
for (const d of SRC_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

/* 2) 构建脚本直接读的数据（目录取一个真实文件来试，空目录就查目录本身） */
for (const rel of REQUIRED_PATHS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`✗ 构建输入缺失：${rel}（文件/目录不存在）`);
    process.exitCode = 1;
    continue;
  }
  if (fs.statSync(abs).isDirectory()) {
    const sample = fs.readdirSync(abs).find((f) => !f.startsWith('.'));
    check(sample ? `${rel}/${sample}` : rel);
  } else {
    check(rel);
  }
}

if (gitMissing) {
  console.warn('⚠ 拿不到 git（未安装或不在仓库里），跳过「是否被 ignore」检查');
  process.exit(0);
}
if (offenders.length) {
  console.error('\n✗ 下面这些构建要读的文件被 .gitignore 挡住了 —— 本机能构建，仓库里却没有：\n');
  for (const f of offenders) {
    console.error(`    ${f}`);
    const rule = ignoreRule(f);
    if (rule) console.error(`      ↳ ${rule}`);
  }
  console.error('\n  被 ignore 的文件永远提交不上去，Cloudflare 构建会直接挂在 import 解析上。');
  console.error('  修法：在 .gitignore 里给这个文件加一条 `!路径` 白名单（参考 data/map-sizes.json、data/terr-manifest.json）。\n');
  process.exit(1);
}
console.log(`构建输入检查通过（${checked.size} 个路径，均未被 ignore）`);
