import { simpleParser, type AddressObject } from 'mailparser';
import TurndownService from 'turndown';
import type { Converter, ConvertMeta } from '../types.js';

/**
 * `.eml` 转换器：用 mailparser 解 MIME，输出"邮件元数据 + 正文 markdown"。
 *
 * 输出形状（hydrator 看到的就是这一坨）：
 *
 *   **From:** Alice <a@x>
 *   **To:** Bob <b@y>, Carol <c@z>
 *   **Cc:** ...
 *   **Subject:** ...
 *   **Date:** 2026-05-15T10:00:00.000Z
 *
 *   ---
 *
 *   <正文 markdown>
 *
 *   (附件清单 N 项)：
 *   - report.pdf · 12 KB
 *   - logo.png · 3 KB
 *
 * 正文优先级：
 *   1. HTML part（`parsed.html`）—— 用 turndown 转 md（与 .html 同款配置）
 *      注意：HTML-only 邮件，mailparser 会自动用 html-to-text 派生一份 `parsed.text`，
 *      但那个库把 <h1> 渲成大写无前缀、列表丢符号，对 LLM 不友好；turndown 输出
 *      规范的 markdown 才是 hydrator 想要的形态。所以 HTML 在则总走 turndown。
 *   2. 没有 HTML 但有 plaintext（`parsed.text`）—— 直接用（纯文本邮件本来就是干净的）
 *   3. 都没有 —— 返回空正文，让 EmptyConversionError 在上游打 dead，避免空 entry
 *
 * 附件：v1 只列**清单**（filename + size），不抽内容也不外存
 *   - 抽 PDF 附件得递归走 pdf-parse，组合下还要回写另一个 entry，复杂度高
 *   - 实际场景里"邮件本身的话术 + 附件文件名" 90% 已经够搜索定位
 *   - 真要全文挖，把对应附件保存出来再单独 ingest 它即可
 *
 * 不处理：
 *   - 加密邮件（S/MIME / PGP）：mailparser 不解密；密文部分会被丢
 *   - .mbox / .pst 这种容器格式：本转换器只吃单封 .eml
 *   - inline 图片：HTML→md 时 turndown 会保留 <img src="cid:...">，对 LLM 无用但
 *     无害，懒得清；想清的话宿主可以注册一个 priority>0 的 eml 覆盖
 */

interface MailparserAddress {
  name?: string;
  address?: string;
}

/** 把 mailparser 的 AddressObject（单个或数组）压成一个显示串。 */
function formatAddresses(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  const arr = Array.isArray(addr) ? addr : [addr];
  const parts: string[] = [];
  for (const a of arr) {
    // mailparser 把每个 header 解析成 { value: [{name, address}], text, html }
    // 优先用 a.text（mailparser 已经格式化好）；不行 fallback 拼 value 数组。
    if (a.text && a.text.trim()) {
      parts.push(a.text.trim());
      continue;
    }
    const v = a.value as MailparserAddress[] | undefined;
    if (v && Array.isArray(v)) {
      for (const one of v) {
        if (one.name && one.address) parts.push(`${one.name} <${one.address}>`);
        else if (one.address) parts.push(one.address);
        else if (one.name) parts.push(one.name);
      }
    }
  }
  return parts.join(', ');
}

/**
 * 邮件正文 HTML 转 markdown 之前先做一遍噪声清洗。
 *
 * 为什么必须做：Outlook / Foxmail 这类客户端发的邮件 HTML 体积巨大但信号极低。
 * 一封 200 字的"放假通知"经常带 1.6MB 的 `<style>` 块（@font-face / p.MsoNormal /
 * mso-* 全家桶）和嵌入 base64 的 inline 图。turndown 不识别这些非文本元素，
 * 会原样保留进 markdown——最后喂给 LLM 触发 context window 爆掉。
 *
 * 清洗清单（按收益排）：
 *   1. `<style>` / `<script>` 整块剥掉 —— 邮件正文里的 mso CSS 是体积大头
 *   2. `<!-- ... -->` 注释 —— Outlook 常把样式包在注释里防老客户端崩
 *   3. `<head>...</head>` 整块剥 —— meta / link / 注释样式集中地
 *   4. data:image base64 URL —— 一张内嵌图能顶几百 KB，且 LLM 看不懂二进制
 *   5. `<o:p>` `<v:*>` 这类 Office 专有命名空间标签
 *
 * 不做（保守）：
 *   - style="" 属性内联值：去掉无害但回归风险高（个别邮件靠 style 表达加粗等
 *     语义），且大头不在这里——剥完 <style> 之后剩下的体积通常已经能塞下了
 *   - <img src="cid:..."> inline 图引用：保留无害，turndown 会渲成 ![](cid:xxx)
 *     LLM 能识别为图片占位，比硬删更有意义
 */
