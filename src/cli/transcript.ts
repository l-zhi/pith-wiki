import fs from 'node:fs';
import path from 'node:path';

/**
 * 一个 REPL session 一份 markdown transcript。
 *
 * 写入策略：
 *   - 文件名 = 启动时间戳（ISO，冒号/小数点替成 -），保证不同 session 不会撞名
 *   - 每条事件 append 一段 markdown，分隔符为 `---`
 *   - 用 `appendFileSync` 同步落盘，REPL 异常退出也不丢内容
 *   - 写失败时只 console.warn 一次再静默——transcript 是辅助记录，不该把主流程拖崩
 */

export interface TranscriptHeader {
  model: string;
  workspaceRoot: string;
  wikiRoot: string;
  startedAt: string;
}

export class TranscriptLogger {
  private failed = false;

  constructor(public readonly filePath: string) {}

  /**
   * 在文件开头写一次会话头。如果文件已存在（不太可能，但理论上时间戳碰撞）
   * 就直接 append；md 结构上仍可读。
   */
  writeHeader(header: TranscriptHeader): void {
    const lines = [
      `# Chat Session ${header.startedAt}`,
      '',
      `- model: \`${header.model}\``,
      `- workspaceRoot: \`${header.workspaceRoot}\``,
      `- wikiRoot: \`${header.wikiRoot}\``,
      '',
      '---',
      '',
    ];
    this.write(lines.join('\n'));
  }

  recordUser(text: string): void {
    this.write(`\n## 🧑 User · ${nowIso()}\n\n${escapeBody(text)}\n`);
  }

  recordAssistant(text: string): void {
    this.write(`\n## 🤖 Assistant · ${nowIso()}\n\n${escapeBody(text)}\n`);
  }

  /**
   * 思考过程。终端默认只留一行降权标记，完整内容靠这里落盘追溯。
   * source 标明来自 reasoning 字段、`<think>` 标签或委托型 agent。
   */
  recordThinking(text: string, source: string): void {
    this.write(
      `\n### 💭 Thinking (${source}) · ${nowIso()}\n\n\`\`\`\n${fencedBody(text)}\n\`\`\`\n`,
    );
  }

  recordToolCall(name: string, args: unknown): void {
    const json = safeStringify(args);
    this.write(`\n### → tool: ${name} · ${nowIso()}\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  }

  recordToolResult(name: string, ok: boolean, preview: string): void {
    const marker = ok ? '✓' : '✗';
    this.write(`\n### ${marker} tool result: ${name}\n\n\`\`\`\n${preview}\n\`\`\`\n`);
  }

  recordError(msg: string): void {
    this.write(`\n## ⚠ Error · ${nowIso()}\n\n\`\`\`\n${msg}\n\`\`\`\n`);
  }

  recordSystem(text: string): void {
    this.write(`\n> ${nowIso()} · ${text.replace(/\n/g, ' ')}\n`);
  }

  /** 在用户回合结束之后写一条分隔线，让 transcript 在视觉上一段一段。 */
  endTurn(): void {
    this.write('\n---\n');
  }

  private write(chunk: string): void {
    if (this.failed) return;
    try {
      fs.appendFileSync(this.filePath, chunk, 'utf8');
    } catch (err) {
      this.failed = true;
      // 不打 console.error 进 REPL（会跟 Ink 渲染打架），写到 stderr 一次足够
      process.stderr.write(
        `transcript write failed (${this.filePath}): ${(err as Error).message}\n`,
      );
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * markdown 安全转义：
 *   - 把内容里的 ``` 替换成 \`\`\`，避免提前关闭代码块
 *   - 文本本身不强制 fenced code，user / assistant 段就让它当普通 markdown 渲染
 */
function escapeBody(text: string): string {
  return text.replace(/```/g, '\\`\\`\\`');
}

/** 放进 ``` fenced code 块的内容：把内部的 ``` 转义，避免提前关闭代码块。 */
function fencedBody(text: string): string {
  return text.replace(/```/g, '\\`\\`\\`');
}

/**
 * 给一个 outputDir 派生唯一 transcript 路径：`<outputDir>/<sessionId>.md`。
 * sessionId = ISO timestamp，冒号 / 小数点替成 -，保证文件名合法。
 */
export function deriveTranscriptPath(outputDir: string, startedAt: Date = new Date()): string {
  const sessionId = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(outputDir, `${sessionId}.md`);
}
