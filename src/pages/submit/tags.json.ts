/**
 * /submit/tags.json —— 投稿表单用的**全站标签词表**（构建期生成）。
 *
 * 为什么要它：标签一直是自由文本（「每行一个」），投稿人看不到站内已有哪些标签，
 * 于是同一个意思会分叉成好几个（现已 254 个标签，其中 172 个只挂在 1 张图上）；
 * 更麻烦的是 tags 是**整组替换**——投稿人只想加一个，却常把原有的全写丢。
 * 有了这份词表，表单可以把所有标签列出来让他勾，并默认勾上这张图现有的那些。
 *
 * 关键点：词表**从当前全站数据算**（每个标签挂多少张图），不写死。
 * 所以审核通过的新标签，下一次构建就自动进词表 —— 以后任何人给**任何图**投稿都能看到它，
 * 不需要谁去维护一份名单。
 *
 * 与 /submit/maps.json 一样：用 import.meta.glob / getMaps 在构建期读，别改成 fs.readFile + 相对路径
 * （Cloudflare 预渲染时 cwd 会变成 /bundle，2026-09-23 线上构建失败就是这个原因）。
 */
import { getMaps } from '../../lib/maps';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const maps = await getMaps();
  const count = new Map<string, number>();
  for (const m of maps) {
    /* data.tags 已经由 loader 合并过社区覆盖，且做过大小写归一 —— 与页面上看到的一致 */
    for (const tag of new Set(m.data.tags ?? [])) {
      count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...count.entries()]
    .map(([n, c]) => ({ n, c }))
    .sort((a, b) => b.c - a.c || a.n.localeCompare(b.n, 'zh'));

  return new Response(JSON.stringify({ total: tags.length, tags }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
