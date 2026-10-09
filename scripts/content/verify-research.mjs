#!/usr/bin/env node
/**
 * 校验 data/research/*.json（线上检索资料）的质量与格式，避免把可疑内容带上线。
 *   node scripts/content/verify-research.mjs
 *   node scripts/content/verify-research.mjs --fix-tags   # 顺带把非法标签字符替换掉
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIFFICULTIES } from '../../shared/difficulty.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data/research');
const FIX = process.argv.includes('--fix-tags');

// 难度枚举与站点/Worker 共用一份定义（shared/difficulty.mjs），别再这里硬编码
const DIFFS = DIFFICULTIES.filter((d) => d !== '未知');
const BAD_PHRASES = ['根据搜索结果', '我查到', '作为AI', '作为 AI', '以下是', '综上所述，我们', '无法访问'];
const SAFE_TAG = (t) => String(t || '').replace(/[\\/:*?"<>|#%]/g, '·').replace(/\s+/g, ' ').trim().slice(0, 24);
const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ''));

// 资料文件允许出现的字段（生成脚本只会读这些，多写的字段等于没写）。
// 之所以专门查一遍：把 author 打成 awthor 这种错误 **JSON 依然合法**，
// 构建、CI 全绿，只是署名被悄悄丢掉 —— 2026-09-24 的 PR 就是这样。
const KNOWN_FIELDS = new Set([
  'slug', 'title', 'author', 'players', 'duration', 'version', 'game', 'featured', 'stages',
  'difficulty', 'summary', 'tags', 'videoUrls', 'sources', 'confidence', 'verified',
  /* 手写小节的图：正文放 sections，页面 slug ≠ 实体名时用 maps 声明 */
  'sections', 'maps',
  /* 教程 / 神器讲解：叠在自动正文之上的小节（左图右文用 :::figure 语法，见 shared/guide-blocks.mjs） */
  'guides',
]);

/** 给写错的字段名猜一个最接近的正确写法（编辑距离 ≤3 才给提示） */
const nearestField = (k) => {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let best = null;
  let bestD = Infinity;
  for (const f of KNOWN_FIELDS) {
    const dd = dist(String(k).toLowerCase(), f);
    if (dd < bestD) { bestD = dd; best = f; }
  }
  return bestD <= 3 ? best : null;
};

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'priority.json');
const errors = [];
const warns = [];
let ok = 0, empty = 0, fixed = 0;

