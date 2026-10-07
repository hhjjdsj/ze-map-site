/**
 * /search/maps.json —— 站内搜索的轻量索引（构建期生成）：图名 + 标签。
 *
 * 为什么搜索页和页头搜索框都需要它：
 *
 * 1. **Pagefind 的中文分词对短词组不可靠**。实测（2026-09-24）「指环王」匹配不到标题就叫
 *    《指环王：米那斯提力斯》的那张图（那一页正文里「指环王」出现 9 次，h1 就是它），
 *    却返回一批正文里只出现过「指」的页面；换排序参数救不了（问题出在「匹不匹配」，
 *    不是「排第几」）。所以自己拿这份索引兜一层。
 *
 * 2. **连续词（短语）匹配只能自己算**。Pagefind 不支持引号短语（产物里根本没有 phrase 相关
 *    代码），它把中文按字索引，于是搜「后室」会命中「惊魂实验室」这种「后」「室」分开的页面
 *    （2026-10-07 实测：20 条结果里只有 8 条真的连在一起）。索引里的图名 / 标签天然是
 *    子串匹配，正好补上这一块。
 *
 * 结构（键名刻意短，这份文件每次搜索都要拉）：
 *   maps[]: s=slug  t=中文名  e=英文名  d=难度  g=标签[]
 *   tags[]: n=标签名  c=该标签的地图数
 *
 * 页头搜索框只在这些字段里做**连续子串**匹配，所以「后室」不会命中「后…室」。
 * 比 /submit/maps.json 小得多（那个要预填表单字段）。
 */
import { getMaps } from '../../lib/maps';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const maps = await getMaps();

  const tagCount = new Map<string, number>();
  const out = maps.map((m) => {
    const tags = (m.data.tags ?? []) as string[];
    for (const t of tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const row: Record<string, unknown> = {
      s: m.id, // slug
      t: m.data.title, // 中文名
      e: m.data.titleEn, // 英文名（内部名）
      d: m.data.difficulty, // 难度，用于结果里的徽章
    };
    /* 只有非空才带上，文件能小一点（多数图有标签，但空数组没必要占位置） */
    if (tags.length) row.g = tags;
    return row;
  });

  const tags = [...tagCount.entries()]
    .map(([n, c]) => ({ n, c }))
    .sort((a, b) => b.c - a.c || a.n.localeCompare(b.n, 'zh'));

  return new Response(JSON.stringify({ maps: out, tags }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
