/**
 * 地图整页编辑的共享契约。
 *
 * 这份文件同时被构建期、编辑页和 Worker 使用。玩家内容是覆盖层，
 * 不是 research 的副本；缺省字段表示不修改，reset 表示移除覆盖。
 */

import { itemKey } from './items.mjs';
import { DIFFICULTIES, isDifficulty } from './difficulty.mjs';

export const PAGE_CONTENT_VERSION = 1;
export const PAGE_REVISION_MAX_BYTES = 64 * 1024;
export const GUIDE_ITEM_MAX = 30;
export const STAGE_ROW_MAX = 30;
export const ITEM_EDIT_MAX = 200; /* 2026-10-27：大图一次改 50+ 件神器很常见，40 会把整份 content 判非法 */
export const DOC_FONT_SIZE_MIN = 12;
export const DOC_FONT_SIZE_MAX = 32;
export const ITEM_NAME_MAX = 60;
export const ITEM_TEXT_MAX = 200;
export const ITEM_CD_MAX = 3600;
export const ITEM_USES_MAX = 99;
export const TAGS_MAX = 15;
export const TAG_MAX_LEN = 24;

export const DOC_COLOR_TOKENS = Object.freeze([
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'pink',
  'gray',
  'brown',
]);

const DOC_NODES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'figure',
]);

const DOC_MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'link', 'textStyle']);
const DOC_ALIGNMENTS = new Set(['left', 'center', 'right']);
const SAFE_TAG = /^[^\\/:*?"<>|#%]+$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isInteger = (value) => Number.isInteger(value);

export function emptyPageContent(slug) {
  return {
    v: PAGE_CONTENT_VERSION,
    slug,
    baseRev: null,
    researchRev: null,
    heroImage: null,
    tags: null,
    difficulty: null,
    blocks: [],
    guideCleared: false,
    infobox: {},
    stageRows: null,
    itemEdits: [],
    itemOrder: [],
    videos: null,
    history: [],
  };
}

/** 稳定序列化：key 排序，保证构建期与 Worker 对同一份内容算出同一个 revision。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 内容文件的版本号：不看 baseRev 自身，避免“写入 baseRev 又改变 baseRev”。 */
export function contentRevision(content) {
  const clone = { ...(isObject(content) ? content : {}) };
  delete clone.baseRev;
  return hashText(stableStringify(clone));
}

/** research 的版本号（用于提示 research 已更新）。 */
export const researchRevision = (research) => hashText(stableStringify(research ?? null));

function error(path, message) {
  return { path, message };
}

function validateImageRef(value, path) {
  if (typeof value !== 'string') return error(path, '必须是字符串');
  if (/^\/(?:images|terr)\/[^\s]+$/.test(value) && !value.includes('..')) return null;
  return validateUrl(value, path);
}

function validateUrl(value, path) {
  if (typeof value !== 'string') return error(path, '必须是字符串');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return error(path, '只允许 https 链接');
  } catch {
    return error(path, '链接格式不合法');
  }
  return null;
}

