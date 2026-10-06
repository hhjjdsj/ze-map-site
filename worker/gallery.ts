/**
 * 地图图片集 —— **真实图片**：工坊预览图（作者自己发的）+ 玩家投稿。
 *
 * 为什么没有「本站渲染的 3D 视角图」了：那几张虽然清晰可控，但本质是本站画的示意图，
 * 放在「图片集」里和真实截图混在一起会误导人（2026-10-06 站长决定去掉）。
 * 现在图片集只收人拍的东西，投稿入口在 /submit/ 的「图片集图片」。
 *
 * 存储分工（和封面刻意不同）：
 *   - **待审图片**放 KV（`UPLOADS` 绑定的 `pending-gallery/<uuid>.<ext>`）：
 *     带 30 天 TTL，没人审的图会自己过期，不用配 R2 生命周期规则 —— 和封面同一套路；
 *   - **通过的图片**在写回仓库时挪进 R2（`gallery/<slug>/u<投稿id>.<ext>`，公开可读、
 *     一年 immutable）。图片不进 git：546 张地图 × 若干张图，塞进去会重演 terr 那次的体积事故；
 *   - **入库的只有清单** `data/gallery/<slug>.json`（几百字节），由 worker/submissions.ts 的
 *     攒批写回和社区文档一起提交 —— 一次提交 = 一次重建。
 *
 * 文件名为什么是 `u<投稿id>.<ext>`：id 由 D1 自增保证唯一，**同一个 id 每次重试都写同一个
 * 对象名** —— 写回失败重来时不会在桶里留下孤儿图。工坊预览图沿用 `05-workshop.<ext>`。
 */
import { detectImageFormat, imageSize } from '../shared/image-size.mjs';
import { GitError } from './community';
import type { Env } from './http';

/** 正式图片的 R2 前缀（公开读：https://terr.ze-map.cn/gallery/<slug>/<file>） */
export const GALLERY_PREFIX = 'gallery/';
/** 待审图片在 KV 里的前缀（与封面的 `pending/` 分开，便于分别排查） */
export const GALLERY_PENDING_PREFIX = 'pending-gallery/';
/** 图片集清单在仓库里的目录 */
export const GALLERY_MANIFEST_DIR = 'data/gallery';
/** 图片 URL 前缀：清单里存的就是完整 URL，页面直接当 <img src> 用 */
export const GALLERY_URL_BASE = 'https://terr.ze-map.cn/gallery';
/**
 * 单张上限 1.5 MB。比封面的 700 KB 宽得多 —— 封面要走 git blob（base64 有体积限制），
 * 图片集只进 R2。浏览器端已经压到 1600px webp，正常只有一两百 KB。
 */
export const GALLERY_MAX_BYTES = 1500 * 1024;
/** 最小宽度：手机竖屏截图也有 1080，480 只是用来挡住图标 / 表情包这类东西 */
export const GALLERY_MIN_WIDTH = 480;
/** 允许的扩展名（按文件内容判断，不看 content-type） */
export const GALLERY_EXTS = ['webp', 'jpg', 'png'];
/** 单张图的说明上限（会显示在图片下方） */
export const GALLERY_CAPTION_MAX = 60;
/** 一次写回最多处理几张图片集投稿：每张都要读 KV、写 R2、改清单，占子请求额度 */
export const GALLERY_PER_FLUSH = 8;
/** 单张地图的图片集上限：超了页面太长，也不该由一个人塞满（审核台会拒） */
export const GALLERY_PER_MAP_MAX = 24;

/** 存进 submissions.value 的图片集元数据 */
export interface GalleryMeta {
  key: string;
  ext: string;
  bytes: number;
  width: number;
  height: number;
  caption: string;
}

/** 从投稿内容里安全地取出图片集元数据（值可能被改坏） */
export function galleryMetaOf(value: unknown): GalleryMeta | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key) return null;
  const ext = typeof v.ext === 'string' ? v.ext : '';
  if (!GALLERY_EXTS.includes(ext)) return null;
  return {
    key: v.key,
    ext,
    bytes: Number(v.bytes) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    caption: typeof v.caption === 'string' ? v.caption : '',
  };
}

export interface GalleryCheck {
  ok: boolean;
  error?: string;
  format?: string;
  width?: number;
  height?: number;
}

