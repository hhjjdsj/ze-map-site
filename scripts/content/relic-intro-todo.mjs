#!/usr/bin/env node
/**
 * 神器说明的工作清单：哪些图的哪些神器还没有「一句话说明」/「详细讲解」。
 *
 * 为什么需要：站长的朋友要「给全神器做一遍简单介绍」—— 全站 210 张图、1700 多件神器，
 * 靠人肉记「哪张图还没写」是不可能的。这个脚本把缺口列出来，并可导出**可以直接填的骨架**。
 *
 * 两种写法（见 docs/relic-guides.md）：
 *   · 一句话说明 → data/research/<地图>.json 的 relicIntros（神器表会多一列「说明」）
 *   · 详细讲解（可左图右文） → 同一份原稿的 guides[]（神器表那行变成锚点链接）
 *
 * 用法：
 *   node scripts/content/relic-intro-todo.mjs                    # 看总览与缺口最多的图
 *   node scripts/content/relic-intro-todo.mjs --map ze_castlevania   # 打印这张图的 relicIntros 骨架（复制去填）
 *   node scripts/content/relic-intro-todo.mjs --write            # 写一份清单 data/relic-intros.todo.md
 *   node scripts/content/relic-intro-todo.mjs --json             # 机器可读的完整状态
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeItems } from '../../shared/items.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PARSED_DIR = path.join(ROOT, 'data/gfl-parsed');
const RESEARCH_DIR = path.join(ROOT, 'data/research');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const pages = new Set(fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, '')));
const readResearch = (slug) => {
  const f = path.join(RESEARCH_DIR, `${slug}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** 全站状态：每张图的神器 → 有没有说明 / 讲解 */
const maps = [];
for (const file of fs.readdirSync(PARSED_DIR)) {
  if (!file.endsWith('.json')) continue;
  const slug = file.replace(/\.json$/, '');
  if (!pages.has(slug)) continue; // 只在站内有页面的图
  let gfl;
  try {
    gfl = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, file), 'utf8'));
  } catch {
    continue;
  }
  const items = Array.isArray(gfl.items) ? gfl.items : [];
  if (!items.length) continue;
  const rows = mergeItems(items, []).rows;
  const research = readResearch(slug) ?? {};
  const intros = new Map(
    Object.entries(research.relicIntros && typeof research.relicIntros === 'object' ? research.relicIntros : {})
      .map(([k, v]) => [String(k).trim().toLowerCase(), String(v ?? '').trim()])
      .filter(([, v]) => v)
  );
  const guideTitles = (Array.isArray(research.guides) ? research.guides : []).map((g) => String(g?.title ?? ''));
  const relics = rows.map((r) => {
    const name = String(r.name ?? '').trim();
    return {
      name,
      intro: intros.get(name.toLowerCase()) ?? '',
      guide: guideTitles.some((t) => t.includes(name)),
    };
  });
  maps.push({ slug, relics });
}

const total = maps.reduce((n, m) => n + m.relics.length, 0);
const withIntro = maps.reduce((n, m) => n + m.relics.filter((r) => r.intro).length, 0);
const withGuide = maps.reduce((n, m) => n + m.relics.filter((r) => r.guide).length, 0);
const untouched = maps.filter((m) => m.relics.every((r) => !r.intro && !r.guide));

if (args.includes('--json')) {
  console.log(JSON.stringify({ maps, total, withIntro, withGuide }, null, 1));
  process.exit(0);
}

const pick = argVal('--map');
if (pick) {
  const hit = maps.find((m) => m.slug === pick);
  if (!hit) {
    console.error(`✗ 找不到有神器数据的图：${pick}`);
    process.exit(1);
  }
  const skeleton = {};
  for (const r of hit.relics) skeleton[r.name] = r.intro || '';
  console.log(`// ${hit.slug}：${hit.relics.length} 件神器，${hit.relics.filter((r) => r.intro).length} 件已有说明`);
  console.log('// 填好这一段，贴进 data/research/<地图>.json 的顶层（和 tags 同级）：');
  console.log(JSON.stringify({ relicIntros: skeleton }, null, 2));
  process.exit(0);
}

console.log(`【神器说明进度】站内有神器数据的图 ${maps.length} 张，神器 ${total} 件`);
console.log(`  已有一句话说明：${withIntro} 件（${((withIntro / total) * 100).toFixed(1)}%）`);
console.log(`  已有详细讲解：${withGuide} 件`);
console.log(`  一个字都还没写的图：${untouched.length} 张`);
console.log(`\n缺口最大的 12 张图：`);
for (const m of [...maps].sort((a, b) => b.relics.filter((r) => !r.intro).length - a.relics.filter((r) => !r.intro).length).slice(0, 12)) {
  const miss = m.relics.filter((r) => !r.intro).length;
  console.log(`  ${m.slug.padEnd(34)} 缺 ${String(miss).padStart(2)}/${String(m.relics.length).padStart(2)} 件`);
}

if (args.includes('--write')) {
  const out = path.join(ROOT, 'data/relic-intros.todo.md');
  const lines = [
    '# 神器说明工作清单（由 scripts/content/relic-intro-todo.mjs 生成，可随时重跑）',
    '',
    `站内有神器数据的图 ${maps.length} 张 / 神器 ${total} 件；已有一句话说明 ${withIntro} 件，详细讲解 ${withGuide} 件。`,
    '',
    '写法见 docs/relic-guides.md：一句话说明进 `relicIntros`，详细讲解（可左图右文）进 `guides`。',
    '拿某张图的骨架：`node scripts/content/relic-intro-todo.mjs --map <地图英文名>`',
    '',
  ];
  for (const m of maps.sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`## ${m.slug}（${m.relics.length} 件）`, '');
    for (const r of m.relics) {
      lines.push(`- [${r.intro ? 'x' : ' '}] ${r.name}${r.guide ? ' · 已有讲解' : ''}${r.intro ? ` —— ${r.intro}` : ''}`);
    }
    lines.push('');
  }
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\n已写出清单：${path.relative(ROOT, out)}（${maps.length} 张图）`);
} else {
  console.log(`\n提示：加 --write 导出勾选清单，加 --map <地图> 导出可直接填的骨架。`);
}
