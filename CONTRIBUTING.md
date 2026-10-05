# 参与这个项目

本站还在初期，缺的东西很多 —— 补一张图的资料、纠正一处错误、加一个功能，都欢迎。

**投稿指南在网站上，看这份就够：<https://ze-map.cn/contribute/>**

那份是写给「不会写代码、没有 GitHub 账号」的人的，包含网页表单、提 issue、提 PR、换封面五条路径的完整步骤。这份文件只补充 GitHub 侧的技术约定。

## 三条路径

| 方式 | 需要 GitHub 账号 | 适合 |
| --- | --- | --- |
| [网页投稿表单](https://ze-map.cn/submit/) | 不用 | 补 / 改某张图的字段（难度、标签、作者、视频、来源、神器 / 道具、正文、封面图） |
| [提 issue](https://github.com/hhjjdsj/ze-map-site/issues/new/choose) | 要 | 一次说好几件事、交整段攻略 |
| 提 PR 改文件 | 要 | 熟悉 GitHub，或一次改很多张图 |

## 改文件时，哪些能改

| 文件 | |
| --- | --- |
| `data/research/<地图英文名>.json` | ✅ **资料原稿，改这里** |
| `data/community/<slug>.json` | ⚠️ 社区投稿落盘目录，由审核流程写入；手改请开 PR 说明理由 |
| `data/community/<slug>.json` 的 `items[]` | ✅ 神器 / 道具就只能这么改：条目里的表来自 `data/gfl-parsed/`（服务器配置解析结果，脚本产出），社区更正逐行合并、原值保留在备注里 —— 走投稿页选「神器 / 道具」，或手改这里的 `items[]` |
| `public/images/covers/custom/<地图英文名>.jpg`（或 `.png` / `.webp`） | ✅ 换地图封面（文件名必须正好是地图英文名） |
| `src/content/maps/*.mdx` | ❌ **全部由脚本生成**，手改会被 `npm run maps:generate` 整段覆盖 |

> **地形分片（`terr`）不在仓库里**：322 MB 已搬到 Cloudflare R2（见 `docs/r2-migration.md`），
> 烘焙产物写到仓库外的 `bake/terr`。所以**新增地图的 PR 里不含地形文件** ——
> 合并后由站长跑一次 `npm run terr:upload` 补上（需要 R2 凭证，本地上传脚本用，
> **CI 和 Cloudflare 构建都不需要凭证**）。
> 补上传之前的临时状态：那张图的实体预览、资料、条目页都正常，只是 3D 地形还取不到。

> **改 `data/research/*.json` 就够了，不需要提交生成物。**
> MDX 虽然由脚本产出，但 Cloudflare 构建时会用资料重新生成，**线上内容以资料为准** ——
> 所以只改 JSON 的 PR 是正确的做法，CI 会放行（只提示一句「仓库里的打印稿落后了」）。
>
> 唯一会被拦下的是**手改生成物**：本次 PR 动了 `src/content/maps/*.mdx`，却没同时动
> `data/research/`、烘焙产物或 `scripts/` 下的生成器 —— 那说明你在手工编辑打印稿，
> 它下次构建就会被覆盖。
>
> 想让仓库里的打印稿也同步（可选）：`npm run maps:generate`，然后把 `src/content/maps/`
> 下的改动一起提交。
>
> 不想碰仓库的人：投稿页 `/submit/` 写的是 `data/community/<slug>.json`，由审核流程落盘。
>
> 判定逻辑在 `scripts/content/check-mdx-drift.mjs`（可在本地跑：`npm run content:mdx`）。

`ze_ffvii_mako_reactor`、`ze_lotr_minas_tirith`、`ze_pirates_port_royal` 的富内容也已迁入对应的 research JSON 的 `document` 字段，不直接编辑 MDX。

「地图英文名」= 地图页标题下面那行小字 = 网址 `/maps/` 后面那一段，**不是** Steam 分片名（`2001-ze_xxx-123456`）。

> 顺带说清 slug：research JSON 里的 `slug` 字段**两种写法都认** —— 地图英文名
> （`ze_bathroom`）或数据分片名（`2001-ze_bathroom-3450347689`），生成器会从分片名里
> 反解出地图名（`scripts/content/generate-map-entries.mjs` 顶部的 `mapNameFromSlug`）。
> 文件名用地图英文名最稳妥，但 slug 写成哪种**都不是**上面那个报错的原因。

### 图片这类二进制文件（地图封面）

**首选走投稿页**：地图详情页右侧栏 →「✏️ 补充这张图的资料」→ 选 **地图封面** → 上传。
不需要 GitHub 账号，也不用 Fork —— 浏览器端会自动裁成 16:9、压成 webp，服务端校验后进审核队列。

想直接改文件（提 PR）的话：**网页上的铅笔编辑对二进制文件不可用** —— 铅笔只对文字文件出现，所以要走上传/删除。

⚠️ **上传前必须先 Fork**：你在本仓库没有写权限，直接在 `public/images/covers/custom/` 里点
「Add file → Upload files」会被 GitHub 拒绝（`You need write access to this repository`）。
先在仓库首页 **Fork → Create fork**，在**你自己的副本**里操作，最后发 PR 回来。

| 操作 | 怎么做（都在你自己 fork 的 `custom/` 里） |
| --- | --- |
| 新增 | **Add file → Upload files** |
| 替换 | 同样上传，**路径与文件名保持一致**即覆盖（commit 显示为 modified） |
| 删除（换回渲染封面） | 文件页面 **⋯ → Delete file** |

不想折腾 GitHub 的话，把图发给站长代传（`npm run cover:set -- <地图英文名> <图片>`，自动压成 16:9 webp）。

相关限制：网页上传单文件 25 MB（GitHub 规则）、一次最多 100 个文件；本项目封面另有 `cover:verify` 的 800 KB 硬上限。

## 提 PR 后会自动跑什么

`.github/workflows/build-check.yml`，约 1~2 分钟，只读不部署、不需要任何密钥：

| 步骤 | 抓什么 |
| --- | --- |
| 检查有没有改错文件 | 自动生成的 `.mdx` 变了、但对应的 `data/research/<地图>.json` 没变 —— 即「改了会被覆盖的文件」 |
| `npm run content:verify` | 资料 JSON 的语法、难度写法、来源链接、字段名拼写（`awthor` 这种会被抓出来）、可疑措辞 |
| `npm run cover:verify` | 人工封面的文件名对不对得上地图、格式、体积、比例 |
| `npm run build` | 和线上一样的完整构建（Linux 上跑，还能抓出大小写导致的 404） |
| `npm run content:links` | 全站站内链接与静态资源引用，查死链 |

## 本机开发

```bash
npm install
npm run dev            # 开发服务器
npm run build          # 完整构建（日期清单 → 生成条目 → 站点 → 搜索索引）
npm run content:verify # 资料 JSON 校验
npm run cover:verify   # 人工封面校验
npm run content:links  # 死链检查
npm run cover:set -- <地图英文名> <图片>   # 裁图并换成人工封面
```

架构与设计记录见 `docs/`，地图资料原稿的详细写法见 `data/research/README.md`。

## 内容约定

- 附上可核对的**来源链接**；查不到的宁缺勿假
- 不要整段搬运他人文章，引用请注明出处
- 地图版权归原作者，本站只做整理