for (const file of files) {
  const p = path.join(DIR, file);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    errors.push(`${file}: JSON 解析失败 ${e.message}`);
    continue;
  }
  const slug = file.replace(/\.json$/, '');

  // 字段名拼错 = 内容照样能构建、但页面上什么都不显示，所以按错误处理
  for (const k of Object.keys(j)) {
    if (k.startsWith('_') || KNOWN_FIELDS.has(k)) continue; // 下划线开头当注释用（骨架里的「_说明」）
    const guess = nearestField(k);
    errors.push(`${file}: 不认识的字段「${k}」${guess ? `，是不是想写「${guess}」？` : ''}（拼错的字段不会显示在页面上）`);
  }

  if (j.slug) {
    // 两种写法都接受：地图内部名，或数据分片名（含该地图名即可）
    const okSlug = j.slug === slug || (j.slug.includes(slug) && /^\d+-[a-zA-Z0-9_]+-\d+$/.test(j.slug));
    if (!okSlug) errors.push(`${file}: slug(${j.slug}) 与文件名(${slug}) 对不上`);
  }

  /*
   * 手写小节的图（魔晄炉 / 米纳斯 / 黑珍珠号）：正文以 `sections` 数组存放。
   * 2026-10-08 之前是一整篇 `document`（MDX 文本）由生成器照抄，现在和普通图同一条流程 ——
   * 所以这里按「结构化小节」校验，并要求配好来源链接（那三页的正文都是人工整理的，得能追溯）。
   */
  if (j.document !== undefined) {
    errors.push(
      `${file}: 还有 document 字段 —— 已改成 sections 数组（每节 { title, body }），` +
        `见 scripts/content/generate-map-entries.mjs 的说明`
    );
    continue;
  }

  if (j.guides !== undefined) {
    if (!Array.isArray(j.guides) || !j.guides.length) {
      errors.push(`${file}: guides 必须是非空数组（不需要就删掉这个字段）`);
    } else {
      j.guides.forEach((s, i) => {
        if (!s || typeof s !== 'object') errors.push(`${file}: guides[${i}] 应该是 { title, body }`);
        else {
          if (typeof s.title !== 'string' || !s.title.trim()) errors.push(`${file}: guides[${i}].title 不能为空`);
          if (typeof s.body !== 'string' || !s.body.trim()) errors.push(`${file}: guides[${i}].body 不能为空`);
          for (const k of Object.keys(s)) {
            if (k !== 'title' && k !== 'body') errors.push(`${file}: guides[${i}] 有多余字段「${k}」（只认 title / body）`);
          }
        }
      });
    }
  }

  if (j.sections !== undefined) {
    if (!Array.isArray(j.sections) || !j.sections.length) {
      errors.push(`${file}: sections 必须是非空数组`);
    } else {
      j.sections.forEach((s, i) => {
        if (!s || typeof s !== 'object') errors.push(`${file}: sections[${i}] 应该是 { title, body }`);
        else {
          if (typeof s.title !== 'string' || !s.title.trim()) errors.push(`${file}: sections[${i}].title 不能为空`);
          if (typeof s.body !== 'string' || !s.body.trim()) errors.push(`${file}: sections[${i}].body 不能为空`);
          for (const k of Object.keys(s)) {
            if (k !== 'title' && k !== 'body') errors.push(`${file}: sections[${i}] 有多余字段「${k}」（只认 title / body）`);
          }
        }
      });
    }
    if (!Array.isArray(j.sources) || !j.sources.length || j.sources.some((url) => !isUrl(url))) {
      errors.push(`${file}: 带 sections 的条目必须提供有效的 sources 链接`);
    }
    if (j.maps !== undefined && (!Array.isArray(j.maps) || !j.maps.length || j.maps.some((x) => typeof x !== 'string'))) {
      errors.push(`${file}: maps 必须是「实体名」组成的非空数组`);
    }
    ok++;
    continue;
  }

  const hasSummary = typeof j.summary === 'string' && j.summary.trim().length > 0;
  if (!hasSummary) {
    empty++;
    if (j.summary === undefined) errors.push(`${file}: 缺少 summary 字段（无资料请写 null）`);
    if (Array.isArray(j.sources) && j.sources.length && !hasSummary) {
      warns.push(`${file}: 没有摘要却带了 ${j.sources.length} 条来源`);
    }
    continue;
  }

  const len = j.summary.trim().length;
  if (len < 80) warns.push(`${file}: 摘要偏短（${len} 字）`);
  if (len > 5000) warns.push(`${file}: 摘要偏长（${len} 字），建议拆分`);

  for (const ph of BAD_PHRASES) {
    if (j.summary.includes(ph)) errors.push(`${file}: 摘要里出现不该有的措辞「${ph}」`);
  }

  /* 分段写成了双反斜杠：文件里写 \\n\\n 时，JSON 解析出来的是「反斜杠 + n」这两个字符本身，
     页面上就原样显示成 `…水果\n\n该地图…`，不会换行 —— 而构建、CI、本脚本以前全都是绿的。
     正确写法是单反斜杠加 n（JSON 的换行转义），让字符串里真正出现换行。
     2026-09-25 站上真有两张图这样显示了（ze_forsaken_temple 来自贡献者 PR、ze_obf_rampage_v2 更早），
     所以按错误处理。用 fromCharCode 拼出这对字符，避免源码里再套一层转义看不出所以然。 */
  const LITERAL_BS_N = String.fromCharCode(92) + 'n';
  if (j.summary.includes(LITERAL_BS_N)) {
    errors.push(
      `${file}: 摘要里有字面量「${LITERAL_BS_N}」（分段写成了双反斜杠）——` +
        `页面上会原样显示、不会换行。改成单反斜杠加 n，也就是让 JSON 字符串里真的出现换行。`
    );
  }

  if (!Array.isArray(j.sources) || j.sources.length === 0) {
    errors.push(`${file}: 有摘要但没有任何来源链接`);
  } else {
    for (const s of j.sources) if (!isUrl(s)) errors.push(`${file}: 来源不是 http(s) 链接：${String(s).slice(0, 60)}`);
  }
  for (const v of j.videoUrls || []) if (!isUrl(v)) errors.push(`${file}: videoUrls 不是链接：${String(v).slice(0, 60)}`);

  if (j.difficulty && !DIFFS.includes(j.difficulty)) {
    errors.push(`${file}: difficulty「${j.difficulty}」不在允许值内`);
  }
  if (!j.confidence) warns.push(`${file}: 缺少 confidence`);
  else if (!['high', 'medium', 'low'].includes(j.confidence)) errors.push(`${file}: confidence「${j.confidence}」非法`);

  if (Array.isArray(j.tags)) {
    const cleaned = [...new Set(j.tags.map(SAFE_TAG).filter(Boolean))];
    const changed = JSON.stringify(cleaned) !== JSON.stringify(j.tags);
    if (changed) {
      if (FIX) {
        j.tags = cleaned;
        fs.writeFileSync(p, JSON.stringify(j, null, 1));
        fixed++;
      } else {
        errors.push(`${file}: 标签含非法字符或重复（用 --fix-tags 自动修正）：${JSON.stringify(j.tags)}`);
      }
    }
    if (cleaned.length > 8) warns.push(`${file}: 标签偏多（${cleaned.length} 个）`);
  }

  // 摘要里混入 < 或 { 会被 MDX 当 JSX 解析（生成脚本已转义，这里只提醒）
  if (/[<{][^\s]/.test(j.summary)) warns.push(`${file}: 摘要含 < 或 {，生成时会转义（确认不是想写 HTML）`);

  ok++;
}

console.log(`资料文件 ${files.length} 个：有内容 ${ok} · 空条目 ${empty}${FIX ? ` · 已修正标签 ${fixed}` : ''}`);
if (warns.length) {
  console.log(`\n⚠️  提醒 ${warns.length} 条：`);
  for (const w of warns.slice(0, 20)) console.log('   - ' + w);
  if (warns.length > 20) console.log(`   … 另有 ${warns.length - 20} 条`);
}
if (errors.length) {
  console.log(`\n❌ 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 30)) console.log('   - ' + e);
  process.exit(1);
}
console.log('\n✅ 资料校验通过');
