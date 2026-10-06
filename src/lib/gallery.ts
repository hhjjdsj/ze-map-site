/**
 * 地图图片集（data/gallery/<slug>.json）。
 *
 * 图片本身存在 Cloudflare R2（`terr.ze-map.cn/gallery/<slug>/...`）——
 * 546 张地图 × 5 张图 ≈ 200 MB，塞进 git/dist 会重演 terr 那次的体积事故。
 * 入库的只有这份几 KB 的清单（谁、什么机位、什么说明），页面按清单取图。
 *
 * 清单由 `scripts/gallery/render-gallery.mjs` + `upload-gallery.mjs` 生成：
 *   工坊预览图（作者上传的那张，第一张）+ 本站用真实地形渲染的 3D 机位图。
 *
 * ⚠️ 用 import.meta.glob 而不是 fs.readFile：预渲染时 cwd 是 dist/.prerender，
 * 相对路径读文件会直接构建失败（2026-09-23 线上部署失败的根因）。
 */
export interface GalleryImage {
  src: string;
  kind: string;
  caption: string;
}

const modules = import.meta.glob('../../data/gallery/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;

const cache = new Map<string, GalleryImage[]>();

/** 某张地图的图片集；没有就返回空数组（页面据此决定要不要渲染这一块） */
export function galleryFor(slug: string): GalleryImage[] {
  const hit = cache.get(slug);
  if (hit) return hit;
  const raw = modules[`../../data/gallery/${slug}.json`];
  const data = (raw?.default ?? raw) as { images?: unknown } | undefined;
  let out: GalleryImage[] = [];
  if (data && Array.isArray(data.images)) {
    out = data.images
      .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
      .map((i) => ({
        src: String(i.src ?? ''),
        kind: String(i.kind ?? 'other'),
        caption: String(i.caption ?? ''),
      }))
      .filter((i) => i.src);
  }
  cache.set(slug, out);
  return out;
}
