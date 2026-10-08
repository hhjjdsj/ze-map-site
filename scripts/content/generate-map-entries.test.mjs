import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdText, docItemRows, mergeItems } from '../../shared/items.mjs';
import { validateValue } from '../../shared/submission-fields.mjs';
import { applySubmission, contributors, emptyDoc, normalizeDoc } from '../../shared/community-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('JSON and catalog overwrite MDX regardless of its previous origin', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-map-entries-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const dir of ['scripts/content', 'shared', 'data/research', 'src/content/maps', 'public/entity']) {
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'scripts/content/generate-map-entries.mjs'), path.join(temp, 'scripts/content/generate-map-entries.mjs'));
  /* shared/ 整个复制：生成器依赖 difficulty / entity-source / community-doc / items，
     漏一个就会在临时目录里 import 失败（这里是测生成器，不是测打包） */
  for (const name of fs.readdirSync(path.join(root, 'shared'))) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'shared', name), path.join(temp, 'shared', name));
  }
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'public/entity/catalog.json'), JSON.stringify({
    meta: { legacyBuilt: '2026-01-01' }, groups: [], maps: [
      { a: '2001', m: 'ze_demo', s: '2001-ze_demo-1', f: '1', k: '2001/ze_demo/1', cn: 'Demo', n: 1, k2: 1, st: 0, c: {}, t: [] },
      { a: '2001', m: 'ze_other', s: '2001-ze_other-2', f: '2', k: '2001/ze_other/2', cn: 'Other', n: 1, k2: 1, st: 0, c: {}, t: [] },
    ],
  }));
  fs.writeFileSync(path.join(temp, 'data/research/ze_demo.json'), JSON.stringify({ title: 'From JSON', summary: null, tags: [] }));
  /*
   * 手写小节的图（2026-10-08 起的新写法）：正文放 sections，页面 slug 与实体名不同时用 maps 声明。
   * 以前这里测的是 `document` 整篇照抄 + scripts/content/curated-links.json 的映射，
   * 那条特殊路径已经取消 —— 现在和普通图同一条流程，只是正文来自 sections。
   */
  fs.writeFileSync(path.join(temp, 'data/research/ze_rich.json'), JSON.stringify({
    slug: 'ze_rich',
    maps: ['ze_other'],
    title: 'Rich',
    difficulty: '未知',
    sections: [{ title: '背景故事', body: 'Rich body' }],
    sources: ['https://example.com/x'],
  }));
  fs.writeFileSync(path.join(temp, 'src/content/maps/ze_demo.mdx'), 'Manual MDX without generator marker');
  fs.writeFileSync(path.join(temp, 'src/content/maps/ze_rich.mdx'), 'Old manual rich page');

  const generate = () => {
    const result = spawnSync(process.execPath, [path.join(temp, 'scripts/content/generate-map-entries.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  generate();
  const demo = fs.readFileSync(path.join(temp, 'src/content/maps/ze_demo.mdx'), 'utf8');
  assert.match(demo, /title: "From JSON"/);
  assert.doesNotMatch(demo, /Manual MDX/);

  const rich = fs.readFileSync(path.join(temp, 'src/content/maps/ze_rich.mdx'), 'utf8');
  assert.match(rich, /title: "Rich"/);
  assert.match(rich, /titleEn: "ze_rich"/); // 页面名，不是实体名 ze_other
  assert.match(rich, /## 背景故事/);
  assert.match(rich, /Rich body/);
  assert.match(rich, /<MapGallery slug="ze_rich"/);
  /* maps 里被接管的实体不再单独出页 */
  assert.equal(fs.existsSync(path.join(temp, 'src/content/maps/ze_other.mdx')), false);

  generate();
  assert.equal(fs.readFileSync(path.join(temp, 'src/content/maps/ze_demo.mdx'), 'utf8'), demo);
  assert.equal(fs.readFileSync(path.join(temp, 'src/content/maps/ze_rich.mdx'), 'utf8'), rich);
});

test('老的 document 字段会被明确拒绝（避免静默退回数据条目）', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-map-doc-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const dir of ['scripts/content', 'shared', 'data/research', 'src/content/maps', 'public/entity']) {
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'scripts/content/generate-map-entries.mjs'), path.join(temp, 'scripts/content/generate-map-entries.mjs'));
  for (const name of fs.readdirSync(path.join(root, 'shared'))) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'shared', name), path.join(temp, 'shared', name));
  }
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'public/entity/catalog.json'), JSON.stringify({ meta: { legacyBuilt: '2026-01-01' }, groups: [], maps: [] }));
  fs.writeFileSync(path.join(temp, 'data/research/ze_old.json'), JSON.stringify({ slug: 'ze_old', document: '---\ntitle: Old\n---\nbody\n' }));
  const result = spawnSync(process.execPath, [path.join(temp, 'scripts/content/generate-map-entries.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /还有 document 字段/);
});

/* ===== 神器 / 道具（items 字段）===== */

const base = [
  { name: 'Survivor', cd: 45, maxuses: 1 },
  { name: 'Sniper', cd: 45, maxuses: 1 },
  { name: 'Heal', cd: 80, maxuses: 0 },
];

test('神器 / 道具：逐行合并，原值留在备注里', () => {
  const { rows, changed } = mergeItems(base, [
    { action: 'update', name: 'Survivor', cd: 60, uses: null, note: '第四关才有', by: '老王' },
    { action: 'add', name: '新道具', cd: 30, uses: 2, note: '', by: '老王' },
    { action: 'remove', name: 'Sniper', cd: null, uses: null, note: '本图没有', by: '小李' },
  ]);

  assert.equal(changed, 3);
  assert.equal(rows.length, 4, '删除是标注而不是删行，避免正文里凭空少一件');

  assert.equal(rows[0].name, 'Survivor');
  assert.equal(rows[0].kind, 'updated');
  assert.equal(rows[0].cd, 60);
  assert.equal(rows[0].uses, 1, '次数留空 = 不改这一项');
  assert.deepEqual(rows[0].original, { cd: 45, uses: 1 });
  assert.equal(rows[0].by, '老王');

  assert.equal(rows[1].name, 'Sniper');
  assert.equal(rows[1].kind, 'removed');
  assert.equal(rows[1].cd, 45, '原值保留');
  assert.equal(rows[1].note, '本图没有');

  assert.equal(rows[2].name, 'Heal');
  assert.equal(rows[2].kind, 'server', '没被投稿碰过的行保持原样');

  const added = rows.find((r) => r.name === '新道具');
  assert.equal(added.kind, 'added');
  assert.equal(added.cd, 30);
  assert.equal(added.uses, 2);
});

test('神器 / 道具：同名一律按更正处理，大小写与全角空格不算新道具', () => {
  const { rows, changed } = mergeItems(base, [
    { action: 'add', name: '  survivor ', cd: 90, uses: null, note: '' },
  ]);
  assert.equal(changed, 1);
  assert.equal(rows.length, 3, '不该多出一行同名道具');
  assert.equal(rows[0].kind, 'updated');
  assert.equal(rows[0].cd, 90);
});

test('神器 / 道具：没有服务器配置时整张表由社区提供', () => {
  const { rows } = mergeItems([], [{ action: 'add', name: 'Foo', cd: 20, uses: 3, note: '仅第一关', by: '某人' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'added');
  assert.equal(rows[0].uses, 3);
});

test('神器 / 道具：配置里的小数冷却不能被抹掉（ze_dark_souls 一整排 4.5 / 2.5 秒）', () => {
  const { rows } = mergeItems(
    [
      { name: 'Estus Flask', cd: 4.5, maxuses: 0 },
      { name: 'Dark Orb', cd: 2.5, maxuses: 0 },
    ],
    []
  );
  assert.equal(rows[0].cd, 4.5);
  assert.equal(rows[1].cd, 2.5);
  assert.equal(cdText(rows[0].cd), '4.5 秒');
  assert.equal(cdText(null), '—');

  /* 投稿也允许小数冷却：不然「改成 4 秒」这种更正根本提交不上去 */
  const ok = validateValue('items', [{ action: 'update', name: 'Dark Orb', cd: '4.5', uses: '', note: '' }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.value[0].cd, 4.5);

  /* 次数仍是整数 */
  const badUses = validateValue('items', [{ action: 'update', name: 'Dark Orb', cd: '', uses: '1.5', note: '' }]);
  assert.equal(badUses.ok, false);
});

test('投稿校验：神器 / 道具行必须说清改了什么', () => {
  const ok = validateValue('items', [
    { action: 'update', name: 'Survivor', cd: '60', uses: '', note: '' },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, [{ action: 'update', name: 'Survivor', cd: 60, uses: null, note: '' }]);

  const empty = validateValue('items', [{ action: 'update', name: 'Survivor', cd: '', uses: '', note: '' }]);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /什么都没改/);

  const noName = validateValue('items', [{ action: 'add', cd: 30 }]);
  assert.equal(noName.ok, false);
  assert.match(noName.error, /缺少道具名/);

  const badAction = validateValue('items', [{ action: '改一下', name: 'X', cd: 30 }]);
  assert.equal(badAction.ok, false);
  assert.match(badAction.error, /更正 \/ 新增 \/ 删除/);

  const dup = validateValue('items', [
    { action: 'add', name: 'X', cd: 30 },
    { action: 'update', name: 'x', cd: 40 },
  ]);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /写了两行/);

  const pipe = validateValue('items', [{ action: 'add', name: 'A|B', cd: 30 }]);
  assert.equal(pipe.ok, false);

  const range = validateValue('items', [{ action: 'add', name: 'X', cd: 99999 }]);
  assert.equal(range.ok, false);
  assert.match(range.error, /0~3600/);
});

/* ===== 手写正文里的神器表（魔晄炉 / 米纳斯 / 黑珍珠号）===== */

test('手写资料：认得出三种写法的神器表（中文+英文 / 中文+分数 / 中文+效果+冷却）', () => {
  const mako = `## 神器（Materia）

<table class="item-table">
  <tbody>
    <tr><td>火焰</td><td>Fire</td><td>火焰伤害</td><td>可升级</td></tr>
    <tr><td>究极</td><td>Ultima</td><td>大范围伤害</td><td>固定刷新点，不升级</td></tr>
  </tbody>
</table>

## 视频攻略

<table><tbody><tr><td>不该被读到</td></tr></tbody></table>`;

  const makoRows = docItemRows(mako);
  assert.deepEqual(
    makoRows.map((r) => [r.name, r.label]),
    [
      ['Fire', '火焰'],
      ['Ultima', '究极'],
    ]
  );

  const lotr = `## 神器 / 道具表

| 神器 | 分数 | 效果 |
|---|---|---|
| 旗子 | 100 | 血量变为 200 |
| 甘道夫 | 300 | 圣光 |`;
  assert.deepEqual(docItemRows(lotr).map((r) => r.name), ['旗子', '甘道夫']);

  const potr = `## 神器 / 道具表

<table><tbody>
  <tr><td>炸药桶</td><td>放置后减速僵尸</td><td>60s</td><td>断后位</td></tr>
  <tr><td>巴博萨</td><td>后 3 关出现</td><td>—</td><td>僵尸方</td></tr>
</tbody></table>`;
  const potrRows = docItemRows(potr);
  assert.deepEqual(potrRows.map((r) => r.name), ['炸药桶', '巴博萨']);
  assert.equal(potrRows[0].cd, 60, '独立的 60s 单元格应当认成冷却');
  assert.equal(potrRows[1].cd, null);

  assert.deepEqual(docItemRows('## 关卡\n\n没有表'), []);
  assert.deepEqual(docItemRows(''), []);
});

test('社区文档：items 落到自己的桶里，并记进贡献者名单', () => {  const doc = emptyDoc('ze_demo');
  const change = applySubmission(doc, {
    id: 7,
    field: 'items',
    value: [{ action: 'update', name: 'Survivor', cd: 60, uses: null, note: '改一下' }],
    submitter: '老王',
    reviewedAt: Date.parse('2026-09-27T00:00:00Z'),
  });

  assert.equal(change.field, 'items');
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].by, '老王');
  assert.equal(doc.fields.items, undefined, '神器 / 道具不该进 fields（那是整值覆盖）');

  /* 同名再来一条 = 覆盖那一行，不是追加第二行 */
  applySubmission(doc, {
    id: 8,
    field: 'items',
    value: [{ action: 'remove', name: 'Survivor', note: '本图没有' }],
    submitter: '小李',
    reviewedAt: Date.parse('2026-09-27T01:00:00Z'),
  });
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].action, 'remove');
  assert.equal(doc.items[0].by, '小李');

  /* 手改坏的文件也要能读：坏行丢掉，好行留下 */
  const broken = normalizeDoc('ze_demo', { items: [{ name: '' }, { action: 'add', name: 'Good', cd: '30' }, null] });
  assert.equal(broken.items.length, 1);
  assert.equal(broken.items[0].name, 'Good');
  assert.equal(broken.items[0].cd, 30);
});

