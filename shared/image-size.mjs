/**
 * 从文件头读图片宽高与格式（png / jpeg / webp）—— Node 与 Worker 共用一份。
 *
 * 为什么要抽出来：封面校验要用（`npm run cover:verify`）、投稿上传也要用（Worker 端权威校验）。
 * 两边各写一份必然漂移，而这类检查最容易「读不出来就跳过」→ 静默失效。
 *
 * 不引任何依赖：只用到 DataView，Node 和 Workers 都有。
 */

/** 是不是 webp / jpg / png（按 magic bytes 判断，不信扩展名和 content-type） */
export function detectImageFormat(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length > 16 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8.length > 16 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpg';
  if (
    u8.length > 16 &&
    u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && // RIFF
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50 // WEBP
  ) {
    return 'webp';
  }
  return null;
}

/**
 * 读宽高；读不出返回 null（调用方决定是报错还是只提醒）。
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {{ w: number, h: number } | null}
 */
export function imageSize(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 32) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ascii = (start, len) => {
    let s = '';
    for (let i = start; i < start + len; i++) s += String.fromCharCode(u8[i]);
    return s;
  };

  /* PNG：IHDR 固定在第 16~24 字节 */
  if (ascii(1, 3) === 'PNG') return { w: dv.getUint32(16), h: dv.getUint32(20) };

  /* WebP：三种子格式（有扩展头 / 有损 / 无损）宽高位置都不一样 */
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const fmt = ascii(12, 4);
    if (fmt === 'VP8X') {
      if (u8.length < 30) return null;
      return {
        w: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)),
        h: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)),
      };
    }
    if (fmt === 'VP8 ') {
      /*
       * ⚠️ 必须读**小端**：VP8 的码流是小端，宽高就在帧头里
       * （帧标签 3 字节 + 起始码 9d 01 2a 三字节 → 宽在高 14 位、高在高 14 位）。
       * 2026-10-06 之前这里漏了 `true`，按大端读出来是垃圾值：555×312 的图会读成
       * 11010×14337 —— 于是 `w*h > 40M` 的护栏把**浏览器压出来的所有有损 webp 都判成
       * 「图片尺寸过大」**（投稿封面走的就是 canvas.toBlob('image/webp')）。
       */
      return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
    if (fmt === 'VP8L') {
      const b = dv.getUint32(21, true);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  /* JPEG：扫 SOFn 段（跳过 C4/C8/CC 这几个不是尺寸的） */
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i < u8.length - 9) {
      if (u8[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = u8[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
