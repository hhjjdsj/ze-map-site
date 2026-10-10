/**
 * /updates/feed.json —— 「最近改动」的完整清单（供首页 / 更新页的「加载更多」拉取）。
 *
 * 为什么单独一个 JSON 而不是把全部条目塞进首页 HTML：
 * 首页只需要前 8 条，把几百条一起吐出去会让首屏 HTML 白白大几十 KB。
 * 这个文件由构建期生成（静态资源，可直接缓存），点「加载更多」时才拉一次，
 * 之后从内存里按页追加 —— 一次请求翻到底。
 */
import type { APIRoute } from 'astro';
import { getUpdateFeed } from '../../lib/update-feed';

export const GET: APIRoute = async () => {
  const items = await getUpdateFeed();
  return new Response(JSON.stringify({ total: items.length, items }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
