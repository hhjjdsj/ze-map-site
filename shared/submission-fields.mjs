/**
 * 投稿字段定义 —— 全站唯一来源。
 *
 * 为什么要单独抽出来：
 * 「什么算一条合法投稿」这件事有三个地方需要知道 ——
 *   1. 投稿表单（src/pages/submit.astro）—— 前端即时校验、渲染对应控件
 *   2. Worker（worker/index.ts）—— 服务端权威校验，绝不相信前端
 *   3. 测试脚本 —— 单独验证规则本身
 * 三处各写一份必然漂移。难度枚举那次线上构建红叉（有人写了「普通」）
 * 就是同一类事故，所以这次一开始就共用一份。
 *
 * 加字段的步骤：在这里加一条规则 → 表单自动出现控件 → Worker 自动开始校验。
 * kind=longtext 的字段还会自动进社区补充区块（不用改页面）。
 */

import { DIFFICULTIES } from './difficulty.mjs';
import { ITEM_ACTIONS, intOrNull, numOrNull } from './items.mjs';

/** 单条投稿的字段上限（跨字段） */
export const LIMITS = {
  submitter: 32,
  contact: 80,
  note: 500,
  /**
   * 每个 IP 每小时最多投稿几次（文本与封面**共用一个桶**，防止靠两个入口把额度翻倍）。
   * 2026-09-28 从 5 放宽到 300：站长反馈 5 条太少，批量补资料时会被自己的额度拦住。
   * 正常人手打一天也到不了这个数，所以它现在只拦脚本。
   */
  perHour: 300,
  /**
   * 每天上限，兜底用：`TURNSTILE_SECRET` 没配时上面那个小时桶是唯一闸门，
   * 而脚本可以每小时刷满 —— 待审队列会被灌满，还会吃掉 D1 免费额度（每天 10 万行写入）。
   * 设成 0 = 不设每日上限。
   */
  perDay: 2000,
};

/**
 * 字段规则。
 * kind 决定表单控件类型与校验方式：
 *   enum     单选（下拉 / 按钮组）
 *   text     单行文本
 *   tags     字符串数组（标签）
 *   int      整数
 *   urlList  链接数组
 *   image    图片文件（**不走这里的 text 校验**：由 /api/submit-cover 以 multipart 上传，
 *            校验与落盘在 worker/covers.ts；这里只用于表单控件与审核台标签）
 *   gallery  图片集图片（**同 image**：由 /api/submit-gallery 一次一张上传，
 *            校验在 worker/gallery.ts，图片进 R2、通过的清单写进 data/gallery/<slug>.json）
 *   longtext 多行正文（**正文类字段不做条目字段覆盖，而是进「社区补充」区块的笔记** ——
 *            见 shared/community-doc.mjs 的 applySubmission 与 isNoteField）
 *   itemlist 神器 / 道具行（**逐行合并**，不整表替换：见 shared/items.mjs 的 mergeItems；
 *            落盘进社区文档的 items[]，由生成器合并进条目正文）
 *
 * ⚠️ `hint` 是**纯文本**：投稿表单用 textContent 填、/contribute/ 直接插值，
 *    两边都不会解析 markdown —— 写 `**加粗**` 只会原样显示出星号。
 *    要强调就用「」引起来（2026-10-10 统一清掉了历史遗留的星号）。
 */
