# 地形分片搬到 Cloudflare R2 —— 迁移方案

> 状态：**已完成（2026-10-04）** —— 546 个分片已全量上传并抽查一致，预览页走 R2 渲染正常，
> `public/terr` 已从仓库移除（本地副本在仓库外 `bake/terr`，已 gitignore）。
> 最后更新：2026-10-04

## 结论速览

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| dist 体积 / 文件数 | 354.5 MB / 3,465 | **31.9 MB / 2,919** |
| 地形分片位置 | `public/terr/`（进 git、进 dist） | Cloudflare R2 `terr.ze-map.cn/terr/<id>.bin` |
| 本地烘焙产物 | `public/terr/` | `bake/terr/`（仓库外） |
| 每轮全量重烘焙的历史增量 | ~330 MB | **~10 MB**（只剩 entity 分片） |
| 单文件 25 MiB 部署限制 | 最大一张 15.93 MB，逼近 | 已不再进 dist，**风险消失** |

## 日常操作（以后照着做）

```bash
npm run bake:start        # 烘焙（产物写到仓库外的 bake/terr）
npm run terr:upload       # 把新增/变化的分片传到 R2（增量，几秒到几十秒）
npm run build             # 构建（dist 里不再有 terr）
```

* 忘了 `terr:upload` 会怎样：新图的地形在页面上 404（预览只缺地形，其它功能正常）。
  补跑一次即可，不需要重新烘焙。
* 凭证在 `.env.r2`（已 gitignore，模板见 `.env.r2.example`）。
* 想整体换位置：设 `TERR_OUT=<dir>`（烘焙输出）与 `TERR_SRC=<dir>`（上传来源）。

## 回滚

把 `PUBLIC_TERR_BASE=/terr` 传给构建，并把一份分片放回 `public/terr/` 即可回到同源；
或者恢复 `git revert` 这次收尾提交（`public/terr` 历史版本还在 git 里）。

---

## 以下是最初的方案记录（保留作为背景）

## 为什么要搬

| 位置 | 体积 | 说明 |
|---|---|---|
| `public/terr/` | **322.6 MB / 546 个文件** | 真实碰撞地形，**只有浏览器读**（预览页 3D 视图） |
| `public/entity/data/` | 9.8 MB / 646 个文件 | 实体分片，**构建期要读**（索引、关卡推断、校验） |
| `public/entity/catalog.json` | ~0.5 MB | 地图索引 |

问题出在**重烘焙**：git 会把每次改写的分片旧版本永久留在历史里，
所以「全量重烘焙一次」≈ 往仓库里再塞 320 MB。而仓库的软上限是 5 GB —— 大约 14 次全量重烘焙就见底。
另外最大的一张 terr 已经 **15.93 MB**，离 Cloudflare 单文件 25 MiB 的硬限制不远（超了**部署直接失败**）。

## 关键决策：只搬 `terr`，`entity` 留在仓库

看起来"把所有大文件都搬走"更彻底，但 `public/entity/data/*.bin` 是**生成器的输入**：

- `scripts/entity-data/build-catalog.mjs` 遍历分片更新索引；
- `scripts/content/generate-map-entries.mjs` 读分片推断关卡数（`stageCountFromEntities`）；
- `scripts/entity-data/verify-entity-data.mjs --all` 校验分片结构。

分片一旦只存在于 R2，本地/CI 构建就得先下载 322 MB 才能跑（构建变慢、又引入网络依赖）。
而 `terr` 只被浏览器读取，搬走零副作用，且它占了 97% 的体积。所以：

**只搬 `public/terr/` → R2；`public/entity/` 原样留在仓库。**

这样每次全量重烘焙的历史增量从 ~330 MB 降到 ~10 MB（entity 分片），
dist 体积从 **354 MB 降到 ~32 MB**，部署上传也快得多。

## 你需要做的（站长）

1. ~~开通 R2~~ ✅ 已完成；
2. R2 控制台点 **Create bucket**，名字 `ze-map-terr`，Location 建议 **Asia-Pacific (APAC)**；
   （等价命令：`npx wrangler r2 bucket create ze-map-terr --location apac`）
