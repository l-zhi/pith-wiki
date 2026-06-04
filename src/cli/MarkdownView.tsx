import React from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import terminalLink from 'terminal-link';
import { visualWidth, vpad, vpadStart } from './dashboardData.js';
import { C } from './theme.js';

/**
 * 把 LLM 回复正文的 Markdown 渲染成终端友好的 Ink 节点——去掉裸符号，
 * 标题/强调着色、列表/引用块、对齐表格、可点击链接。
 *
 * 设计要点：
 *   - 只解析「一段已完整到达的字符串」（assistant final body），无流式增量重绘。
 *   - 用 marked 词法（`marked.lexer`）拿 token 树，自己映射成 <Box>/<Text>，
 *     不引第三方终端渲染器，颜色/表格/链接完全可控。
 *   - 代码块：暗灰纯文本，去围栏，不做语法高亮。
 *   - 链接：terminal-link 输出 OSC 8 超链接，不支持的终端自动回退「文字 (url)」。
 *   - 表格：复用 dashboardData 的 CJK 宽度助手做列对齐 + 表头分隔线，无边框。
 *   - 配色：复用 theme.ts 的 Dashboard 调色板。
 *
 * 健壮性：整个 `renderMarkdown` 包在 try/catch；任何解析/映射异常都返回
 * undefined——调用方（ChatView）随即回退到原始 `<Text>{text}</Text>`，正文不丢、UI 不崩。
 */

/** 标题按层级取色：h1 青 / h2 绿 / h3 琥珀 / 更深紫。 */
function headingColor(depth: number): string {
  switch (depth) {
    case 1:
      return C.cyan;
    case 2:
      return C.green;
    case 3:
      return C.amber;
    default:
      return C.purple;
  }
}

/** 抽取 inline token 的可见纯文本（去样式），给表格列宽计算用。 */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += (t as Tokens.Text).tokens
          ? plainText((t as Tokens.Text).tokens)
          : (t as Tokens.Text).text;
        break;
      case 'codespan':
        out += (t as Tokens.Codespan).text;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out +=
          plainText((t as Tokens.Strong | Tokens.Em | Tokens.Del | Tokens.Link).tokens) ||
          (t as { text?: string }).text ||
          '';
        break;
      case 'br':
        out += ' ';
        break;
      default:
        out += (t as { text?: string }).text ?? '';
    }
  }
  return out;
}

/** 行内 token → Ink 节点（递归）。返回可直接塞进 <Text> 的子节点数组。 */
function renderInline(tokens: Token[] | undefined, key: string): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'text': {
        const tok = t as Tokens.Text;
        return tok.tokens ? (
          <Text key={k}>{renderInline(tok.tokens, k)}</Text>
        ) : (
          tok.text
        );
      }
      case 'strong':
        return (
          <Text key={k} bold>
            {renderInline((t as Tokens.Strong).tokens, k)}
          </Text>
        );
      case 'em':
        return (
          <Text key={k} italic>
            {renderInline((t as Tokens.Em).tokens, k)}
          </Text>
        );
      case 'del':
        return (
          <Text key={k} strikethrough dimColor>
            {renderInline((t as Tokens.Del).tokens, k)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={k} color={C.amber}>
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case 'link': {
        const tok = t as Tokens.Link;
        const label = plainText(tok.tokens) || tok.text;
        return (
          <Text key={k} color={C.cyan} underline>
            {terminalLink(label, tok.href)}
          </Text>
        );
      }
      case 'br':
        return '\n';
      case 'escape':
        return (t as Tokens.Escape).text;
      default:
        return (t as { text?: string }).text ?? '';
    }
  });
}

/** 表格：用可见纯文本做列对齐（CJK 宽度感知），表头着色 + 暗色分隔线。 */
function renderTable(t: Tokens.Table, key: string): React.ReactNode {
  const headerCells = t.header.map((c) => plainText(c.tokens));
  const bodyRows = t.rows.map((row) => row.map((c) => plainText(c.tokens)));
  const ncols = headerCells.length;

  const colW: number[] = [];
  for (let c = 0; c < ncols; c++) {
    let w = visualWidth(headerCells[c] ?? '');
    for (const row of bodyRows) w = Math.max(w, visualWidth(row[c] ?? ''));
    colW[c] = w;
  }

  const padCell = (s: string, c: number): string =>
    t.align[c] === 'right' ? vpadStart(s, colW[c]) : vpad(s, colW[c]);

  const headerLine = headerCells.map((s, c) => padCell(s, c)).join('  ');
  const totalW = colW.reduce((a, b) => a + b, 0) + 2 * Math.max(0, ncols - 1);
  const sep = '─'.repeat(totalW);

  return (
    <Box key={key} flexDirection="column">
      <Text bold color={C.cyan}>
        {headerLine}
      </Text>
      <Text dimColor>{sep}</Text>
      {bodyRows.map((row, r) => (
        <Text key={`${key}.r${r}`}>{row.map((s, c) => padCell(s, c)).join('  ')}</Text>
      ))}
    </Box>
  );
}

