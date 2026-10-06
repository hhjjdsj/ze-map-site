/**
 * 地图图片集（data/gallery/<slug>.json）—— **只放真实图片**：工坊预览图 + 玩家投稿。
 *
 * 图片本身存在 Cloudflare R2（`terr.ze-map.cn/gallery/<slug>/...`）——
 * 546 张地图 × 若干张图，塞进 git/dist 会重演 terr 那次的体积事故。
 * 入库的只有这份几百字节的清单（谁、什么说明），页面按清单取图。
 *
 * 清单有两个来源，两种都会被人手动改，所以**两边的写法必须一致**：
 *   · `scripts/gallery/fetch-workshop-previews.mjs` + `upload-gallery.mjs`：作者上传的工坊预览图
 *     （`kind: 'workshop'`，脚本重写清单时会保留玩家投稿的那些条目，不会冲掉）；
 *   · Worker 的写回（worker/gallery.ts + worker/submissions.ts 的 handleAdminFlush）：
 *     审核通过的玩家投稿（`kind: 'user'`，图片名 `u<投稿id>.<ext>`）。
 *
 * ⚠️ 以前这里还有「本站用真实碰撞地形渲染的 3D 视角图」（kind: 'render'）。
 *    2026-10-06 去掉了：那是本站画的示意图，和真实截图混在一起会误导人。
 *
 * ⚠️ 用 import.meta.glob 而不是 fs.readFile：预渲染时 cwd 是 dist/.prerender，
 * 相对路径读文件会直接构建失败（2026-09-23 线上部署失败的根因）。
 */
export interface GalleryImage {
  src: string;
  kind: string;
  caption: string;
  /** 投稿人昵称（玩家投稿才有） */
  by: string;
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
        by: String(i.by ?? ''),
      }))
      .filter((i) => i.src);
  }
  cache.set(slug, out);
  return out;
}
