import type { Converter } from '../types.js';

/**
 * `.md` / `.markdown` 默认转换器：直接 utf8 解码，不做任何处理。
 *
 * 优先级 0 —— 宿主想做"先清洗再 hydrate"只需注册一个 priority>0 的同名/同扩展
 * 转换器，自然覆盖。
 */
export const markdownPassthrough: Converter = {
  name: 'markdown-passthrough',
  version: '1',
  priority: 0,
  extensions: ['.md', '.markdown'],
  async convert({ bytes }) {
    return { content: bytes.toString('utf8') };
  },
};
