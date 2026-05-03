import * as mammothNs from 'mammoth';
import type { Converter } from '../types.js';

/**
 * `.docx` 转换器：用 mammoth 直接产出 markdown。
 *
 * mammoth.convertToMarkdown 接受 `{ buffer: Buffer }` 或 `{ path: string }`，
 * 我们走 buffer 形式（已经在 ConvertInput 里）。
 *
 * 类型旁路：mammoth 自带的 `.d.ts` 没声明 `convertToMarkdown`（只导了
 * `convertToHtml` / `extractRawText` / `embedStyleMap` / `images`），但运行时
 * 是有的（README + 实测都有）。这里用一个最小的局部类型描述需要的形状，
 * 避免拉一个不存在的 `@types/mammoth`。
 */
interface MammothConvertResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}
const mammothExt = mammothNs as unknown as {
  convertToMarkdown(input: { buffer: Buffer }): Promise<MammothConvertResult>;
};

export const docxMammothConverter: Converter = {
  name: 'docx-mammoth',
  version: '1',
  priority: 0,
  extensions: ['.docx'],
  async convert({ bytes }) {
    const result = await mammothExt.convertToMarkdown({ buffer: bytes });
    const warnings = result.messages
      .filter((m) => m.type === 'warning' || m.type === 'error')
      .map((m) => m.message);
    return {
      content: result.value,
      meta: warnings.length > 0 ? { warnings } : undefined,
    };
  },
};
