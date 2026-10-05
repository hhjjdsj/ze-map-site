/**
 * 社区投稿（P2）—— 投稿进队列、审核、写回 git。
 *
 * 流程：
 *   任何人 POST /api/submit  →  submissions(status=pending)
 *   站长   GET  /api/admin/queue        （密钥）
 *   站长   POST /api/admin/review 通过  → 写 data/community/<slug>.json → status=applied
 *   站长   POST /api/admin/review 驳回  → status=rejected（可带理由）
 *   push 触发 Cloudflare 重建 → 页面出现社区内容
 */

import { applySubmission, isItemField, isNoteField, touch } from '../shared/community-doc.mjs';
import { FIELD_RULES, LIMITS, isField, validateValue } from '../shared/submission-fields.mjs';
import {
  GitError,
  type CommitFile,
  type CommunityFile,
  commitFiles,
  communityPath,
  readCommunityDoc,
} from './community';
import {
  checkCoverBytes,
  coverMetaOf,
  coverRepoPath,
  coverUrl,
  dropPendingCover,
  imageResponse,
  pendingCoverKey,
  putPendingCover,
  readPendingCover,
} from './covers';
import { allowWrite, fail, isBanned, json, readJsonBody, type Env } from './http';
import { SLUG_RE } from './votes';

interface SubmissionRow {
  id: number;
  map_slug: string;
  field: string;
  value: string;
  note: string | null;
  submitter: string | null;
  contact: string | null;
  status: string;
  created_at: number;
  reviewed_at: number | null;
  reviewer: string | null;
  reject_note: string | null;
  commit_sha: string | null;
  error: string | null;
}

/* ===== 小工具 ===== */

/**
 * 投稿额度：小时桶 + 天桶（文本投稿与封面投稿**共用** `submit` 桶，防止靠两个入口翻倍）。
 * 为什么不设成「无限」：`TURNSTILE_SECRET` 没配时，这两个桶是唯一的防刷闸门 ——
 * 脚本灌满待审队列会挤掉正常投稿，也会吃掉 D1 免费额度（每天 10 万行写入）。
 * 300 条/小时对正常人是天文数字（手打一天也到不了），所以它实际只拦脚本。
 */
async function submissionQuota(env: Env, ipHash: string): Promise<Response | null> {
  if (!(await allowWrite(env, ipHash, 'submit', LIMITS.perHour))) {
    return fail(`投稿太频繁了（一小时最多 ${LIMITS.perHour} 条），请过一会儿再试`, 429);
  }
  if (LIMITS.perDay > 0 && !(await allowWrite(env, ipHash, 'submit', LIMITS.perDay, 'day'))) {
    return fail(`这个网络出口今天投得太多了（上限 ${LIMITS.perDay} 条），请明天再试`, 429);
  }
  return null;
}

function optString(
  v: unknown,
  max: number,
  label: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, error: `${label}格式不对` };
  const s = v.trim();
  if (s.length > max) return { ok: false, error: `${label}最多 ${max} 个字` };
  return { ok: true, value: s };
}

/** 投稿内容存在 submissions.value 里（TEXT，JSON）。坏掉时返回 null，由调用方决定怎么报错。 */
function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Turnstile 校验。没配 TURNSTILE_SECRET 就跳过（这时靠限流 + 人工审核兜底）。 */
async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

/* ===== 公开接口 ===== */