function preprocessHtml(html: string): string {
  return (
    html
      // 1+2+3：注释、style、script、head（注意 [\s\S] 跨行；DOTALL 等价）
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      // 4：data:image/...;base64,... 长 URL（出现在 src= 或 background= 里）
      //    用 [base64 image stripped] 替换，保留语义占位
      .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\s]+/gi, '[base64 image stripped]')
      // 5：Office 专有命名空间标签（<o:p>、<v:shape>、<w:WordDocument> 等）
      //    匹配 `<前缀:标签 ...>` 和闭合 `</前缀:标签>`
      .replace(/<\/?[a-z]+:[a-z][a-z0-9-]*\b[^>]*>/gi, '')
  );
}

function htmlToMarkdown(html: string): string {
  const cleaned = preprocessHtml(html);
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '*',
    codeBlockStyle: 'fenced',
  });
  return td.turndown(cleaned);
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const emlMailparserConverter: Converter = {
  name: 'eml-mailparser',
  version: '1',
  priority: 0,
  extensions: ['.eml'],
  async convert({ bytes }) {
    const parsed = await simpleParser(bytes);

    // ── 元数据头 ──
    const headerLines: string[] = [];
    const from = formatAddresses(parsed.from);
    const to = formatAddresses(parsed.to);
    const cc = formatAddresses(parsed.cc);
    const subject = parsed.subject ?? '';
    const date = parsed.date ? parsed.date.toISOString() : '';

    if (from) headerLines.push(`**From:** ${from}`);
    if (to) headerLines.push(`**To:** ${to}`);
    if (cc) headerLines.push(`**Cc:** ${cc}`);
    if (subject) headerLines.push(`**Subject:** ${subject}`);
    if (date) headerLines.push(`**Date:** ${date}`);

    // ── 正文 ──
    // HTML 优先：mailparser 给 HTML-only 邮件自动派生 parsed.text（html-to-text 库），
    // 但那个版本对 LLM 不友好（heading 渲成全大写、列表丢符号），turndown 才能
    // 产出规范 markdown。所以只要有 HTML 就走 turndown；没 HTML 再退回 plaintext。
    let body = '';
    if (parsed.html && typeof parsed.html === 'string' && parsed.html.trim()) {
      body = htmlToMarkdown(parsed.html).trim();
    } else if (parsed.text && parsed.text.trim()) {
      body = parsed.text.trim();
    }

    // ── 附件清单（仅列表，不抽内容）──
    const attachmentLines: string[] = [];
    const attachments = parsed.attachments ?? [];
    if (attachments.length > 0) {
      attachmentLines.push('');
      attachmentLines.push(`**Attachments (${attachments.length}):**`);
      for (const a of attachments) {
        const name = a.filename || a.contentType || '(unnamed)';
        attachmentLines.push(`- ${name} · ${formatBytes(a.size)}`);
      }
    }

    // ── 拼装 ──
    const sections: string[] = [];
    if (headerLines.length > 0) sections.push(headerLines.join('\n'));
    if (body) sections.push(body);
    if (attachmentLines.length > 0) sections.push(attachmentLines.join('\n').trim());
    const content = sections.join('\n\n---\n\n');

    const meta: ConvertMeta = {};
    if (subject) meta.title = subject;
    if (attachments.length > 0) meta.attachmentCount = attachments.length;
    if (date) meta.sentAt = date;

    return { content, meta };
  },
};