/** 列表项：前缀 bullet/序号，项内行内递归，嵌套列表缩进递归。 */
function renderListItem(
  item: Tokens.ListItem,
  bullet: string,
  key: string,
): React.ReactNode {
  const inlineParts: React.ReactNode[] = [];
  const blockParts: React.ReactNode[] = [];
  for (let i = 0; i < item.tokens.length; i++) {
    const tok = item.tokens[i];
    if (tok.type === 'text') {
      const tt = tok as Tokens.Text;
      if (tt.tokens) inlineParts.push(...renderInline(tt.tokens, `${key}.t${i}`));
      else inlineParts.push(tt.text);
    } else if (tok.type === 'list') {
      blockParts.push(renderList(tok as Tokens.List, `${key}.l${i}`));
    } else {
      blockParts.push(...renderBlocks([tok], `${key}.b${i}`));
    }
  }
  return (
    <Box key={key} flexDirection="column">
      <Box>
        <Text color={C.purple}>{bullet} </Text>
        <Text>{inlineParts}</Text>
      </Box>
      {blockParts.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {blockParts}
        </Box>
      ) : null}
    </Box>
  );
}

function renderList(t: Tokens.List, key: string): React.ReactNode {
  const start = typeof t.start === 'number' ? t.start : 1;
  return (
    <Box key={key} flexDirection="column">
      {t.items.map((item, i) => {
        const bullet = t.ordered ? `${start + i}.` : '•';
        return renderListItem(item, bullet, `${key}.i${i}`);
      })}
    </Box>
  );
}

/** 块级 token → Ink 节点数组（过滤 space）。 */
function renderBlocks(tokens: Token[], key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'space':
        continue;
      case 'heading': {
        const tok = t as Tokens.Heading;
        out.push(
          <Text key={k} bold color={headingColor(tok.depth)}>
            {renderInline(tok.tokens, k)}
          </Text>,
        );
        break;
      }
      case 'paragraph':
        out.push(<Text key={k}>{renderInline((t as Tokens.Paragraph).tokens, k)}</Text>);
        break;
      case 'text': {
        const tok = t as Tokens.Text;
        out.push(
          <Text key={k}>
            {tok.tokens ? renderInline(tok.tokens, k) : tok.text}
          </Text>,
        );
        break;
      }
      case 'list':
        out.push(renderList(t as Tokens.List, k));
        break;
      case 'blockquote': {
        const tok = t as Tokens.Blockquote;
        // 行内内容（paragraph/text）渲染成暗色斜体；其余块（嵌套列表/代码等）正常递归。
        // 不把块级 <Box> 塞进 <Text>——Ink 不允许 Box 作为 Text 的子节点。
        const inner: React.ReactNode[] = [];
        for (let j = 0; j < tok.tokens.length; j++) {
          const inq = tok.tokens[j];
          if (inq.type === 'paragraph' || inq.type === 'text') {
            const its = (inq as Tokens.Paragraph | Tokens.Text).tokens;
            inner.push(
              <Text key={`${k}.q${j}`} dimColor italic>
                {its ? renderInline(its, `${k}.q${j}`) : (inq as Tokens.Text).text}
              </Text>,
            );
          } else if (inq.type !== 'space') {
            inner.push(...renderBlocks([inq], `${k}.q${j}`));
          }
        }
        out.push(
          <Box
            key={k}
            borderStyle="single"
            borderColor={C.purple}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            paddingLeft={1}
            flexDirection="column"
          >
            {inner}
          </Box>,
        );
        break;
      }
      case 'code':
        out.push(
          <Box key={k} paddingLeft={1} flexDirection="column">
            <Text color="gray">{(t as Tokens.Code).text}</Text>
          </Box>,
        );
        break;
      case 'table':
        out.push(renderTable(t as Tokens.Table, k));
        break;
      case 'hr': {
        const width = process.stdout.columns ? Math.min(process.stdout.columns - 1, 80) : 40;
        out.push(
          <Text key={k} dimColor>
            {'─'.repeat(width)}
          </Text>,
        );
        break;
      }
      default:
        out.push(<Text key={k}>{(t as { text?: string }).text ?? ''}</Text>);
    }
  }
  return out;
}

/**
 * 解析并渲染 Markdown 正文为 Ink 节点。
 * 失败（解析/映射异常）返回 undefined，调用方回退原始文本。
 */
export function renderMarkdown(text: string): React.ReactNode | undefined {
  try {
    const tokens = marked.lexer(text);
    const blocks = renderBlocks(tokens, 'md');
    if (blocks.length === 0) return undefined;
    return (
      <Box flexDirection="column">
        {blocks.map((node, i) => (
          <Box key={`blk.${i}`} marginTop={i === 0 ? 0 : 1}>
            {node}
          </Box>
        ))}
      </Box>
    );
  } catch {
    return undefined;
  }
}
