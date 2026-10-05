/**
 * 投稿封面（B 方案：网页自助上传）：校验 → 临时存 KV → 审核通过后提交进仓库。
 *
 * 分工刻意划清：
 *   - **浏览器端**负责把图裁成 16:9、转 webp（不支持就退 JPEG）、压到 ~100 KB —— 省流量、省时间；
 *   - **服务端**负责权威校验（大小、magic bytes、尺寸），并把文件名从 slug + 实际格式生成。
 *     文件名绝不由客户端决定：写错名字的封面**永远不会显示**，而构建、CI、页面全都正常
 *     （老坑，见 scripts/content/verify-covers.mjs 的说明），所以这里从根上不给这个口子。
 *
 * 上限为什么是 700 KB 而不是 cover:verify 的 800 KB：
 *   二进制要 base64 之后走 GitHub contents API，800 KB → 约 1.07 MB，贴到单文件限制边上；
 *   700 KB → 约 960 KB，留出余量。`npm run cover:set` 的产物约 100 KB，正常投稿远碰不到上限。
 */

import { detectImageFormat, imageSize } from '../shared/image-size.mjs';
import { GitError, deleteRepoFile, listRepoDir, writeRepoBinary } from './community';
import type { Env } from './http';

export const COVER_DIR = 'public/images/covers/custom';
export const COVER_MAX_BYTES = 700 * 1024;
export const COVER_MIN_WIDTH = 640;
/** 允许的扩展名，按生成器的取图优先级排列（webp → png → jpg → jpeg） */
export const COVER_EXTS = ['webp', 'png', 'jpg', 'jpeg'];

/** 存进 submissions.value 的封面元数据 */
export interface CoverMeta {
  key: string;
  ext: string;
  bytes: number;
  width: number;
  height: number;
}

/** 从投稿内容里安全地取出封面元数据（值可能被改坏） */
export function coverMetaOf(value: unknown): CoverMeta | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key) return null;
  const ext = typeof v.ext === 'string' ? v.ext : '';
  if (!COVER_EXTS.includes(ext)) return null;
  return {
    key: v.key,
    ext,
    bytes: Number(v.bytes) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
  };
}

export interface CoverCheck {
  ok: boolean;
  error?: string;
  format?: 'webp' | 'jpg' | 'png';
  width?: number;
  height?: number;
}

/** 服务端权威校验：不信 content-type，只看字节 */
export function checkCoverBytes(bytes: Uint8Array): CoverCheck {
  if (bytes.length === 0) return { ok: false, error: '图片是空的' };
  if (bytes.length > COVER_MAX_BYTES) {
    return {
      ok: false,
      error: `图片 ${Math.round(bytes.length / 1024)} KB，超过 ${COVER_MAX_BYTES / 1024} KB 上限`,
    };
  }
  const format = detectImageFormat(bytes);
  if (!format) return { ok: false, error: '只收 webp / jpg / png 图片（按文件内容判断，不是看扩展名）' };
  const size = imageSize(bytes);
  if (!size) return { ok: false, error: '读不出图片尺寸，文件可能已损坏' };
  if (size.w < COVER_MIN_WIDTH) {
    return { ok: false, error: `宽度只有 ${size.w}px，至少 ${COVER_MIN_WIDTH}px（详情页顶部要当大图用）` };
  }
  if (size.w * size.h > 40_000_000) return { ok: false, error: '图片尺寸过大' };
  return { ok: true, format, width: size.w, height: size.h };
}

/** KV 里的临时 key：<uuid>.<ext>，不暴露地图名，避免有人猜别人的待审图 */
export function pendingCoverKey(format: string): string {
  return `pending/${crypto.randomUUID()}.${format}`;
}

/** 待审图片的存放时长：30 天。KV 自带过期，不用再配生命周期规则 */
const PENDING_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 存进 KV。用 metadata 带上 content-type（KV 值本身没有头部），
 * 并设 expirationTtl —— 传了没人审的图会自己过期，不用额外配清理规则。
 */
export async function putPendingCover(
  env: Env,
  key: string,
  bytes: Uint8Array,
  format: string
): Promise<void> {
  if (!env.UPLOADS) {
    throw new GitError('封面功能尚未配置（缺少 KV 绑定 UPLOADS，见 wrangler.jsonc）', 503);
  }
  await env.UPLOADS.put(key, bytes, {
    expirationTtl: PENDING_TTL_SECONDS,
    metadata: { contentType: `image/${format}`, bytes: bytes.length },
  });
}

