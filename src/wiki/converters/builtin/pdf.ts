import { PDFParse } from 'pdf-parse';
import type { Converter } from '../types.js';

/**
 * `.pdf` 转换器：用 pdf-parse v2 抽取文字。
 *
 * 实现要点：
 *   - pdf-parse 的 `data` 接受 TypedArray —— 我们把 Buffer 转成 Uint8Array 喂进去
 *   - 提取每页 text，用空行连起来；最终内容 = 全文档文本（hydrator 自己再压缩）
 *   - meta.pages 记录页数；invalid PDF 会让 pdf-parse 抛错，processJob 当失败处理
 *   - 显式调用 `destroy()` 释放底层 worker 句柄，避免 Node 进程因 pdfjs 残留 keep-alive
 *
 * 不做的事（v1 之外）：
 *   - 扫描 PDF 的 OCR：等真有需求再单独写一个 priority 更高的 `pdf-ocr` 转换器覆盖
 *   - 提取图像/表格：pdf-parse 支持 getImage/getTable，但喂给 LLM 用文字就够
 */
export const pdfParseConverter: Converter = {
  name: 'pdf-parse',
  version: '1',
  priority: 0,
  extensions: ['.pdf'],
  async convert({ bytes }) {
    // 转成 Uint8Array：pdfjs 内部会把数据 transfer 到 worker，传共享 Buffer
    // 可能在某些版本 Node 引发问题
    const data = new Uint8Array(bytes);
    const parser = new PDFParse({ data });
    try {
      const text = await parser.getText();
      // 多页之间补换行，让 hydrator 看到清晰的页边界
      const pageTexts = text.pages.map((p) => p.text).filter((t) => t && t.trim().length > 0);
      const content = pageTexts.length > 0 ? pageTexts.join('\n\n') : (text.text ?? '');
      return {
        content,
        meta: {
          pages: text.total,
        },
      };
    } finally {
      // 不 await：destroy 内部用 worker.terminate 之类的异步流程，但
      // 即使没结束也不影响主流程的正确性（worker 进程会被自然回收）
      void parser.destroy();
    }
  },
};
