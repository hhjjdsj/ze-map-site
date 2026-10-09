# 成批扩图：把 s2ze 上有、我们没有的 ZE 图接进来

一次几十上百张的扩图流程。2026-10-09 用这套流程接入了 s2ze 剩下的 ZE 图（473 个工坊条目）。

## 0. 先算清楚「哪些还没有」

```bash
node scripts/content/plan-new-maps.mjs
```

产出两份清单（都在 `.gitignore` 覆盖的 `data/` 下，不进仓库）：

| 文件 | 内容 |
|---|---|
| `data/bootstrap-live.txt` | **还能下载**的图，按体积升序（小的先跑，先出成果） |
| `data/bootstrap-dead.txt` | **工坊已下架**的图 —— 源文件永远拿不到，只能出「没有实体预览」的资料页 |

三个容易踩的坑，脚本已经处理：

1. **s2ze 的清单有重复条目**（同一工坊 ID 出现多次）。2026-10-09 那次 513 条里只有 473 个不同 ID —— 不去重会把批次算大 40 张。
2. **能不能下载**要用 Steam 的 `GetPublishedFileDetails` 的 `result` 字段判断（`1` 在售 / `9` 已删除），**不能**拿 s2ze 的体积字段代替：s2ze 的 `height` 只覆盖一部分图，而且下架的图照样有体积记录。
3. **真实的体积**只能问 Steam 的 `file_size`。s2ze 的 `height` 是字符串（`"142.424 MB"`），量纲还得自己解析。

实测（2026-10-09）：473 个条目 → 330 个不同地图名的可下载图 / 80.1 GB，129 个已下架。

## 1. 烘焙：实体分片 + 地形分片

```powershell
# 分批跑，每批 100 张；done.txt 断点续跑，重复执行会跳过已完成的
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/terr-bake/bake-all.ps1 `
  -IdsFile E:\Astro-code\ze-map-site\data\bootstrap-live.txt -MaxMaps 100 -Parallel 2
```

- **下载是大头**：每张 5 MB 的小图也要 ~25 秒（steamcmd 的固定开销），大图按带宽算；烘焙本身每张 **1–3 秒**。
- 产物两处：`public/entity/data/2001-<英文名>-<工坊ID>.bin`（**进仓库**，中位 13 KB，330 张合计约 5 MB）、`bake/terr/<工坊ID>.bin`（仓库外，每张约 0.6 MB，最后传 R2）。
- `scripts/terr-bake/data/done.txt` / `failed.txt` 是进度台账（入库），失败原因看 `scripts/terr-bake/bake.log`。

⚠️ 2026-10-09 修掉的坑：`bake-all.ps1` 里 worker 原本是 `powershell.exe -File bake-one.ps1` 的嵌套调用，**没装 Steam 的机器**上 `-LocalCache` 是空串，Windows PowerShell 5.1 会丢掉空实参、参数表整体错位，worker 秒退且错误只进 error 流，日志只写 `worker no result`。现在改成 splat 直接调用，失败会打印真实原因。

## 2. 条目原稿（只补缺失的）

```bash
node scripts/content/scaffold-entries.mjs --ids data/bootstrap-live.txt --ids data/bootstrap-dead.txt
```

- 地图英文名的来源：**已烘分片的内部名 > s2ze 的 `name`**。前者最可靠（作者填的工坊标题可能带中文、空格、括号）。
- 只生成 `{slug, title, summary:null, tags:[], videoUrls:[], sources:[], confidence:'low'}` 这种最小原稿，**已存在的同名原稿一律跳过**，绝不覆盖人工内容。
- 难度不写 → 生成器落成「未知」，页面自动标「资料待补充」。
- 只收 `ze_` 开头的图（和 `scripts/content/add-map.mjs` 同一条规矩）。

## 3. 工坊资料

```powershell
# 在售图：catalog 里的都会抓（按 -Mode 2001 过滤）
powershell -File scripts/content/fetch-workshop.ps1 -Mode 2001
# 下架图：catalog 里没有它们，要直接点名
powershell -File scripts/content/fetch-workshop.ps1 -IdsFile data\bootstrap-dead.txt
```

下架图也会落一份 `data/workshop/<id>.json`（`result: 9`）—— **必须有**，生成器靠它写 `workshopMissing: true`，页面才能解释「为什么没有实体预览」。

⚠️ 国内网络直连 `api.steampowered.com` 时通时不通（2026-10-09 实测断了十几分钟，`curl` 直连和走代理都返回 000）。脚本已内置重试 3 次，另有 `-Proxy http://127.0.0.1:7897`。

## 4. 封面

| 图的类型 | 命令 | 说明 |
|---|---|---|
| 在售 | `node scripts/gallery/fetch-workshop-previews.mjs --all` → `npm run cover:workshop` | 作者上传的工坊预览图（`bake/gallery/<英文名>/05-workshop.<ext>` → `public/images/covers/workshop/`） |
| 已下架 | `node scripts/gallery/fetch-s2ze-covers.mjs --ids data/bootstrap-dead.txt` → `npm run cover:workshop` | 图源是 s2ze 记录里留着的 Steam CDN 地址 —— 工坊条目没了，图通常还在（但**不保证**：2026-10-09 实测 126 张里 87 张还能下，其余 404） |

没有封面不影响上线：详情页用深色 hero；有实体数据的图还会用 `npm run data:covers` 渲染的密度图兜底。

## 5. 体积 → 生成 → 校验 → 上传

