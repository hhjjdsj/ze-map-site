/**
 * ze-map-site Worker —— 路由入口。
 *
 * 背景：站点原本是**纯静态资源** Worker，一行脚本都没有。现在它承担两件事：
 *   P1  社区难度投票（/api/vote /api/stats）
 *   P2  社区投稿 + 审核台（/api/submit /api/submission /api/admin/*）
 *   P3  视频署名（/api/video-meta）：标题与 UP 主名，运行时抓 + KV 缓存，
 *       这样 UP 主信息不必进 GitHub 仓库（见 worker/videos.ts 的说明）
 *
 * 性能：Cloudflare 官方路由规则是「静态资源优先命中，匹配不到才调用 Worker」，
 * 且 wrangler.jsonc 里 `run_worker_first` 只对 /api/* 生效。所以：
 *   1. 800 多个静态页面（2026-10-05 构建产物是 815 个 html）仍由边缘直接发出，不经过这里，速度不受影响；
 *   2. 就算本文件抛异常，站点本身照常访问，最坏只是接口 500。
 *
 * 需要的绑定与密钥：
 *   DB                 D1（wrangler.jsonc）
 *   ASSETS             静态资源（wrangler.jsonc）
 *   UPLOADS            Workers KV：待审图片的临时存放（封面 + 图片集；wrangler.jsonc）
 *   TERR               R2：地形分片（/terr/* 同源回退）+ 玩家投稿的图片集图片
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
  handleAdminFlush,
  handleAdminImage,
  handleAdminQueue,
  handleAdminReview,
  handleAdminUnstage,
  handleSubmissionStatus,
  handleSubmit,
  handleSubmitCover,
  handleSubmitGallery,
} from './submissions';
import { handleStats, handleVote } from './votes';
import { handleTerr } from './terr';
import { handleVideoMeta } from './videos';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    /*
     * /terr/* 是地形分片的同源回退（见 worker/terr.ts）：正常情况前端直连 R2 自定义域，
     * 在那个域不通的网络里才落到这里。必须在「交回资源」之前处理，否则会被当成静态资源。
     */
    if (path.startsWith('/terr/')) return handleTerr(request, env);

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
      /* 待审图片的缩略图（封面 / 图片集）：<img> 带不了自定义头，所以审核台用 fetch + Bearer 取 blob，
         这样密钥不会出现在 URL 里（也就不进任何日志）。 */
      if (path.startsWith('/api/admin/cover/') || path.startsWith('/api/admin/gallery/')) {
        return handleAdminImage(request, env, path);
      }
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
    if (path === '/api/submit-gallery') return handleSubmitGallery(request, env, ipHash, clientIp(request));
    if (path === '/api/submission') return handleSubmissionStatus(request, env, url);
    /* 视频标题 / UP 主名：只读、带 KV 缓存。不写 D1（见 videos.ts 顶部的取舍说明） */
    if (path === '/api/video-meta') return handleVideoMeta(request, env, url);

    return fail('未知接口', 404);
  },
};
