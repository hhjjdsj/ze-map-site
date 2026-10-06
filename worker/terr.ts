/**
 * 地形分片的**同源回退**：GET /terr/<工坊ID>.bin → R2 桶 ze-map-terr
 *
 * 为什么需要它：
 *   地形本来只从 R2 自定义域（terr.ze-map.cn）取，那是**另一个域名**。
 *   国内手机网络 / App 内置浏览器里，这个跨域请求可能直接失败（前端只看到
 *   「Failed to fetch」），而站点自己的域名是通的 —— 于是用户在手机上
 *   只能看到「真实碰撞地形加载失败」，把块体一关就一片空（2026-10-05 反馈）。
 *   走同源就没有跨域这回事，也不需要 R2 的 CORS 配置。
 *
 * 为什么不是「全部走同源」：Worker 要跑一遍、还占 CPU 时间。
 *   前端仍然优先直连 R2（快、不占 Worker），只有失败时才退到这里。
 *
 * 边缘缓存：用 Cache API 存一年（分片是不可变的，路径里带工坊 ID）。
 *   命中缓存时不会回源 R2，所以正常浏览不会增加 R2 的读取次数。
 */
import { fail, type Env } from './http';

const KEY_RE = /^terr\/\d+\.bin$/;

export async function handleTerr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('只支持 GET', 405);

  const path = new URL(request.url).pathname.replace(/^\/+/, '');
  if (!KEY_RE.test(path)) return fail('路径不对：应该是 /terr/<工坊ID>.bin', 400);

  if (!env.TERR) {
    return fail('地形回退没配置（wrangler.jsonc 缺少 r2_buckets 绑定 TERR）', 503);
  }

  /* 边缘缓存：key 用完整 URL（同一个分片只有一个 URL） */
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  let obj: { body: ReadableStream; size: number } | null = null;
  try {
    obj = await env.TERR.get(path);
  } catch (e) {
    return fail('读 R2 失败：' + (e instanceof Error ? e.message : String(e)), 502);
  }
  if (!obj) return new Response('没有这个地形分片', { status: 404 });

  const res = new Response(request.method === 'HEAD' ? null : obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      /* 分片不可变：路径里就带工坊 ID，重建也是换 ID/换文件 */
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
  /* 写缓存失败不该影响这次请求 */
  try {
    await cache.put(request, res.clone());
  } catch {
    /* 忽略：下次再来还是会读到 R2 */
  }
  return res;
}
