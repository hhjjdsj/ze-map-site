/**
 * 神器 / 道具行的归一与合并 —— 站点生成器、投稿表单、审核台共用一份。
 *
 * 为什么是「逐行合并」而不是「整表替换」：
 * 条目里的神器表来自公开的服务器配置（data/gfl-parsed，目前只有 GFL 一份），
 * 玩家在别的服看到的、或者干脆发现本站抄错的地方，都只能一行一行改。
 * 如果允许整表替换，这张表就会变成「既不是 GFL、也不是别服」的第三份数据，
 * 谁也说不清它对不对 —— 所以原值一律保留在备注里，来源逐行标注。
 *
 * 数据流向：
 *   投稿（/submit/，字段 items）→ D1 → 审核 → data/community/<slug>.json 的 items[]
 *   → 生成器用 mergeItems() 合并进条目正文的「神器 / 道具」表
 */

/** 投稿里这三种动作；键会进 JSON、进日志，别随意改名 */
export const ITEM_ACTIONS = { update: '更正', add: '新增', remove: '删除' };

/** 名称比对用的归一：全角空格、大小写、首尾空白都不该造成「新增了一件」 */
export function itemKey(name) {
  return String(name ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 冷却显示：配置里 0（或没写）就是没有冷却 */
export const cdText = (cd) => (Number.isFinite(cd) && cd > 0 ? `${cd} 秒` : '—');

/** 次数显示：entwatch 里 maxuses=0 表示不限次数 */
export const usesText = (uses) => (Number.isFinite(uses) && uses > 0 ? `${uses} 次` : '不限');

/** 冷却 / 次数这类可选整数：空值 → null（表示投稿人没改这一项） */
export function intOrNull(v) {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

/**
 * 可选数字：空值 → null。
 * 冷却**允许小数** —— 服务器配置里真的存在 4.5 / 2.5 秒这种值（ze_dark_souls 一整排都是），
 * 只收整数的后果是把它们显示成「—」，等于把配置里的信息抹掉。
 */
export function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把任意来源（投稿值、仓库里的 JSON、人手改过的文件）规整成一行。
 * 认不出来就返回 null，由调用方丢弃 —— 构建期不该因为一行坏数据整页崩掉。
 */
export function normalizeItemRow(raw, extra = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw;
  const name = String(row.name ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;
  const action =
    typeof row.action === 'string' && Object.prototype.hasOwnProperty.call(ITEM_ACTIONS, row.action)
      ? row.action
      : 'update';
  return {
    action,
    name,
    cd: numOrNull(row.cd),
    uses: intOrNull(row.uses),
    note: String(row.note ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    /* 神器表「说明」列的一句话介绍（社区投稿可改，站长也能直接写进原稿的 relicIntros） */
    intro: String(row.intro ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    by: String(extra.by ?? row.by ?? '').trim(),
    at: extra.at ?? row.at ?? null,
    submission: extra.submission ?? row.submission ?? null,
  };
}

/**
 * 从手写资料（data/research/<slug>.json 的 document）里抽出「神器 / 道具」表里的条目。
 *
 * 为什么需要它：有三张图（魔晄炉、米纳斯、黑珍珠号）的神器表是人工整理后写进正文的
 * （HTML `<table class="item-table">`），本站没有对应的服务器配置。投稿表单如果只认
 * `data/gfl-parsed`，就会对着这些图说「本站还没有这张图的神器表」——
 * 而页面上明明摆着一张表，投稿人当场就懵了（2026-09-28 的反馈）。
 *
 * 只做「认名字」这一件事，不重写手写正文：命中的行用来做表单里的名称联想与对照。
 * 名字取哪一列：中文列 + 英文名/ID 列并存时（火焰 | Fire）取英文列，否则取第一列。
 */
export function docItemRows(text) {
  const src = String(text ?? '');
  if (!src) return [];

  const rows = [];
  let active = false;
  let level = 0;

  for (const line of src.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      if (/(神器|道具)/.test(heading[2])) {
        active = true;
        level = heading[1].length;
      } else if (active && heading[1].length <= level) {
        active = false; /* 同级或更高级标题 = 这一节结束 */
      }
      continue;
    }
    if (!active) continue;

    const html = line.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    if (html) {
      rows.push(cellsOfHtml(html[1]));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((s) => stripInline(s));
      /* 表头分隔行 |---|---| 与表头本身都会被过滤掉（认不出名字） */
      rows.push(cells);
    }
  }

  const out = [];
  const seen = new Set();
  for (const cells of rows) {
    const row = pickDocRow(cells);
    if (!row) continue;
    const key = itemKey(row.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** HTML 表格的 <td> 组合 → 纯文本单元格 */
function cellsOfHtml(inner) {
  const cells = [];
  for (const m of inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripInline(m[1]));
  return cells;
}

/** 去掉行内标签与常见实体，压掉多余空白 */
function stripInline(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK_RE = /[\u3400-\u9fff]/;
const CD_RE = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)$/i;

/** 一行单元格 → { name, label, cd }；认不出来返回 null */
function pickDocRow(cells) {
  const clean = (Array.isArray(cells) ? cells : []).map((c) => String(c ?? '').trim());
  const [first = '', second = ''] = clean;
  if (!first) return null;
  /* 表头行 / 分隔行：第一格就是「神器」「道具」这类标题，或者整行都是横线 */
  if (/^(神器|道具|名称|英文名|item|name)$/i.test(first)) return null;
  if (/^-+$/.test(first) || clean.every((c) => !c || /^:?-+:?$/.test(c))) return null;

  const secondIsId = Boolean(second) && !CJK_RE.test(second) && /[A-Za-z]/.test(second);
  const name = CJK_RE.test(first) && secondIsId ? second : first;
  const label = name === first ? '' : first;

  const cdCell = clean.slice(1).find((c) => CD_RE.test(c));
  const cd = cdCell ? Number(cdCell.match(CD_RE)[1]) : null;
  return { name, label, cd };
}

/**
 * 把社区投稿行合并到服务器配置的基表上。
 *
 * @param base 服务器配置：[{ name, cd, maxuses }]
 * @param rows 社区行：[{ action, name, cd, uses, note, by }]
 * @returns {{ rows: Array, changed: number }}
 *   rows[].kind：
 *     server   服务器配置原样
 *     updated  社区更正（original 里留着原值）
 *     added    社区补充（服务器配置里没有）
 *     removed  社区反馈「本图没有这件道具」（原行保留，只是标注）
 */
export function mergeItems(base = [], rows = []) {
  const out = (Array.isArray(base) ? base : []).map((it) => ({
    name: String(it?.name ?? '').trim(),
    cd: numOrNull(it?.cd),
    uses: intOrNull(it?.maxuses),
    kind: 'server',
    note: '',
    /* 服务器配置里没有「说明」—— 那一列只有人写（原稿 relicIntros 或社区投稿的 intro） */
    intro: '',
    by: '',
    original: null,
  })).filter((r) => r.name);

  const index = new Map(out.map((r) => [itemKey(r.name), r]));
  let changed = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeItemRow(raw);
    if (!row) continue;
    const hit = index.get(itemKey(row.name));

    /* 同名就是同一件道具：就算投稿人点了「新增」，也按更正处理，避免表里出现两行同名 */
    if (hit) {
      hit.by = row.by;
      if (row.action === 'remove') {
        hit.kind = 'removed';
        hit.note = row.note;
      } else {
        hit.original = { cd: hit.cd, uses: hit.uses };
        if (row.cd !== null) hit.cd = row.cd;
        if (row.uses !== null) hit.uses = row.uses;
        /* 说明是「逐行盖上」：社区写了就以社区的为准（审核已过），没写就保持原样 */
        if (row.intro) hit.intro = row.intro;
        hit.kind = 'updated';
        hit.note = row.note;
      }
      changed++;
      continue;
    }

    /* 基表里没有：追加一行（基表为空时整张表都由社区提供） */
    out.push({
      name: row.name,
      cd: row.cd,
      uses: row.uses,
      kind: 'added',
      note: row.note,
      intro: row.intro,
      by: row.by,
      original: null,
    });
    changed++;
  }

  return { rows: out, changed };
}
