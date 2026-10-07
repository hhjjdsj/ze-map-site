# 给地图换封面（用自己找的图，取代默认图）

地图封面现在有**三个来源**，生成器按顺序挑，找到哪个用哪个：

| 优先级 | 文件 | 谁生成的 |
| --- | --- | --- |
| 1 | `public/images/covers/custom/<地图英文名>.<webp\|png\|jpg>` | **人工**（本文要说的事） |
| 2 | `public/images/covers/workshop/<地图英文名>.<ext>` | `npm run cover:workshop` 导入的**作者工坊预览图**（2026-10-07 起） |
| 3 | `public/images/covers/<Steam 分片名>.webp` | `npm run data:covers` 从实体数据渲染的 16:9 缩略图（兜底） |

生成器在写 `src/content/maps/*.mdx` 的 `cover:` 时按这个顺序找，找到哪个用哪个。
第 1 层删掉就自动回落到第 2 层，第 2 层也删掉才回落到渲染图 —— **不需要改任何配置**。

> **手写正文的三张图**（魔晄炉 `ze_ffvii_mako_reactor` / 米纳斯 `ze_lotr_minas_tirith` /
> 黑珍珠号 `ze_pirates_port_royal`）走的是另一条生成路径：正文从 `data/research/<slug>.json`
> 的 `document` 原样搬过来，**但 `cover:` 这一行照样按上表重算** —— 生成器只替换 frontmatter
> 里的那一行，正文一个字不动。
> 2026-10-08 之前不是这样，于是这三页的封面永远停在「写正文那天」：魔晄炉后来补了作者工坊图、
> 米纳斯和黑珍珠号补了人工封面，页面上却一直挂着黑底密度点图 —— 看起来就是「这张图没有封面」，
> 而构建、CI、`cover:verify` 全是绿的。
> 给这三张换封面同样走 `cover:set` / `custom/`；**不要去改 `document` 里那行 `cover:`**，
> 改了下一轮构建也会被层级重算掉（`npm run maps:generate` 会打印它改写了哪几页）。

## 第 2 层：作者工坊图（为什么有它、怎么更新）

没有人工封面的地图，以前用的是渲染图 —— 那是本站算出来的密度雷达示意图，跟「地图长什么样」差得远。
现在默认换成**作者自己在创意工坊上传的预览图**（真实截图，555×312，正好 16:9）：

```bash
npm run gallery:fetch -- --all      # 1) 抓工坊预览图到 bake/gallery/（已抓过的会跳过）
npm run cover:workshop             # 2) 导成封面：public/images/covers/workshop/<地图英文名>.webp
npm run maps:generate              # 3) 重新生成条目，cover: 就会指过去
npm run cover:verify               # 4) 核对（会打印「人工 88 · 工坊 442 · 其余用渲染图」）
```

- `npm run cover:workshop -- --dry` 先看要导多少张；`--prune` 顺手删掉「已经有人工封面」的那些多余文件。
- **图片是复制进仓库的**（不是直接引 R2 的 `terr.ze-map.cn/gallery/...`）：那个域名在国内部分网络下不通，
  而封面是每个卡片都要加载的东西，必须跟其它封面一样走本站同源。
- 尺寸够用：详情页顶上只把它当 **22% 透明度**的氛围底图（还有遮罩渐隐），卡片按 16:9 裁切，
  而它本来就是 16:9，不会变形。
- ⚠️ 图片集里的同一张工坊图不会再重复出现：地图页在地工坊图当封面时，会把图片集里那条 `kind: workshop` 过滤掉。

## 第 3 层：渲染兜底图（以及为什么有 18 张看起来「没有封面」）

第 3 层是 `npm run data:covers` 从实体数据画出来的**俯视密度图**：黑底 + 彩色点位。
它信息量不小（一眼看出机关、传送门都堆在哪），但详情页顶部只把它当 **22% 透明度**的氛围底图，
在深色页面上几乎看不见；卡片列表里就是一张黑图 —— 观感上等于没有封面。

截至 2026-10-08 还有 **18 张**停在这一层，`npm run cover:verify` 会把它们列出来：

```
ze_bang_dream_mygo、ze_cursed_bear_tales、ze_doom、ze_ice_cavern_z、ze_italy_town_z、
ze_laser_competition、ze_laser_island_z、ze_mgden_z、ze_mission_escape、ze_naruto_z、
ze_outlast、ze_project_codex_z、ze_scp_containment_breach、ze_steyliff_grove、
ze_sunkentemple、ze_tesv_skyrim_i、ze_tesv_skyrim_p、ze_theback_bureau
```