/** POST /api/submit */
export async function handleSubmit(
  request: Request,
  env: Env,
  ipHash: string,
  rawIp: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  /* 16 KB：神器 / 道具一次能交 40 行（字段规则里另有 6000 字的文本总量上限），
     8 KB 装不下 —— 但也没有放开到「随便传」的程度。 */
  const parsed = await readJsonBody(request, 16384);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const slug = typeof b.map === 'string' ? b.map.trim() : '';
  const field = typeof b.field === 'string' ? b.field.trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  if (!isField(field)) return fail('不认识的字段');

  const checked = validateValue(field, b.value);
  if (!checked.ok) return fail(checked.error);

  const submitter = optString(b.submitter, LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(b.contact, LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(b.note, LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, b.turnstileToken, rawIp))) {
    return fail('人机验证没通过，请重试', 400);
  }

  const quota = await submissionQuota(env, ipHash);
  if (quota) return quota;

  const row = await env.DB.prepare(
    `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8) RETURNING id`
  )
    .bind(slug, field, JSON.stringify(checked.value), note.value, submitter.value, contact.value, ipHash, Date.now())
    .first<{ id: number }>();

  return json({
    ok: true,
    id: row?.id ?? null,
    message: '已收到，审核通过后会出现在条目里',
  });
}

/**
 * GET /api/submission?id=<id> —— 投稿人查自己的审核状态。
 *
 * 说明：id 是自增整数，理论上可被枚举。所以这里**只返回状态与理由**，
 * 不回显投稿内容、昵称和联系方式 —— 枚举者拿不到别人填了什么。
 */
export async function handleSubmissionStatus(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const row = await env.DB.prepare(
    `SELECT status, field, map_slug, reject_note, created_at, commit_sha FROM submissions WHERE id = ?1`
  )
    .bind(id)
    .first<{
      status: string;
      field: string;
      map_slug: string;
      reject_note: string | null;
      created_at: number;
      commit_sha: string | null;
    }>();

  if (!row) return fail('没有这条投稿', 404);
  return json({ ok: true, id, ...row });
}

/* ===== 封面投稿（B 方案）：multipart 上传 → KV 暂存 → 审核后进仓库 ===== */

/**
 * POST /api/submit-cover —— multipart/form-data
 *   map / submitter / contact / note / turnstileToken + 文件字段 cover
 *
 * 与 /api/submit 的关系：走同一套限流桶（免得有人靠两个入口把额度翻倍）、
 * 同一套封禁与人机校验，只是内容从 JSON 换成文件。
 */
export async function handleSubmitCover(
  request: Request,
  env: Env,
  ipHash: string,
  rawIp: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  /* 先看 Content-Length：明显超限的直接拒，别把整个 body 读进内存 */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > 2 * 1024 * 1024) return fail('上传内容过大', 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('上传格式不对（应为 multipart/form-data）');
  }

  const slug = typeof form.get('map') === 'string' ? String(form.get('map')).trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  const file = form.get('cover');
  if (!(file instanceof File) && !(file instanceof Blob)) return fail('没有收到图片文件');
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());

  /* 服务端权威校验：不看 content-type，只看字节（客户端压缩只是省流量，不算数） */
  const check = checkCoverBytes(bytes);
  if (!check.ok || !check.format) return fail(check.error ?? '图片不合法');

  const submitter = optString(form.get('submitter'), LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(form.get('contact'), LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(form.get('note'), LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, form.get('turnstileToken'), rawIp))) {
    return fail('人机验证没通过，请重试', 400);
  }

  const quota = await submissionQuota(env, ipHash);
  if (quota) return quota;

  /* 先写 KV 再写 D1：反过来的话 D1 里会留下指向不存在图片的记录 */
  const key = pendingCoverKey(check.format);
  try {
    await putPendingCover(env, key, bytes, check.format);
  } catch (err) {
    const e = err as GitError;
    return fail(e?.message || '图片暂存失败', typeof e?.status === 'number' ? e.status : 500);
  }

  const meta = {
    key,
    ext: check.format,
    bytes: bytes.length,
    width: check.width ?? 0,
    height: check.height ?? 0,
  };

  try {
    const row = await env.DB.prepare(
      `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at)
       VALUES (?1,'cover',?2,?3,?4,?5,?6,'pending',?7) RETURNING id`
    )
      .bind(slug, JSON.stringify(meta), note.value, submitter.value, contact.value, ipHash, Date.now())
      .first<{ id: number }>();

    return json({
      ok: true,
      id: row?.id ?? null,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      message: '已收到封面，审核通过后会出现在条目里',
    });
  } catch (err) {
    await dropPendingCover(env, key); // 回滚：别留下没人认领的图片
    throw err;
  }
}

