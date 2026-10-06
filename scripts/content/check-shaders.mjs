/**
 * GLSL 静态检查：顶点 / 片元之间**同名 uniform 的类型与精度必须一致**。
 *
 * 为什么需要单独查这个（2026-10-05 手机端「3D 打不开」的根因）：
 *   GLSL ES 1.00 规定跨阶段同名 uniform 的精度必须相同。顶点着色器里不写限定符时
 *   默认是 highp，片元着色器则由 `precision mediump float;` 决定 —— 于是同一个
 *   `uXray` 一边 highp 一边 mediump。桌面 ANGLE 不较真，链接照过；
 *   手机内核（实测：夸克 U4 / 华为机）直接链接失败，整个 3D 视图打不开，
 *   而且失败信息只在设备上出现 —— 电脑上永远复现不了。
 *
 * 这里把 app.js 里那几段着色器源码抠出来，按 program 逐对比较。
 * 判定用的是「有效精度」：显式限定符优先，否则取该阶段的默认精度
 * （顶点 = highp；片元 = 最后一条 precision 语句，带 GL_FRAGMENT_PRECISION_HIGH
 *  分支时按 highp 算，与顶点侧一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'public/preview/app.js');
const src = fs.readFileSync(SRC, 'utf8');

/** 把 `const NAME = [ '...', '...' ].join('\n');` 还原成一段源码 */
function grab(name) {
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`).exec(src);
  if (!m) throw new Error(`app.js 里找不到着色器数组 ${name}（改名了？请同步更新本脚本）`);
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")).join('\n');
}

function defaultPrecision(code, stage) {
  if (stage === 'vs') return /precision\s+\w+\s+float\s*;/.test(code)
    ? /precision\s+(highp|mediump|lowp)\s+float\s*;/.exec(code)[1]
    : 'highp';                                  // 顶点着色器默认就是 highp
  const m = /precision\s+(highp|mediump|lowp)\s+float\s*;/.exec(code);
  if (!m) return 'highp';
  /* 带 ifdef 分支时按 highp 算：与实际能跑 highp 的设备一致，也与顶点侧默认值一致 */
  return /GL_FRAGMENT_PRECISION_HIGH/.test(code) ? 'highp' : m[1];
}

function uniforms(code, stage) {
  const def = defaultPrecision(code, stage);
  const out = new Map();
  for (const raw of code.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = /^(?:(highp|mediump|lowp)\s+)?uniform\s+(?:(highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/.exec(line);
    if (m) out.set(m[4], { type: m[3], precision: m[1] || m[2] || def });
  }
  return out;
}

/* 三套 program：别名 → [显示名, 顶点着色器数组, 片元着色器数组] */
const PAIRS = [
  ['实体块', 'VS', 'FS'],
  ['点云', 'PVS', 'PFS'],
  ['地形', 'MVS', 'MFS'],
];

let bad = 0;
for (const [prog, vName, fName] of PAIRS) {
  const v = uniforms(grab(vName), 'vs');
  const f = uniforms(grab(fName), 'fs');
  for (const k of [...v.keys()].filter((x) => f.has(x))) {
    const a = v.get(k), b = f.get(k);
    if (a.type !== b.type || a.precision !== b.precision) {
      bad++;
      console.error(
        `❌ ${prog}：uniform ${k} 跨阶段不一致 —— 顶点 ${a.precision} ${a.type} / 片元 ${b.precision} ${b.type}\n` +
          `   手机内核（夸克 / 部分安卓 GPU）会因此链接失败、整个 3D 打不开。\n` +
          `   改法：两边都显式写成同一精度，例如 uniform mediump float ${k};`
      );
    }
  }
}

if (bad) {
  console.error(`\n着色器检查未通过：${bad} 处跨阶段精度/类型不一致`);
  process.exit(1);
}
console.log('✅ 着色器检查通过（跨阶段同名 uniform 精度与类型一致）');
