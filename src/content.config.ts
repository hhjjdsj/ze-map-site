import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { DIFFICULTIES, DIFFICULTY_DEFAULT } from '../shared/difficulty.mjs';

/*
 * ⚠️ 读地图数据请用 src/lib/maps.ts 的 getMaps()，不要直接 getCollection('maps')。
 * 社区投稿（data/community/<slug>.json）对难度/标签等字段的覆盖是在那一层合并的，
 * 直接 getCollection 会拿到未合并的原始数据，造成页面之间自相矛盾。
 */

const maps = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/maps' }),
  schema: z.object({
    title: z.string(),
    titleEn: z.string(),
    game: z.enum(['CS:S', 'CS:GO', 'CS2']),
    /* 下面四项对「数据条目」可能暂时没有资料，允许留空 */
    author: z.string().optional(),
    /** 作者署名的补充说明（多作者 / 原作与移植的区分），侧栏只显示简短 author */
    authorNote: z.string().optional(),
    version: z.string().optional(),
    /* 难度枚举取自 shared/difficulty.mjs —— 与投票 Worker 共用一份定义。
       类型断言只是因为 z.enum 需要「非空元组」字面量类型，运行时校验完全按 DIFFICULTIES 走。
       2026-09-24 的线上构建失败就是有人写了枚举外的「普通」，这份共享定义就是为了不再重演。 */
    difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).default(DIFFICULTY_DEFAULT),
    players: z.string().optional(),
    duration: z.string().optional(),
    stages: z.number(),
    /* 下载体积（MB）。来源是 data/map-sizes.json（s2ze 公开数据，npm run data:sizes），
       没有这张图的数据就没有这个字段，页面侧栏不显示「体积」那一行。 */
    size: z.number().optional(),
    tags: z.array(z.string()),
    cover: z.string().optional(),
    workshopUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
    videoUrls: z.array(z.string()).optional(),
    releaseDate: z.coerce.string().optional(),
    lastUpdated: z.coerce.string().optional(),
    featured: z.boolean().default(false),

    /* ===== 实体预览（工坊地图包烘焙数据及已入库的历史快照） ===== */
    /** 实体数据分片 slug，对应 /entity/data/<entitySlug>.bin */
    entitySlug: z.string().optional(),
    /** 原始索引键：<模式>/<地图名>/<工坊ID> */
    entityKey: z.string().optional(),
    /** 工坊文件 ID */
    workshopId: z.string().optional(),
    /** 工坊订阅数（热度） */
    workshopSubs: z.number().optional(),
    /** 工坊浏览量 */
    workshopViews: z.number().optional(),
    /** 工坊条目是否已下架 / 不可见 */
    workshopMissing: z.boolean().default(false),
    /** 工坊上传者昵称（不一定是原作者，常见于 CS2 移植版） */
    uploader: z.string().optional(),
    /** 实体总数（按图分片统计） */
    entityCount: z.number().optional(),
    /** 是否只有数据、正文待社区补充 */
    stub: z.boolean().default(false),
    /** 资料出处链接 */
    sources: z.array(z.string()).optional(),

    /*
     * ===== 社区补充 =====
     * 下面三项由 src/lib/maps.ts 的 mergeEntry() 在读取时注入，
     * 不要手写进 MDX（写了也会被合并结果覆盖）。这里声明是为了让类型与
     * 默认值稳定，页面可以直接解构不用担心 undefined。
     */
    /** 已被社区覆盖的字段名，用于在页面上标注来源 */
    communityFields: z.array(z.string()).default([]),
    /** 社区补充正文（审核通过、站长「写回仓库」后写入 data/community/<slug>.json） */
    communityNotes: z
      .array(
        z.object({
          text: z.string(),
          by: z.string(),
          at: z.string().nullable().default(null),
          /** 原本投的是哪个字段（story / body …）；null = 老数据，按「社区补充」显示 */
          field: z.string().nullable().default(null),
          /**
           * 被修订过才有（谁最后改的、什么时候、改过几次）。
           * by 始终是原作者 —— 别人帮忙改个错别字不该把署名换掉。
           */
          revisedBy: z.string().nullable().default(null),
          revisedAt: z.string().nullable().default(null),
          revision: z.number().default(0),
        })
      )
      .default([]),
    /** 贡献者昵称（去重） */
    communityPeople: z.array(z.string()).default([]),
    /**
     * 社区**单独**补充的来源链接。
     * 与 sources 分开：sources 是合并后的完整清单，这个只是社区那一份，
     * 侧栏标注「社区补充的来源」时用，避免和研究来源混在一起显示。
     */
    communitySources: z.array(z.string()).default([]),
  }),
});

export const collections = { maps };
