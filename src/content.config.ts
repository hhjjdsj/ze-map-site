import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { DIFFICULTIES, DIFFICULTY_DEFAULT } from '../shared/difficulty.mjs';

/*
 * ⚠️ 读地图数据请用 src/lib/maps.ts 的 getMaps()，不要直接 getCollection('maps')。
 * 玩家覆盖（data/content/<slug>.json）对难度/标签等字段的覆盖是在那一层合并的，
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
    /* 难度枚举取自 shared/difficulty.mjs —— 页面、编辑器和 Worker 共用一份定义。
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
    /* 视频类型标注：{ "BVxxxx": "地图档案" } —— 页面据此给对应的视频挂小标签（可选）。
       原稿写在 data/research/<slug>.json 的 videoKinds 里，由生成脚本带进 frontmatter。 */
    videoKinds: z.record(z.string(), z.string()).optional(),
  /* 攻略区直接嵌入的原版文档（PDF 路径，可选） */
  manualPdf: z.string().optional(),
    /* 其他社区叫法（可选）：["X 社区：爬雪山【娱】", "UB 难度表：雪山逃亡v6"]
       —— 页面显示在地图名下方的小字里，帮「对不上名字」的人找到图。
       原稿（data/research）或社区投稿都能写；社区那份按追加 + 去重合并。 */
    aliases: z.array(z.string()).optional(),
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
    /**
     * 本站是否已经有人工整理的简介（正文开头那段导语）。
     * 由生成器在**有简介时**才写这一行（没简介的图连字段都不出现）。
     * 用途：社区投稿的「地图简介」只在这张图为 false 时渲染到开头 ——
     * 有本站简介的图不接受玩家简介覆盖（见 docs/content-model.md）。
     */
    hasSummary: z.boolean().default(false),
    /** 资料出处链接 */
    sources: z.array(z.string()).optional(),

  }),
});

export const collections = { maps };