/** GET /api/admin/cover/<id> —— 审核台取待审图片（走 /api/admin/* 的密钥校验） */
export async function handleAdminCover(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const id = Number(path.slice('/api/admin/cover/'.length));
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const row = await env.DB.prepare(`SELECT field, value FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<{ field: string; value: string }>();
  if (!row) return fail('没有这条投稿', 404);
  if (row.field !== 'cover') return fail('这条投稿不是封面', 400);

  const meta = coverMetaOf(parseStoredValue(row.value));
  if (!meta) return fail('这条封面投稿缺少图片信息', 500);

  try {
    const pending = await readPendingCover(env, meta.key);
    if (!pending) {
      return fail(
        `待审图片在 KV 里找不到（key=${meta.key}）。常见原因是投稿时线上还是旧版本或换了存储，也可能已过期 —— 让投稿人重新上传即可`,
        410
      );
    }
    return imageResponse(pending.bytes, pending.contentType);
  } catch (err) {
    const e = err as GitError;
    return fail(e?.message || '读取图片失败', typeof e?.status === 'number' ? e.status : 500);
  }
}

/* ===== 审核台接口（全部要 ADMIN_TOKEN） ===== */

/** GET /api/admin/queue?status=pending&limit=50 */
export async function handleAdminQueue(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const status = url.searchParams.get('status') ?? 'pending';
  /* approved = 审核通过但还没写回仓库（攒批队列），见 handleAdminFlush */
  if (!['pending', 'approved', 'applied', 'rejected'].includes(status)) return fail('状态不合法');
  const limitRaw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const { results } = await env.DB.prepare(
    `SELECT id, map_slug, field, value, note, submitter, contact, status, created_at,
            reviewed_at, reviewer, reject_note, commit_sha, error
     FROM submissions WHERE status = ?1 ORDER BY created_at ASC LIMIT ?2`
  )
    .bind(status, limit)
    .all<SubmissionRow>();

  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`
  ).all<{ status: string; n: number }>();

  /*
   * 附上社区文档里该字段的当前值，审核员好做「现值 vs 新值」对比。
   * 读不到（没配 GITHUB_TOKEN、网络抽风）不算错误 —— 队列照样要能看，
   * 每张图只读一次。
   */
  const cache = new Map<string, CommunityFile | null>();
  const items = [];
  for (const row of results ?? []) {
    let current: unknown = null;
    try {
      if (!cache.has(row.map_slug)) cache.set(row.map_slug, await readCommunityDoc(env, row.map_slug));
      const doc = cache.get(row.map_slug)?.doc;
      /* 神器 / 道具的「现值」是社区文档里已有的行，不是 fields 里的某个值 */
      current = isItemField(row.field)
        ? (doc?.items ?? [])
        : isNoteField(row.field)
          ? null
          : (doc?.fields?.[row.field]?.v ?? null);
    } catch {
      cache.set(row.map_slug, null as never);
    }

    let value: unknown = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    items.push({ ...row, value, current });
  }

  return json({
    ok: true,
    status,
    items,
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
    gitReady: Boolean(env.GITHUB_TOKEN),
  });
}

/**
 * POST /api/admin/review
 *   body: { id, action: 'approve'|'reject', rejectNote?, reviewer? }
 *   也接受批量：{ ids: [1,2,3], action: 'approve', reviewer? }
 *
 * ⚠️ 2026-10-05 起「通过」**不再立刻写回仓库**，而是把状态置成 `approved`（攒着），
 * 由 POST /api/admin/flush 一次性写回 —— 一次提交 = 一次 Cloudflare 重建。
 * 以前每条通过都独立提交，攒 20 条就是 20 次重建（免费版每月只有 3000 构建分钟）。
 */
