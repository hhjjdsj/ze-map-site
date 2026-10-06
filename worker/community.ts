/**
 * 把审核通过的投稿写回 GitHub 仓库（data/community/<slug>.json）。
 *
 * 为什么绕一圈写 git，而不是直接读 D1：
 *   1. 构建必须「可离线重跑」—— 之前两次线上构建失败，教训就是不要让构建依赖运行时环境；
 *      内容在仓库里，构建就是纯本地的。
 *   2. git 自带版本历史：谁改的、什么时候、改前是什么，`git log` 就是内容变更史。
 *   3. 出问题 `git revert` 一下就回去了，不需要自己实现回滚。
 *
 * 需要的 secret：GITHUB_TOKEN（细粒度 PAT，只授权本仓库、只给 Contents: Read and write）
 */

import { normalizeDoc } from '../shared/community-doc.mjs';
import type { Env } from './http';

const DEFAULT_REPO = 'hhjjdsj/ze-map-site';
const DEFAULT_BRANCH = 'main';
const DEFAULT_API = 'https://api.github.com';

export class GitError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

const repo = (env: Env) => env.GITHUB_REPO || DEFAULT_REPO;
const branch = (env: Env) => env.GITHUB_BRANCH || DEFAULT_BRANCH;
const apiBase = (env: Env) => (env.GITHUB_API_BASE || DEFAULT_API).replace(/\/+$/, '');

export const communityPath = (slug: string) => `data/community/${slug}.json`;

/* ===== base64（Workers 的 btoa 只吃 latin1，中文必须自己转） ===== */

function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ===== GitHub REST ===== */

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    throw new GitError('缺少 GITHUB_TOKEN，无法读写仓库（见 docs/community-editing-plan.md 第 9 节）', 503);
  }
  return fetch(apiBase(env) + path, {
    ...init,
    headers: {
      'user-agent': 'ze-map-site-worker',
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...((init.headers as Record<string, string>) || {}),
    },
  });
}

export interface CommunityFile {
  doc: ReturnType<typeof normalizeDoc>;
  /** 文件当前的 blob sha；文件不存在时为 null（新建） */
  sha: string | null;
}

/** 读社区文档；文件不存在返回空文档（不是错误） */
export async function readCommunityDoc(env: Env, slug: string): Promise<CommunityFile> {
  const res = await gh(
    env,
    `/repos/${repo(env)}/contents/${communityPath(slug)}?ref=${encodeURIComponent(branch(env))}`
  );  if (res.status === 404) return { doc: normalizeDoc(slug, null), sha: null };
  if (!res.ok) throw new GitError(`读取仓库文件失败（HTTP ${res.status}）`, 502);

  const data = (await res.json()) as { content?: string; sha?: string };
  let parsed: unknown = null;
  if (data.content) {
    try {
      parsed = JSON.parse(fromBase64Utf8(data.content));
    } catch {
      // 文件被改坏了也别让整条链路炸：当成空文档，本次审核会把它重写成合法结构
      parsed = null;
    }
  }
  return { doc: normalizeDoc(slug, parsed), sha: data.sha ?? null };
}

/**
 * 一次读多份社区文档（按 slug 批量）。
 *
 * 为什么要批量：Workers 免费版**单次调用最多 50 个子请求**（fetch 出去一次算一个），
 * 而「写回仓库」以前是每张图一次 GET —— 十几条投稿就能把额度吃光，
 * 线上表现是 HTTP 500「Too many subrequests by single Worker invocation」（2026-10-06 实遇）。
 * 目录接口一次就能把所有文件的 base64 内容带回来（每份文档才 1~3 KB），
 * 于是 N 次读完变成 1 次；目录里没带内容的再按单个文件补读。
 */
export async function readCommunityDocs(
  env: Env,
  slugs: string[]
): Promise<Map<string, CommunityFile>> {
  const out = new Map<string, CommunityFile>();
  const want = new Set(slugs.filter(Boolean));
  if (!want.size) return out;

  let listed: Array<{ name?: string; content?: string; sha?: string }> = [];
  try {
    const res = await gh(
      env,
      `/repos/${repo(env)}/contents/data/community?ref=${encodeURIComponent(branch(env))}`
    );
    if (res.ok) {
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) listed = data as typeof listed;
    }
  } catch {
    /* 目录读不到就退化成逐文件读（下面那段） */
  }

  for (const f of listed) {
    const m = /^(.+)\.json$/.exec(String(f.name ?? ''));
    if (!m || !want.has(m[1]) || !f.content) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fromBase64Utf8(f.content));
    } catch {
      parsed = null;      // 坏文件当空文档，写回时会重写成合法结构
    }
    out.set(m[1], { doc: normalizeDoc(m[1], parsed), sha: f.sha ?? null });
  }

  for (const slug of want) {
    if (out.has(slug)) continue;
    out.set(slug, await readCommunityDoc(env, slug));
  }
  return out;
}

