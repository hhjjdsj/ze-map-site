/**
 * 社区贡献文档 data/community/<slug>.json 的形状与读写辅助。
 *
 * Worker（写入）与站点构建（读取）共用这一份，避免两边对格式的理解漂移。
 *
 * 文件长这样：
 * {
 *   "v": 1,
 *   "slug": "ze_flowering",
 *   "updatedAt": "2026-09-24T07:00:00.000Z",
 *   "fields": {
 *     "difficulty": { "v": "普通", "by": "老王", "at": "...", "submission": 12 }
 *   },
 *   "notes": [
 *     { "text": "第二关的传送门……", "by": "某人", "at": "...", "submission": 13 }
 *   ],
 *   "items": [
 *     { "action": "update", "name": "Survivor", "cd": 60, "uses": 1, "note": "第四关才有",
 *       "by": "某人", "at": "...", "submission": 14 }
 *   ],
 *   "log": [ { "field": "difficulty", "from": "未知", "to": "普通", "by": "...", "at": "..." } ]
 * }
 *
 * 渲染优先级：社区（本文件） > 人工资料 data/research > 自动生成 src/content/maps
 *
 * 正文类字段（kind=longtext，例如「补充说明 / 纠错」body、「背景故事」story）
 * **不进 fields**，而是作为一条 note 追加到 notes 里（note 上带 field，标明投的是哪个字段），
 * 地图页再按字段分块显示：story → 「背景故事（社区投稿）」，body → 「社区补充」。
 * 判断走 isNoteField()，从字段表派生 —— 别再写死字段名。
 *
 * 神器 / 道具（kind=itemlist）**也不进 fields**：它是一行行的增量（更正 / 新增 / 删除），
 * 整表替换说不清来源，所以单独放 items[]，由生成器用 mergeItems() 合并进正文的表格。
 * 判断走 isItemField()，同样从字段表派生。
 */

import { FIELD_RULES } from './submission-fields.mjs';
import { itemKey, normalizeItemRow } from './items.mjs';

export const DOC_VERSION = 1;

/**
 * 这个字段是「正文类」吗（进 notes 而不是覆盖条目字段）。
 * 从 shared/submission-fields.mjs 的 kind 派生：加一个 longtext 字段就自动跟上。
 */
export const isNoteField = (field) => FIELD_RULES?.[field]?.kind === 'longtext';

/** 这个字段是「神器 / 道具行」吗（进 items，由生成器逐行合并） */
export const isItemField = (field) => FIELD_RULES?.[field]?.kind === 'itemlist';

/** 新建一个空文档 */
export function emptyDoc(slug) {
  return { v: DOC_VERSION, slug, updatedAt: null, fields: {}, notes: [], items: [], log: [] };
}

/**
 * 把任意（可能残缺、可能被人手改坏的）JSON 规整成合法文档。
 * 构建期也会走这里 —— 仓库里的文件万一被改坏，页面不该整个崩掉。
 */
export function normalizeDoc(slug, raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  if (d.fields && typeof d.fields === 'object') {
    for (const [k, v] of Object.entries(d.fields)) {
      if (v && typeof v === 'object' && 'v' in v) {
        fields[k] = { v: v.v, by: v.by ?? '匿名', at: v.at ?? null, submission: v.submission ?? null };
      } else if (v !== undefined && v !== null) {
        /* 容忍手写的简写形式：difficulty: "普通" */
        fields[k] = { v, by: '匿名', at: null, submission: null };
      }
    }
  }
  return {
    v: DOC_VERSION,
    slug,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    fields,
    notes: (Array.isArray(d.notes) ? d.notes : [])
      .filter((n) => n && typeof n.text === 'string' && n.text.trim())
      .map((n) => ({
        text: n.text,
        by: n.by ?? '匿名',
        at: n.at ?? null,
        submission: n.submission ?? null,
        /* 投的是哪个字段（story / body / 以后新增的长文本字段）。
           老文件没有这一项 → null，页面按「社区补充」显示。 */
        field: typeof n.field === 'string' && n.field ? n.field : null,
      })),
    log: Array.isArray(d.log) ? d.log : [],
    items: (Array.isArray(d.items) ? d.items : [])
      .map((row) => normalizeItemRow(row))
      .filter(Boolean),
  };
}

