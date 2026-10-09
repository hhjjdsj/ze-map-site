/**
 * 「图文块」的统一语法（教程 / 攻略正文用）—— 脚本与页面共用这一份解析。
 *
 * 为什么需要它：神器教程要**左图右文**，而投稿正文按设计只能用「纯 Markdown 子集、禁 JSX」，
 * 手写原稿也不想让人写 JSX。所以定一条纯文本约定，两条路径都认：
 *
 *     :::figure 2            ← 引用图片集里的第 2 张，图在左（默认）
 *     :::figure 2 right      ← 图在右
 *     这一段文字会排到图片的右侧，可以分多段、可以写 Markdown。
 *     :::
 *
 * 图片从哪来：**地图自己的图片集**（data/gallery/<slug>.json，图片在 R2）。
 * 投稿页的「图片集图片」字段一次能传 24 张、每张写一句说明 —— 序号就是那里的顺序（从 1 开始）。
 * 这样作者不用懂路径、不用懂 JSX：先传图，再在正文里按序号引用。
 *
 * 两条渲染路径：
 *   · 原稿（data/research/<map>.json 的 guides[]）→ 生成器把 :::figure 转成 <GuideFigure> JSX 写进 MDX；
 *   · 社区投稿（data/community/<map>.json 的 notes，field = guide）→ 页面用 GuideNote 组件按块渲染。
 *
 * 解析失败**一律降级成普通文字**，绝不抛错：教程写错一个符号不该让整站构建红。
 */

/** 开块：:::figure <序号> [left|right] */
const OPEN_RE = /^:::figure\s+(\d+)(?:\s+(left|right))?\s*$/i;
/** 闭块：单独一行 ::: */
const CLOSE_RE = /^:::\s*$/;

/**
 * 把正文切成块。
 * @returns {{type:'text', text:string} | {type:'figure', n:number, side:'left'|'right', text:string}[]}
 */
export function parseGuideBlocks(input) {
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buf = [];

  const flushText = () => {
    const text = buf.join('\n').trim();
    if (text) blocks.push({ type: 'text', text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i]);
    if (!open) {
      buf.push(lines[i]);
      continue;
    }
    /* 找闭块；找不到就当普通文字（写漏了 ::: 也不至于把后面的内容吞掉） */
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (CLOSE_RE.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      buf.push(lines[i]);
      continue;
    }
    flushText();
    blocks.push({
      type: 'figure',
      n: Number(open[1]),
      side: (open[2] || 'left').toLowerCase() === 'right' ? 'right' : 'left',
      text: lines
        .slice(i + 1, end)
        .join('\n')
        .trim(),
    });
    i = end;
  }
  flushText();
  return blocks;
}

/**
 * 生成器用：把正文里的 :::figure 块转成 <GuideFigure> JSX（写进 MDX）。
 * 非 figure 的行原样保留 —— 生成器不做别的改动。
 */
export function guideTextToMdx(input, { slug }) {
  const blocks = parseGuideBlocks(input);
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      /* MDX 里 JSX 块的子内容要独立成段，所以前后留空行 */
      return [
        `<GuideFigure slug=${JSON.stringify(slug)} n={${b.n}} side="${b.side}">`,
        '',
        b.text,
        '',
        '</GuideFigure>',
      ].join('\n');
    })
    .join('\n\n');
}

/** 正文里有没有用到图（页面据此决定要不要给图片集那块加提示） */
export function usesGuideFigures(input) {
  return parseGuideBlocks(input).some((b) => b.type === 'figure');
}

/** 神器 / 道具表某一行的锚点 id（由 guides 小节的序号决定，稳定、不依赖中文 slug） */
export const relicAnchorId = (sectionIndex) => `relic-${sectionIndex}`;
