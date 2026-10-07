# 难度回填：来自一份服务器地图列表（2026-10-08）

## 结论

548 张地图里，**未知难度从 432 张降到 9 张**。现在分布：

| 难度 | 入门 | 简单 | 普通 | 困难 | 火星 | 入土 | 未知 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 张数 | 51 | 151 | 91 | 170 | 66 | 10 | 9 |

改动：`data/research/*.json` 448 个（389 张改值 + 59 张原本没有 `difficulty` 键的补上）、
`src/content/maps/*.mdx` 447 个（生成器重跑）。**没有动任何渲染/评分逻辑**。

## 数据是从哪来的

站长录了一段 70 秒的屏幕录像（`QQ20261008-001623.mp4`，1310×574）：某个 ZE 服务器的地图管理器
界面，表格按地图内部名排序，列是 **地图 / 译名 / 难度 / 模式 / 大小 / 状态 / 通知**，
难度用的正是本站的六档枚举（入门/简单/普通/困难/火星/入土）。

抽取方式（本机没有 ffmpeg，所以走无头浏览器）：

1. 用无头 Edge 播放视频，**每 0.5 秒抽一帧**（共 140 帧，画面静止的重复帧会被哈希去重）；
2. 把每帧裁成「地图 + 译名 + 难度」那一块（原图 1280×479 → 裁 800×445，省一半面积）；
3. 交给 4 个子代理并行抄录（每份 35 帧），要求逐字符照抄、看不清写 `?`、**不许猜**；
4. 合并时按 **多数票** 去重（相邻帧重叠，同一行会被读到 2~3 次），
   并把站内不存在的 slug 丢掉。

**准确性核对**：主代理自己读了 4 帧（每份抄录各一帧）当标准答案，逐行比对 —— 31 行里 30 行一致；
唯一一条不一致是主代理看错了（`ze_avalanche_reboot` 在帧顶被半透明红横幅染色，
标准答案应为「火星」，抄录是对的）。跨帧只有 1 处冲突：`ze_rawnscape_p`（普通×2 / 困难×1，取普通）。

## ⚠️ 与站内原有难度冲突的 11 条（按来源覆盖）

这些地图站内本来有难度（多半是早期从别处补的），与服务器列表不一致。
**按站长 2026-10-06 定的规矩「以来源为准」覆盖**，如果哪条你觉得站内的更对，直接改回即可：

| 地图 | 站内原值 | 本次改为 |
| --- | --- | --- |
| ze_abandoned_industry_p | 普通 | 简单 |
| ze_ancient_wrath_p | 困难 | 火星 |
| ze_aoraitsu_reloaded | 普通 | 困难 |
| ze_dark_souls | 困难 | **入土** |
| ze_jurassicpark_p | 简单 | 入门 |
| ze_loom | 普通 | 困难 |
| ze_mountain_escape_snow | 简单 | 入门 |
| ze_obf_rescape | 困难 | 火星 |
| ze_requiem_test | 普通 | 困难 |
| ze_samosbor | 困难 | 火星 |
| ze_squid_game | 简单 | 困难 |

## 视频里有、本站没有条目的 22 个（没写进去）

`ze_bioshock_v6_cs2`、`ze_bluearchive_abydos`、`ze_boatsescape101_p`、`ze_boatsescape777`、
`ze_boatsescape888`、`ze_boatsescape999`、`ze_boatsescape_ultimate`、`ze_ffvii_mako_reactor_v5_3`、
`ze_ffvii_mako_reactor_v6_p`、`ze_grace`、`ze_halo3_thestorm`、`ze_jaser_island_z`、
`ze_lemonsnickets_p`、`ze_light_shadow_cs2`、`ze_little_trip`、`ze_lotr_minas_tirith_cs2`、
`ze_mlgsurf`、`ze_obscura_tower`、`ze_silenthill_pt`、`ze_steyliff_grove_r`、`ze_trepang`、`ze_verdant`

其中几类：

- **版本变体 / 拼写不同**：`ze_ffvii_mako_reactor_v5_3`、`ze_ffvii_mako_reactor_v6_p`（站内合并成
  `ze_ffvii_mako_reactor`）、`ze_lotr_minas_tirith_cs2`（站内 `ze_lotr_minas_tirith`）、
  `ze_steyliff_grove_r`、`ze_lemonsnickets_p`（站内拼作 `ze_lemonysnickets_p`）。
  `ze_boatsescape*` 五个是转置拼写，站内叫 `ze_boatescape*` —— 顺带验证：这五张站内本来就是「入门」，
  与视频一致，所以没有做别名映射。
- **本站确实缺条目**：`ze_grace`、`ze_halo3_thestorm`、`ze_light_shadow_cs2`、`ze_little_trip`、
  `ze_mlgsurf`、`ze_obscura_tower`、`ze_silenthill_pt`、`ze_trepang`、`ze_verdant`、
  `ze_bioshock_v6_cs2`、`ze_bluearchive_abydos`。想补的话走 `npm run map:add`。

## 还剩 1 张未知

`ze_zombie_scenario_lostcity`（失落之城，工坊已下架、没进那个服务器的图池）。
等着站内的**难度投票**补（入口在地图页，见 `/api/vote`），或者哪次玩到了直接告诉我。

## 追加（同日，站长直接给了值）

站长随后手动补齐了最后一批，现在 **未知 = 1 张**：

| 地图 | 难度 | 说明 |
| --- | --- | --- |
| ze_lemonysnickets_p | 简单 | |
| ze_puta_p | 简单 | |
| ze_studying_the_factory | 简单 | |
| ze_surf_sparks_cs2 | 简单 | |
| ze_surf_vortex_p | 简单 | 资料文件里原本连 `difficulty` 键都没有，本次插入 |
| ze_toggle_theory | 困难 | |
| ze_winter | 简单 | |
| ze_tesv_skyrim_i | 火星 | ⚠️ 站长写的是 `ze_tesv_skyrim_p`（那张本来就是火星）；站内唯一还是未知的是 `_i`，按同一张图处理，两张都设为火星。另外它是全站唯一没有资料文件的地图，本次补建 |

同时为 **11 张「视频里有、本站还没有条目」的地图**先建了资料 stub
（`data/research/<slug>.json`：只写 difficulty + 一条 `_待建条目` 说明）。
它们**不会**出现在站点上（生成器只认工坊地图包里有实体数据的图），
但等哪天用 `npm run map:add -- <工坊ID>` 把图加进来，难度会自动生效：

`ze_grace` 困难 · `ze_halo3_thestorm` 困难 · `ze_light_shadow_cs2` 困难 · `ze_little_trip` 普通 ·
`ze_mlgsurf` 简单 · `ze_obscura_tower` 困难 · `ze_silenthill_pt` 简单 · `ze_trepang` 火星 ·
`ze_verdant` 困难 · `ze_bioshock_v6_cs2` 困难 · `ze_bluearchive_abydos` 困难

⚠️ 这 11 张在 `public/entity/catalog.json`（646 张工坊地图的实体目录）里**一个都没有** ——
所以加图这件事不只是写个条目：得先把地图包加进工坊订阅、重跑实体烘焙，才会有 3D 预览和实体数据。

## 最终分布

| 难度 | 入门 | 简单 | 普通 | 困难 | 火星 | 入土 | 未知 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 张数 | 51 | 157 | 91 | 171 | 67 | 10 | **1** |
