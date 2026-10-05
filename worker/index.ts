/**
 * ze-map-site Worker —— 路由入口。
 *
 * 背景：站点原本是**纯静态资源** Worker，一行脚本都没有。现在它承担两件事：
 *   P1  社区难度投票（/api/vote /api/stats）
 *   P2  社区投稿 + 审核台（/api/submit /api/submission /api/admin/*）
 *
 * 性能：Cloudflare 官方路由规则是「静态资源优先命中，匹配不到才调用 Worker」，
 * 且 wrangler.jsonc 里 `run_worker_first` 只对 /api/* 生效。所以：
 *   1. 800 多个静态页面（2026-10-05 构建产物是 815 个 html）仍由边缘直接发出，不经过这里，速度不受影响；
 *   2. 就算本文件抛异常，站点本身照常访问，最坏只是接口 500。
 *
 * 需要的绑定与密钥：
 *   DB                 D1（wrangler.jsonc）
 *   ASSETS             静态资源（wrangler.jsonc）
 *   UPLOADS            Workers KV：投稿封面的临时存放（wrangler.jsonc；没配只有封面接口不可用）
 *   IP_SALT            必须
 *   ADMIN_TOKEN        审核台必须
 *   GITHUB_TOKEN       审核台点「写回仓库」时必须（2026-10-05 起「通过」只入队，不直接写仓库）
 *   TURNSTILE_SECRET   选填
 */

import {
  checkAdmin,
  checkOrigin,
  clientIp,
  fail,
  isLocalHost,
  sha256Hex,
  type Env,
} from './http';
import {
  handleAdminBan,
  handleAdminCover,
  handleAdminFlush,
  handleAdminQueue,
  handleAdminReview,
  handleAdminUnstage,
  handleSubmissionStatus,
  handleSubmit,
  handleSubmitCover,
} from './submissions';
import { handleStats, handleVote } from './votes';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    /*
     * 非 /api/* 一律交回资源绑定（含未命中时的 404 兜底）。
     * 千万别在这里自己 new Response('Not found')，那会把站内 404 页顶掉。
     */
    if (!path.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not Found', { status: 404 });
      return env.ASSETS.fetch(request);
    }

    // 同源检查：挡掉别人页面上的跨站调用（本站接口不需要被外部站点调用）
    const originError = checkOrigin(request, url);
    if (originError) return originError;

    if (!env.DB) return fail('服务尚未配置（缺少 D1 绑定）', 503);

    /* ===== 审核台：先验密钥，再碰任何数据 ===== */
    if (path.startsWith('/api/admin/')) {
      const denied = checkAdmin(request, env);
      if (denied) return denied;

      if (path === '/api/admin/queue') return handleAdminQueue(request, env, url);
      if (path === '/api/admin/review') return handleAdminReview(request, env);
      if (path === '/api/admin/flush') return handleAdminFlush(request, env);
      if (path === '/api/admin/unstage') return handleAdminUnstage(request, env);
      if (path === '/api/admin/ban') return handleAdminBan(request, env);
      /* 待审封面的缩略图：<img> 带不了自定义头，所以审核台用 fetch + Bearer 取 blob，
         这样密钥不会出现在 URL 里（也就不进任何日志）。 */
      if (path.startsWith('/api/admin/cover/')) return handleAdminCover(request, env, path);
      return fail('未知接口', 404);
    }

    /*
     * IP 盐必须显式配置（线上）。
     * 盐如果是个写在公开仓库里的常量，等于没有盐：别人能拿它暴力枚举整个 IPv4 空间，
     * 把 ip_hash 反查回具体 IP —— 那就变成在收集个人信息了。
     * 所以线上缺 IP_SALT 时直接 503（宁可功能不可用，也不静默降级），只在本地开发放行。
     */
    const salt = env.IP_SALT;
    if (!salt && !isLocalHost(url.host)) {
      return fail('服务尚未配置（缺少 IP_SALT 密钥）', 503);
    }
    const ipHash = await sha256Hex(`${salt ?? 'local-dev-only'}:${clientIp(request)}`);

    /* ===== 公开接口 ===== */
    if (path === '/api/stats') return handleStats(request, env, url, ipHash);
    if (path === '/api/vote') return handleVote(request, env, ipHash);
    if (path === '/api/submit') return handleSubmit(request, env, ipHash, clientIp(request));
    if (path === '/api/submit-cover') return handleSubmitCover(request, env, ipHash, clientIp(request));
    if (path === '/api/submission') return handleSubmissionStatus(request, env, url);

    return fail('未知接口', 404);
  },
};
