#!/usr/bin/env node
/**
 * 给地图生成「图片集」素材（本地批处理，不进构建流程）。
 *
 * 每张图产出：
 *   · 本站自己渲染的 3D 视角图（俯视 / 斜视 / 侧视 / 近景）—— 真实碰撞地形 + 实体块，
 *     清晰、可控、没有版权问题；
 *   · 工坊预览图（作者自己上传的那张，从 Steam 公开接口取 preview_url）。
 *
 * 产物写到仓库外的 `bake/gallery/<slug>/NN-<角度>.webp`，再由 upload-gallery.mjs
 * 传到 R2（gallery/ 前缀）。**不进仓库也不进 dist**：546 张图 × 4 张 ≈ 200 MB，
 * 塞进 git 会重演 terr 那次体积事故。
 *
 * 用法：
 *   node scripts/gallery/render-gallery.mjs ze_2012_p ze_backrooms_insomnia
 *   node scripts/gallery/render-gallery.mjs --all          # 全部有地形的图
 *   node scripts/gallery/render-gallery.mjs --size 1600x900 --force
 *
 * 前置：本地预览服务（npm run preview）在监听，页面里能打开 /preview/?map=<slug>。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.PREVIEW_BASE || 'http://localhost:4321';
const OUT_DIR = path.join(ROOT, 'bake/gallery');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ALL = args.includes('--all');
/** 只取工坊预览图（作者上传的那张），不跑 3D 截图 —— 全部 546 张图几分钟就能跑完 */
const WORKSHOP_ONLY = args.includes('--workshop-only');
const sizeArg = args.find((a) => a.startsWith('--size=')) || '--size=1280x720';
const [W, H] = sizeArg.split('=')[1].split('x').map(Number);
let slugs = args.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 机位：yaw/pitch/dist 倍率 —— 与页面里 CAM 的语义一致（pitch 1.5 ≈ 正俯视）。
   文件名用 ASCII（iso/top/side/close/workshop）：中文名会变成 percent-encoded 的
   长 URL，页面上不好看，也容易被别处转义搞乱 —— 中文只出现在清单的 caption 里。 */
const SHOTS = [
  { name: '01-iso', yaw: -Math.PI / 2, pitch: 0.62, zoom: 1.0 },
  { name: '02-top', yaw: -Math.PI / 2, pitch: 1.45, zoom: 1.0 },
  { name: '03-side', yaw: -Math.PI / 2 - 0.9, pitch: 0.18, zoom: 1.05 },
  { name: '04-close', yaw: -Math.PI / 2 + 0.7, pitch: 0.42, zoom: 0.62 },
];

if (!slugs.length && !ALL) {
  console.error('用法：node scripts/gallery/render-gallery.mjs <slug...> | --all');
  process.exit(1);
}
if (ALL) {
  slugs = fs.readdirSync(path.join(ROOT, 'src/content/maps'))
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\.mdx$/, ''))
    .sort();
}
console.log(`要渲染 ${slugs.length} 张地图，每张 ${SHOTS.length} 个机位 → ${path.relative(ROOT, OUT_DIR)}`);

/* ---------- 工坊预览图（公开接口，不需要 key） ---------- */
function workshopIdOf(slug) {
  const p = path.join(ROOT, 'src/content/maps', `${slug}.mdx`);
  if (!fs.existsSync(p)) return null;
  const m = /^workshopId:\s*"?(\d+)"?\s*$/m.exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1] : null;
}

function fetchPreviewUrl(ids) {
  const map = new Map();
  /* 接口一次别塞太多：按 100 个一批 */
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = [`itemcount=${chunk.length}`, ...chunk.map((id, k) => `publishedfileids[${k}]=${id}`)].join('&');
    try {
      const out = execFileSync('curl.exe', [
        '-sS', '--max-time', '60', '-X', 'POST', '-d', body,
        'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
      ], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
      const json = JSON.parse(out.replace(/^\uFEFF/, ''));
      for (const d of json?.response?.publishedfiledetails ?? []) {
        if (d?.preview_url) map.set(String(d.publishedfileid), d.preview_url);
      }
    } catch (e) {
      console.error(`  工坊接口这一批失败（${chunk.length} 个）：${e.message}`);
    }
  }
  return map;
}

/* ---------- CDP：一次加载，多机位截图 ---------- */
async function withPage(fn) {
  const PORT = 9400 + Math.floor(Math.random() * 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-gallery-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
      } catch { /* 还没起来 */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('连不上 headless 浏览器');
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    };
    const send = (method, params = {}) =>
      new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: Math.max(W, 1280), height: Math.max(H + 220, 900), deviceScaleFactor: 1, mobile: false });
    return await fn({ send, evaluate });
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    proc.kill();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 300);
  }
}

