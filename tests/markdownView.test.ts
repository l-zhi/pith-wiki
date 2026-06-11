import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { renderMarkdown } from '../src/cli/MarkdownView.js';

/** 渲染 markdown 并返回最终终端帧（含 ANSI 着色码，但不含 markdown 字面符号）。 */
function frame(md: string): string {
  const node = renderMarkdown(md);
  if (node === undefined) return '';
  const { lastFrame } = render(node as React.ReactElement);
  return lastFrame() ?? '';
}

describe('renderMarkdown', () => {
  it('去掉裸 markdown 符号，保留可见文本', () => {
    const md = [
      '# 标题一',
      '',
      '一段含 **粗体** 和 *斜体* 与 `code` 的话。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用一句',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const out = frame(md);

    // 字面符号被吃掉
    expect(out).not.toContain('**');
    expect(out).not.toContain('```');
    expect(out).not.toMatch(/^#\s/m);
    expect(out).not.toMatch(/^-\s/m);

    // 可见文本保留
    expect(out).toContain('标题一');
    expect(out).toContain('粗体');
    expect(out).toContain('斜体');
    expect(out).toContain('code');
    expect(out).toContain('第一项');
    expect(out).toContain('引用一句');
    expect(out).toContain('const x = 1;');
    // 无序列表渲染成 • bullet
    expect(out).toContain('•');
  });

  it('表格对齐渲染，去掉竖线分隔符', () => {
    const md = ['| 名称 | 值 |', '|---|---|', '| alpha | 1 |', '| 长名称 | 2 |'].join('\n');
    const out = frame(md);

    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
    expect(out).toContain('名称');
    expect(out).toContain('alpha');
    expect(out).toContain('长名称');
    // 表头下有一条 ─ 分隔线
    expect(out).toContain('─');
  });

  it('链接：不支持 OSC 8 的环境回退显 URL', () => {
    // 测试环境 stdout 非 TTY → terminal-link 回退「文字 (url)」
    const out = frame('see [docs](https://example.com/x) here');
    expect(out).not.toContain('](');
    expect(out).toContain('docs');
    expect(out).toContain('https://example.com/x');
  });

  it('相对链接（无 scheme）不渲染成超链接，避免终端补成坏 http://', () => {
    const out = frame('see [output/report.html](output/report.html) here');
    // 不应出现 http:// 前缀（terminal-link 会给无 scheme 的 href 补 http://）
    expect(out).not.toContain('http://');
    expect(out).toContain('output/report.html');
  });

  it('file:// 链接正常渲染（有 scheme）', () => {
    const out = frame('open [report](file:///Users/me/.pith-wiki/wiki-data/output/r.html)');
    expect(out).toContain('file:///Users/me/.pith-wiki/wiki-data/output/r.html');
  });

  it('空输入返回 undefined（调用方回退原文）', () => {
    expect(renderMarkdown('')).toBeUndefined();
    expect(renderMarkdown('   \n  ')).toBeUndefined();
  });

  it('残缺 markdown 不抛异常', () => {
    // 未闭合围栏 / 坏表格：marked 宽容解析，renderMarkdown 不应 throw
    expect(() => renderMarkdown('```ts\nconst x =')).not.toThrow();
    expect(() => renderMarkdown('| a | b\n|--')).not.toThrow();
    expect(() => renderMarkdown('**未闭合 *嵌套')).not.toThrow();
  });
});