/**
 * 写入社区文档并提交。
 * 用 contents API 的 sha 做乐观并发：拿到的 sha 过期时 GitHub 会拒绝，
 * 我们上抛 409 让审核员重试 —— D1 里的投稿还在，不会丢数据。
 */
export async function writeCommunityDoc(
  env: Env,
  slug: string,
  doc: unknown,
  message: string,
  /**
   * 调用方读文件时拿到的 blob sha。
   * 不传会自己再读一次（方便单独调用），但**审核流程必须传**：
   * 否则「读 → 改 → 写」之间多出一次读，期间别人改了文件就会被静默覆盖。
   */
  knownSha?: string | null
): Promise<{ sha: string; created: boolean }> {
  const currentSha = knownSha === undefined ? (await readCommunityDoc(env, slug)).sha : knownSha;
  const body = JSON.stringify(doc, null, 2) + '\n';

  const res = await gh(env, `/repos/${repo(env)}/contents/${communityPath(slug)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(body),
      branch: branch(env),
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    throw new GitError('仓库里的这个文件刚刚被改动过，请刷新后重试', 409);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `写回仓库失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }

  const data = (await res.json()) as { commit?: { sha?: string } };
  return { sha: data.commit?.sha ?? '', created: !currentSha };
}

/* ===== 二进制文件（投稿封面图）=====
 *
 * ⚠️ 2026-10-05 起投稿封面也走 `commitFiles()`（审核台「写回仓库」时与文档改动合成一个 commit），
 *   本节的 `commitCoverToRepo()` 与它下面用到的 contents API 助手（`writeRepoBinary` /
 *   `deleteRepoFile` / `listRepoDir` / `repoFileSha`）**目前没有调用方**，保留仅作参考实现。
 *   别把封面写回改回单文件 contents API —— 那会为一张图多产生一次提交与一次重建。
 *
 * 当初选 contents API 而不是 Git Data API 的理由（当时封面是审核通过即写回）：
 *   封面上限 700 KB（见 worker/covers.ts 的说明），base64 后约 960 KB，
 *   在 contents API 的承受范围内；换成 blob/tree/commit/ref 四步反而更长、
 *   还丢掉「按 sha 做乐观并发」这个现成的保护。
 */

export interface RepoFileEntry {
  name: string;
  path: string;
  sha: string;
}

/** 列目录（contents API 返回数组）。目录不存在返回空数组，不算错误。 */
export async function listRepoDir(env: Env, dir: string): Promise<RepoFileEntry[]> {
  const res = await gh(env, `/repos/${repo(env)}/contents/${dir}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new GitError(`读取仓库目录失败（HTTP ${res.status}）`, 502);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && e.type === 'file')
    .map((e) => ({ name: String(e.name), path: String(e.path), sha: String(e.sha) }));
}

/** 取单个文件的 blob sha；不存在返回 null */
export async function repoFileSha(env: Env, path: string): Promise<string | null> {
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GitError(`读取仓库文件失败（HTTP ${res.status}）`, 502);
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? null;
}

/** 写一个二进制文件（新建或覆盖） */
export async function writeRepoBinary(
  env: Env,
  path: string,
  bytes: Uint8Array,
  message: string
): Promise<{ sha: string; created: boolean }> {
  const currentSha = await repoFileSha(env, path);
  let bin = '';
  const CHUNK = 0x8000; // 一次展开太多会爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const content = btoa(bin);

  const res = await gh(env, `/repos/${repo(env)}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content,
      branch: branch(env),
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    throw new GitError('仓库里的这个文件刚刚被改动过，请刷新后重试', 409);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `写回仓库失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }
  const data = (await res.json()) as { commit?: { sha?: string } };
  return { sha: data.commit?.sha ?? '', created: !currentSha };
}

/** 删一个文件（换封面时清掉同名的其它扩展名）。文件不存在视为成功。 */
export async function deleteRepoFile(env: Env, path: string, message: string): Promise<boolean> {
  const sha = await repoFileSha(env, path);
  if (!sha) return false;
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: branch(env) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `删除仓库文件失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }
  return true;
}

