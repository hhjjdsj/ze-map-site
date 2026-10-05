# data/community/

社区投稿的落盘目录。**一张地图一个文件**，文件名就是地图 slug
（与 `src/content/maps/<slug>.mdx` 同名，也与网址 `/maps/<slug>/` 一致）。

## 谁写这个目录

**不是手写的** —— 是审核台在通过投稿后，由 Worker 调 GitHub API 写进来的。
2026-10-05 起改成**攒批**：点「通过」只是把投稿攒进待写回队列（D1 里 `status='approved'`），
再点一次「写回仓库」才真正提交 —— **不管攒了多少条，都只有一个 commit、只触发一次 Cloudflare 重建**
（免费版每月只有 3000 构建分钟，一条一提交太浪费）。

```
投稿表单 /submit/ → D1 待审队列 → /admin 点「通过」（攒着）
                                    → /admin 点「写回仓库」 → 写入这里 → 触发一次 Cloudflare 重建
```

攒批的实现：`worker/community.ts` 的 `commitFiles()` 走 Git Data API
（blob → tree → commit → ref），一次提交可以同时包含多张图的 JSON、多张封面图，
以及「删掉同名的其它扩展名」这类删除项。分支被并发推过时它会自动重试（force=false）。

所以这里每个文件，`git log` 都能看到「谁提的、谁审的、改了什么、依据什么」。

## 文件格式

```jsonc
{
  "v": 1,
  "slug": "ze_flowering",
  "updatedAt": "2026-09-24T07:00:00.000Z",
  "fields": {
    // 只出现「被社区覆盖过」的字段
    "difficulty": { "v": "普通", "by": "某玩家", "at": "…", "submission": 12 }
  },
  "notes": [
    { "text": "补充说明正文……", "by": "某玩家", "at": "…", "submission": 13 }
  ],
  "items": [
    // 神器 / 道具：一行一件，逐行合并进条目正文的表格（不整表替换）
    { "action": "update", "name": "Survivor", "cd": 60, "uses": 1, "note": "第四关才有",
      "by": "某玩家", "at": "…", "submission": 14 }
  ],
  "log": [ /* 每次变更一行，便于追溯 */ ]
}
```

可覆盖字段：`difficulty` `tags` `author` `authorNote` `version` `players`
`duration` `stages` `sources` `videoUrls`（定义在 `shared/submission-fields.mjs`）。

**正文类字段**（`story` 背景故事、`body` 补充说明 / 纠错）**不进 `fields`** ——
它们是往 `notes` 里**追加一条**，由地图页的「社区补充」区块渲染（多条会按顺序全部显示，
各自署名）。判定走 `shared/community-doc.mjs` 的 `isNoteField()`，也就是字段表里
`kind: 'longtext'` 的那些；以后再加长文本字段不用改这里。

**神器 / 道具**（`items`，字段表里 `kind: 'itemlist'`）**也不进 `fields`** ——
它是一行行的增量：`action` 取 `update`（更正）/ `add`（新增）/ `remove`（反馈「本图没有」），
`cd` 是冷却秒数、`uses` 是次数（`0` 与 `null` 分别表示不限 / 不改这一项）。
落进 `items[]` 后由生成器 `shared/items.mjs` 的 `mergeItems()` 合并：
服务器配置（`data/gfl-parsed/`）打底，同名的社区行盖上，**原值保留在表格备注里**。
判定走 `isItemField()`。为什么不做整表替换：这张表是服务器配置的整理结果，
整表换掉就变成了「既不是 GFL、也不是别服」的第三份数据，谁也说不清对不对。

## 渲染优先级

**社区（本目录） > 人工资料 `data/research/` > 自动生成 `src/content/maps/`**

合并逻辑在 `src/lib/maps.ts` 的 `mergeEntry()`；页面请通过 `getMaps()` 取数据。

## ⚠️ 三个容易踩的点

1. **读取一律走 `src/lib/maps.ts`，不要直接 `getCollection('maps')`。**
   那样拿到的是没合并社区覆盖的原始数据，会出现「详情页显示困难、地图库里还是
   中等」这种自相矛盾。（曾经试过在 content loader 里 `store.set()` 回写合并结果，
   Astro 不认，详见 `src/lib/maps.ts` 顶部注释。）
2. **本目录靠 `.gitignore` 里的一条白名单才入得了库**（`data/*` 会连它一起忽略，
   `!data/community/` 才放行）。那行删了，文件就进不了仓库，构建期也读不到。
3. **想撤销某次社区改动**：删掉对应文件，或者 `git revert` 那次提交。
   两种方式都会在下次构建时生效。