function validateDocNode(node, path, errors) {
  if (!isObject(node) || typeof node.type !== 'string' || !DOC_NODES.has(node.type)) {
    errors.push(error(path, '节点类型不在允许列表中'));
    return;
  }

  if (node.type === 'text' && typeof node.text !== 'string') errors.push(error(`${path}.text`, '文本节点缺少 text'));
  if (node.type === 'heading' && ![3, 4].includes(node.attrs?.level)) errors.push(error(`${path}.attrs.level`, '标题只允许 H3 / H4'));
  if (node.type === 'paragraph' || node.type === 'heading') {
    const align = node.attrs?.textAlign;
    /* Tiptap TextAlign 未设置时把 textAlign 序列化成 null；null 等同默认左对齐。 */
    if (align !== undefined && align !== null && !DOC_ALIGNMENTS.has(align)) errors.push(error(`${path}.attrs.textAlign`, '对齐方式不合法'));
  }
  if (node.type === 'figure') {
    const src = node.attrs?.src;
    if (src !== undefined) {
      if (typeof src !== 'string' || !/^\/(?!\/)/.test(src)) errors.push(error(`${path}.attrs.src`, '图片地址必须是站内路径'));
    } else if (!isInteger(node.attrs?.n) || node.attrs.n < 1 || node.attrs.n > 36) {
      errors.push(error(`${path}.attrs.n`, '图片序号必须在 1 到 36 之间'));
    }
    if (node.attrs?.side !== undefined && !['left', 'right'].includes(node.attrs.side)) {
      errors.push(error(`${path}.attrs.side`, '图片位置不合法'));
    }
  }

  if (Array.isArray(node.marks)) {
    node.marks.forEach((mark, index) => {
      if (!isObject(mark) || !DOC_MARKS.has(mark.type)) {
        errors.push(error(`${path}.marks[${index}]`, '文本样式不在允许列表中'));
        return;
      }
      if (mark.type === 'link') {
        const linkError = validateUrl(mark.attrs?.href, `${path}.marks[${index}].attrs.href`);
        if (linkError) errors.push(linkError);
      }
      if (mark.type === 'textStyle') {
        const attrs = mark.attrs ?? {};
        if (attrs.fontSize !== undefined && attrs.fontSize !== null && (!isInteger(attrs.fontSize) || attrs.fontSize < DOC_FONT_SIZE_MIN || attrs.fontSize > DOC_FONT_SIZE_MAX)) {
          errors.push(error(`${path}.marks[${index}].attrs.fontSize`, '字号必须是 12 到 32 的整数'));
        }
        if (attrs.color !== undefined && attrs.color !== null && !DOC_COLOR_TOKENS.includes(attrs.color)) {
          errors.push(error(`${path}.marks[${index}].attrs.color`, '颜色必须是主题 token'));
        }
        for (const key of Object.keys(attrs)) {
          if (!['fontSize', 'color'].includes(key)) errors.push(error(`${path}.marks[${index}].attrs.${key}`, '样式属性不允许'));
        }
      }
    });
  }

  if (Array.isArray(node.content)) node.content.forEach((child, index) => validateDocNode(child, `${path}.content[${index}]`, errors));
}

export function validateDoc(doc) {
  const errors = [];
  if (!isObject(doc) || doc.type !== 'doc') {
    errors.push(error('doc', '必须是 ProseMirror doc'));
  } else if (Array.isArray(doc.content)) {
    doc.content.forEach((node, index) => validateDocNode(node, `doc.content[${index}]`, errors));
  } else if (doc.content !== undefined) {
    errors.push(error('doc.content', '必须是数组'));
  }
  return errors;
}

function validateBlock(block, index, errors) {
  const path = `blocks[${index}]`;
  if (!isObject(block) || typeof block.id !== 'string' || typeof block.type !== 'string') {
    errors.push(error(path, '正文块缺少 id 或 type'));
    return;
  }
  if (!['story', 'intro', 'gameplay', 'guideItem'].includes(block.type)) errors.push(error(`${path}.type`, '正文块类型不合法'));
  if (block.type === 'guideItem' && (typeof block.title !== 'string' || !block.title.trim())) errors.push(error(`${path}.title`, '攻略条目必须有标题'));
  errors.push(...validateDoc(block.doc).map((item) => ({ ...item, path: `${path}.${item.path}` })));
}

const INFOBOX_KEYS = new Set(['author', 'version', 'players', 'duration', 'stages', 'size', 'aliases', 'authorNote']);
const PAGE_KEYS = new Set(['slug', 'baseRev', 'researchRev', 'title', 'heroImage', 'tags', 'difficulty', 'blocks', 'removedBlocks', 'guideCleared', 'infobox', 'stageRows', 'stageDocs', 'itemEdits', 'itemOrder', 'videos']);