/* ===== 一次提交多个文件（攒批写回）=====
 *
 * 为什么需要它：contents API 一次只能动一个文件、一次提交一个文件 ——
 * 审核通过 20 条投稿就是 20 次提交、20 次 Cloudflare 重建（免费版每月 3000 构建分钟）。
 * 攒批之后：一次 flush = **一个 commit**（不管涉及多少张图、多少个文件），
 * 于是无论攒了多少条，都只触发一次重建。
 *
 * 用 Git Data API 的五步：读 ref → 读 commit 的 tree → 建 tree（带 base_tree）
 * → 建 commit → 更新 ref。tree 里可以直接内联文本内容（不必先建 blob），
 * 二进制（封面图）先建 blob 再引用 sha；删除则把 sha 设成 null。
 *
 * 并发保护：更新 ref 时 force=false，main 被别人推过就报 422 → 这里重试整轮
 * （重新读 ref、重建 tree/commit），最多 3 次。重试是安全的，因为我们每次都是从
 * 最新的 head 重新组装整棵树。
 */

export interface CommitFile {
  path: string;
  /** 文本内容（UTF-8）；与 base64 二选一 */
  text?: string;
  /** 二进制内容（base64）；与 text 二选一 */
  base64?: string;
  /** true = 删除这个文件 */
  remove?: boolean;
}

async function ghJson<T>(env: Env, path: string, init: RequestInit, what: string): Promise<T> {
  const res = await gh(env, path, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(`${what}失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`, res.status === 422 ? 409 : 502);
  }
  return (await res.json()) as T;
}

export async function commitFiles(
  env: Env,
  files: CommitFile[],
  message: string
): Promise<{ sha: string; files: number }> {
  if (!files.length) return { sha: '', files: 0 };
  const br = branch(env);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      /* 1) 当前 head */
      const ref = await ghJson<{ object?: { sha?: string } }>(
        env,
        `/repos/${repo(env)}/git/ref/heads/${encodeURIComponent(br)}`,
        {},
        '读取分支'
      );
      const head = ref.object?.sha;
      if (!head) throw new GitError('读不到分支的最新提交', 502);

      /* 2) head 的 tree */
      const commit = await ghJson<{ tree?: { sha?: string } }>(
        env,
        `/repos/${repo(env)}/git/commits/${head}`,
        {},
        '读取提交'
      );
      const baseTree = commit.tree?.sha;

      /* 3) 组装 tree 条目：二进制先建 blob */
      const tree: Array<Record<string, unknown>> = [];
      for (const f of files) {
        if (f.remove) {
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        if (f.base64 !== undefined) {
          const blob = await ghJson<{ sha?: string }>(
            env,
            `/repos/${repo(env)}/git/blobs`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: f.base64, encoding: 'base64' }),
            },
            '创建二进制对象'
          );
          if (!blob.sha) throw new GitError('创建二进制对象失败（没有返回 sha）', 502);
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
          continue;
        }
        tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.text ?? '' });
      }

      const newTree = await ghJson<{ sha?: string }>(
        env,
        `/repos/${repo(env)}/git/trees`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree }),
        },
        '创建目录树'
      );
      if (!newTree.sha) throw new GitError('创建目录树失败（没有返回 sha）', 502);

      /* 4) 新提交 */
      const newCommit = await ghJson<{ sha?: string }>(
        env,
        `/repos/${repo(env)}/git/commits`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
        },
        '创建提交'
      );
      if (!newCommit.sha) throw new GitError('创建提交失败（没有返回 sha）', 502);

      /* 5) 移动 ref（force=false：main 动过就报错，我们重试） */
      const res = await gh(env, `/repos/${repo(env)}/git/refs/heads/${encodeURIComponent(br)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      });
      if (res.status === 409 || res.status === 422) {
        lastError = new GitError('分支刚刚被别人推过，正在重试', 409);
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new GitError(`更新分支失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`, 502);
      }
      return { sha: newCommit.sha, files: files.length };
    } catch (err) {
      lastError = err;
      const status = (err as GitError)?.status;
      /* 只有「分支动了」值得重试，其它错误直接上抛 */
      if (status !== 409) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GitError('分支连续被推过三次，请稍后再试', 409);
}
