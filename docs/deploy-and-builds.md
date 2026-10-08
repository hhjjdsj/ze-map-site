# 部署链路：推送之后到底发生了什么（以及构建没触发怎么查）

## 链路

```
本地 git push
   ↓  GitHub 把 push 事件发给 Cloudflare 的 GitHub App（webhook）
Cloudflare Workers Builds   ← 这一步会往提交上写一条 check-run：`Workers Builds: ze-map-site`
   ↓  npm run build（见 package.json：build-catalog → map-dates → map-entries → astro build → Pagefind）
   ↓  wrangler deploy（Worker `ze-map-site` + 静态资源）
ze-map.cn                   ← Cloudflare 缓存 HTML（Ctrl+F5 强制刷新）
```

一次正常的构建：本地 `astro build` 约 50 秒，CI 里装依赖 + Pagefind 通常 **2~4 分钟**。

## 判据：提交上有没有 `Workers Builds` 这条 check-run

推送后先跑：

```bash
npm run deploy:check                # 看 main 最新提交的构建状态
npm run deploy:check -- --watch     # 盯着直到结束（最多 15 分钟）
npm run deploy:check -- --commit 42d5796
```

- **有 check-run、failed** → 代码或 CI 的问题，点脚本打印的日志链接看卡在哪一步（多半是内容校验脚本拦的）。
- **一条 check-run 都没有** → Cloudflare **根本没收到这次推送事件**，构建不会自己出现。这不是代码问题，别去改代码。

也可以在 GitHub 的提交页面上直接看：有那个橙色/绿色的 `Workers Builds: ze-map-site` 就是收到了。

## 事件丢了怎么办（2026-10-08 真实发生过）

现象：`git push` 返回成功、远端 `main` 确实更新了，但线上一直是旧版，提交上一个 check-run 都没有。

背景：那段时间 GitHub 自己在返回 500（`git-receive-pack` 内部错误 + 网页也是 500），
而 webhook 是**静默丢弃**的 —— 没有重投、没有任何告警。Cloudflare 侧当时完全正常
（Workers Builds 组件 operational，无相关事故）。

处置，按顺序试：

1. **面板手动部署**（不产生多余提交，首选）：
   `dash.cloudflare.com` → **Workers & Pages** → `ze-map-site` → **Deployments**
   → **Create deployment**，分支 `main`、提交选最新那个。
2. **重推一次**：随便改点东西推上去，或者 `git commit --allow-empty -m "ci: retrigger build"`。
   推完再跑 `npm run deploy:check` 确认这次收到了。
3. **连 Create deployment 都没有** → Git 集成本身断了：
   Worker → **Settings → Builds → Git repository** 重新连接仓库（顺带确认
   GitHub 的 Cloudflare GitHub App 授权里这个仓库还在）。

## 为什么会有这篇

原来的链路没有任何自查手段：webhook 丢了和构建失败在表面上完全一样 —— 都是「线上没更新」。
`npm run deploy:check` 就是把当时的排查（手工调 GitHub 的 check-runs 接口）固化成一条命令，
`scripts/ops/check-deploy.mjs` 里有详细注释。它读 `.git/config` 拿仓库地址、走 GitHub 公开接口，
不需要 token、也不依赖 git 命令（这台机器上 git 只有 GitHub Desktop 自带的那份，不在 PATH 里）。

## 可选的加固（还没做）

给 Worker 配一个 **Deploy Hook**，再加一个 GitHub Action：push 后如果 1 分钟内没出现
`Workers Builds` 的 check-run，就 `curl` 那个 hook 兜底触发。这样 webhook 丢了也能自愈。
需要先做两件手工事：在 Cloudflare 面板建 Deploy Hook（拿到 URL），把它存成仓库 secret
（例如 `CF_DEPLOY_HOOK`）。要做的时候再说。
