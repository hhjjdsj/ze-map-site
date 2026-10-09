# 外部数据来源（谁提供的数据、怎么刷新、怎么署名）

本站大部分数据是自己算的（实体分片、关卡、神器表、攻略视频），但有几项是**别处来的**。
这份文件把每一项的出处、刷新方式、以及署名要求记清楚 —— 免得日后有人看到
`data/map-sizes.json` 里一堆数字，不知道是谁整理的。

## 1. 地图体积（`data/map-sizes.json`）

- **用途**：详情页侧栏那行「体积 ~194 MB」。玩家在决定下不下载之前，这个数字很实用。
- **来源**：[s2ze.com](https://s2ze.com)（**Ruby Bot**）的公开地图数据
  `https://api.s2ze.com/site/data/maps.json` —— 每条记录的 `height` 字段（名字起得怪，值就是「142.424 MB」）。
- **刷新**：`npm run data:sizes`（`scripts/content/fetch-map-sizes.mjs`）。
  **故意不在构建时现抓**：第三方接口挂了/改版/被墙不该让我们的构建变红，体积也不是天天变的数据。
- **匹配**：先按工坊 ID（我们 frontmatter 的 `workshopId` ↔ 他们的 `addon`），再按地图名（大小写不敏感）。
- **覆盖率**：548 张里 **540 张**有数据。差的 8 张是**版本对不上**而不是漏抓，例如
  `ze_tesv_skyrim_p`（他们记的是 P 组另一次上传，工坊 ID 3242492031；我们目录里是 3239514390）、
  `ze_lotr_minas_tirith`（他们那条是 `ze_LOTR_Minas_Tirith_p`，另一个版本），
  以及 `ze_black_lion_p`、`ze_pools_p`、`ze_last_man_standing`、`ze_fireboy_watergirl`、
  `ze_castlevania_nes`、`ze_laser_competition`（他们没有这些图）。
- **展示口径**：页面上带「~」是**刻意的** —— 这是工坊分包的体积，跟玩家实际下载量可能略有出入；
  鼠标悬停会提示来源。
- **署名**：数据来源写「s2ze.com（Ruby Bot）」。

## 2. 16 张补回来的工坊封面（2026-10-09）

有 18 张图的创意工坊条目被作者删除，Steam 接口拿不到 `preview_url`，页面只能挂黑底密度点图。
s2ze 那份数据里还留着其中 16 张的**原工坊预览图地址**（图在 Steam 图片 CDN 上，条目下架了图还在），
于是抓回来走正常的工坊封面链路入库。清单、复现步骤、以及「哪些是高清原图」都记在
`docs/cover-images.md` 的「从 s2ze 的公开数据补回 16 张」一节。

图片版权归各作者；**「哪张图对应哪张地图」这份聚合是 Ruby Bot 整理的**。

## 3. B 站视频（攻略视频 / 视频封面）

- 视频条目本身来自社区投稿与人工整理，来源是 B 站 / YouTube 的公开链接。
- 单个视频的**封面与抽帧**用 B 站公开接口取：
  - `api.bilibili.com/x/web-interface/view?bvid=…` → 标题、UP、时长、官方封面 `pic`；
  - `api.bilibili.com/x/player/videoshot?aid=…&cid=…` → 一张**雪碧图**（10×10 格，单格 480×270），
    按格子裁就能得到真实画面，**不用播放器、不用登录**。
  例：`ze_laser_competition` 与 `ze_tesv_skyrim_i` 的封面就是这么取的（见 git 记录与 `docs/cover-images.md`）。
- ⚠️ 别指望给图片 URL 加 `?imw=1280` 能拿更高清 —— 实测拿回来还是 555×312（Steam 存的就那么大）。

## 4. 与 s2ze / Ruby Bot 的关系

两边都是社区项目，没有隶属关系。我们的用法是**引用公开数据 + 注明出处**（社区同好站之间互相引用）。
他们站上只署名团队品牌「Ruby Bot Team」，没有公开具体个人；对外联系走他们的 Discord（Support 链接）。
如果哪天要大规模使用他们的数据（比如整批补 `creators` 作者），**先去他们的 Discord 说一声**更合适。
