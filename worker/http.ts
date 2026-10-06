/**
 * Worker 的公共小工具：响应封装、IP 哈希、限流、环境类型。
 * 拆出来是为了让 votes.ts / submissions.ts / index.ts 都能用同一套。
 */

/*
 * 只声明本文件真正用到的 D1 接口。
 * 这样不必为了类型引入 @cloudflare/workers-types 依赖（少一个包、少一次 lock 变更）。
 */
export interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}
export interface D1 {
  prepare(query: string): D1Prepared;
}

/*
 * 同理，只声明用到的 Workers KV 接口（避免引 @cloudflare/workers-types）。
 * 线上真正的 KVNamespace 是这个形状的超集，结构兼容。
 */
export interface KVLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { expirationTtl?: number; metadata?: unknown }
  ): Promise<void>;
  /** ⚠️ 线上必须用对象形式 `{ type: 'arrayBuffer' }`，字符串简写会被当成"没指定类型" */
  getWithMetadata(
    key: string,
    options: { type: 'arrayBuffer' }
  ): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  delete(key: string): Promise<void>;
}

/** 同理，只声明用到的 R2 接口（wrangler.jsonc 的 r2_buckets → TERR） */
export interface R2Like {
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
}

export interface Env {
  DB: D1;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** 待审封面的临时存储（wrangler.jsonc 的 kv_namespaces → UPLOADS） */
  UPLOADS?: KVLike;
  /** 地形分片所在的 R2 桶（wrangler.jsonc 的 r2_buckets → TERR）：/terr/* 同源回退用 */
  TERR?: R2Like;
  /** IP 哈希用的盐，必须用 `wrangler secret put IP_SALT` 设置 */
  IP_SALT?: string;
  /** 审核台密钥，必须用 `wrangler secret put ADMIN_TOKEN` 设置 */
  ADMIN_TOKEN?: string;
  /** 可选：配置后投稿会要求 Turnstile 人机验证；不配就靠限流 + 人工审核 */
  TURNSTILE_SECRET?: string;
  /** 写回 git 用的细粒度 PAT，`wrangler secret put GITHUB_TOKEN` */
  GITHUB_TOKEN?: string;
  /** 以下三项可选，默认值见 worker/community.ts */
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  /** 便于本地拿假 GitHub 做测试 */
  GITHUB_API_BASE?: string;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

/** 本地开发（`wrangler dev` 跑在 localhost）时允许缺省 IP_SALT */
export function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** 按小时分桶，如 '2026-09-24T07' */
export function hourWindow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** 按天分桶，如 '2026-09-24'（投稿的每日兜底额度用这个） */
export function dayWindow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * 限流：同一 IP 在同一个桶里、同一时间窗内最多 limit 次。
 * 投票与投稿用不同的桶名，互不挤占额度；period 决定窗口是小时还是天。
 * 用 UPSERT + RETURNING 一条语句完成「自增并读回」，避免并发下的竞态。
 */
export async function allowWrite(
  env: Env,
  ipHash: string,
  bucket: string,
  limit: number,
  period: 'hour' | 'day' = 'hour'
): Promise<boolean> {
  const window = `${bucket}:${period === 'day' ? dayWindow() : hourWindow()}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (ip_hash, window, count) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash, window) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(ipHash, window)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** 是否被封禁 */
export async function isBanned(env: Env, ipHash: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ip_hash FROM bans WHERE ip_hash = ?1`)
    .bind(ipHash)
    .first<{ ip_hash: string }>();
  return Boolean(row);
}

/**
 * 解析并校验「同源」。
 * @returns null 表示通过；否则返回应当直接返回的错误响应。
 */
export function checkOrigin(request: Request, url: URL): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return fail('来源不合法', 403);
  }
  if (originHost !== url.host) return fail('跨站请求被拒绝', 403);
  return null;
}

/** 读取并限长的 JSON 请求体 */
export async function readJsonBody(
  request: Request,
  maxBytes = 8192
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const raw = await request.text();
  if (raw.length > maxBytes) return { ok: false, response: fail('请求体过大', 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: fail('请求体不是合法 JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: fail('请求体格式不对') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** 恒定时间字符串比较（避免用 === 比较密钥时泄漏长度/内容信息） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验审核台密钥。未配置 ADMIN_TOKEN 时一律拒绝（而不是放行）。 */
export function checkAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return fail('审核台尚未配置（缺少 ADMIN_TOKEN 密钥）', 503);
  }
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, env.ADMIN_TOKEN)) {
    return fail('未授权', 401);
  }
  return null;
}
