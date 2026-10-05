#!/usr/bin/env node
/** Add one CS2 ZE Workshop map through the existing bake and content pipelines. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bakeDir = path.join(root, 'scripts/terr-bake');
const cappedFile = path.join(bakeDir, 'data/capped.txt');
const catalogFile = path.join(root, 'public/entity/catalog.json');
const [id, ...extra] = process.argv.slice(2);

if (!id || extra.length || !/^[1-9]\d*$/.test(id)) {
  console.error('用法: npm run map:add -- <Steam 创意工坊物品 ID>');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('单图烘焙依赖 Windows PowerShell 和 Source2Viewer，请在 Windows 上运行。');
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败（退出码 ${result.status ?? '未知'}）`);
}

try {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  if (catalog.maps.some((map) => String(map.f) === id)) {
    throw new Error(`工坊 ID ${id} 已在地图索引中；更新已有地图请使用 npm run bake:start。`);
  }
  const listed = fs.readFileSync(cappedFile, 'utf8').split(/\r?\n/).includes(id);
  const tools = [
    path.join(bakeDir, '.tools/steamcmd/steamcmd.exe'),
    path.join(bakeDir, '.tools/s2v/Source2Viewer-CLI.exe'),
    path.join(root, 'node_modules/meshoptimizer'),
  ];
  if (tools.some((file) => !fs.existsSync(file))) {
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bakeDir, 'setup.ps1')]);
  }

  // Use a temporary one-ID list so the batch script does not process the full backlog.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-map-add-'));
  try {
    const idsFile = path.join(temp, 'ids.txt');
    const doneFile = path.join(bakeDir, 'data/done.txt');
    const doneCount = () => fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split(/\r?\n/).filter((line) => line === id).length : 0;
    const before = doneCount();
    fs.writeFileSync(idsFile, `${id}\n`);
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bakeDir, 'bake-all.ps1'), '-IdsFile', idsFile, '-IgnoreDone', '-Parallel', '1']);

    /* 地形分片写在仓库外的 bake/terr（见 scripts/terr-bake/bake-all.ps1 的说明），
       页面从 R2 取；这里只校验产物存在且非空。 */
    const terrain = path.join(process.env.TERR_OUT || path.join(root, 'bake/terr'), `${id}.bin`);
    const entityDir = path.join(root, 'public/entity/data');
    const shards = fs.readdirSync(entityDir).filter((name) => name.endsWith(`-${id}.bin`));
    if (doneCount() <= before || !fs.existsSync(terrain) || shards.length !== 1 || !fs.statSync(terrain).size) {
      throw new Error(`地图 ${id} 烘焙未完成；检查 scripts/terr-bake/bake.log 和 data/failed.txt。`);
    }
    const shard = zlib.gunzipSync(fs.readFileSync(path.join(entityDir, shards[0])));
    const payload = JSON.parse(shard.subarray(4, 4 + shard.readUInt32LE(0)).toString('utf8'));
    if (String(payload.map?.f) !== id || !/^ze_/i.test(payload.map?.m || '')) {
      throw new Error(`工坊 ID ${id} 的地图不是 CS2 ZE 地图，无法生成 ZE 条目。`);
    }
    if (!listed) fs.appendFileSync(cappedFile, `${fs.readFileSync(cappedFile, 'utf8').endsWith('\n') ? '' : '\n'}${id}\n`);

    const record = spawnSync(process.execPath, [path.join(bakeDir, 'select-bake.mjs'), '--record', idsFile], { cwd: root, stdio: 'inherit' });
    if (record.error || record.status !== 0) console.warn('未能登记工坊版本；本次烘焙已完成，可稍后重试版本登记。');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/content/fetch-workshop.ps1'), '-Mode', '2001', '-Id', id]);
  if (!fs.existsSync(path.join(root, 'data/workshop', `${id}.json`))) {
    throw new Error(`工坊资料 ${id} 抓取失败；稍后重试工坊资料抓取并运行 npm run build。`);
  }
  run(process.execPath, [path.join(root, 'scripts/entity-data/render-covers.mjs')]);
  run(process.execPath, [path.join(root, 'scripts/entity-data/verify-entity-data.mjs'), '--all']);
  run('npm', ['run', 'build'], { shell: true });
  run('npm', ['run', 'content:links'], { shell: true });
  console.log(`\n地图 ${id} 已生成。请核对 git status、地图资料与封面，再提交改动。`);
  /* 地形分片不在仓库里 —— 漏了这步新图在预览页会缺地形（见 docs/r2-migration.md） */
  console.log(`新图的地形分片记得传 R2：npm run terr:upload（顺带刷新 data/terr-manifest.json）`);
} catch (error) {
  console.error(`\n加入地图失败：${error.message}`);
  process.exitCode = 1;
}