export async function handleAdminReview(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const action = typeof b.action === 'string' ? b.action : '';
  if (action !== 'approve' && action !== 'reject') return fail('action 只能是 approve / reject');

  const reviewerRaw = optString(b.reviewer, 32, '审核人');
  if (!reviewerRaw.ok) return fail(reviewerRaw.error);
  const reviewer = reviewerRaw.value;

  /* 单个 id 与批量 ids 都收：批量只是省几次请求，逻辑完全一样 */
  const ids = Array.isArray(b.ids)
    ? [...new Set(b.ids.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0))]
    : [Number(b.id)];
  if (!ids.length || ids.some((n: number) => !Number.isInteger(n) || n <= 0)) return fail('id 不合法');

  const rejectNoteRaw = action === 'reject' ? optString(b.rejectNote, 300, '驳回理由') : null;
  if (rejectNoteRaw && !rejectNoteRaw.ok) return fail(rejectNoteRaw.error);
  const rejectNote = rejectNoteRaw && rejectNoteRaw.ok ? rejectNoteRaw.value : '';

  const results: Array<{ id: number; ok: boolean; status?: string; error?: string }> = [];

  for (const id of ids) {
    const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<SubmissionRow>();
    if (!sub) {
      results.push({ id, ok: false, error: '找不到这条投稿' });
      continue;
    }
    if (sub.status === 'applied') {
      results.push({ id, ok: false, error: '已经写回仓库了' });
      continue;
    }
    if (sub.status === 'rejected') {
      results.push({ id, ok: false, error: '已被驳回' });
      continue;
    }

    /* --- 驳回 --- */
    if (action === 'reject') {
      await env.DB.prepare(
        `UPDATE submissions SET status='rejected', reviewed_at=?1, reviewer=?2, reject_note=?3, error=NULL WHERE id=?4`
      )
        .bind(Date.now(), reviewer, rejectNote, id)
        .run();
      /* 封面被驳回：KV 里的待审图没人会再来看了，直接删掉 */
      if (sub.field === 'cover') {
        const meta = coverMetaOf(parseStoredValue(sub.value));
        if (meta) await dropPendingCover(env, meta.key);
      }
      results.push({ id, ok: true, status: 'rejected' });
      continue;
    }

    /* --- 通过：只入队（攒批），不改仓库 --- */
    if (parseStoredValue(sub.value) === null) {
      results.push({ id, ok: false, error: '这条投稿的值已损坏，无法应用' });
      continue;
    }
    await env.DB.prepare(
      `UPDATE submissions SET status='approved', reviewed_at=?1, reviewer=?2, reject_note=NULL, error=NULL WHERE id=?3`
    )
      .bind(Date.now(), reviewer, id)
      .run();
    results.push({ id, ok: true, status: 'approved' });
  }

  const staged = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status='approved'`).first<{ n: number }>();
  return json({
    ok: results.every((r) => r.ok),
    results,
    staged: staged?.n ?? 0,
    message: action === 'approve'
      ? '已攒下。到「待写回」里点一次「写回仓库」才会生效（一次提交 = 一次重建）'
      : '已驳回',
  });
}

/**
 * POST /api/admin/flush  body: { reviewer? }
 *
 * 把「审核通过但还没写回仓库」的投稿（status=approved）**一次性**写回：
 * 不管涉及多少张图、多少条投稿、多少张封面，都只有**一个 commit** —— 于是只触发一次
 * Cloudflare 重建（2026-10-05 之前是一条一次提交一次重建，攒批后省掉大量构建分钟）。
 *
 * 分组顺序：
 *   1. 读出所有 approved 投稿，按地图分组，逐条 applySubmission 到内存里的文档；
 *   2. 封面：从 KV 取待审图 → 作为二进制写进同一个 commit，顺带把同名的其它扩展名删掉，
 *      并在文档里把 cover 记成 **URL**（页面直接当 <img src> 用，绝不能存仓库路径）；
 *   3. 一次提交（worker/community.ts 的 commitFiles，Git Data API）；
 *   4. 提交成功后才改 D1 状态、才清 KV —— 中途失败什么都不动，重试即可。
 */
export async function handleAdminFlush(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const reviewerRaw = optString(parsed.body.reviewer, 32, '审核人');
  if (!reviewerRaw.ok) return fail(reviewerRaw.error);
  const reviewer = reviewerRaw.value;
  const audit = reviewer ? `，审核 ${reviewer}` : '';

  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status='approved' ORDER BY created_at ASC LIMIT 200`
  ).all<SubmissionRow>();
  if (!rows?.length) return json({ ok: true, committed: 0, message: '没有待写回的投稿' });

  /* 按地图分组：同一张图的多条投稿合并进同一份文档 */
  const bySlug = new Map<string, SubmissionRow[]>();
  for (const row of rows) {
    const list = bySlug.get(row.map_slug) ?? [];
    list.push(row);
    bySlug.set(row.map_slug, list);
  }

  const skipped: Array<{ id: number; reason: string }> = [];
  const files: CommitFile[] = [];
  const pendingCovers: Array<{ id: number; key: string }> = [];
  const authors = new Set<string>();
  const fieldSummary = new Set<string>();

  try {
    for (const [slug, list] of bySlug) {
      const { doc } = await readCommunityDoc(env, slug);
      let touched = false;

      for (const row of list) {
        const value = parseStoredValue(row.value);
        if (value === null) {
          skipped.push({ id: row.id, reason: '投稿的值已损坏' });
          continue;
        }

        /* 封面：图片进同一个 commit，文档里只记 URL */
        if (row.field === 'cover') {
          const meta = coverMetaOf(value);
          if (!meta) {
            skipped.push({ id: row.id, reason: '缺少图片信息' });
            continue;
          }
          const pending = await readPendingCover(env, meta.key);
          if (!pending) {
            skipped.push({ id: row.id, reason: 'KV 里的待审图片已不在（让投稿人重新上传）' });
            continue;
          }
          const check = checkCoverBytes(pending.bytes);
          if (!check.ok || !check.format) {
            skipped.push({ id: row.id, reason: `待审图片校验未通过：${check.error ?? '未知'}` });
            continue;
          }
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < pending.bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...pending.bytes.subarray(i, i + CHUNK));
          }
          files.push({ path: coverRepoPath(slug, check.format), base64: btoa(bin) });
          for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
            if (ext !== check.format) files.push({ path: coverRepoPath(slug, ext), remove: true });
          }
          pendingCovers.push({ id: row.id, key: meta.key });
          applySubmission(doc, {
            id: row.id,
            field: 'cover',
            value: coverUrl(slug, check.format),
            submitter: row.submitter,
            reviewedAt: row.reviewed_at ?? Date.now(),
          });
          touched = true;
        } else {
          const change = applySubmission(doc, {
            id: row.id,
            field: row.field,
            value,
            submitter: row.submitter,
            reviewedAt: row.reviewed_at ?? Date.now(),
          });
          isItemField(change.field) ? fieldSummary.add(`${slug} 神器/道具`) : fieldSummary.add(`${slug} ${change.field}`);
          touched = true;
        }
        if (row.submitter) authors.add(row.submitter);
      }

      if (touched) {
        touch(doc);
        files.push({ path: communityPath(slug), text: JSON.stringify(doc, null, 2) + '\n' });
      }
    }

    const committedIds = rows.filter((r) => !skipped.some((s) => s.id === r.id));
    if (!committedIds.length) {
      await markErrors(env, skipped);
      return json({ ok: false, committed: 0, skipped, message: '没有可写回的投稿，见 skipped 原因' }, 409);
    }

    const who = authors.size ? [...authors].slice(0, 3).join('、') : '匿名';
    const summary = fieldSummary.size > 4
      ? `${[...fieldSummary].slice(0, 4).join('、')} 等 ${fieldSummary.size} 项`
      : [...fieldSummary].join('、');
    const message = `社区投稿：${bySlug.size} 张图 · ${committedIds.length} 条（${summary}）（by ${who}${audit}）`;

    const { sha: commitSha, files: fileCount } = await commitFiles(env, files, message);

    /* 提交成功后才动 D1 与 KV */
    const now = Date.now();
    for (const row of committedIds) {
      await env.DB.prepare(
        `UPDATE submissions SET status='applied', commit_sha=?1, error=NULL WHERE id=?2`
      )
        .bind(commitSha, row.id)
        .run();
    }
    for (const c of pendingCovers) await dropPendingCover(env, c.key);
    await markErrors(env, skipped);

    return json({
      ok: true,
      committed: committedIds.length,
      maps: bySlug.size,
      files: fileCount,
      commit: commitSha,
      skipped,
      note: '已写回仓库，Cloudflare 会在 1~2 分钟内重建上线（一次提交只重建一次）',
      _now: now,
    });
  } catch (err) {
    const e = err as GitError;
    const text = e?.message || String(err);
    /* 失败时**不改状态**：投稿仍在「待写回」里，修好（比如换 token）再点一次即可 */
    await markErrors(env, [{ id: 0, reason: text.slice(0, 280) }]);
    return fail(text, typeof e?.status === 'number' ? e.status : 500);
  }
}