/**
 * 应用一条审核通过的投稿（就地修改 doc）。
 * @returns {{field: string, from: unknown, to: unknown}} 改动摘要，用于 git 提交信息
 */
export function applySubmission(doc, sub) {
  const at = new Date(sub.reviewedAt ?? Date.now()).toISOString();
  const by = sub.submitter || '匿名';

  if (isNoteField(sub.field)) {
    /* note 里记下**它原本投的是哪个字段**（story / body）：
       页面据此分块显示 —— 投「背景故事」的内容如果出现在「社区补充」里，
       投稿人会以为稿子丢了（2026-09-28 的反馈）。log 里本来也有这个信息，
       但渲染只读 notes，所以得在 note 上存一份。 */
    doc.notes.push({ text: sub.value, by, at, submission: sub.id ?? null, field: sub.field });
    doc.log.push({ field: sub.field, from: null, to: null, by, at, submission: sub.id ?? null });
    return { field: sub.field, from: null, to: sub.value };
  }

  /* 神器 / 道具：逐行合并。同名行以最后一次审核通过为准（投稿人会先看到旧值再改） */
  if (isItemField(sub.field)) {
    const incoming = (Array.isArray(sub.value) ? sub.value : [])
      .map((row) => normalizeItemRow(row, { by, at, submission: sub.id ?? null }))
      .filter(Boolean);
    if (!Array.isArray(doc.items)) doc.items = [];
    const applied = [];
    for (const row of incoming) {
      const key = itemKey(row.name);
      const i = doc.items.findIndex((x) => itemKey(x.name) === key);
      if (i >= 0) doc.items[i] = row;
      else doc.items.push(row);
      applied.push(row);
    }
    doc.log.push({ field: sub.field, from: null, to: applied.length, by, at, submission: sub.id ?? null });
    return { field: sub.field, from: null, to: applied };
  }

  const prev = doc.fields[sub.field]?.v ?? null;
  doc.fields[sub.field] = { v: sub.value, by, at, submission: sub.id ?? null };
  doc.log.push({ field: sub.field, from: prev, to: sub.value, by, at, submission: sub.id ?? null });
  return { field: sub.field, from: prev, to: sub.value };
}

/** 更新时间戳 */
export function touch(doc, at = new Date().toISOString()) {
  doc.updatedAt = at;
}

/** 所有贡献过的昵称（去重，按首次出现顺序） */
export function contributors(doc) {
  const seen = [];
  for (const f of Object.values(doc?.fields ?? {})) {
    if (f?.by && !seen.includes(f.by)) seen.push(f.by);
  }
  for (const n of doc?.notes ?? []) {
    if (n?.by && !seen.includes(n.by)) seen.push(n.by);
  }
  for (const row of doc?.items ?? []) {
    if (row?.by && !seen.includes(row.by)) seen.push(row.by);
  }
  return seen;
}

/** 取社区覆盖的字段值（没有就返回 undefined，调用方回退到人工/自动数据） */
export function fieldValue(doc, field) {
  return doc?.fields?.[field]?.v;
}

/** 取字段的归属信息（谁补的、什么时候） */
export function fieldMeta(doc, field) {
  return doc?.fields?.[field] ?? null;
}

/** 是否是一份「有内容」的文档（空文档不渲染任何东西） */
export function hasContent(doc) {
  return Boolean(
    doc &&
      (Object.keys(doc.fields ?? {}).length > 0 ||
        (doc.notes ?? []).length > 0 ||
        (doc.items ?? []).length > 0)
  );
}
