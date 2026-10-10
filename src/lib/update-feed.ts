/**
 * 「最近改动」feed —— 首页底部那块逐条记录的数据来源（也可被 /updates/ 页复用）。
 *
 * 两层合并，一层一层说清楚：
 *
 *   ① 社区投稿（data/community/<slug>.json 的 log[]）
 *      构建期直接读文件就有：哪个字段、从什么变成什么、谁投的、投稿编号。
 *      所以它**永远是最新的** —— Worker 写回仓库 → Cloudflare 重建 → 这里就能看到，
 *      不依赖 git，也没有浅克隆问题。封面这类批量改动聚合成一天一条。
 *
 *   ② 本站整理的资料（data/research-changes.json）
 *      由 scripts/content/build-research-changes.mjs 从 git 历史生成（字段级），
 *      本地构建时更新、随提交入库；线上浅克隆时沿用上一份。
 *      为什么不做成构建期现算：Cloudflare 的克隆深度不确定，浅克隆会把整站历史
 *      都说成「今天」（data/map-dates.json 当初就是因此改成「生成后提交」的）。
 *
 * 显示用的标题（《魔晄炉》这种）在渲染层从 getMaps() 里取 —— 这里只出 slug，
 * 免得同一份数据里存两套名字（改标题时只改一处）。
 */
import changes from '../../data/research-changes.json';
import { normalizeDoc } from '../../shared/community-doc.mjs';
import { FIELD_RULES } from '../../shared/submission-fields.mjs';
import { getMaps } from './maps';

