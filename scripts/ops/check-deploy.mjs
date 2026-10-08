#!/usr/bin/env node
/**
 * 推送之后，Cloudflare 到底有没有收到、有没有开始构建？
 *
 *   npm run deploy:check                # 看 main 最新提交上的 Workers Builds 状态
 *   npm run deploy:check -- --watch     # 盯着它，直到构建结束（最多 15 分钟）
 *   npm run deploy:check -- --commit 42d5796
 *
 * 为什么需要这个（2026-10-08 真实踩过）：
 *   GitHub 抽风的那 20 分钟里推了一次，远端 main 更新了、`git push` 也返回成功，
 *   但 **Cloudflare 从头到尾没收到 webhook** —— 提交上一个 check-run 都没有，
 *   线上一直是旧版。当时只能手工调 GitHub API 才分辨出「事件丢了」和「构建失败」，
 *   而这两件事的处置完全不同：
 *     · 有 check-run 但 failed  → 代码/CI 的问题，看构建日志；
 *     · 一个 check-run 都没有    → 事件丢了，去面板手动部署，或重推一次。
 *   Workers Builds 每次构建都会往提交上写一条名叫 `Workers Builds: <worker 名>` 的
 *   check-run，所以「有没有这条」就是判据。
 *
 * 不依赖任何东西：仓库地址直接读 `.git/config`（这台机器上 git 不在 PATH 里，
 * 只有 GitHub Desktop 自带的那份，所以脚本里不能调 git），提交信息走 GitHub 公开接口。
 * 仓库是 public，匿名就能查；嫌 60 次/小时的匿名限额不够，可以给个
 * `GITHUB_TOKEN=ghp_xxx npm run deploy:check`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const argOf = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const COMMIT = argOf('--commit', null);
const BRANCH = argOf('--branch', 'main');

/** 构建时间：本地 astro build 50 秒左右，CI 装依赖 + Pagefind 一般 2~4 分钟，给足余量 */
const WATCH_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 15 * 1000;

/* ---------------- 仓库地址：读 .git/config，不调 git ---------------- */

function gitDir() {
  const dot = path.join(ROOT, '.git');
  if (fs.statSync(dot).isDirectory()) return dot;
  /* worktree / submodule 里 .git 是个文件：gitdir: <路径> */
  return path.resolve(ROOT, fs.readFileSync(dot, 'utf8').replace(/^gitdir:\s*/i, '').trim());
}

function repoSlug() {
  const cfg = fs.readFileSync(path.join(gitDir(), 'config'), 'utf8');
  const block = cfg.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
  const url = block && block[1].match(/url\s*=\s*(\S+)/);
  if (!url) throw new Error('`.git/config` 里找不到 origin 地址');
  const m = url[1].match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`认不出 GitHub 仓库地址：${url[1]}`);
  return `${m[1]}/${m[2]}`;
}

/* ---------------- GitHub 公开接口 ---------------- */

async function api(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ze-map-deploy-check' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    throw new Error(
      `GitHub 匿名接口限额用完了（每小时 60 次），${new Date(reset).toLocaleTimeString('zh-CN')} 后恢复；` +
        `\n     也可以带 token：GITHUB_TOKEN=xxx npm run deploy:check`
    );
  }
  if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}：${url}`);
  return res.json();
}

const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const isBuild = (c) => /workers builds|cloudflare/i.test(c.name);

function printBuilds(builds) {
  for (const c of builds) {
    const state =
      c.status === 'completed' ? (c.conclusion === 'success' ? '✓ 成功' : `✗ ${c.conclusion}`) : `… ${c.status}`;
    console.log(`  ${c.name}  →  ${state}`);
    console.log(`     开始 ${time(c.started_at)}　结束 ${time(c.completed_at)}`);
    if (c.details_url) console.log(`     日志 ${c.details_url}`);
  }
}

function noBuildHelp(sha) {
  console.log('\n  ⚠️  这个提交上没有任何 Workers Builds 记录 —— Cloudflare **没收到这次推送事件**。');
  console.log('     远端 main 已经更新、push 也返回成功，但构建不会自己出现（webhook 被静默丢弃，');
  console.log('     GitHub 抽风时发生过一次，见 docs/deploy-and-builds.md）。处置：');
  console.log('       1) 面板手动部署：dash.cloudflare.com → Workers & Pages → ze-map-site → Deployments');
  console.log(`          → Create deployment（分支 ${BRANCH}，提交 ${sha}）`);
  console.log('       2) 或者再推一个提交重新打一次 webhook，推完再跑一遍 npm run deploy:check');
  console.log('       3) 连 Create deployment 都没有 → Settings → Builds → Git repository 重新连接仓库');
}

/* ---------------- 跑 ---------------- */

const slug = repoSlug();
const head = COMMIT
  ? await api(`https://api.github.com/repos/${slug}/commits/${COMMIT}`)
  : await api(`https://api.github.com/repos/${slug}/commits/${BRANCH}`);
const sha = head.sha.slice(0, 7);
const subject = head.commit.message.split('\n')[0];

console.log(`仓库 ${slug}　分支 ${BRANCH}`);
console.log(`提交 ${sha}  ${subject}`);
console.log(`提交时间 ${time(head.commit.committer.date)}\n`);

let builds = (await api(`https://api.github.com/repos/${slug}/commits/${head.sha}/check-runs`)).check_runs.filter(isBuild);
if (!builds.length) {
  console.log('  （没有构建记录）');
  noBuildHelp(sha);
  process.exit(0);
}
printBuilds(builds);

if (WATCH && builds.some((c) => c.status !== 'completed')) {
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    builds = (await api(`https://api.github.com/repos/${slug}/commits/${head.sha}/check-runs`)).check_runs.filter(isBuild);
    const snapshot = builds.map((c) => `${c.status}/${c.conclusion}`).join(',');
    if (snapshot !== last) {
      last = snapshot;
      console.log(`  [${new Date().toLocaleTimeString('zh-CN')}] ${snapshot}`);
    }
    if (builds.every((c) => c.status === 'completed')) break;
  }
  console.log('');
  printBuilds(builds);
}

const failed = builds.filter((c) => c.status === 'completed' && c.conclusion !== 'success');
if (failed.length) {
  console.log('\n  ✗ 构建失败：打开上面的日志链接看卡在哪一步（多半是内容校验脚本拦下来的）。');
  process.exit(1);
}
if (builds.every((c) => c.status === 'completed')) {
  console.log('\n  ✓ 构建成功。线上生效还要几分钟，刷新前先 Ctrl+F5（Cloudflare 会缓存 HTML）。');
} else {
  console.log('\n  … 还在构建中，加 --watch 可以盯到结束。');
}
