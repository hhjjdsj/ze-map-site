# ZE 地图资料站

僵尸逃跑（Zombie Escape）地图中文资料库 —— https://ze-map.cn

由社区共同维护的兴趣项目，**纯粹为爱发电**：没有任何商业目的，不接商业推广、不做付费内容、不卖数据。
整理这些内容只为帮玩家（尤其是刚入门的萌新）看懂一张地图。

本站仍在**初期**，不少条目还标注「资料待补充」，欢迎更多人一起完善 —— 补一张图的资料、纠正一处错误、
加一个功能都算数；不需要 GitHub 账号，见 [投稿指南](https://ze-map.cn/contribute/)。

## 功能

- **地图库**：CS2 ZE 地图，按难度、游戏、标签筛选，客户端分页
- **地图详情**：背景故事、关卡流程、神器、视频；数据条目自动生成，附实体构成与关卡统计
- **实体预览**（`/preview/`）：从工坊地图包烘焙实体与地形，提供可交互的 3D / 平面视图；索引保留已收录的历史元数据
  - 12 个图层：传送门 / 落点、可破坏物、危险区、触发区、机关 / 门、路径点、出生点、逻辑节点、武器道具、动态模型、环境点、其他
  - 3D 视图（自写 WebGL）与平面视图（俯视 XY / 侧视 XZ / 前后 ZY）
  - 按高度着色、区域光晕、方块体积、按高度剖切、关卡分层、单点属性与触发连线、导出 PNG
  - 已收录地图（含 TTT / MG / DE），按图按需加载
- **标签索引**、深浅色切换、移动端适配、sitemap、自定义 404
- **社区共建**：`/submit/` 网页投稿（不需要 GitHub 账号）→ D1 队列 → `/admin` 审核台 → 攒批写回 git →
  自动重建；另有难度投票、`/updates/` 更新日志、贡献者署名（见 [社区编辑方案与实施记录](docs/community-editing-plan.md)）

## 技术栈

- Astro（静态输出）+ MDX 内容集合 + Tailwind CSS 4
- 实体预览：原生 JS + 手写 WebGL（无 three.js），数据 gzip 分片 + `DecompressionStream`

## 开发

```
npm install
npm run dev
```

## 构建

```
npm run build
npm run preview
```

## 数据管线

新增一张 CS2 ZE 工坊地图（Windows，参数是工坊页面 `?id=` 后的物品 ID，不是上传者的 SteamID）：

```powershell
npm run map:add -- 1234567890
```

该命令仅烘焙指定地图（首次会安装本地工具链），抓取工坊资料，生成封面、条目并检查构建；检查 `git status` 后提交生成的分片、索引及 `scripts/terr-bake/data/` 记录，并跑一次 `npm run terr:upload` 把新地形分片传到 R2（漏了这步新图会缺地形，见 [R2 迁移记录](docs/r2-migration.md)）。补充中文介绍等资料请编辑 `data/research/<地图英文名>.json`，再运行 `npm run content:verify` 和 `npm run build`。地图首次进站日期根据提交历史计算，提交新增 MDX 后下次构建才会更新日期清单。

实体与地形的**后续获取、更新**走 `scripts/terr-bake/`：从 Steam 工坊地图包解出实体定义与模型碰撞壳、`world_physics`，分别写入 `public/entity/data/` 和 `bake/terr/`。地形分片**不再进仓库**，烘焙后用 `npm run terr:upload` 传到 R2（详见[迁移记录](docs/r2-migration.md)）。在项目根目录运行 `npm run bake:start`；环境及批量运行参数见 [烘焙说明](scripts/terr-bake/README.md)。

`public/entity/catalog.json` 保留已有中文名等历史元数据；`npm run data:catalog` 会从当前分片更新实体统计、逐图来源并收录新地图。`bake-all.ps1` 结束后和 `npm run build` 时都会运行这一步。旧单文件导入管线已移除。

```
# 烘焙后或单独重建索引；校验分片与索引
npm run data:catalog
npm run data:verify

# 抓取工坊详情（作者自述、发布时间、订阅数；Node 的 fetch 被拦，用 PowerShell）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-workshop.ps1 -Mode 2001

# 抓工坊上传者昵称（走 profiles/<id>/?xml=1）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-creators.ps1

# 抓 GFL 公开服务器配置并解析（神器/道具、BOSS、BGM）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-gfl-configs.ps1
npm run gfl:parse
npm run gfl:link      # 生成别名表（只接受同名或仅差移植/版本后缀的匹配，避免张冠李戴）

# 由现有索引 + 工坊数据 + GFL 配置 + data/research 批量生成/覆盖地图条目
#    生成时会统一标签写法（Boss / boss / BOSS → Boss），否则 Cloudflare 上会出现 404 标签页
npm run maps:generate

# 校验线上检索资料（来源链接、难度枚举、可疑措辞、标签字符）
npm run content:verify

# 构建后检查站内死链（标签页、实体预览深链、封面图等）
npm run build && npm run content:links

# 需要时渲染某张图的实体分布图（PNG）+ 打印可用热点坐标
npm run data:image -- --slug 2001-ze_ffvii_mako_reactor_v6_p-3273375829 \
  --out public/images/maps/ze_ffvii_mako_reactor/overview.png --size 1100

# 批量渲染卡片封面（16:9 WebP）
npm run data:covers
```

已存在的封面不会因新分片缺少旧密度底图而被 `--force` 覆盖；新收录且尚无封面的地图可用 `npm run data:covers` 生成点位图，人工封面仍可放在 `public/images/covers/custom/`。

产物：

| 路径 | 说明 |
|---|---|
| `public/entity/catalog.json` | 保留历史人工元数据并从本地分片更新统计与来源的地图索引 |
| `public/entity/data/<slug>.bin` | 每图一个 gzip 分片，格式 `[4B JSON 长度][JSON][BIN]` |
| `bake/terr/<工坊ID>.bin` | 从工坊地图包烘焙的碰撞地形（仓库外，上传到 R2，不进 git / dist） |
| `src/content/maps/*.mdx` | 全部由脚本从 JSON 和索引生成，不直接手改 |
| `public/images/covers/<slug>.webp` | 由实体数据渲染的卡片封面（16:9） |
| `data/research/<map>.json` | 线上检索到的资料（作者/难度/摘要/来源），生成条目时合并 |
| `data/workshop/<id>.json` | Steam Web API 抓到的工坊详情（正文、发布时间、订阅数） |
| `data/creators.json` | 工坊上传者昵称映射（SteamID64 → persona） |
| `data/gfl-parsed/<map>.json` | 从 GFL 公开配置解析出的神器/道具、BOSS、BGM |

> 已提交的索引及 `data/` 中间数据可用于离线重跑 `npm run maps:generate`；新地图的实体/地形烘焙需要工坊地图包。

富内容 JSON 与索引地图版本的对应关系在 `scripts/content/curated-links.json`，避免同一张图出现两条。

## 目录

```
scripts/
├── content/                      站点内容管线（条目 / 日期 / 搜索 / 链接 / 工坊抓取）
│   ├── fetch-workshop.ps1        Steam Web API 批量抓工坊详情
│   ├── fetch-creators.ps1        抓工坊上传者昵称（profiles/<id>/?xml=1）
│   ├── fetch-gfl-configs.ps1     抓 GFL 公开服务器配置
│   ├── parse-gfl-configs.mjs     JSONC → 神器/BOSS/BGM 结构化数据
│   ├── link-gfl-configs.mjs      GFL 配置名 ↔ 站点地图名（保守匹配）
│   ├── generate-map-entries.mjs  批量生成地图条目（含标签大小写归一）
│   ├── verify-research.mjs       检索资料质量闸门
│   ├── check-links.mjs           构建产物站内死链检查
│   └── curated-links.json        手写条目 ↔ 索引地图映射
├── entity-data/                  实体/地形分片的读取、渲染、校验、索引
│   ├── lib/entity-common.mjs     读取分片 / classname 分类 / 绘制工具
│   ├── verify-entity-data.mjs    新旧分片结构校验
│   ├── build-catalog.mjs         分片 → 更新/新增索引
│   ├── render-map-image.mjs      实体分布图 PNG + 热点坐标
│   └── render-covers.mjs         批量卡片封面（WebP）
└── terr-bake/                    烘焙流水线：工坊 VPK → 实体分片与地形分片
    ├── *.ps1                     bootstrap / setup / launch / run-to-end / bake-all / bake-one / watchdog …
    ├── *.mjs                     bake-terrain / extract-entities / extract-bounds / build-entity-bin / select-bake
    └── data/                     capped.txt / done.txt / failed.txt / bake-manifest.json（入库的烘焙记录）

public/preview/app.js             实体预览 viewer（移植自单文件版）
src/pages/preview.astro           /preview 页面
src/pages/sitemap.xml.ts          静态 sitemap
```

## 版权与许可

代码以 **MIT** 许可开源，详见 [`LICENSE`](LICENSE)；地图条目（`src/content/maps/*.mdx`）、`data/`、`public/entity/`、`public/images/` 等**站点内容不适用 MIT** —— 地图版权归各原作者所有，工坊自述与社区引用内容归原出处，本站仅作整理与索引，详见 [`NOTICE`](NOTICE)。

3D 地图查看功能由 **emmmm** 完成。

## 贡献者

- **宇宙机器人（hhjjdsj）** —— 站点本身与日常维护
- **[SolsticeStarry](https://github.com/SolsticeStarry)** —— 3D 预览增强（实体包围盒、环绕视角）、实体 / 地形烘焙管线与内容管线重构（`npm run map:add`）
- **[trrrr-ai](https://github.com/trrrr-ai)**（SiKi）—— 多张地图的背景故事、难度与视频资料
- **[xianoom](https://github.com/xianoom)** —— 地图难度订正
- **emmmm** —— 3D 地图查看功能

完整名单见仓库的[贡献者页面](https://github.com/hhjjdsj/ze-map-site/graphs/contributors)。

## 特别感谢

本站最有价值的那部分内容几乎全靠别人铺路，这里必须单独致谢。

- **Source2Viewer（s2v）** —— 开源的 Source 2 资源解析工具。
  本站的实体预览与 3D 地形靠它从创意工坊地图包里解出实体定义、模型与真实碰撞壳；
  没有这个工具，这两块功能都无从谈起。

另外，本站建站早期入库过一份第三方公开的服务端实体 dump，这部分历史数据至今原样保留，
条目里只写中性的来源说明。再次向 **Source2Viewer** 致以诚挚谢意。
本站只是站在别人铺好的路上，做了一点整理工作。