function validateItemEdit(row, index, errors) {
  const path = `itemEdits[${index}]`;
  if (!isObject(row)) {
    errors.push(error(path, '神器修改必须是对象'));
    return;
  }
  if (!['update', 'add', 'remove'].includes(row.action)) errors.push(error(`${path}.action`, '神器修改动作不合法'));
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > ITEM_NAME_MAX) errors.push(error(`${path}.name`, `名称不能为空且不能超过 ${ITEM_NAME_MAX} 个字符`));
  for (const key of ['intro', 'note']) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || row[key].length > ITEM_TEXT_MAX)) errors.push(error(`${path}.${key}`, `文本不能超过 ${ITEM_TEXT_MAX} 个字符`));
  }
  for (const key of ['cd', 'uses']) {
    const valid = key === 'cd' ? typeof row[key] === 'number' && Number.isFinite(row[key]) : isInteger(row[key]);
    if (row[key] !== undefined && row[key] !== null && (!valid || row[key] < 0 || row[key] > (key === 'cd' ? ITEM_CD_MAX : ITEM_USES_MAX))) errors.push(error(`${path}.${key}`, `${key} 必须是合法数字`));
  }
}

export function validatePageContent(raw, options = {}) {
  const errors = [];
  const value = isObject(raw) ? raw : {};
  for (const key of Object.keys(value)) if (!PAGE_KEYS.has(key) && key !== 'v' && key !== 'history') errors.push(error(key, '字段不允许由编辑器提交'));
  if (value.v !== undefined && value.v !== PAGE_CONTENT_VERSION) errors.push(error('v', '内容版本不支持'));
  if (options.slug && value.slug && value.slug !== options.slug) errors.push(error('slug', 'slug 与请求不一致'));
  if (value.heroImage !== null && value.heroImage !== undefined) {
    const urlError = validateImageRef(value.heroImage, 'heroImage');
    if (urlError) errors.push(urlError);
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 80)) {
    errors.push(error('title', '标题必须是 80 字符以内的文本'));
  }
  if (value.tags !== null && value.tags !== undefined) {
    if (!Array.isArray(value.tags)) errors.push(error('tags', '必须是数组或 null'));
    else {
      if (value.tags.length > TAGS_MAX) errors.push(error('tags', `标签不能超过 ${TAGS_MAX} 个`));
      const seen = new Set();
      value.tags.forEach((tag, index) => {
        if (typeof tag !== 'string' || !tag.trim()) {
          errors.push(error(`tags[${index}]`, '标签必须是非空字符串'));
          return;
        }
        if (tag.length > TAG_MAX_LEN) errors.push(error(`tags[${index}]`, `标签不能超过 ${TAG_MAX_LEN} 个字符`));
        if (!SAFE_TAG.test(tag)) errors.push(error(`tags[${index}]`, '标签包含不允许的字符'));
        const key = tag.toLowerCase();
        if (seen.has(key)) errors.push(error(`tags[${index}]`, '标签重复'));
        seen.add(key);
      });
    }
  }
  if (value.difficulty !== null && value.difficulty !== undefined && !isDifficulty(value.difficulty)) {
    errors.push(error('difficulty', `难度必须是：${DIFFICULTIES.join(' / ')}`));
  }
  if (value.blocks !== undefined) {
    if (!Array.isArray(value.blocks)) errors.push(error('blocks', '必须是数组'));
    else {
      if (value.blocks.filter((block) => block?.type === 'guideItem').length > GUIDE_ITEM_MAX) errors.push(error('blocks', `攻略条目不能超过 ${GUIDE_ITEM_MAX} 个`));
      value.blocks.forEach((block, index) => validateBlock(block, index, errors));
    }
  }
  if (value.removedBlocks !== undefined && (!Array.isArray(value.removedBlocks) || value.removedBlocks.some((id) => typeof id !== 'string' || !id))) errors.push(error('removedBlocks', '删除块必须是 id 数组'));
  if (value.guideCleared !== undefined && typeof value.guideCleared !== 'boolean') errors.push(error('guideCleared', '必须是布尔值'));
  if (value.stageRows !== null && value.stageRows !== undefined) {
    if (!Array.isArray(value.stageRows)) errors.push(error('stageRows', '必须是数组或 null'));
    else if (value.stageRows.length > STAGE_ROW_MAX) errors.push(error('stageRows', `关卡行不能超过 ${STAGE_ROW_MAX} 行`));
  }
  if (value.stageDocs !== undefined && value.stageDocs !== null) {
    if (!Array.isArray(value.stageDocs)) errors.push(error('stageDocs', '必须是数组或 null'));
    else {
      if (value.stageDocs.length > STAGE_ROW_MAX) errors.push(error('stageDocs', `关卡内容不能超过 ${STAGE_ROW_MAX} 项`));
      value.stageDocs.forEach((doc, index) => {
        if (doc === null || doc === undefined) return;
        errors.push(...validateDoc(doc).map((item) => ({ ...item, path: `stageDocs[${index}].${item.path}` })));
      });
    }
  }
  if (value.itemEdits !== undefined && (!Array.isArray(value.itemEdits) || value.itemEdits.length > ITEM_EDIT_MAX)) errors.push(error('itemEdits', `神器修改不能超过 ${ITEM_EDIT_MAX} 行`));
  if (Array.isArray(value.itemEdits)) value.itemEdits.forEach((row, index) => validateItemEdit(row, index, errors));
  if (value.itemOrder !== undefined && !Array.isArray(value.itemOrder)) errors.push(error('itemOrder', '必须是数组'));
  if (Array.isArray(value.itemOrder) && value.itemOrder.some((item) => typeof item !== 'string' || item.length > ITEM_NAME_MAX)) errors.push(error('itemOrder', '神器顺序必须是名称数组'));
  if (value.infobox !== undefined && !isObject(value.infobox)) errors.push(error('infobox', '必须是对象'));
  if (isObject(value.infobox)) for (const [key, item] of Object.entries(value.infobox)) {
    if (!INFOBOX_KEYS.has(key)) errors.push(error(`infobox.${key}`, '基本信息字段不允许编辑'));
    if (typeof item !== 'string' || item.length > 200) errors.push(error(`infobox.${key}`, '基本信息必须是 200 字符以内的文本'));
  }
  if (value.videos !== null && value.videos !== undefined && !Array.isArray(value.videos)) errors.push(error('videos', '必须是数组或 null'));
  if (Array.isArray(value.videos)) value.videos.forEach((item, index) => {
    if (!isObject(item) || typeof item.url !== 'string') errors.push(error(`videos[${index}]`, '视频必须包含 url'));
    else {
      const urlError = validateUrl(item.url, `videos[${index}].url`);
      if (urlError) errors.push(urlError);
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        if (!['www.bilibili.com', 'b23.tv', 'www.b23.tv'].includes(host)) errors.push(error(`videos[${index}].url`, '只允许 B 站视频链接'));
      } catch { /* validateUrl already reported it */ }
    }
    if (isObject(item) && item.kind !== undefined && !['run', 'guide', 'music'].includes(item.kind)) errors.push(error(`videos[${index}].kind`, '视频分类不合法'));
  });
  if (value.stageRows !== null && value.stageRows !== undefined && Array.isArray(value.stageRows)) value.stageRows.forEach((row, index) => {
    if (!Array.isArray(row) || row.length > 6 || row.some((cell) => typeof cell !== 'string' || cell.length > 500)) errors.push(error(`stageRows[${index}]`, '关卡行必须是最多 6 列的纯文本数组'));
  });
  return { ok: errors.length === 0, errors };
}

