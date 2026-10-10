/**
 * GET /api/video-meta?bvs=BV1xxx,BV2yyy —— 视频的标题与 UP 主名（给播放器门面补署名）。
 *
 * 为什么走 Worker 而不是写进仓库：
 *   站长要求 UP 主信息不进 GitHub（2026-10-10）。而线上构建不联网、B 站接口既没有 CORS
 *   也不支持 JSONP（实测 jsonp=jsonp / callback=cb 都只返回纯 JSON），所以「页面上显示
 *   UP 主名」只有一条干净的路 —— **运行时问我们自己的 Worker**，由它去 B 站取并缓存。
 *
 * 设计要点：
 *   · **只读接口**，同源检查已在 index.ts 统一做过；批量化（一次最多 MAX_IDS 个），
 *     一页视频通常 1~9 条，正好一次请求搞定；
 *   · **KV 缓存 30 天**（UPLOADS 里 `vmeta:<id>`）：同一支视频全网只抓一次，
 *     既快又不会把 B 站惹毛；KV 没绑定时照样工作，只是每次都现抓；
 *   · **失败也缓存**（30 分钟）：防止有人拿随机 BV 号刷我们的出口 IP；
 *   · **取不到就不返回这一条** —— 前端保持现在的样子（「bilibili · 播放器在点击后才加载」），
 *     绝不显示占位假数据。
 */

import { fail, type Env, type KVLike } from './http';

/** BV 号：BV + 10 位左右；av 号；YouTube 的 11 位 id */
const BV_RE = /^BV[0-9A-Za-z]{8,12}$/;
const AV_RE = /^av\d{1,12}$/i;
const YT_RE = /^[A-Za-z0-9_-]{11}$/;

const MAX_IDS = 24;
/** 元数据 30 天，失败 30 分钟 */
const TTL_OK = 60 * 60 * 24 * 30;
const TTL_FAIL = 60 * 30;
/** 并发抓取上限：别一次给 B 站发 24 个请求 */
const CONCURRENCY = 4;
const TIMEOUT_MS = 6000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface VideoMeta {
  /** 标题 */
  t: string;
  /** UP 主 / 作者 */
  u: string;
  /** B 站 UID：页面上把 UP 主名做成回他主页的链接（对方愿意被收录时，这也算把流量还给他） */
  m?: string;
}

const keyOf = (id: string) => `vmeta:${id}`;

async function cacheGet(kv: KVLike | undefined, id: string): Promise<VideoMeta | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(keyOf(id), { type: 'text' });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VideoMeta | { miss: true };
    if (parsed && typeof parsed === 'object' && 'miss' in parsed) return null;
    if (parsed && typeof (parsed as VideoMeta).t === 'string') return parsed as VideoMeta;
  } catch {
    /* 缓存读失败就当没有，继续去抓 */
  }
  return null;
}

async function cachePut(kv: KVLike | undefined, id: string, value: VideoMeta | null): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(keyOf(id), JSON.stringify(value ?? { miss: true }), {
      expirationTtl: value ? TTL_OK : TTL_FAIL,
    });
  } catch {
    /* 写缓存失败不影响返回 */
  }
}

/** B 站：标题 + UP 主名（+ UID，用于署名链接） */
async function fetchBilibili(id: string): Promise<VideoMeta | null> {
  const api = AV_RE.test(id)
    ? `https://api.bilibili.com/x/web-interface/view?aid=${id.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`;
  const res = await fetch(api, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    code?: number;
    data?: { title?: string; owner?: { name?: string; mid?: number } };
  };
  if (j.code !== 0 || !j.data) return null;
  const t = String(j.data.title ?? '').trim();
  const u = String(j.data.owner?.name ?? '').trim();
  const m = Number(j.data.owner?.mid ?? 0);
  return t || u ? { t, u, ...(m > 0 ? { m: String(m) } : {}) } : null;
}

/** YouTube：oEmbed（不需要 key） */
async function fetchYoutube(id: string): Promise<VideoMeta | null> {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
  const res = await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const j = (await res.json()) as { title?: string; author_name?: string };
  const t = String(j.title ?? '').trim();
  const u = String(j.author_name ?? '').trim();
  return t || u ? { t, u } : null;
}

async function fetchMeta(id: string): Promise<VideoMeta | null> {
  try {
    return BV_RE.test(id) || AV_RE.test(id) ? await fetchBilibili(id) : await fetchYoutube(id);
  } catch {
    /* 超时 / 网络错 / 被风控：这一条就当拿不到 */
    return null;
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

  const kv = env.UPLOADS;
  const items: Record<string, VideoMeta> = {};
  const misses: string[] = [];
  for (const id of ids) {
    const hit = await cacheGet(kv, id);
    if (hit) items[id] = hit;
    else misses.push(id);
  }

  if (misses.length) {
    const got = await mapLimit(misses, CONCURRENCY, fetchMeta);
    for (const [id, meta] of got) {
      if (meta) items[id] = meta;
      /* 失败的也写进缓存（短 TTL）：挡掉「拿随机编号刷接口」这种用法 */
      await cachePut(kv, id, meta);
    }
  }

  return new Response(JSON.stringify({ ok: true, items }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* 浏览器侧也能缓存一小时：同一页来回翻不用反复问 */
      'cache-control': 'public, max-age=3600',
    },
  });
}