export const FIELD_RULES = {
  difficulty: { kind: 'enum', label: '难度', hint: '必须从这几个里选', values: DIFFICULTIES },
  tags: {
    kind: 'tags',
    label: '标签',
    hint:
      '从全站已有标签里勾选（括号里是「全站多少张图用过」，方便挑常用的）；' +
      '「这张图现有的标签」已经帮你勾好了，你只要加要加的、取消不要的即可（提交的是整组，不是追加）。' +
      '列表里没有想要的，就在下面「新建标签」里输入 —— 新标签需要审核确认，通过后会进全站标签，' +
      '以后任何人给任何图投稿都能选到。',
    /* 上限 15（2026-10-09 由 12 放宽）：站内有 2 张图原本就有 13/14 个标签，
       而标签是整组替换 —— 上限卡在 12 会让这两张图的标签**没法微调**（提交现况就被拒）。 */
    max: 15,
    maxLen: 24,
  },
  author: { kind: 'text', label: '作者', hint: '尽量与工坊署名一致', maxLen: 120 },
  authorNote: { kind: 'text', label: '署名详情', hint: '多作者 / 原作与移植的区分', maxLen: 300 },
  version: { kind: 'text', label: '版本', maxLen: 40 },
  players: { kind: 'text', label: '人数', hint: '如「最多 64 人」', maxLen: 40 },
  duration: { kind: 'text', label: '时长', hint: '如「约 40 分钟」', maxLen: 40 },
  stages: { kind: 'int', label: '关卡数', min: 1, max: 30 },
  items: {
    kind: 'itemlist',
    label: '神器 / 道具',
    hint:
      '一行填一件。上面列着本站这张图现在的表 —— 点一件就能改它（名字、冷却、次数、说明都会带出来）；' +
      '要加表里没有的，点「＋ 再加一行」手填。动作不用你选：名字对得上表里已有的算「更正」，对不上算「新增」。' +
      '「说明」是神器表那一列的一句话介绍（这件神器是干嘛的，最多 200 字，长文请投「攻略 / 神器讲解」）；' +
      '「备注」写的是我们服和原表的差别（例如「第四关才刷」）。冷却 / 次数留空 = 这一项不动；' +
      '如果表里那件在本图其实没有，勾「本图没有这件」。',
    /* 上限：一次能交的行数、单个字段长度、以及整表文本总量（防巨型投稿） */
    maxRows: 40,
    nameMaxLen: 60,
    noteMaxLen: 200,
    introMaxLen: 200,
    cdMax: 3600,
    usesMax: 99,
    textBudget: 6000,
  },
  videoUrls: {
    kind: 'urlList',
    label: '攻略视频',
    hint:
      '每行一个，https 开头。B 站和 YouTube 会用「官方播放器嵌入」（点击才加载，本站不转存、不下载、不剪辑），' +
      '其它站会显示成链接。只投公开视频 —— 付费、未公开、或者你不确定能不能公开的请别提交；' +
      '不是自己拍的，请把作者 / 来源一并写在下面的「理由」里。版权归原 UP 主，' +
      '作者说不想被收录我们会立刻撤下（「关于」页的版权一节写了规则）。',
    /* 上限 12：站内已有 10 张图的视频超过 5 个（最多 9 个），
       上限太小会导致「想补全但提交不了」。 */
    max: 12,
    /* 社区补的按「追加 + 去重」合并，不替换 —— 否则补 1 个会把原有的全顶掉 */
    append: true,
  },
  sources: {
    kind: 'urlList',
    label: '资料来源',
    hint: '每行一个，https 开头',
    /* 同理：现有资料里超过 5 条来源的很多 */
    max: 12,
    append: true,
  },
  cover: {
    kind: 'image',
    label: '地图封面',
    hint:
      '选一张横向图（16:9 最好）。会在你的浏览器里自动裁成 16:9、压成 webp 再上传，不用自己处理。' +
      '请用作者在工坊公开的预览图，或者你自己截的图 —— 版权归原作者，作者要求撤下我们会立刻删。',
    /* 图片上限在 worker/covers.ts（700 KB，比 cover:verify 的 800 KB 略低：
       二进制要 base64 进 git blob，留出余量。2026-10-05 前走 contents API，现在是 Git Data API） */
  },
  gallery: {
    kind: 'gallery',
    label: '图片集图片',
    hint:
      '真实的游戏内截图 / 作者自己发的图，可一次选多张（一张图最多收 24 张投稿图）。' +
      '会在你的浏览器里压成 webp 再上传，通过后进条目底部的「图片集」，每张都能写一句说明。' +
      '不要传本站渲染的 3D 视角示意图。' +
      '只传你自己截的、或者作者公开允许传播的图：别人的作品请先问过再传；' +
      '图片版权归原作者，作者要求撤下我们会立刻删。',
    /* 图片上限与落盘在 worker/gallery.ts（单张 1.5 MB、宽至少 480px、每图最多 24 张）；
       说明上限 60 字；接口是 /api/submit-gallery（multipart，一次一张） */
    maxCaption: 60,
  },
  /*
   * 正文类字段的排序就是表单里「要提交哪一项」下拉的顺序：
   * 简介 → 背景故事 → 攻略讲解 → 补充说明。三者的分工必须在提示里写死，
   * 否则一定会收到投错字段的稿子（简介和背景故事尤其容易混，2026-10-10 的反馈）。
   */
  summary: {
    kind: 'longtext',
    label: '地图简介',
    hint:
      '条目打开后、标题下面那第一段话（导语）：这张图是什么题材、大致怎么玩、有什么特别之处，' +
      '一两段说清就行。和「背景故事」的分工：这里是开头那段总览，' +
      '剧情、设定、来历请投「背景故事」（它会单独成一块，不占开头）。' +
      '规则：只有本站还没写简介的图可以补 —— 已经有本站简介的图不能覆盖，那种情况请投「背景故事」或「补充说明」。' +
      '支持简单 Markdown，不支持 HTML 与 MDX，最多 1500 字。',
    maxLen: 1500,
  },
  story: {
    kind: 'longtext',
    label: '背景故事',
    hint:
      '地图的剧情、设定与来历，可以分多段写 —— 注意这不是开头那段导语：' +
      '开头那段总览请投「地图简介」，这里写的是故事本身（会单独成块显示）。' +
      '支持简单 Markdown，不支持 HTML 与 MDX。' +
      '通过后会显示在条目的「背景故事（社区投稿）」一节：不会覆盖本站整理的正文，会署你的昵称。' +
      '右侧面板里列着本站正文与已经通过的社区投稿 —— 想改哪一条，点那条的「修订这条」，' +
      '正文会带进下面的框里，改完提交即可（署名仍是原作者，页面上会标出是谁修订的）。',
    maxLen: 4000,
  },
  guide: {
    kind: 'longtext',
    label: '攻略 / 神器讲解',
    hint:
      '神器机制、道具怎么用、关卡要点这类玩法讲解（剧情与来历请投「背景故事」，' +
      '开头那段总览请投「地图简介」）。' +
      '支持简单 Markdown：分多段写即可，正文里换行就换行。' +
      '想做成左图右文，先在下面的「图片集图片」里传图，再在正文里写一行 :::figure 2 ' +
      '（引用图片集第 2 张，图在左；写成 :::figure 2 right 则图在右），紧接着写文字，最后用单独一行 ::: 结束。' +
      '通过后显示在条目的「攻略 / 神器讲解（社区投稿）」一节，署你的昵称。' +
      '改已完成的那一条：点右侧面板里它的「修订这条」，正文会带进下面的框里。',
    maxLen: 4000,
  },
  body: {
    kind: 'longtext',
    label: '补充说明 / 纠错',
    hint:
      '纯文本，支持简单 Markdown，不支持 HTML 与 MDX。' +
      '通过后会显示在条目末尾的「社区补充」一节，同样会署名。' +
      '改已完成的那一条：点右侧面板里它的「修订这条」，正文会带进下面的框里。',
    maxLen: 4000,
  },
};

