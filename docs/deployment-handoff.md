# 部署交接清单（站长版）

> 目标：PR 合并到 `hhjjdsj/ze-map-site` 后，站长在自己的 Cloudflare 账户把生产站接到新下游。
> AI 协作版见 [`deployment-handoff-ai.md`](deployment-handoff-ai.md)；规划见 [`planning/refactor-merge-plan.md`](planning/refactor-merge-plan.md)。

## 资源

| 资源 | 生产值 |
|---|---|
| Worker | `ze-map-site` |
| D1 | `ze-map-community` |
| KV | `UPLOADS` |
| R2 | `ze-map-terr`（绑定 `TERR`） |
| 域名 | `ze-map.cn`、`terr.ze-map.cn` |
| 构建 | GitHub Actions（`.github/workflows/deploy.yml`）→ `wrangler deploy`；Cloudflare 的 Git 构建已断开，见 [automation.md](automation.md) |

默认 `wrangler.jsonc` 已经指向以上生产资源；仓库不携带个人测试 Cloudflare / GitHub 配置。

## 上线顺序

1. **先导出，再破坏**
   ```bash
   npx wrangler d1 export ze-map-community --remote --output ./migration-owner/d1-before-cutover.sql
   npx wrangler kv key list --namespace-id <生产 KV ID> --remote
   ```
   确认 `submissions`、`difficulty_votes`（如存在）和 `page_revisions` 都在导出里；KV pending 图先记录 / 导出再清理。

2. **D1 迁移**
   ```bash
   npx wrangler d1 migrations apply ze-map-community --remote
   ```
   迁移后确认：存在 `page_revisions`（含 `mode`），不存在 `submissions` / `difficulty_votes`。

3. **Secrets**
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put IP_SALT
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
   npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put TURNSTILE_SECRET   # 如启用
   ```
   `GITHUB_TOKEN` 只授权 `hhjjdsj/ze-map-site` 的 Contents 读写；OAuth callback 为
   `https://ze-map.cn/api/auth/github/callback`。不要使用 PR 作者的个人 token / OAuth App。

4. **Preview / 构建验收**
   ```bash
   npm ci
   npm run build
   npm run content:verify-content
   npm run test:content
   npm run handoff:check
   ```
   抽查 `/maps/ze_cyberspace_v2/`、`/maps/ze_depths/`、`/submit/edit`、`/submit`、`/admin/`、`/api/vote`；审核写回只碰 `data/content`；封面 / 图集走 KV → 审核 → 仓库 / R2。

5. **切生产**
   确认 Workers Builds 连接 `hhjjdsj/ze-map-site` 的 `main`，构建 `npm run build`，部署 `npx wrangler deploy`；再检查 `ze-map.cn`、`terr.ze-map.cn` 和缓存。

## 边界

- 生产 D1 的旧 pending / approved / rejected / draft 只归档，不导入新队列。
- 任何 drop 前必须完成导出。
- 不建备份分支 / tag；旧数据导出不是回滚备份。
- PR 不含 `.dev.vars`、`migration/legacy/`、个人账户信息或个人 Cloudflare ID。
