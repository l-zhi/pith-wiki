import TurndownService from 'turndown';
import type { Converter } from '../types.js';

/**
 * `.html` / `.htm` 转换器：用 turndown 把 HTML 转 markdown。
 *
 * 配置：保留 ATX heading（`#`）、用 `*` 做 bullet、用 ``` 包代码块——
 * 与 markdown-passthrough 风格一致。
 *
 * 不处理：
 *   - 网页抓取：本转换器只吃本地字节。需要 fetch 请在外层做（比如先下载成 .html
 *     再 ingest），或者写一个自定义 url 转换器
 *   - 大量 boilerplate（导航/侧栏/页脚）：turndown 是直翻的；想做"主体抽取"
 *     可以在更高 priority 注册一个用 readability 之类的转换器覆盖
 */
export const htmlTurndownConverter: Converter = {
  name: 'html-turndown',
  version: '1',
  priority: 0,
  extensions: ['.html', '.htm'],
  async convert({ bytes }) {
    const html = bytes.toString('utf8');
    const td = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '*',
      codeBlockStyle: 'fenced',
    });
    return { content: td.turndown(html) };
  },
};