3. bucket → **Settings → Custom Domains → Connect Domain** → 填 `terr.ze-map.cn`（同账户域名，记录会自动加）；
4. 同页 **CORS Policy** 允许预览页跨域取分片：

   ```json
   [
     {
       "AllowedOrigins": ["https://ze-map.cn", "http://localhost:4321"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

5. 右上头像 → **My Profile → API Tokens → Create Token**，权限 **Account · Workers R2 Storage · Edit**，
   把值填进仓库根目录的 `.env.r2`（照 `.env.r2.example` 复制；该文件已 gitignore，**别贴到聊天里**）；
6. 顺手开 **Budget alerts**（阈值 $1）：Manage Account → Billing → Billable Usage。

### 还要给 `terr.ze-map.cn` 加一条缓存规则（重要）

R2 自定义域后面就是 Cloudflare 的 CDN，但 `.bin` 不在默认缓存扩展名里 ——
不加规则的话**每次预览都要回源读 R2**（白耗 Class B 操作）。**Caching → Cache Rules** 新建一条：

- 匹配：`http.host eq "terr.ze-map.cn"`
- 动作：Cache Eligibility = **Eligible**，Edge TTL = **Ignore cache-control / 1 year**
  （上传时对象本身也带了 `Cache-Control: public, max-age=31536000, immutable`）

## 代码侧进度

| 项 | 状态 |
|---|---|
| 预览页数据源开关 `PUBLIC_TERR_BASE` / `PUBLIC_ENTITY_BASE` | ✅ 已完成 |
| 地形张数回落 `data/terr-manifest.json` | ✅ 已完成 |
| 上传脚本 `npm run terr:upload`（增量 / `--dry` / `--all` / `--manifest-only`） | ✅ 已完成 |
| `.gitignore`（`.env.r2`、`.r2-terr-state.json`、`bake/`；白名单 `data/terr-manifest.json`） | ✅ 已完成 |
| 烘焙输出目录 `public/terr` → `bake/terr`（连带 `bake-terrain.mjs`、`select-bake.mjs`、`add-map.mjs`、`bake-all.ps1` 等） | ⏳ 上传验证通过后再动 |
| `git rm -r --cached public/terr` + 烘焙 README / `data:verify` 路径说明 | ⏳ 放最后一步 |

上传走 Cloudflare 官方 `wrangler r2 object put`（签名交给官方工具，不自己搓 SigV4）；
增量判断按「大小 + mtime」，状态存本地 `.r2-terr-state.json`。

**已验证**：
- 默认构建 → 注入 `/terr`；`PUBLIC_TERR_BASE=https://terr.ze-map.cn` 构建 → 注入该地址；
- `npm run terr:upload -- --dry` → 正确列出 **546 个分片 / 322.6 MB**；
- 无凭证时报明确错误，不会静默失败；
- `--manifest-only` → 写出 546 条 id 的 `data/terr-manifest.json`。

## 执行顺序（bucket 建好后）

1. 建 bucket + 自定义域 + CORS + API Token + 缓存规则（上面 2~6 步）；
2. `npm run terr:upload -- --dry` 看清单 → `npm run terr:upload` 首次全量上传（546 个，约 10~20 分钟）；
3. 抽查 `https://terr.ze-map.cn/terr/3071209915.bin`：能下载、响应头有 `Cache-Control`；
4. 本地验证：`PUBLIC_TERR_BASE=https://terr.ze-map.cn npm run build:site` → `npm run preview` →
   打开 `/preview/?map=<某图>`，3D 地形能加载；
5. 线上灰度：构建时带环境变量部署 → 观察预览页正常；
6. 一切正常后，我才动烘焙输出目录与 `git rm --cached public/terr`。

## 回滚

任何一步出问题：**去掉 `PUBLIC_TERR_BASE` 环境变量重新部署**，预览页立刻回到同源 `/terr`
（前提是 `public/terr` 还在 —— 所以 `git rm --cached` 放最后一步）。
`git rm --cached` 只从索引里移除、不删本地文件，随时 `git reset` 即可恢复。

## 关于"仓库体积不会立刻变小"

`git rm --cached` 只影响之后的历史：**已有的 529 MB 仍在 git 历史里**。
真要变小，得用 `git filter-repo` 重写历史（所有协作者必须重新 clone，风险高）。
建议**先不重写**，只要"不再增长"就解决了未来的问题；等哪天真逼近 5 GB 再说。

## 顺带说明：为什么不是 GitHub Release 资产

Release 资产不占仓库体积、也不要绑卡，但：每次烘焙要重新上传、旧版本要手动清理、
国内访问速度一般，而且没有 R2 那样的自定义域与缓存控制。作为"完全不花钱"的备选方案可行，
但既然 R2 已经开通，就用 R2。
