# 自动化现状（2026-11-02 起）

> 本文是当前自动化的事实来源。`deployment-handoff.md` 与 `deploy-and-builds.md` 里关于 Workers Builds 的描述已过时（Cloudflare 的 Git 构建已断开）。

## 三条链路

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `Workshop dates` | 每天 03:17 UTC（北京 11:17） | 拉 MapTracking-CS2 的 manifest，更新 `data/workshop-updates.json` 里的工坊最近更新日期 |
| `New maps` | 每周一 04:10 UTC（北京周一 12:10） | 用同一份 manifest 找站内没有的工坊条目，调 Steam API 拉详情，建「无实体」资料页（`data/workshop/<id>.json` + `data/research/2001-<map>-<id>.json`） |
| `Deploy to Cloudflare` | push main、`Workshop dates`/`New maps` 完成后、手动 | `npm ci` → `npm run build` → `npx wrangler deploy` → 冒烟测试 |

后两个工作流都用 `GITHUB_TOKEN` 提交，**不会触发 push 事件**，所以 `deploy.yml` 额外监听 `workflow_run`，等它们跑完再部署。

## 需要的仓库 secret

- `CLOUDFLARE_API_TOKEN`：Workers Scripts / KV / D1 / R2 的 Edit 权限
- `CLOUDFLARE_ACCOUNT_ID`：`15eae06c306850ce8f1157d86f21e95f`

## 失败时怎么查

1. 打开 https://github.com/hhjjdsj/ze-map-site/actions
2. 点失败的那条 → 看是哪一步：`Build` 多半是内容校验/数据文件缺失，`Deploy` 多半是 token 或 Cloudflare 偶发
3. `Deploy` 偶发失败可以直接 **Re-run failed jobs**；构建本身可复现时不要重跑，先修
4. 每次失败会在该 run 的 Summary 里留一段「失败提示」，包含日志链接

## 手动触发

- 工坊日期：Actions → `Workshop dates` → Run workflow
- 新图收录：Actions → `New maps` → Run workflow（没有新图时会打印「没有新图，不提交」并跳过）

## 数据迁移的坑（一次性，已处理）

生产 D1 是早于迁移文件建的老库，`d1_migrations` 里没有 0001–0005 的记录，直接 `migrations apply` 会 `duplicate column name`。当时的做法：

1. 先 `wrangler d1 export ze-map-community --remote --output backup.sql`
2. 对已经手工建过的迁移执行 `INSERT OR IGNORE INTO d1_migrations (name) VALUES (...)` 回填
3. 再 `wrangler d1 migrations apply ze-map-community --remote`，实际执行 0006、0007

以后再改结构：**先导出**，再写新迁移，不要改旧迁移文件。

## 内容校验的一个硬限制

`shared/page-schema.mjs` 的 `ITEM_EDIT_MAX` 已从 40 调到 200。原因：`ze_backrooms_insomnia` 一次有 56 条神器修改，超过 40 会让整份 `data/content` 校验失败、`normalizePageContent` 静默回退成空内容，页面看不到任何审核结果。

## 下一步（数据层）

计划把实体快照整理成公开的结构化数据（每张图一个 JSON：分组统计、实体列表、神器、边界），先在本地原型验证 schema，再做成 `/api/map/<slug>` 按需返回。当前本地原型在 `E:\Astro-code\mapdata\explorer.html`（未入库）。
