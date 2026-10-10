/**
 * GET /api/video-meta?bvs=BV1xxx,BV2yyy[&debug=1] —— 视频的标题与 UP 主名 / UID。
 *
 * 为什么走 Worker 而不是写进仓库：
 *   站长要求 UP 主信息不进 GitHub。而线上构建不联网、B 站接口既没有 CORS 也不支持
 *   JSONP（实测 `jsonp=jsonp` / `callback=cb` 都只返回纯 JSON），所以「页面上显示 UP 主名」
 *   只有一条干净的路 —— **运行时问我们自己的 Worker**。
 *
 * 数据从哪来（2026-10-10 定稿）：
 *   **R2 里的静态索引** `video-meta/index.json`（`{ "<BV号>": { t, u, m } }`，约 46 KB），
 *   由本地 `tools/video-meta-push.mjs` 用 `wrangler r2 object put` 推上去。
 *
 *   为什么不是 KV、也不是运行时抓：
 *     · **KV 写不了**：`.env.r2` 里那个 API token 只有 R2 权限，`wrangler kv bulk put` 直接
 *       认证失败（code 10000）；而 R2 写是验证过可用的。用现成权限，不折腾新 token。
 *     · **运行时抓 B 站拿不到**：部署后实测 `/api/video-meta` 返回 `{"ok":true,"items":{}}` ——
 *       Cloudflare 的出口 IP 从 B 站接口取不到数据（风控 / 412，`?debug=1` 能看到原因）。
 *       本机在国内容易取，所以数据本地抓好再推上去。
 *   回源 B 站只作为**兜底**（索引里没有的新视频试一把，成不成看运气），失败就当没有。
 *
 * 性能：整份索引按 isolate 缓存在内存里（TTL 10 分钟），一次 R2 读取服务 N 个请求；
 * 一页最多问 24 个编号，一次请求答完。
 */

import { fail, type Env, type R2Like } from './http';

/** BV 号：BV + 10 位左右；av 号；YouTube 的 11 位 id */
const BV_RE = /^BV[0-9A-Za-z]{8,12}$/;
const AV_RE = /^av\d{1,12}$/i;
const YT_RE = /^[A-Za-z0-9_-]{11}$/;

const INDEX_KEY = 'video-meta/index.json';
const MAX_IDS = 24;
/** 索引在内存里放多久（每个 isolate 自己算） */
const INDEX_TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;
const TIMEOUT_MS = 6000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface VideoMeta {
  /** 标题 */
  t: string;
  /** UP 主 / 作者 */
  u: string;
  /** B 站 UID：页面上把 UP 主名做成回他主页的链接（署名也把流量还给他） */
  m?: string;
}

/* ---------- R2 索引（每个 isolate 缓存一份） ---------- */
let indexCache: { at: number; data: Record<string, VideoMeta> } | null = null;

async function loadIndex(r2: R2Like | undefined, force = false): Promise<Record<string, VideoMeta>> {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.data;
  if (!r2) return {};
  try {
    const obj = await r2.get(INDEX_KEY);
    if (!obj) return {};
    const text = await new Response(obj.body).text();
    const data = JSON.parse(text) as Record<string, VideoMeta>;
    indexCache = { at: Date.now(), data };
    return data;
  } catch {
    /* 读不到就当索引为空：走回源，最坏是与以前一样没有署名 */
    return {};
  }
}

/* ---------- 回源兜底（B 站 / YouTube），只在索引里没有时用 ---------- */
async function fetchBilibili(id: string): Promise<{ meta: VideoMeta | null; note?: string }> {
  const api = AV_RE.test(id)
    ? `https://api.bilibili.com/x/web-interface/view?aid=${id.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`;
  const res = await fetch(api, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { meta: null, note: `HTTP ${res.status}` };
  let j: { code?: number; message?: string; data?: { title?: string; owner?: { name?: string; mid?: number } } };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    return { meta: null, note: '返回不是 JSON（多半被风控页顶掉了）' };
  }
  if (j.code !== 0 || !j.data) return { meta: null, note: `code=${j.code ?? '?'} ${j.message ?? ''}`.trim() };
  const t = String(j.data.title ?? '').trim();
  const u = String(j.data.owner?.name ?? '').trim();
  const m = Number(j.data.owner?.mid ?? 0);
  return { meta: t || u ? { t, u, ...(m > 0 ? { m: String(m) } : {}) } : null };
}

async function fetchYoutube(id: string): Promise<{ meta: VideoMeta | null; note?: string }> {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
  const res = await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { meta: null, note: `HTTP ${res.status}` };
  const j = (await res.json()) as { title?: string; author_name?: string };
  const t = String(j.title ?? '').trim();
  const u = String(j.author_name ?? '').trim();
  return { meta: t || u ? { t, u } : null };
}

async function fetchMeta(id: string): Promise<{ meta: VideoMeta | null; note?: string }> {
  try {
    return BV_RE.test(id) || AV_RE.test(id) ? await fetchBilibili(id) : await fetchYoutube(id);
  } catch (err) {
    return { meta: null, note: err instanceof Error ? err.message : String(err) };
  }
}

/** 小并发池：按 blocks 依次跑，每块内部并发 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<[T, R]>> {
  const out: Array<[T, R]> = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const got = await Promise.all(chunk.map(async (item) => [item, await fn(item)] as [T, R]));
    out.push(...got);
  }
  return out;
}

export async function handleVideoMeta(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const raw = url.searchParams.get('bvs') ?? '';
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return fail('缺少 bvs 参数');
  if (ids.length > MAX_IDS) return fail(`一次最多查 ${MAX_IDS} 个`, 413);
  const bad = ids.find((id) => !(BV_RE.test(id) || AV_RE.test(id) || YT_RE.test(id)));
  if (bad) return fail(`不认识的视频编号：${bad.slice(0, 24)}`);

  const debug = url.searchParams.get('debug') === '1';
  const index = await loadIndex(env.TERR);

  const items: Record<string, VideoMeta> = {};
  const misses: string[] = [];
  for (const id of ids) {
    const hit = index[id];
    if (hit && (hit.t || hit.u)) items[id] = hit;
    else misses.push(id);
  }

  const diag: Record<string, string> = {};
  if (misses.length) {
    const got = await mapLimit(misses, CONCURRENCY, fetchMeta);
    for (const [id, r] of got) {
      if (r.meta) {
        items[id] = r.meta;
        /* 回源成功就顺手补进内存索引（不写回 R2：本地那份才是权威，避免线上悄悄分叉） */
        if (indexCache) indexCache.data[id] = r.meta;
      } else if (r.note) {
        diag[id] = r.note;
      }
    }
  }

  const body: Record<string, unknown> = { ok: true, items };
  if (debug) {
    body.diag = {
      indexed: Object.keys(index).length,
      miss: misses.length,
      ...(Object.keys(diag).length ? { upstream: diag } : {}),
    };
  }
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* 浏览器侧也缓存一小时：同一页来回翻不用反复问 */
      'cache-control': 'public, max-age=3600',
    },
  });
}