const communityModules = import.meta.glob('../../data/community/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;

/** feed 最多留这么多条（更早的翻不到；也顺带给 JSON 体积封顶） */
export const FEED_LIMIT = 400;
/** 首页一次显示几条，也是「加载更多」每次追加的条数 */
export const FEED_PAGE_SIZE = 8;

export interface FeedExtra {
  slug: string;
  /** 明细里那张图的页面标题（渲染时直接用，客户端追加条目时也一样） */
  title?: string;
  /** 这一条在聚合里的说明（「更新封面」「资料改动」…） */
  what: string;
}

export interface FeedItem {
  /** ISO 时间，排序用 */
  at: string;
  /** YYYY-MM-DD，显示用 */
  day: string;
  /** 单图条目才有；聚合条目（一天一堆封面）为 null */
  slug: string | null;
  /** 页面标题（slug 查不到时为空，渲染层退回显示 slug） */
  title: string | null;
  what: string;
  /** 社区投稿人昵称；本站整理的为 null */
  by: string | null;
  src: '社区投稿' | '本站整理';
  /** 聚合条目的明细（可展开） */
  extra?: FeedExtra[];
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 社区投稿的一条 log → 人话。返回 null 表示这类改动不单独展示（封面走聚合）。 */
function communityWhat(field: string, from: unknown, to: unknown, revised: boolean): string | null {
  if (field === 'cover') return null;
  const label = FIELD_RULES[field]?.label ?? '资料';
  switch (field) {
    case 'difficulty': {
      const a = typeof from === 'string' ? from.trim() : '';
      const b = typeof to === 'string' ? to.trim() : '';
      if (!b) return null;
      return a && a !== b ? `难度：${a} → ${b}` : `难度：${b}`;
    }
    case 'tags':
      return `标签更新（${listOf(to).length} 个）`;
    case 'videoUrls':
      return `攻略视频 +${listOf(to).length} 个`;
    case 'sources':
      return `资料来源 +${listOf(to).length} 条`;
    case 'items':
      return `神器 / 道具 ${listOf(to).length} 件`;
    default:
      /* 正文类（背景故事 / 攻略讲解 / 补充说明）：修订和新增要分清 */
      return revised ? `修订了${label}` : `新增${label}`;
  }
}

interface RawLog {
  field?: string;
  from?: unknown;
  to?: unknown;
  by?: string;
  at?: string | null;
  submission?: number | null;
  reviseOf?: string;
  note?: string;
}

/** 社区那一层（读文件，永远最新） */
function communityItems(): FeedItem[] {
  const out: FeedItem[] = [];
  /** 封面按天聚合：一天导一批封面不该刷 95 行 */
  const covers = new Map<string, { at: string; slugs: Set<string>; by: Set<string> }>();

  for (const [path, mod] of Object.entries(communityModules)) {
    const slug = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
    const raw = (mod?.default ?? mod) as { log?: RawLog[] } | undefined;
    const doc = normalizeDoc(slug, raw);
    for (const log of doc.log as RawLog[]) {
      if (!log || typeof log.field !== 'string') continue;
      const at = typeof log.at === 'string' && log.at ? log.at : doc.updatedAt;
      if (!at) continue;
      const day = at.slice(0, 10);
      if (log.field === 'cover') {
        const c = covers.get(day) ?? { at, slugs: new Set<string>(), by: new Set<string>() };
        c.slugs.add(slug);
        if (log.by) c.by.add(String(log.by));
        if (at > c.at) c.at = at;
        covers.set(day, c);
        continue;
      }
      const what = communityWhat(log.field, log.from, log.to, Boolean(log.reviseOf));
      if (!what) continue;
      out.push({
        at,
        day,
        slug,
        what,
        by: typeof log.by === 'string' && log.by ? log.by : null,
        src: '社区投稿',
      });
    }
  }

  for (const [day, c] of covers) {
    out.push({
      at: c.at,
      day,
      slug: null,
      what: `${c.slugs.size} 张图更新了封面`,
      by: c.by.size === 1 ? [...c.by][0] : c.by.size > 1 ? [...c.by].slice(0, 3).join('、') : null,
      src: '社区投稿',
      extra: [...c.slugs].sort().map((s) => ({ slug: s, what: '更新封面' })),
    });
  }
  return out;
}

/** 本站整理资料那一层（读 data/research-changes.json） */
function researchItems(): FeedItem[] {
  const raw = (changes as { items?: Array<{ at?: string; slug?: string; parts?: string[]; gallery?: number; first?: boolean }> })
    .items;
  const out: FeedItem[] = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it?.at || !it.slug) continue;
    const parts = Array.isArray(it.parts) ? it.parts.filter(Boolean) : [];
    /* 一次提交能改十几个键（比如 10-08 那次 document → sections 的迁移），
       全列出来是一面墙，只留前几个 —— 明细可以在条目页看。 */
    const head = parts.slice(0, 3).join('、');
    const rest = parts.length > 3 ? ` 等 ${parts.length} 项` : '';
    const bits: string[] = [];
    if (it.first) bits.push('首次补充资料');
    else if (parts.length) bits.push(`资料更新：${head}${rest}`);
    if (it.gallery) bits.push(`图片集 +${it.gallery} 张`);
    if (!bits.length) continue;
    out.push({
      at: it.at,
      day: it.at.slice(0, 10),
      slug: it.slug,
      what: bits.join(' · '),
      by: null,
      src: '本站整理',
    });
  }
  return out;
}

/**
 * 合并两层，按时间倒序，并把 slug 换成页面标题。
 *
 * 标题在这里补齐（而不是让页面各自再查一遍）：首页 SSR 与「加载更多」拉取的
 * /updates/feed.json 用的是同一份数据，标题必须在 feed 里 —— 否则客户端追加的
 * 那几条会没有名字。
 *
 * 查不到标题的条目直接丢掉：那多半是已经删掉的图，链过去是 404。
 */
export async function getUpdateFeed(limit = FEED_LIMIT): Promise<FeedItem[]> {
  const maps = await getMaps();
  const titles = new Map(maps.map((m) => [m.id, m.data.title]));

  const items = [...communityItems(), ...researchItems()]
    .filter((it) => (it.slug ? titles.has(it.slug) : true))
    .map((it) => ({
      ...it,
      title: it.slug ? (titles.get(it.slug) ?? null) : null,
      extra: it.extra
        ?.filter((e) => titles.has(e.slug))
        .map((e) => ({ ...e, title: titles.get(e.slug) ?? e.slug })),
    }))
    .filter((it) => !it.extra || it.extra.length > 0)
    .sort((a, b) => (a.at === b.at ? (a.slug ?? '').localeCompare(b.slug ?? '') : a.at < b.at ? 1 : -1));

  return items.slice(0, limit);
}
