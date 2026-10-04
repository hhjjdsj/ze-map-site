#!/usr/bin/env node
/**
 * PR 检查：地图条目（src/content/maps/*.mdx）是不是被**手改**了。
 *
 * 为什么不是「构建后 MDX 有任何变化就红」：
 *   MDX 是脚本从 data/research/*.json 打印出来的成品，但 Cloudflare 构建时会**重新生成**，
 *   所以「只改资料、不交 MDX」的 PR 线上结果完全正确 —— 那种 PR 恰恰是最该欢迎的
 *   （网页上改一个 JSON 就能投稿）。旧判定把这类 PR 全判红，2026-09-28 有贡献者连着两个 PR
 *   卡在这上面，而且提示写的是「必须由脚本生成并提交」，看的人只会更懵。
 *   烘焙管线批量更新分片/索引时也会让 MDX 变（资料没动），同样被误伤。
 *
 * 所以现在只拦一件事：
 *   **这次 PR 动了 MDX，却没有同时动 data/research/ 或烘焙产物** → 那是手改生成物，红。
 *   其它情况（只改资料、烘焙重新生成、资料与 MDX 一起交但忘了重新生成）只提示
 *   「仓库里的打印稿落后了，构建时会重生成」并放行。
 *
 * 用法：
 *   node scripts/content/check-mdx-drift.mjs                 # CI：自动取 GITHUB_BASE_REF
 *   node scripts/content/check-mdx-drift.mjs --base HEAD~1   # 本地：拿某次提交当「PR 基线」
 *
 * 前置：必须在 `npm run build`（会重新生成 MDX）之后跑，否则看不到漂移。
 */
import { execFileSync } from 'node:child_process';

/* git 可执行文件：CI（ubuntu）上就是 `git`；Windows 开发机常常只有 GitHub Desktop 内置的那份，
   没在 PATH 里，这时用 GIT_BIN 指过去：GIT_BIN="C:\...\git.exe" node scripts/content/check-mdx-drift.mjs */
const GIT = process.env.GIT_BIN || 'git';

/**
 * 跑 git。
 * ⚠️ 失败**绝不静默**：这个脚本的第一版用 try/catch 吞掉所有错误，结果本机 git 不在 PATH 时
 * 它把「跑不了 git」当成「没有漂移」，打印「地图条目与资料一致 ✅」—— 检查形同虚设。
 * 所以这里把「git 起不来」和「git 正常返回但输出为空」分开：前者直接报错退出（exit 2）。
 */
function git(...args) {
  try {
    return { ok: true, out: execFileSync(GIT, args, { encoding: 'utf8' }).trim() };
  } catch (err) {
    return { ok: false, out: '', err };
  }
}

const inActions = Boolean(process.env.GITHUB_ACTIONS);
const announce = (level, message) => console.log(inActions ? `::${level}::${message}` : `[${level}] ${message}`);

/* ---------- 1. 构建后的漂移：committed MDX ≠ 重新生成的结果 ---------- */
const status = git('status', '--porcelain', '--', 'src/content/maps');
if (!status.ok) {
  announce('error', `跑不了 git（${GIT}）：${status.err?.message ?? status.err}`);
  if (status.err?.code === 'ENOENT') {
    console.log('本地请把 git 加进 PATH，或用 GIT_BIN 指定：GIT_BIN=/path/to/git node scripts/content/check-mdx-drift.mjs');
  }
  process.exit(2);
}
const driftRaw = status.out;
if (!driftRaw) {
  console.log('地图条目与资料一致 ✅');
  process.exit(0);
}
const drift = driftRaw
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

/* ---------- 2. 这次 PR 动了哪些文件（相对基线） ---------- */
const argBase = process.argv.indexOf('--base');
const baseArg = argBase >= 0 ? process.argv[argBase + 1] : '';
const baseRef = baseArg || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
const baseSha = git('merge-base', 'HEAD', baseRef).out || git('rev-parse', baseRef).out;

let changed = [];
if (!baseSha) {
  /* 拿不到基线（本地没 fetch、或 detached 得很干净）时不误伤：只提示，不判红 */
  announce('warning', `拿不到基线 ${baseRef}，跳过「手改」判定；本次只提示 MDX 漂移。`);
} else {
  changed = git('diff', '--name-only', baseSha, 'HEAD')
    .out.split('\n')
    .filter(Boolean);
}

const touchedMdx = changed.filter((f) => /^src\/content\/maps\/.*\.mdx$/.test(f));
const touchedResearch = changed.filter((f) => /^data\/research\/.*\.json$/.test(f));
/* 烘焙产物：实体/地形分片、索引、烘焙记录 —— 它们一变，MDX 就会被批量重新生成 */
const touchedBake = changed.filter(
  (f) =>
    f.startsWith('public/entity/') ||
    f.startsWith('scripts/terr-bake/data/') ||
    f === 'data/map-dates.json'
);
/*
 * 生成器 / 站点脚本：改了 scripts/ 下的东西，条目本来就该重新生成 ——
 * 例：2026-09-30 的正文信息层级重排（只调段落顺序），548 个条目全变、资料一个没动。
 * 这类改动与「手改生成物」在结果上一样（MDX 变了、research 没变），意图却完全不同，
 * 所以按「有正当理由」放行 + 提示，不判红。
 */
const touchedScripts = changed.filter((f) => f.startsWith('scripts/'));

/* ---------- 3. 判定 ---------- */
const handEdited =
  baseSha &&
  touchedMdx.length > 0 &&
  touchedResearch.length === 0 &&
  touchedBake.length === 0 &&
  touchedScripts.length === 0;

console.log(`构建后有 ${drift.length} 个地图条目与资料不一致：`);
for (const line of drift.slice(0, 20)) console.log(`  ${line}`);
if (drift.length > 20) console.log(`  …共 ${drift.length} 个`);

if (handEdited) {
  announce(
    'error',
    '修改了「自动生成」的地图条目，却没改对应的资料文件 —— 这些改动会在下次 npm run maps:generate 时被整段覆盖。'
  );
  console.log('');
  console.log('受影响的条目（本次 PR 改过、且与资料对不上）：');
  for (const f of touchedMdx) console.log(`  ${f}`);
  console.log('');
  console.log('正确做法：改 data/research/<地图英文名>.json（原稿），需要时再跑 npm run maps:generate。');
  console.log('src/content/maps/*.mdx 是机器从原稿打印出来的成品，手改它等于白改。');
  process.exit(1);
}

announce(
  'warning',
  '仓库里的地图条目已落后于资料（不影响线上：构建时会用资料重新生成）。想让打印稿同步，本地跑一次 npm run maps:generate 再提交即可。'
);
if (!baseSha) console.log(`（基线 ${baseRef} 不可用，本次未判定是否为手改）`);
else if (touchedResearch.length) console.log(`本次 PR 改了 ${touchedResearch.length} 份资料，条目随之重新生成 —— 正常。`);
else if (touchedBake.length) console.log(`本次 PR 改了烘焙产物（${touchedBake.length} 个），条目随之重新生成 —— 正常。`);
else if (touchedScripts.length) console.log(`本次 PR 改了生成器 / 脚本（${touchedScripts.length} 个），条目随之重新生成 —— 正常。`);
process.exit(0);
