/**
 * 地图数据的**统一读取入口**。
 *
 * ⚠️ 页面里请一律用 getMaps()，不要直接 getCollection('maps')。
 *
 * 为什么需要这一层：
 * 站点有近十处读地图数据（地图库卡片、首页、标签索引、标签详情、同类推荐、
 * 投稿表单索引、404、关于页、搜索页）。社区投稿可以覆盖难度/标签/作者等字段
 * （data/community/<slug>.json），如果只在详情页合并，就会出现
 * 「详情页显示困难、地图库里还是中等」这种自相矛盾。合并放在这里一次，
 * 所有调用方自动一致。
 *
 * 曾经试过的方案（记录一下，别再走一遍）：
 * 包一层 content loader、在 load() 里 context.store.set() 回写合并结果 ——
 * **不行**。实测：glob 命中、store 能读能写、预演也显示「会合并 1 条」，
 * 但合并后回读仍是原值，渲染出来的页面也没变。Astro 的 content store
 * 不认这种「包一层再回写」的用法，所以改成在读取层合并。
 */
import { getCollection } from 'astro:content';
import { contributors, fieldValue, hasContent, isNoteField, normalizeDoc } from '../../shared/community-doc.mjs';
import { FIELD_RULES } from '../../shared/submission-fields.mjs';

/*
 * 社区文件由打包器解析路径 —— 绝不要改成 fs.readFile + 相对路径，
 * 那正是 2026-09-23「/bundle」构建失败的根因（构建期 cwd 会变）。
 */
const communityModules = import.meta.glob('../../data/community/*.json', { eager: true });

/**
 * 社区可以覆盖的字段 —— **直接从投稿表单的字段规则派生**。
 *
 * 以前这里是手写一份列表，两边一旦不同步就会出现「表单能投、但页面不渲染」
 * 这种静默失效 —— `videoUrls`（页面压根没渲染）和 `sources`（烤进正文里、
 * 覆盖了也不显示）都栽在这上面。派生出来就不会再漂移：
 * 在 shared/submission-fields.mjs 加一个字段，它自动成为可覆盖字段。
 *
 * 正文类字段（kind=longtext：body、story…）排除在外：它们进的是 communityNotes
 * （地图页按字段分块显示：story → 「背景故事（社区投稿）」，body → 「社区补充」），
 * 不是条目字段。判断走 community-doc.mjs 的 isNoteField()，
 * 别再写死 "body" —— 否则以后再加一个长文本字段就会踩同一个坑。
 */
const OVERRIDABLE: string[] = Object.keys(FIELD_RULES).filter((k) => !isNoteField(k));

/** 按「追加 + 去重」而不是替换合并的字段 —— 标记在字段规则的 `append` 上 */
const APPEND_FIELDS = new Set(
  Object.entries(FIELD_RULES)
    .filter(([, rule]) => (rule as { append?: boolean }).append)
    .map(([k]) => k)
);

const docCache = new Map<string, ReturnType<typeof normalizeDoc> | null>();
function communityFor(slug: string) {
  if (docCache.has(slug)) return docCache.get(slug) ?? null;
  const raw = communityModules[`../../data/community/${slug}.json`] as
    | { default?: unknown }
    | undefined;
  const doc = raw ? normalizeDoc(slug, raw.default ?? raw) : null;
  docCache.set(slug, doc);
  return doc;
}

/** 把社区覆盖合并进一个条目（返回新对象，不改原条目） */
export function mergeEntry<T extends { id: string; data: Record<string, any> }>(entry: T): T {
  const doc = communityFor(entry.id);
  const data: Record<string, any> = { ...entry.data };

  if (!doc || !hasContent(doc)) {
    data.communityFields = [];
    data.communityNotes = [];
    data.communityPeople = [];
    data.communitySources = [];
    return { ...entry, data } as T;
  }

  const applied: string[] = [];
  for (const field of OVERRIDABLE) {
    const v = fieldValue(doc, field);
    if (v === undefined || v === null) continue;

    /*
     * sources / videoUrls 的语义是**追加**，不是替换。
     *
     * 投稿人是在补充清单（「我找到一个视频」），不是在重写整份。用替换会静默
     * 丢掉原有条目 —— 例如研究里已经整理好 3 个视频，社区补第 4 个时把前 3 个顶掉，
     * 页面上只剩 1 个，而且没有任何提示。去重后合并才符合意图。
     * 想删条目仍然可以改 data/research/ 下的原稿，走的不是这条路径。
     */
    if (APPEND_FIELDS.has(field) && Array.isArray(v)) {
      const base: unknown[] = Array.isArray(data[field]) ? data[field] : [];
      data[field] = [...base, ...v.filter((x: unknown) => !base.includes(x))];
    } else {
      data[field] = v;
    }
    applied.push(field);
  }

  /* 有社区补充正文就不再算「资料待补充」 */
  if (doc.notes.length > 0) data.stub = false;

  data.communityFields = applied;
  data.communityNotes = doc.notes;
  data.communityPeople = contributors(doc);
  /* 社区那一份来源单独留一份：侧栏要标注「社区补充」，不能和研究来源混在一起显示 */
  const onlySources = fieldValue(doc, 'sources');
  data.communitySources = Array.isArray(onlySources) ? onlySources : [];

  return { ...entry, data } as T;
}

/** 所有地图（已合并社区覆盖） */
export async function getMaps() {
  const maps = await getCollection('maps');
  // 生成条目已统一标签写法；社区追加的标签也要归到同一个大小写，
  // 否则 Windows 构建时 /tags/BOSS战 与 /tags/boss战 会互相覆盖。
  const variants = new Map<string, Map<string, number>>();
  for (const m of maps) for (const tag of m.data.tags) {
    const key = tag.toLowerCase();
    if (!variants.has(key)) variants.set(key, new Map());
    const counts = variants.get(key)!;
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const canonical = new Map<string, string>();
  for (const [key, counts] of variants) {
    canonical.set(key, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))[0][0]);
  }
  return maps.map((m) => {
    const entry = mergeEntry(m as any);
    return { ...entry, data: { ...entry.data, tags: [...new Set(entry.data.tags.map((tag: string) => canonical.get(tag.toLowerCase()) || tag))] } };
  });
}