export const FIELD_KEYS = Object.keys(FIELD_RULES);

/** 是不是允许投稿的字段 */
export function isField(key) {
  return Object.prototype.hasOwnProperty.call(FIELD_RULES, key);
}

/* ===== 校验 ===== */

function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '不是合法的链接';
  }
  if (url.protocol !== 'https:') return '链接必须以 https:// 开头';
  if (!url.hostname.includes('.')) return '链接域名看起来不对';
  if (/^\d+(\.\d+){3}$/.test(url.hostname)) return '不接受 IP 直链';
  if (raw.length > 300) return '链接过长';
  return null;
}

/**
 * 校验并归一化一个字段值。
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function validateValue(field, raw) {
  const rule = FIELD_RULES[field];
  if (!rule) return { ok: false, error: '不认识的字段' };

  switch (rule.kind) {
    case 'enum': {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!rule.values.includes(v)) return { ok: false, error: `必须是：${rule.values.join(' / ')}` };
      return { ok: true, value: v };
    }

    case 'text': {
      const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
      if (!v) return { ok: false, error: '不能为空' };
      if (v.length > rule.maxLen) return { ok: false, error: `最多 ${rule.maxLen} 个字` };
      return { ok: true, value: v };
    }

    case 'longtext': {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) return { ok: false, error: '不能为空' };
      if (v.length > rule.maxLen) return { ok: false, error: `最多 ${rule.maxLen} 个字` };
      /*
       * 正文只收纯文本。
       * 现有条目里已经踩过「工坊正文含 < 和 { 被当 JSX 解析导致构建失败」的坑，
       * 社区入口必须从格式上堵死：尖括号与花括号直接拒绝。
       */
      if (/[<>{}]/.test(v)) return { ok: false, error: '正文里不能出现 < > { } 这几个字符' };
      return { ok: true, value: v };
    }

    case 'tags': {
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      for (const item of list) {
        const t = typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : '';
        if (!t) continue;
        if (t.length > rule.maxLen) return { ok: false, error: `单个标签最多 ${rule.maxLen} 个字` };
        /*
         * 禁掉的不只是 Markdown 里的保留字符，还有**路径敏感字符**：
         * 标签会变成 /tags/<标签>/ 目录，`/` 会造出嵌套路由、`:` `*` `?` `"` `\` 在 Windows 上直接非法。
         * 实测现有 254 个标签里一个都没有这类字符，所以收紧不会误伤历史数据。
         */
        if (/[<>{}[\]|,\\/:*?"]/.test(t)) return { ok: false, error: `标签「${t}」含不支持的字符（< > { } [ ] | , / \\ : * ? "）` };
        if (!out.includes(t)) out.push(t);
      }
      if (out.length === 0) return { ok: false, error: '至少要有一个标签' };
      if (out.length > rule.max) return { ok: false, error: `最多 ${rule.max} 个标签` };
      return { ok: true, value: out };
    }

    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
      if (!Number.isInteger(n)) return { ok: false, error: '要是整数' };
      if (n < rule.min || n > rule.max) return { ok: false, error: `要在 ${rule.min}~${rule.max} 之间` };
      return { ok: true, value: n };
    }

    case 'itemlist': {
      const list = Array.isArray(raw) ? raw : [];
      if (list.length === 0) return { ok: false, error: '至少要填一件道具' };
      if (list.length > rule.maxRows) return { ok: false, error: `一次最多 ${rule.maxRows} 件道具` };

      const out = [];
      const seen = new Set();
      let budget = 0;
      for (let i = 0; i < list.length; i++) {
        const at = `第 ${i + 1} 行`;
        const row = list[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          return { ok: false, error: `${at}格式不对` };
        }
        const action = typeof row.action === 'string' ? row.action.trim() : '';
        if (!Object.prototype.hasOwnProperty.call(ITEM_ACTIONS, action)) {
          return { ok: false, error: `${at}要选「更正 / 新增 / 删除」` };
        }
        const name = String(row.name ?? '')
          .replace(/\u3000/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!name) return { ok: false, error: `${at}缺少道具名` };
        if (name.length > rule.nameMaxLen) return { ok: false, error: `${at}的道具名最多 ${rule.nameMaxLen} 个字` };
        if (/[<>{}[\]|]/.test(name)) return { ok: false, error: `${at}的道具名里有不支持的字符（< > { } [ ] |）` };

        const cd = numOrNull(row.cd);
        if (row.cd !== undefined && row.cd !== null && String(row.cd).trim() !== '' && cd === null) {
          return { ok: false, error: `${at}的冷却要是数字（秒）` };
        }
        if (cd !== null && (cd < 0 || cd > rule.cdMax)) {
          return { ok: false, error: `${at}的冷却要在 0~${rule.cdMax} 秒之间` };
        }
        const uses = intOrNull(row.uses);
        if (row.uses !== undefined && row.uses !== null && String(row.uses).trim() !== '' && uses === null) {
          return { ok: false, error: `${at}的次数要是整数` };
        }
        if (uses !== null && (uses < 0 || uses > rule.usesMax)) {
          return { ok: false, error: `${at}的次数要在 0~${rule.usesMax} 之间` };
        }
        const note = String(row.note ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (note.length > rule.noteMaxLen) return { ok: false, error: `${at}的备注最多 ${rule.noteMaxLen} 个字` };
        if (/[<>{}|]/.test(note)) return { ok: false, error: `${at}的备注里有不支持的字符（< > { } |）` };

        /* intro = 神器表「说明」列的一句话介绍（和备注不是一回事：
           备注写「我们服里改了哪一项」，说明写「这件神器是干嘛的」） */
        const intro = String(row.intro ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (intro.length > rule.introMaxLen) return { ok: false, error: `${at}的说明最多 ${rule.introMaxLen} 个字（长文请投「攻略 / 神器讲解」）` };
        if (/[<>{}|]/.test(intro)) return { ok: false, error: `${at}的说明里有不支持的字符（< > { } |）` };

        /* 删除只认名字；其它动作得说清改了什么，否则审核员只能猜 */
        if (action !== 'remove' && cd === null && uses === null && !note && !intro) {
          return { ok: false, error: `${at}什么都没改：冷却、次数、说明、备注至少填一项` };
        }

        const key = name.toLowerCase();
        if (seen.has(key)) return { ok: false, error: `「${name}」写了两行，请合并成一行` };
        seen.add(key);

        budget += name.length + note.length + intro.length;
        if (budget > rule.textBudget) return { ok: false, error: '整表内容太长，请分几次提交' };

        out.push({ action, name, cd, uses, note, ...(intro ? { intro } : {}) });
      }
      return { ok: true, value: out };
    }

    case 'image':
      /* 图片不走 JSON 投稿：表单会用 multipart 打到 /api/submit-cover，
         服务端在那里做权威校验（种类、体积、尺寸）。走到这里说明调用方搞错了入口。 */
      return { ok: false, error: '封面请用表单里的图片上传控件（接口是 /api/submit-cover）' };

    case 'gallery':
      /* 同理：图片集走 multipart 到 /api/submit-gallery，一次一张，落盘在 worker/gallery.ts */
      return { ok: false, error: '图片集请用表单里的图片上传控件（接口是 /api/submit-gallery）' };

    case 'urlList': {
      const list = Array.isArray(raw)
        ? raw
        : String(raw ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
      const out = [];
      for (const item of list) {
        const s = typeof item === 'string' ? item.trim() : '';
        if (!s) continue;
        const bad = checkUrl(s);
        if (bad) return { ok: false, error: `${bad}：${s.slice(0, 60)}` };
        if (!out.includes(s)) out.push(s);
      }
      if (out.length === 0) return { ok: false, error: '至少要有一个链接' };
      if (out.length > rule.max) return { ok: false, error: `最多 ${rule.max} 个链接` };
      return { ok: true, value: out };
    }

    default:
      return { ok: false, error: '字段类型未实现' };
  }
}

/** 表单里的控件类型（前端用） */
export function inputKind(field) {
  const rule = FIELD_RULES[field];
  if (!rule) return null;
  if (rule.kind === 'tags' || rule.kind === 'urlList') return 'lines';
  if (rule.kind === 'longtext') return 'textarea';
  if (rule.kind === 'enum') return 'select';
  if (rule.kind === 'image') return 'file';
  if (rule.kind === 'gallery') return 'file';
  if (rule.kind === 'itemlist') return 'itemlist';
  return 'text';
}

/** 把字段值转成给人看的字符串（审核台展示、git 提交信息用） */
export function displayValue(field, value) {
  if (FIELD_RULES[field]?.kind === 'itemlist' && Array.isArray(value)) {
    return value
      .map((row) => {
        const bits = [ITEM_ACTIONS[row?.action] ?? '更正', String(row?.name ?? '')];
        const cd = intOrNull(row?.cd);
        const uses = intOrNull(row?.uses);
        if (cd !== null) bits.push(`冷却 ${cd} 秒`);
        if (uses !== null) bits.push(`${uses} 次`);
        if (row?.note) bits.push(`（${row.note}）`);
        return bits.join(' ');
      })
      .join('；');
  }
  if (Array.isArray(value)) return value.join('、');
  return String(value ?? '');
}

/**
 * 从一组标签里挑出**全站词表里还没有的**（= 这次投稿想新立的词）。
 *
 * 为什么单独一个函数：投稿页用它提示「新标签 N 个需审核确认」，审核台用它给新词打标记 ——
 * 两边规则必须一模一样（忽略大小写、去空白）。写成共用的一份，改的时候不会漏一边。
 *
 * @param {unknown} tags 待检查的标签数组
 * @param {Iterable<string>|null|undefined} vocabulary 全站已有标签（取自 /submit/tags.json）
 * @returns {string[]} 词表里没有的标签（保持输入顺序、去重）。
 *   词表传 null（还没加载出来 / 加载失败）时返回**空数组** —— 拿不到词表就别乱标「新」，
 *   否则审核员会看到一堆假的新词，比不标还糟。
 */
export function newTagsOf(tags, vocabulary) {
  if (!vocabulary) return [];
  const known = new Set([...vocabulary].map((t) => String(t).trim().toLowerCase()));
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw ?? '').trim();
    if (!t || known.has(t.toLowerCase()) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}