原因不是漏抓：这些图的创意工坊条目**已被作者删除 / 下架**（Steam 接口返回 `result=9`，
没有 `preview_url`），作者预览图根本拿不到；这些图也基本没有投稿视频可以截帧。
要救只能靠人工封面：

```bash
npm run cover:set -- ze_doom "D:\图片\游戏内截图.png"
```

## 怎么做（人工封面，优先级最高）

```bash
npm run cover:set -- ze_obj_abyss_v2 "D:\图片\封面.png"
```

- `<地图英文名>` 就是详情页副标题那串，也是 `src/content/maps/` 下的文件名（**不是** Steam 分片名 `2001-ze_xxx-123456`）。不确定就打开那张图的页面看。
- 图片随便什么格式（jpg / png / webp / avif…），脚本会裁成 16:9 并压成 webp。
- 默认输出 `1280×720`，一般 100 KB 上下。

然后提交这两个文件：

```
public/images/covers/custom/<地图英文名>.webp
src/content/maps/<地图英文名>.mdx          ← cover: 指过去了
```

> 只跑 `npm run build` 也行，构建的第一步就是生成器。

## 常用选项

| 选项 | 说明 |
| --- | --- |
| `--position top` | 裁切时贴哪一边：`centre`（默认）/ `top` / `bottom` / `left` / `right` / `attention` |
| `--mode contain` | **不裁切**，完整放下，四周填站点深色底。适合竖版海报、带文字的图 |
| `--width 1920` | 输出更宽（高度按 16:9 自动算） |
| `--quality 90` | webp 质量，默认 82 |

脚本会先告诉你原图比例、以及会不会被裁掉多少，觉得不合适就换 `--position` 或 `--mode contain` 再跑一次（重复执行会直接覆盖上一张）。

## 换回默认图

```bash
npm run cover:set -- ze_obj_abyss_v2 --remove
```

删掉人工封面，再跑一次构建：

- 如果这张图有工坊预览图 → 回落到**工坊图**（第 2 层）；
- 没有 → 回落到渲染图（第 3 层）。

**不需要改任何配置。**

## 别人（贡献者）换封面

**首选：投稿页直接传（不需要 GitHub 账号、不需要 Fork、不用命令行）。**
地图详情页右侧栏 →「✏️ 补充这张图的资料」→「要提交哪一项」选 **地图封面** → 选图。
浏览器端会裁成 16:9、转 webp、压到几十 KB；服务端（`worker/covers.ts`）再做权威校验，
审核通过、站长点「写回仓库」时由 Worker 提交进 `public/images/covers/custom/<地图英文名>.<ext>` 并把待审副本从 KV 删掉。

## 想直接改文件（提 PR）

**可以，但必须先 Fork。**
2026-09-25 更正：以前这里写的是「打开目录 → Add file → Upload files」，那是**错的** ——
在别人的仓库里没有写权限时 GitHub 会直接拒绝上传（「You need write access to this repository」），
所以贡献者必须在自己账号下的副本里操作。

1. 仓库首页右上角 **Fork** → **Create fork**（得到 `你的用户名/ze-map-site`）
2. 在**自己这份副本**里打开 `public/images/covers/custom/`
3. **Add file → Upload files**，把图片拖进去
4. 文件名 = **地图英文名**（`ze_obj_abyss_v2.jpg`），格式 `.jpg` / `.png` / `.webp` 都行
5. 拉到底 **Commit changes**
6. 回到原仓库 `hhjjdsj/ze-map-site` → **Compare & pull request**（没看到就用 **Contribute → Open pull request**）
7. **Create pull request**

生成器在构建时会自动认这个文件，**不需要贡献者同时改 MDX**（合并后线上构建自己会重新生成）。所以 PR 里只有一个图片文件。

图片是二进制文件，**GitHub 的铅笔编辑对它不可用**（铅笔只给文字文件），但网页上这三件事都能做：

| 想做的事 | 怎么做 |
| --- | --- |
| 新增封面 | 在自己 fork 的 `custom/` 里 **Add file → Upload files**，文件名 = 地图英文名 |
| 替换已有的封面 | 同样走上传，**文件名和路径保持一致**就是覆盖（PR 里显示为 modified） |
| 换回渲染图 | 点开那张图 → **⋯ → Delete file** → 提 PR |

