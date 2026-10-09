#!/usr/bin/env node
/** Reconcile the committed map index with locally baked per-map shards. No network access. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { classify } from './lib/entity-common.mjs';
import { BAKED_SOURCE, LEGACY_SOURCE, normalizeEntitySource } from '../../shared/entity-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readShard(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const length = raw.readUInt32LE(0);
  return JSON.parse(raw.subarray(4, 4 + length).toString('utf8'));
}

function workshopDate(root, id) {
  const file = path.join(root, 'data/workshop', `${id}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return info.result === 1 ? info.timeCreated || undefined : undefined;
  } catch { return undefined; }
}

export function buildCatalog(root = ROOT) {
  const indexFile = path.join(root, 'public/entity/catalog.json');
  const dir = path.join(root, 'public/entity/data');
  const existing = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const previous = new Map(existing.maps.map((entry) => [entry.s, entry]));
  const maps = [];
  const files = fs.readdirSync(dir).filter((name) => /^\d+-.+-\d+\.bin$/.test(name)).sort();

  for (const name of files) {
    const slug = name.slice(0, -4);
    const old = previous.get(slug);
    const payload = readShard(path.join(dir, name));
    const m = payload.map;
    if (!m || !Array.isArray(m.e) || !Array.isArray(payload.classes) || !Array.isArray(m.b)) {
      throw new Error(`Invalid entity shard: ${name}`);
    }
    const parsed = slug.match(/^(\d+)-(.+)-(\d+)$/);
    const a = old?.a || parsed[1];
    const mapName = m.m || parsed[2];
    const id = String(m.f || parsed[3]);
    const source = normalizeEntitySource(payload.meta?.source || old?.source || existing.meta.legacySource || LEGACY_SOURCE);
    const baked = source === BAKED_SOURCE;
    const classes = new Map();
    const counts = {};
    if (baked) {
      for (const e of m.e) {
        const cn = payload.classes[e[3]];
        if (!cn) throw new Error(`Invalid class index in ${name}`);
        classes.set(cn, (classes.get(cn) || 0) + 1);
        const group = classify(cn);
        counts[group] = (counts[group] || 0) + 1;
      }
    }
    maps.push({
      ...(old || {}),
      k: old?.k || `${a}/${mapName}/${id}`,
      s: slug,
      m: mapName,
      i: m.i || mapName,
      cn: old?.cn || m.cn || mapName,
      a,
      f: id,
      d: old?.d || workshopDate(root, id),
      st: old?.st || m.st || 0,
      n: m.n,
      k2: m.e.length,
      c: baked ? counts : (old?.c || m.c || {}),
      b: m.b,
      t: baked ? [...classes].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'en')).slice(0, 6) : (old?.t || m.t || []),
      bg: !!m.bg,
      rb: !!m.rb,
      source,
      sourceBuilt: baked ? undefined : (payload.meta?.built || old?.sourceBuilt || existing.meta.legacyBuilt || existing.meta.built),
    });
    previous.delete(slug);
  }

  // Preserve historical index entries if a shard is temporarily unavailable.
  // 注意：这是**有意**保留的（分片暂时缺失时不丢元数据），所以它不会自动清除条目 ——
  // 要下线一张图，得同时删掉 public/entity/data 下的分片*和*公共索引里的条目
  // （索引本身是「已下线」的事实来源，只删分片的话下次构建会把它并回来）。
  maps.push(...previous.values());
  maps.sort((x, y) => x.a.localeCompare(y.a) || x.m.localeCompare(y.m) || x.f.localeCompare(y.f));
  const legacySource = normalizeEntitySource(
    existing.meta.legacySource ||
      (existing.meta.source?.includes('MapTracking-CS2') ? existing.meta.source : LEGACY_SOURCE)
  );
  const legacyBuilt = existing.meta.legacyBuilt || existing.meta.built;
  const meta = {
    built: legacyBuilt,
    legacyBuilt,
    legacySource,
    source: 'Steam Workshop VPK (Source2Viewer) / historical entity snapshot',
    maps: maps.length,
    entities_all: maps.reduce((n, m) => n + m.n, 0),
    entities_kept: maps.reduce((n, m) => n + m.k2, 0),
    bg_res: existing.meta.bg_res || 128,
    radars: maps.filter((m) => m.rb).length,
    bg_density: maps.filter((m) => m.bg).length,
    view3d: 1,
  };
  const result = { meta, groups: existing.groups, count: maps.length, maps };
  const output = JSON.stringify(result) + '\n';
  if (output !== fs.readFileSync(indexFile, 'utf8')) fs.writeFileSync(indexFile, output);
  return { maps: maps.length, baked: maps.filter((m) => m.source === BAKED_SOURCE).length, added: maps.length - existing.maps.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = buildCatalog();
  console.log(`catalog: ${summary.maps} maps (${summary.baked} VPK, ${summary.added} added)`);
}