/** 服务端权威校验：不信 content-type，只看字节（浏览器端压缩只是省流量，不算数） */
export function checkGalleryBytes(bytes: Uint8Array): GalleryCheck {
  if (bytes.length === 0) return { ok: false, error: '图片是空的' };
  if (bytes.length > GALLERY_MAX_BYTES) {
    return {
      ok: false,
      error: `图片 ${Math.round(bytes.length / 1024)} KB，超过 ${Math.round(GALLERY_MAX_BYTES / 1024)} KB 上限`,
    };
  }
  const format = detectImageFormat(bytes);
  if (!format) return { ok: false, error: '只收 webp / jpg / png 图片（按文件内容判断，不是看扩展名）' };
  const size = imageSize(bytes);
  if (!size) return { ok: false, error: '读不出图片尺寸，文件可能已损坏' };
  if (size.w < GALLERY_MIN_WIDTH) {
    return { ok: false, error: `宽度只有 ${size.w}px，至少 ${GALLERY_MIN_WIDTH}px` };
  }
  if (size.w * size.h > 40_000_000) return { ok: false, error: '图片尺寸过大' };
  return { ok: true, format, width: size.w, height: size.h };
}

/* ===== 图片路径 ===== */

export const galleryManifestPath = (slug: string) => `${GALLERY_MANIFEST_DIR}/${slug}.json`;

/** 正式对象的 R2 key 与公开 URL */
export const galleryObjectKey = (slug: string, name: string) => `${GALLERY_PREFIX}${slug}/${name}`;
export const galleryEntryUrl = (slug: string, name: string) =>
  `${GALLERY_URL_BASE}/${slug}/${encodeURIComponent(name)}`;

/** 玩家投稿的图片名：`u<投稿id>.<ext>`（同名重写 = 重试不留孤儿，见文件头说明） */
export const galleryEntryName = (id: number, ext: string) => `u${id}.${ext}`;

/**
 * 放进 R2（正式前缀）。失败抛 GitError —— 调用方（写回）必须让整批失败，
 * 绝不能让清单指向一张并不存在的图。
 */
export async function putGalleryImage(
  env: Env,
  slug: string,
  name: string,
  bytes: Uint8Array,
  format: string
): Promise<void> {
  if (!env.TERR) {
    throw new GitError('图片集功能尚未配置（缺少 R2 绑定 TERR，见 wrangler.jsonc）', 503);
  }
  await env.TERR.put(galleryObjectKey(slug, name), bytes, {
    httpMetadata: {
      contentType: `image/${format === 'jpg' ? 'jpeg' : format}`,
      /* 文件名里带投稿 id，内容不会变：可以放心长缓存 */
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
}

/* ===== 清单（data/gallery/<slug>.json）===== */

export interface GalleryEntry {
  src: string;
  /** workshop（作者上传的工坊预览图） / user（玩家投稿） / other（历史遗留） */
  kind: string;
  caption: string;
  /** 投稿人昵称（选填，页面会署上） */
  by?: string;
}

export interface GalleryManifest {
  slug: string;
  count: number;
  images: GalleryEntry[];
}

/**
 * 解析清单文本。**坏文件不抛错**：当成空清单，本次写回会把它重写成合法结构
 * （和 worker/community.ts 对社区文档的做法一致）。
 */
export function parseManifest(text: string | null, slug: string): GalleryManifest {
  let raw: unknown = null;
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }
  const list = (raw as { images?: unknown } | null)?.images;
  const images: GalleryEntry[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const src = typeof o.src === 'string' ? o.src.trim() : '';
      if (!src) continue;
      const entry: GalleryEntry = {
        src,
        kind: typeof o.kind === 'string' && o.kind ? o.kind : 'other',
        caption: typeof o.caption === 'string' ? o.caption : '',
      };
      if (typeof o.by === 'string' && o.by) entry.by = o.by;
      images.push(entry);
    }
  }
  return { slug, count: images.length, images };
}

/** 追加图片（按 src 去重，count 重算）；返回新对象，不改入参 */
export function withImages(manifest: GalleryManifest, entries: GalleryEntry[]): GalleryManifest {
  const seen = new Set(manifest.images.map((i) => i.src));
  const images = [...manifest.images];
  for (const e of entries) {
    if (!e.src || seen.has(e.src)) continue;
    seen.add(e.src);
    images.push(e);
  }
  return { slug: manifest.slug, count: images.length, images };
}

/** 清单落盘的文本（与 scripts/gallery/upload-gallery.mjs 的写法保持一致：2 空格 + 末尾换行） */
export function serializeManifest(manifest: GalleryManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