/** 把「这条为什么没写回」记进 D1，审核台能直接看到（id=0 表示整体失败） */
async function markErrors(env: Env, skipped: Array<{ id: number; reason: string }>): Promise<void> {
  for (const s of skipped) {
    if (!s.id) continue;
    await env.DB.prepare(`UPDATE submissions SET error=?1 WHERE id=?2`)
      .bind(s.reason.slice(0, 300), s.id)
      .run();
  }
}

/** POST /api/admin/unstage  body: {id} —— 把「待写回」的投稿退回待审（改主意时用） */
export async function handleAdminUnstage(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const sub = await env.DB.prepare(`SELECT status FROM submissions WHERE id=?1`)
    .bind(id)
    .first<{ status: string }>();
  if (!sub) return fail('找不到这条投稿', 404);
  if (sub.status !== 'approved') return fail('只有「待写回」的投稿可以撤回', 409);

  await env.DB.prepare(
    `UPDATE submissions SET status='pending', reviewed_at=NULL, reviewer=NULL, error=NULL WHERE id=?1`
  )
    .bind(id)
    .run();
  return json({ ok: true, id, status: 'pending' });
}

/** POST /api/admin/ban  body: {id, reason?} —— 用投稿 id 封禁，审核台不需要接触 ip_hash */
export async function handleAdminBan(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;

  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');
  const reasonRaw = optString(parsed.body.reason, 200, '封禁理由');
  if (!reasonRaw.ok) return fail(reasonRaw.error);

  const sub = await env.DB.prepare(`SELECT ip_hash, map_slug FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<{ ip_hash: string; map_slug: string }>();
  if (!sub) return fail('找不到这条投稿', 404);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO bans (ip_hash, reason, banned_at) VALUES (?1,?2,?3)
     ON CONFLICT(ip_hash) DO UPDATE SET reason=excluded.reason, banned_at=excluded.banned_at`
  )
    .bind(sub.ip_hash, reasonRaw.value, now)
    .run();

  // 顺手把这个来源所有待审投稿一并驳回，免得还要一条条点
  const cleared = await env.DB.prepare(
    `UPDATE submissions SET status='rejected', reject_note='来源已被封禁', reviewed_at=?1
     WHERE ip_hash=?2 AND status='pending'`
  )
    .bind(now, sub.ip_hash)
    .run();

  return json({ ok: true, banned: true, alsoRejected: cleared ? true : true });
}
