import type { Converter } from '../types.js';

/**
 * `.txt` / `.text` 转换器：utf8 解码。
 *
 * 与 markdown-passthrough 实质相同，分开是为了让 `.txt` 落到一个明确的转换器名上，
 * 缓存 key 不会被 markdown 复用，将来也方便在这里追加"剥离 ANSI 颜色码"之类的处理。
 */
export const textPassthrough: Converter = {
  name: 'text-passthrough',
  version: '1',
  priority: 0,
  extensions: ['.txt', '.text'],
  async convert({ bytes }) {
    return { content: bytes.toString('utf8') };
  },
};
