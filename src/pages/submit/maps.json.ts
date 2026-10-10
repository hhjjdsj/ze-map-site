/**
 * /submit/maps.json —— 投稿表单用的地图索引（构建期生成）。
 *
 * 为什么不在 /submit/?map=x 上做动态路由：
 * 那会给 547 张图各生成一个近乎重复的投稿页，白白撑大构建产物和 sitemap。
 * 这里输出一份小索引，表单取一次就能拿到任意地图的当前值用于预填。
 *
 * 神器 / 道具（items）也在这里给出「本站现在这张图的表」——
 * 投稿是逐行更正的，投稿人得先看见表里已有的名字才好在上面改（表单里做名称联想）。
 */
import { getMaps } from '../../lib/maps';
import { galleryFor } from '../../lib/gallery';
import { normalizeDoc, notePublicId } from '../../../shared/community-doc.mjs';
import { cdText, docItemRows, itemKey, mergeItems, usesText } from '../../../shared/items.mjs';
import type { APIRoute } from 'astro';

/*
 * 用 import.meta.glob 在构建期把三份数据读进来（打包器解析路径）。
 * 绝不要改成 fs.readFile + 相对路径：Cloudflare 适配器预渲染时 cwd 会变成 /bundle，
 * 那正是 2026-09-23 线上构建失败的根因。
 */