/**
 * 从 KV 读出待审图片。
 *
 * ⚠️ 一律用**对象形式** `{ type: 'arrayBuffer' }`（KV 官方文档的写法）。
 * 之前这里写的是字符串简写 `getWithMetadata(key, 'arrayBuffer')` —— 简写一旦被当成
 * "没指定类型"，KV 就会按**文本**解码二进制，读出来是空值；而调用方只看到我写死的
 * 「图片已不存在」，把真正的原因盖住了（2026-09-25 审核台就是被这条骗的）。
 *
 * 语义约定：返回 null 只代表「KV 里确实没这个 key」（或已过期）；读法/类型不对一律抛错，
 * 不许和"没有"混为一谈。
 */
export async function readPendingCover(
  env: Env,
  key: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!env.UPLOADS) throw new GitError('封面功能尚未配置（缺少 KV 绑定 UPLOADS）', 503);
  const { value, metadata } = await env.UPLOADS.getWithMetadata(key, { type: 'arrayBuffer' });
  if (value === null || value === undefined) return null;
  if (!(value instanceof ArrayBuffer)) {
    throw new GitError(
      `存储里的图片读出来不是二进制（key=${key}，实际类型 ${typeof value}）—— 说明读取方式不对，不是图丢了`,
      500
    );
  }
  const meta = (metadata ?? {}) as { contentType?: string };
  return {
    bytes: new Uint8Array(value),
    contentType: meta.contentType || 'application/octet-stream',
  };
}

/**
 * 删除待审图片；失败不影响主流程（KV 自带 30 天过期兜底）。
 * ⚠️ KV 是最终一致的：这里的删除在全球边缘最长约 60 秒才完全生效，不影响正常使用。
 */
export async function dropPendingCover(env: Env, key: string): Promise<void> {
  if (!env.UPLOADS || !key) return;
  try {
    await env.UPLOADS.delete(key);
  } catch {
    /* 忽略：留着也会自己过期 */
  }
}

export const coverRepoPath = (slug: string, ext: string) => `${COVER_DIR}/${slug}.${ext}`;

/**
 * 页面用的 **URL** 形式。
 *
 * ⚠️ 记进 data/community/<slug>.json 的必须是这个，不是仓库路径。
 * 生成器写进 frontmatter 的 `cover:` 是 URL（`/images/...`），社区覆盖的值会被直接当 URL 用；
 * 存成 `public/images/...` 的话，浏览器会按相对路径去 `/maps/<图>/public/images/...` 取，
 * 结果就是「封面变黑 + 一个破图小图标」（2026-09-26 真踩过，两处只差一个前缀）。
 */
export const coverUrl = (slug: string, ext: string) => `/images/covers/custom/${slug}.${ext}`;

/**
 * 把封面提交进仓库，并清掉**同一张图的其它扩展名**。
 *
 * ⚠️ **当前没有调用方**：2026-10-05 起攒批写回（`worker/submissions.ts` 的 `handleAdminFlush`）
 * 直接把图片和文档改动合成一个 commit，并在同一个 commit 里删掉其它扩展名。这里保留作参考实现，
 * 也说明「为什么必须清扩展名」这件事。
 *
 * 为什么要清：生成器按 webp → png → jpg → jpeg 取第一个命中的文件，
 * 如果 `ze_x.webp` 和 `ze_x.jpg` 同时存在，后者永远不生效却一直占着仓库 ——
 * 而且事后根本分不清哪张是"当前生效的那张"。同一个 commit 里删干净最省事。
 */
export async function commitCoverToRepo(
  env: Env,
  slug: string,
  bytes: Uint8Array,
  ext: string,
  message: string
): Promise<{ sha: string; removed: string[] }> {
  const target = coverRepoPath(slug, ext);
  const { sha } = await writeRepoBinary(env, target, bytes, message);

  const removed: string[] = [];
  let entries: { name: string }[] = [];
  try {
    entries = await listRepoDir(env, COVER_DIR);
  } catch {
    entries = []; // 列目录失败不该让整次审核失败：图已经提交上去了
  }
  for (const e of entries) {
    const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(e.name);
    if (!m) continue;
    if (m[1].toLowerCase() !== slug.toLowerCase()) continue;
    if (!COVER_EXTS.includes(m[2].toLowerCase())) continue;
    if (e.name === `${slug}.${ext}`) continue;
    try {
      if (await deleteRepoFile(env, `${COVER_DIR}/${e.name}`, `${message}（清掉旧扩展名 ${m[2]}）`)) {
        removed.push(e.name);
      }
    } catch {
      /* 删不掉就算了，生成器会按优先级取新的那张，不影响显示 */
    }
  }
  return { sha, removed };
}

/** 给审核台用的响应（图片本身，鉴权在外面做） */
export function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': contentType,
      /* 待审内容不进任何缓存 */
      'cache-control': 'private, no-store',
      'content-length': String(bytes.length),
    },
  });
}
