import path from 'node:path';
import { ScheduledOutputArchive, type ScheduledOutputContext } from '@core/schedule/output.js';
import type { LibraryService } from '@core/wiki/library.js';
import { artifactPath, type AgentLike } from './sessionManager.js';

/** 归档在审稿完成后执行，覆盖内置 Agent 与委托 CLI；不让 UI 提前收到失效的文件链接。 */
export class ScheduledOutputAgent implements AgentLike {
  private readonly replacements = new Map<string, string>();
  private readonly finalTexts = new Map<number, string>();

  constructor(
    private readonly agent: AgentLike,
    private readonly library: LibraryService,
    private readonly context: ScheduledOutputContext,
  ) {}

  async send(text: string, opts: Parameters<AgentLike['send']>[1]): Promise<string> {
    const archive = new ScheduledOutputArchive(this.library, this.context);
    const written: string[] = [];
    const reply = await this.agent.send(text, {
      ...opts,
      events: {
        ...opts.events,
        onAssistantText: (event) => {
          if (!event.final) opts.events?.onAssistantText?.(event);
        },
        onToolRound: (event) => {
          if (event.ok) {
            const file = artifactPath(event.name, event.args, archive.outputRoot, this.context);
            if (file) written.push(file);
          }
          opts.events?.onToolRound?.(event);
        },
      },
    });
    const outputs = archive.finish(reply, written);
    for (const [from, to] of outputs.moved) this.replacements.set(from, to);
    let final = this.replacePaths(reply);
    const unlinked = outputs.paths.filter(
      (file) => !final.includes(file) && !final.includes(encodeURI(file)),
    );
    if (unlinked.length)
      final +=
        '\n\n已归档：\n' +
        unlinked.map((file) => `- [${path.basename(file)}](<${file}>)`).join('\n');
    const history = this.agent.exportHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      if ((history[i] as { role?: string }).role === 'assistant') {
        this.finalTexts.set(i, final);
        break;
      }
    }
    for (const file of outputs.paths)
      opts.events?.onToolRound?.({
        name: 'write_file',
        args: { path: file },
        ok: true,
        preview: file.endsWith('.md') ? '已归档并加入 Wiki 索引' : '已归档附件',
      });
    opts.events?.onAssistantText?.({ text: final, final: true });
    return final;
  }

  exportHistory(): unknown[] {
    return structuredClone(this.agent.exportHistory()).map((message, i) => {
      const m = message as { role?: string; content?: unknown };
      if (m.role === 'assistant' && this.finalTexts.has(i)) m.content = this.finalTexts.get(i)!;
      else if (m.role === 'assistant' && typeof m.content === 'string')
        m.content = this.replacePaths(m.content);
      return message;
    });
  }

  restoreHistory(messages: unknown[]): void {
    this.finalTexts.clear();
    this.replacements.clear();
    this.agent.restoreHistory(messages);
  }

  reset(): void {
    this.finalTexts.clear();
    this.replacements.clear();
    this.agent.reset?.();
  }

  snapshot(): string {
    return this.replacePaths(this.agent.snapshot?.() ?? '');
  }

  private replacePaths(text: string): string {
    for (const [from, to] of this.replacements) {
      text = text.split(from).join(to).split(encodeURI(from)).join(encodeURI(to));
    }
    return text;
  }
}