const gflModules = import.meta.glob('../../../data/gfl-parsed/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;
const communityModules = import.meta.glob('../../../data/community/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;
/* 手写资料：魔晄炉 / 米纳斯 / 黑珍珠号的神器表在正文里（不是服务器配置），
   投稿表单得认得它们，否则会对着有表的图说「本站还没有这张图的神器表」。 */
const researchModules = import.meta.glob('../../../data/research/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;

/** glob 的值：不带 import:'default' 时是模块命名空间，JSON 在 default 上 */
const unwrap = (mod: { default?: unknown } | undefined): any => (mod ? (mod.default ?? mod) : null);
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1, -'.json'.length);

/** 按地图内部名索引的服务器配置；_aliases.json 是「配置名 ↔ 站点地图名」的映射表 */
const gflByName = new Map<string, any>();
let aliases: Record<string, string> = {};
for (const [p, mod] of Object.entries(gflModules)) {
  if (baseName(p) === '_aliases') aliases = (unwrap(mod) ?? {}) as Record<string, string>;
  else gflByName.set(baseName(p), unwrap(mod));
}

/** 按 slug 索引的社区文档（里面可能有已审核通过的神器更正） */
const communityBySlug = new Map<string, any>();
for (const [p, mod] of Object.entries(communityModules)) communityBySlug.set(baseName(p), unwrap(mod));

/** 按 slug 索引的手写资料（document 里可能带一张神器表） */
const researchBySlug = new Map<string, any>();
for (const [p, mod] of Object.entries(researchModules)) researchBySlug.set(baseName(p), unwrap(mod));

export const GET: APIRoute = async () => {
  const maps = await getMaps();

  const index = maps.map((m) => {
    const d = m.data;
    const row: Record<string, unknown> = {
      slug: m.id,
      title: d.title,
      titleEn: d.titleEn,
      difficulty: d.difficulty,
      tags: d.tags,
      stages: d.stages,
    };
    /* 只为非空字段占位，文件能小一点 */
    if (d.author) row.author = d.author;
    if (d.authorNote) row.authorNote = d.authorNote;
    if (d.version) row.version = d.version;
    if (d.players) row.players = d.players;
    if (d.duration) row.duration = d.duration;
    if (d.videoUrls?.length) row.videoUrls = d.videoUrls;
    if (d.sources?.length) row.sources = d.sources;
    /* 封面：投稿表单要显示「当前封面」缩略图（换封面时好对比） */
    if (d.cover) row.cover = d.cover;
    /* 图片集已有几张：投稿表单用它说明「现在有几张图」，免得重复投同一张 */
    const galleryCount = galleryFor(m.id).length;
    if (galleryCount) row.galleryCount = galleryCount;

    /* 神器 / 道具现状：手写表 + 服务器配置打底 + 社区已通过的更正。
       字段用短键 —— 1700 多行，键名能省下十几 KB。
       k: doc=手写正文里的表 / server=服务器配置 / updated,added,removed=社区改过。
       l 只有手写表那种「中文名 + 英文名」两列时才有。 */
    const mapName = String(d.titleEn ?? '');
    const gfl = gflByName.get(aliases[mapName] ?? mapName) ?? null;
    const community = communityBySlug.has(m.id) ? normalizeDoc(m.id, communityBySlug.get(m.id)) : null;
    const merged = mergeItems(gfl?.items ?? [], community?.items ?? []);
    /*
     * 手写正文里的神器表：早期是 `document`（一整篇 HTML），2026-10-08 起改成 `sections[]`
     * （结构化小节，魔晄炉 / 米纳斯 / 黑珍珠号那三张）。两种都要认 ——
     * 只认 document 的话，这三张图在投稿页会显示「本站还没有这张图的神器表」，
     * 而页面上明明摆着一张表（对照面板、神器行编辑器也跟着一起错）。
     */
    const research = researchBySlug.get(m.id);
    const legacyDoc = String(research?.document ?? '');
    const sectionsDoc = Array.isArray(research?.sections)
      ? research.sections.map((s: { title?: string; body?: string }) => `## ${s?.title ?? ''}\n\n${s?.body ?? ''}`).join('\n\n')
      : '';
    const docRows = docItemRows(legacyDoc || sectionsDoc);

    /*
     * 本站正文（背景故事等）：投稿人要能看见「现在写的是什么」才谈得上修改，
     * 否则只能盲着追加一条社区投稿（2026-10-10 的反馈）。
     * 两个来源都带上：
     *   story   = 人工整理稿 sections 里的「背景故事」整节（目前 3 张富内容图）
     *   summary = 条目的简介段落（107 张）
     */
    const storySection = Array.isArray(research?.sections)
      ? research.sections.find((s: { title?: string }) => /背景|剧情|故事/.test(String(s?.title ?? '')))
      : null;
    const siteStory = String(storySection?.body ?? '').trim();
    if (siteStory) row.story = siteStory;
    const siteSummary = String(research?.summary ?? '').trim();
    if (siteSummary) row.summary = siteSummary;
    /*
     * 已通过的社区投稿（data/community/<slug>.json 的 notes）：
     * 带 id / 字段 / 作者，投稿表单据此提供「修订这一条」——
     * 以前只能追加，改不了已经发出去的内容。
     */
    const docNotes = (community?.notes ?? [])
      .map(
        (
          n: {
            text?: string;
            by?: string;
            at?: string | null;
            field?: string | null;
            submission?: number | null;
            revisedBy?: string | null;
          },
          i: number
        ) => ({
          id: notePublicId(n, i),
          field: String(n?.field ?? 'body'),
          text: String(n?.text ?? ''),
          by: String(n?.by ?? ''),
          at: n?.at ? String(n.at) : '',
          ...(n?.revisedBy ? { revisedBy: String(n.revisedBy) } : {}),
        })
      )
      .filter((n: { text: string }) => n.text);
    if (docNotes.length) row.notes = docNotes;

    const byKey = new Map<string, Record<string, unknown>>();
    /* 说明（神器表那一列）：原稿 relicIntros 打底，社区投稿的 intro 盖上 —— 与生成器的规则一致 */
    const researchIntros = new Map<string, string>();
    const ri = researchBySlug.get(m.id)?.relicIntros;
    if (ri && typeof ri === 'object') {
      for (const [k, v] of Object.entries(ri)) {
        const text = String(v ?? '').trim();
        if (text) researchIntros.set(itemKey(k), text);
      }
    }
    const communityIntros = new Map<string, string>();
    for (const r of community?.items ?? []) {
      const text = String(r?.intro ?? '').trim();
      if (r?.name && text) communityIntros.set(itemKey(r.name), text);
    }
    const introOf = (name: unknown) => communityIntros.get(itemKey(name)) ?? researchIntros.get(itemKey(name)) ?? '';

    for (const r of docRows) {
      const intro = introOf(r.name);
      byKey.set(itemKey(r.name), {
        n: r.name,
        k: 'doc',
        ...(r.label ? { l: r.label } : {}),
        ...(r.cd === null ? {} : { c: cdText(r.cd) }),
        ...(intro ? { i: intro } : {}),
      });
    }
    for (const r of merged.rows) {
      const intro = introOf(r.name);
      byKey.set(itemKey(r.name), {
        n: r.name,
        c: cdText(r.cd),
        u: usesText(r.uses),
        k: r.kind,
        ...(intro ? { i: intro } : {}),
      });
    }
    if (byKey.size) row.items = [...byKey.values()];
    return row;
  });

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