async function renderMap(slug, previewUrl) {
  const dir = path.join(OUT_DIR, slug);
  if (!FORCE && fs.existsSync(dir) && fs.readdirSync(dir).length >= SHOTS.length) {
    console.log(`  ${slug}: 已有 ${SHOTS.length} 张，跳过（--force 可重做）`);
    return { slug, skipped: true };
  }
  fs.mkdirSync(dir, { recursive: true });

  return withPage(async ({ send, evaluate }) => {
    await send('Page.navigate', { url: `${BASE}/preview/?map=${encodeURIComponent(slug)}` });
    /* 等数据 + 地形加载完（页面里 #loading 消失、地形那行出现面数） */
    let ok = false;
    for (let i = 0; i < 60; i++) {
      const state = await evaluate(`(()=>{
        const l = document.getElementById('loading');
        const t = document.getElementById('tstat');
        return JSON.stringify({ loading: l ? getComputedStyle(l).display : 'none', tstat: t ? t.textContent : '' });
      })()`).catch(() => '{}');
      const s = JSON.parse(state || '{}');
      if (s.loading === 'none' && /面|失败|无/.test(s.tstat || '')) { ok = true; break; }
      await sleep(700);
    }
    if (!ok) console.log(`  ${slug}: 数据没等到，仍然尝试截图`);
    await sleep(900);

    /* 干净画面：藏掉页面内的浮层（这些在画布上方，会进截图） */
    await evaluate(`(()=>{
      for (const sel of ['.esearch', '#ltoggle', '.v3hud', '.hud', '.tip', '#layers', '#glwarn']) {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      }
      return 1;
    })()`);

    const rect = JSON.parse(await evaluate(`JSON.stringify((()=>{ const r=document.getElementById('stage').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })())`));
    const written = [];
    for (const shot of SHOTS) {
      await evaluate(`(()=>{
        CAM.yaw = ${shot.yaw}; CAM.pitch = ${shot.pitch};
        CAM.dist = (CAM.span || 1000) * 1.30 * ${shot.zoom};
        if (CAM.free) {
          const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
          CAM.ex = CAM.tx + CAM.dist*cp*Math.cos(CAM.yaw);
          CAM.ey = CAM.ty + CAM.dist*sp;
          CAM.ez = CAM.tz + CAM.dist*cp*Math.sin(CAM.yaw);
        }
        render3D();
        return 1;
      })()`);
      await sleep(450);
      const png = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      const out = path.join(dir, `${shot.name}.webp`);
      await sharp(Buffer.from(png.result.data, 'base64'))
        .resize({ width: W, height: H, fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toFile(out);
      written.push(out);
    }

    /* 工坊预览图（作者的截图） */
    if (previewUrl) {
      try {
        const buf = execFileSync('curl.exe', ['-sS', '--max-time', '30', previewUrl], { maxBuffer: 32 * 1024 * 1024 });
        await sharp(buf)
          .resize({ width: Math.min(W, 1024), withoutEnlargement: true })
          .webp({ quality: 84 })
          .toFile(path.join(dir, '05-workshop.webp'));
        written.push('05-workshop.webp');
      } catch (e) {
        console.log(`  ${slug}: 工坊预览图下载失败（${e.message}）`);
      }
    }
    const sizes = fs.readdirSync(dir).map((f) => `${f} ${Math.round(fs.statSync(path.join(dir, f)).size / 1024)}KB`);
    console.log(`  ${slug}: ${sizes.join(' · ')}`);
    return { slug, count: written.length };
  });
}

/* ---------- 主流程 ---------- */
const ids = slugs.map(workshopIdOf).filter(Boolean);
const previews = fetchPreviewUrl(ids);
console.log(`工坊预览图：拿到 ${previews.size} / ${ids.length} 张`);

/* 只要工坊图的路：不碰浏览器，546 张几分钟跑完 */
if (WORKSHOP_ONLY) {
  let ok = 0, fail = 0;
  for (const slug of slugs) {
    const id = workshopIdOf(slug);
    const url = id ? previews.get(id) : null;
    if (!url) { fail++; continue; }
    const dir = path.join(OUT_DIR, slug);
    const out = path.join(dir, '05-workshop.webp');
    if (!FORCE && fs.existsSync(out)) { ok++; continue; }
    fs.mkdirSync(dir, { recursive: true });
    try {
      const buf = execFileSync('curl.exe', ['-sS', '--max-time', '40', url], { maxBuffer: 32 * 1024 * 1024 });
      await sharp(buf).resize({ width: Math.min(W, 1024), withoutEnlargement: true }).webp({ quality: 84 }).toFile(out);
      ok++;
      if (ok % 25 === 0) process.stdout.write(`\r  已保存 ${ok} 张   `);
    } catch {
      fail++;
    }
  }
  process.stdout.write('\n');
  console.log(`✓ 工坊预览图 ${ok} 张（失败/没有 ${fail}）→ ${path.relative(ROOT, OUT_DIR)}`);
  process.exit(0);
}

let done = 0;
for (const slug of slugs) {
  const id = workshopIdOf(slug);
  const url = id ? previews.get(id) : null;
  try {
    const r = await renderMap(slug, url);
    if (!r.skipped) done++;
  } catch (e) {
    console.error(`  ${slug}: 失败 —— ${e.message}`);
  }
}
console.log(`✓ 完成 ${done} 张地图 → ${path.relative(ROOT, OUT_DIR)}`);