const FIXED_BLOCK_TYPES = new Set(['story', 'intro', 'gameplay']);
const SIMPLE_PAGE_FIELDS = ['title', 'heroImage', 'tags', 'difficulty', 'stageRows', 'stageDocs', 'videos', 'itemOrder', 'researchRev'];

/**
 * 把一次玩家层变更合并进现有 content。
 *
 * 注意不能 `Object.assign(content, payload)`：payload 是“只带改过的字段”，
 * 直接覆盖会把没提交的玩家覆盖（例如另一个攻略条目、别的神器修改）一起清掉。
 * 同一 slug 多笔待写回修订也靠这个函数串行叠加。
 */
export function applyPagePayload(content, payload) {
  const next = isObject(content) ? { ...content } : {};
  const changes = isObject(payload) ? payload : {};

  if (Array.isArray(changes.blocks) || changes.guideCleared === true) {
    let blocks = Array.isArray(next.blocks) ? [...next.blocks] : [];
    const incoming = Array.isArray(changes.blocks) ? changes.blocks : [];
    for (const block of incoming.filter((item) => item && FIXED_BLOCK_TYPES.has(item.type))) {
      const index = blocks.findIndex((item) => item?.type === block.type);
      if (index >= 0) blocks[index] = block;
      else blocks.push(block);
    }
    const guideBlocks = incoming.filter((item) => item?.type === 'guideItem');
    if (guideBlocks.length || changes.guideCleared === true) {
      blocks = [...blocks.filter((item) => item?.type !== 'guideItem'), ...guideBlocks];
      next.guideCleared = guideBlocks.length === 0;
    }
    next.blocks = blocks;
  }

  if (Array.isArray(changes.removedBlocks)) {
    const removed = new Set(changes.removedBlocks);
    next.blocks = (Array.isArray(next.blocks) ? next.blocks : []).filter((block) => !removed.has(block?.id));
  }

  if (isObject(changes.infobox)) next.infobox = { ...(isObject(next.infobox) ? next.infobox : {}), ...changes.infobox };
  for (const key of SIMPLE_PAGE_FIELDS) if (changes[key] !== undefined) next[key] = changes[key];
  /* 只改 stageRows 没带 stageDocs（旧客户端 / 纯文本编辑）时清掉旧的富文本，避免错位 */
  if (Array.isArray(changes.stageRows) && changes.stageDocs === undefined) next.stageDocs = [];

  if (changes.guideCleared !== undefined) next.guideCleared = Boolean(changes.guideCleared);

  if (Array.isArray(changes.itemEdits)) {
    const rows = Array.isArray(next.itemEdits) ? [...next.itemEdits] : [];
    for (const row of changes.itemEdits) {
      const key = itemKey(row?.name);
      const index = rows.findIndex((item) => itemKey(item?.name) === key);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    }
    next.itemEdits = rows;
  }

  return next;
}