**不折腾 GitHub 的路**：把图发给站长，站长用
`npm run cover:set -- <地图英文名> <图片>` 代传（自动裁 16:9、压 webp、文件名对齐）。

> 2026-10-05 更正：这里以前写着「投稿表单还收不了封面」—— **已经过时了**，
> 投稿页早就能自助传（见上一节）。表单收的是**上传的图**：浏览器裁切压缩 → 服务端校验
> → 审核通过后写进仓库；它**不接受任意外链图片地址**（防的是往页面塞外站图）。

网页上传单文件上限 25 MB（GitHub 的规则），不过封面本来就不该那么大 —— `cover:verify` 的硬上限是 800 KB。
投稿表单那条路卡得更紧：**700 KB**（二进制要 base64 走 GitHub API，800 KB 会贴到单文件限制边上，见 `worker/covers.ts` 的注释）。

合并前可以在 PR 的 **Files changed** 里看新旧对比：常见图片格式 GitHub 会直接渲染出来，渲染不了的会显示 `Binary file not shown`，点文件名进去也能看。

### 为了保证这条路走得通，做了这几件事

| | 为什么 |
| --- | --- |
| 生成器认 `.webp` / `.png` / `.jpg` / `.jpeg` 四种格式 | 普通人不会转 webp（要装工具），但人人都会存 jpg / png。只认 webp 等于把这条路堵死 |
| 生成器找封面文件**大小写不敏感**，并且用的是磁盘上的真实文件名 | Windows / macOS 上传时常带出 `.PNG` / `.JPG`。以前是拼一个小写路径去 `existsSync`，于是「文件在仓库里、页面永远不显示」，而构建、CI、`cover:verify` 全绿（那个脚本会把扩展名转小写再判断）—— 2026-09-25 有贡献者报「传了封面但不生效」才挖出来。现在还会在 CI 上拦住「仅大小写不同的两个同名文件」（那种情况不同系统上表现不一致） |
| `npm run cover:verify` 校验文件名 | **最要命的一种错**：名字写成 Steam 分片名或拼错一个字符，这张图永远不会显示 —— 而构建、CI、页面全都正常。所以按错误处理，并直接给出正确写法 |
| 同一个校验查格式 / 体积 / 比例 | 体积硬上限 800 KB（防止有人往仓库里塞几 MB 的原图）、比例偏离 16:9 超过 15% 给提醒 |
| 校验步骤挂在 CI 的 PR 检查里 | 贡献者提完 PR 立刻在 PR 页面上看到红叉和原因，不用等站长人工看 |
| 图片缺失有兜底 | `npm run content:links` 会核 `dist` 里所有静态资源引用，封面文件没提交就是死链 → CI 红，不会静默 404 |

`cover:verify` 的尺寸读取是自己解析文件头（png / jpeg / webp），**不依赖 sharp** —— sharp 只是 astro 的传递依赖，校验脚本不该依赖它，否则哪天 astro 换了实现，CI 会莫名其妙挂掉。

## 几个容易踩的点

- **别直接覆盖 `public/images/covers/<分片名>.webp`**。说准确一点：`render-covers.mjs` **默认跳过已存在的文件**（`if (fs.existsSync(out) && !argv.includes('--force'))`），所以直接换掉渲染图平时确实能用 —— 但只要有人跑一次 `npm run data:covers --force`（实体数据更新后要整批重渲染时就会跑），你的图就被冲掉了。而且事后光看文件名分不清哪张是脚本渲染的、哪张是人换的。人工封面统一放 `custom/`，两个问题都没有。
- **图片要提交进仓库**。封面走的是 `public/` 静态资源，不进仓库线上就是 404，`npm run content:links` 也会报死链。
- **比例**：卡片封面是 16:9 画幅，详情页顶部还会拿它当满宽背景大图（带遮罩）。所以选图尽量挑**横向、主体居中**的：竖图裁完往往只剩中间一条。
- 封面走的是**上传**：投稿页选「地图封面」传图（浏览器裁成 16:9、压成 webp → `worker/covers.ts` 权威校验 → 审核通过后提交进 `custom/` 并把 `fields.cover` 记成 `/images/...` 的 URL），也可以发给站长代传或按上面的流程提 PR。**表单不接受任意外链图片地址** —— 防的是有人往页面塞外站图。