test('社区文档：一批投稿（字段 + 背景故事 + 神器行）能一起应用 —— 攒批写回的基础', () => {
  const doc = emptyDoc('ze_demo');
  const at = Date.parse('2026-10-05T00:00:00Z');
  const batch = [
    { id: 11, field: 'difficulty', value: '困难', submitter: '甲' },
    { id: 12, field: 'tags', value: ['批量', '测试'], submitter: '甲' },
    { id: 13, field: 'story', value: '一段社区补充的背景故事。', submitter: '乙' },
    { id: 14, field: 'items', value: [{ action: 'add', name: 'Foo', cd: 30, uses: 1, note: '' }], submitter: '丙' },
  ];
  for (const s of batch) applySubmission(doc, { ...s, reviewedAt: at });

  assert.equal(doc.fields.difficulty.v, '困难');
  assert.deepEqual(doc.fields.tags.v, ['批量', '测试']);
  assert.equal(doc.notes.length, 1);
  assert.equal(doc.notes[0].field, 'story', 'note 要记住它投的是哪个字段');
  assert.equal(doc.items.length, 1);
  assert.equal(doc.log.length, 4, '每条投稿都要在 log 里留一行');
  assert.deepEqual(contributors(doc), ['甲', '乙', '丙']);
  assert.equal(doc.updatedAt, null, 'updatedAt 由调用方 touch()，applySubmission 不自己写时间');
});