export function normalizePageContent(slug, raw) {
  const base = emptyPageContent(slug);
  const value = isObject(raw) ? raw : {};
  const normalized = {
    ...base,
    ...value,
    v: PAGE_CONTENT_VERSION,
    slug,
    blocks: Array.isArray(value.blocks) ? value.blocks : [],
    infobox: isObject(value.infobox) ? value.infobox : {},
    itemEdits: Array.isArray(value.itemEdits) ? value.itemEdits : [],
    itemOrder: Array.isArray(value.itemOrder) ? value.itemOrder : [],
    history: Array.isArray(value.history) ? value.history : [],
  };
  return validatePageContent(normalized, { slug }).ok ? normalized : base;
}

export function pageRevisionPayload(payload, slug) {
  if (!isObject(payload)) return { ok: false, errors: [error('payload', '请求体必须是对象')] };
  if (JSON.stringify(payload).length > PAGE_REVISION_MAX_BYTES) return { ok: false, errors: [error('payload', '请求体超过 64KB')] };
  const contentOnly = { ...payload };
  delete contentOnly.mode;
  delete contentOnly.submitter;
  delete contentOnly.media;
  const changeKeys = Object.keys(payload).filter((key) => !['mode', 'submitter', 'media', 'slug', 'baseRev', 'researchRev'].includes(key));
  const hasMedia = Boolean(payload.media && (payload.media.cover || (Array.isArray(payload.media.gallery) && payload.media.gallery.length)));
  const result = validatePageContent({ ...contentOnly, slug }, { slug });
  if (!changeKeys.length && !hasMedia) result.errors.push(error('payload', '没有检测到修改，请先改一处再提交'));
  if (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.length > 80)) result.errors.push(error('title', '标题必须是 80 字符以内的文本'));
  if (payload.baseRev !== undefined && payload.baseRev !== null && typeof payload.baseRev !== 'string') result.errors.push(error('baseRev', 'baseRev 必须是字符串'));
  if (payload.researchRev !== undefined && payload.researchRev !== null && typeof payload.researchRev !== 'string') result.errors.push(error('researchRev', 'researchRev 必须是字符串'));
  return { ok: result.errors.length === 0, errors: result.errors };
}
