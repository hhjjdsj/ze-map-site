#!/usr/bin/env node
/**
 * 把地形分片上传到 Cloudflare R2（增量）。
 *
 * 为什么需要它：`terr/*.bin` 有 322 MB / 546 个文件，曾经占仓库体积的 97%，
 * 而且每次重烘焙都会改写一批 —— git 会把旧版本永久留在历史里，几轮下来就逼近 5 GB 软上限。
 * 2026-10-04 起烘焙产物写到仓库外的 `bake/terr`，由这个脚本送到 R2，
 * 页面从 https://terr.ze-map.cn/terr/<工坊ID>.bin 取（基址见 preview.astro）。
 * 方案与取舍见 docs/r2-migration.md（结论：只搬 terr，entity 留在仓库，因为它是构建输入）。
 *
 * 用法：
 *   npm run terr:upload -- --dry        # 只看要传哪些，不真传（不需要凭证）
 *   npm run terr:upload                 # 增量上传（只传新增/变化的）
 *   npm run terr:upload -- --all        # 全量重传（546 个）
 *
 * 凭证（放本地 .env.r2，已在 .gitignore 里）：
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   CLOUDFLARE_API_TOKEN=...        # 权限：Account → Workers R2 Storage → Edit
 *   R2_BUCKET=ze-map-terr           # 可选，默认 ze-map-terr
 *
 * 上传走 `npx wrangler r2 object put`（Cloudflare 官方 CLI，签名交给它，不自己搓 SigV4）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = process.env.TERR_SRC || process.env.TERR_OUT || path.join(ROOT, 'bake/terr');
const STATE_FILE = path.join(ROOT, '.r2-terr-state.json'); // 本地状态，不入库
const MANIFEST_FILE = path.join(ROOT, 'data/terr-manifest.json'); // 入库：页面要靠它数「多少张有地形」
/*
 * ⚠️ 这个值**不能有空格**：Windows 上 spawn `.cmd` 必须走 shell（见下面 put()），
 * 而 Node 在 shell 模式下只把参数拼成字符串、不转义，带空格的值会被拆成好几个参数，
 * 报出来是「Unknown argument: immutable」这种莫名其妙的错。
 * Cache-Control 值里不加空格是合法的，所以这里直接写紧凑形式。
 */
const CACHE_CONTROL = 'public,max-age=31536000,immutable';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
/** 只写地形清单、不上传：迁移前先让 preview.astro 能数出张数时用 */
const MANIFEST_ONLY = args.includes('--manifest-only');
const CONCURRENCY = 4;

/* ---------- .env.r2（有就用，没有就走系统环境变量） ---------- */
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

/* ---------- 收集待传文件 ---------- */
if (!fs.existsSync(SRC_DIR)) {
  console.error(`✗ 找不到分片目录：${SRC_DIR}`);
  console.error('  （迁移完成后它应该在仓库外的 bake/terr —— 用 TERR_SRC=<dir> 指定）');
  process.exit(1);
}
const files = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.bin'))
  .sort();

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { files: {} };
const pending = [];
let skipped = 0;
let bytes = 0;
for (const name of files) {
  const full = path.join(SRC_DIR, name);
  const st = fs.statSync(full);
  const prev = state.files?.[name];
  bytes += st.size;
  if (!ALL && prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    skipped++;
    continue;
  }
  pending.push({ name, full, size: st.size, mtimeMs: st.mtimeMs });
}

console.log(`分片目录：${path.relative(ROOT, SRC_DIR)}`);
console.log(`共 ${files.length} 个分片 / ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`待上传 ${pending.length} 个（跳过未变化的 ${skipped} 个）${DRY ? ' —— dry run，不会真的上传' : ''}`);

if (DRY) {
  for (const f of pending.slice(0, 10)) console.log(`  + ${f.name}  ${(f.size / 1048576).toFixed(2)} MB`);
  if (pending.length > 10) console.log(`  …另外 ${pending.length - 10} 个`);
  process.exit(0);
}

if (MANIFEST_ONLY) {
  writeManifest(files);
  console.log(`✓ 地形清单已写入 ${path.relative(ROOT, MANIFEST_FILE)}（${files.length} 张）`);
  process.exit(0);
}

if (!ACCOUNT || !TOKEN) {
  console.error('✗ 缺少凭证：请在仓库根目录建 .env.r2（已 gitignore），写入');
  console.error('    CLOUDFLARE_ACCOUNT_ID=<账户 ID>');
  console.error('    CLOUDFLARE_API_TOKEN=<权限 Account · Workers R2 Storage · Edit 的 API Token>');
  console.error('    R2_BUCKET=ze-map-terr');
  process.exit(1);
}

/*
 * 地形清单（入库）。为什么需要：preview.astro 的「N 张带真实碰撞地形」以前靠数
 * public/terr 目录 —— 目录搬出仓库后数不到了，只能读这份清单。
 * ids 就是有地形的工坊 ID，一目了然。
 */
function writeManifest(names) {
  const ids = names.map((f) => f.replace(/\.bin$/, ''));
  fs.writeFileSync(
    MANIFEST_FILE,
    JSON.stringify({ builtAt: new Date().toISOString(), base: 'terr', count: ids.length, ids }, null, 0) + '\n'
  );
  return ids;
}

/**
 * 上传一个对象；wrangler 的签名/重试都交给它自己。
 *
 * ⚠️ Windows 上必须带 shell: true —— Node 从 v18.20 / v20.12 起不再允许直接 spawn
 * `.cmd`（GitHub Desktop 版的 npx 就是 npx.cmd），否则报 `EINVAL ... syscall: spawn`，
 * 而且是在第一个文件就炸，看起来像凭证问题，其实跟凭证无关。
 */
function put({ name, full }) {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      isWin ? 'npx.cmd' : 'npx',
      [
        '--yes', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/terr/${name}`,
        '--file', full,
        '--content-type', 'application/octet-stream',
        '--cache-control', CACHE_CONTROL,
        '--remote',
      ],
      { cwd: ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024, shell: isWin },
      (err, stdout, stderr) => resolve({ name, err, out: String(stdout || '') + String(stderr || '') })
    );
  });
}

const failed = [];
let done = 0;
const queue = [...pending];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const res = await put(item);
    done++;
    if (res.err) {
      failed.push(item.name);
      console.error(`  ✗ ${item.name}：${res.out.trim().split('\n').slice(-2).join(' ')}`);
    } else if (done % 25 === 0 || done === pending.length) {
      console.log(`  … 已上传 ${done}/${pending.length}`);
    }
    if (!res.err) state.files[item.name] = { size: item.size, mtimeMs: item.mtimeMs };
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

/*
 * 写地形清单（入库）：见 writeManifest 的说明。
 */
const ids = writeManifest(files);

console.log('');
console.log(`✓ 上传完成：成功 ${pending.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) {
  console.error(`  失败清单（重跑本命令会自动重试）：${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ' …' : ''}`);
  process.exit(1);
}
console.log(`  地形清单已写入 ${path.relative(ROOT, MANIFEST_FILE)}（${ids.length} 张）`);
console.log('  下一步：构建时设 PUBLIC_TERR_BASE=https://<R2 自定义域>，见 docs/r2-migration.md');