```bash
npm run data:sizes        # 按工坊 ID 匹配，不靠地图名（名字带中文/标点的图也能对上）
npm run maps:generate
npm run build
npm run content:verify && npm run cover:verify && npm run content:mdx && npm run content:shaders && npm run content:links
npm run terr:upload       # 传 R2，顺带重写 data/terr-manifest.json（这个文件要提交）
```

## 6. 没有实体预览的图，页面上怎么解释

这是**硬要求**：读者看到侧栏空着只会以为网站坏了。三层口径都从可查证的事实出发，不写「可能」：

| 位置 | 内容 |
|---|---|
| 侧栏顶部说明卡（`.entity-cta.is-off`，虚线描边、明确不是按钮） | 完整原因 + 怎么办 |
| 基本信息表 | `实体预览 | 暂无（工坊已下架 / 地图包内无实体定义 / 缺碰撞地形 / 尚未入库）` |
| 「数据来源」卡 | 「本图还没有实体数据，因此没有实体预览（原因见上方说明）」 |

原因的判定顺序（见 `src/pages/maps/[...slug].astro`）：

1. `data/entity-status.json` 里登记的实测结论 —— `delisted` / `no-entity-data`（地图包里没有 `default_ents.vents_c`）/ `no-physics`（没有世界碰撞网格）；
2. `workshopMissing: true`（工坊接口 `result != 1`）→ 已下架；
3. 兜底：尚未入库。

「**有实体点位、但没有真实碰撞地形**」是另一种情况：预览仍可打开，CTA 里会说明 3D 视图没有地面起伏（判定依据是 `data/terr-manifest.json`）。

## 7. 下架图的条目是怎么来的

条目一直是**由实体分片驱动**的（`catalog.json` → 页面），而下架图永远不会有分片。所以
`scripts/content/generate-map-entries.mjs` 末尾加了第二轮：扫 `data/research/*.json`，把 slug 形如
`2001-<英文名>-<工坊ID>`、又没有被主循环用掉的原稿，按 `noEntity` 生成条目 ——
正文不写实体数 / 分片点位 / 预览链接，页面侧栏走上面那套说明。将来这张图真烘出了分片，
主循环（同一个 slug）会接管，第二轮自动不再重复生成。

## 8. 2026-10-09 那次实战踩到的坑（下次照做能省几小时）

1. **下载是纯瓶颈，而且可以并行。** 单个 steamcmd 逐张下载约 3.6 MB/s（每张 ~20 秒登录开销）；
   复制一份 `.tools/steamcmd2`（独立安装目录）后**两个实例同时下**，实测合计 **24.5 MB/s**，
   把剩余 60 GB 从「5~6 小时」压到约 1 小时。两份清单要**按体积交替切分**，两边体量才均衡。
   同时给 `bake-all.ps1` 传 `-LogFile`，否则两个进程的日志混在一个 `bake.log` 里没法看进度。
2. **不要试图「一次登录连下多张」。** 一条命令行里连写 25 个 `+workshop_download_item` 实测
   **卡死 59 分钟、一张都没下成**（随后逐张重试反而每张 10~20 秒成功）。已写进 `bake-all.ps1` 注释。
3. **s2ze 的地图名 ≠ 地图包内部名。** 33 例（`ze_Lightnight` → 内部 `ze_lightnight_v1`、
   `ze_Ramp_xyy` → `ze_ramp_xyyy`…）。用 s2ze 名当页面 slug 会生成一批**空壳重复页**，
   等真烘出来才发现同一张图有两个页面。**页面 slug 一律以分片内部名为准**：
   先烘焙、再跑 `scaffold-entries.mjs`（它优先取分片名，取不到才退回 s2ze 名）。
4. **删空壳页时要连封面一起处理**：`bake/gallery/<slug>/` 的暂存目录还留着旧名字的话，
   下次 `npm run cover:workshop` 又会把孤儿封面导回来（`cover:verify` 会红）。
5. **文件名里带 `-` 的地图**（`ze_bp-infested-prison_p`、`ze_infested-industry_p`）写不了原稿：
   `verify-research.mjs` 的 slug 规则只允许 `[a-zA-Z0-9_]`。它们的页面由分片正常生成，只是没有原稿。
6. **作者草稿名不是 ZE 图**：s2ze 里混着 `protecting` / `untitl12` / `untitled_jump` 这类内部名，
   烘焙能成功但违反「只收 ZE」的规矩 —— 收完要按 `^ze_` 过滤一遍页面和 catalog。
7. **失败原因要登记**，否则页面只能说「尚未入库」这种含糊话：核对 `bake-a.log` / `bake-b.log` 里失败的
   `stage`，写进 `data/entity-status.json`（`delisted` / `no-entity-data` / `no-physics` / `parse-failed`）。
8. **catalog 的 1:1 是「大小写敏感」比较的坑**：`ze_1_schizo`（catalog）与 `ze_1_ScHiZo`（页面）
   在 Windows 上是同一个文件，JS 字符串比较却认为不同 —— 审计脚本要按小写比较。

## 9. 已知遗留

- **同名重传**：同一张图「下架旧版 + 在售新版」共用地图名，13 例（`ze_puritytest`、`ze_kz`、`ze_my_first_escape` …）。页面按名字只出一张，原稿的 slug 已改指**在售**的工坊 ID。
- **12 张下架图的内部名无从考证**：s2ze 里存的是显示名（`ze_12の凑家`、`ze_fate/stay_night_ubw`、`ze_changing_room_version:cn` …），带中文/空格/标点，不能当 slug。要收就得人工定名。
- 下架图普遍**没有封面**：s2ze 的 CDN 图会 404，没有实体数据也就没有渲染兜底。
