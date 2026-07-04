import type { AgentLike } from './sessionManager.js';

/**
 * ReviewingAgent —— 「写手 + 审稿人」双 agent 写作流程,自身实现 AgentLike,
 * 所以对 SessionManager 完全透明(AgentFactory 在审稿模式下返回它即可,会话管道不用改)。
 *
 * 一轮 send() 的闭环:
 *   1. writer 产出草稿(正常流式给 UI)
 *   2. reviewer(独立上下文,每轮 reset)对着 rubric 审:输出首行 `VERDICT: PASS|REVISE` + 意见
 *   3. REVISE → 把意见塞回 writer 让它改;PASS 或达 maxRounds → 定稿
 *
 * 记忆边界(见对话设计):
 *   - writer / reviewer 是两个独立实例,**不共享上下文**;只靠"草稿↔意见"这一进一出通信。
 *   - reviewer 每轮 reset(),保持客观(不给自己点赞)。
 *   - **持久化/回放**用 ReviewingAgent 自己的 cleanHistory(只留 [输入, 最终稿]),
 *     writer 内部那些修订轮不进会话历史。writer 的续接由它自身管理(不去动它的 history——
 *     ClaudeCodeAgent 靠 --resume,重挂 history 会切断续接)。
 *   - 审稿轨迹(每轮草稿+意见)经 traceSink 落到独立文件(transcript),不污染会话。
 */

type Msg = { role: 'user' | 'assistant'; content: string };

type SendOpts = Parameters<AgentLike['send']>[1];
type Events = NonNullable<SendOpts['events']>;

export interface ReviewRound {
  /** 第几轮(1-based)。 */
  round: number;
  verdict: 'PASS' | 'REVISE';
  /** 审稿意见(REVISE 时的问题清单;PASS 时可为空)。 */
  issues: string;
  /** 本轮被审的草稿。 */
  draft: string;
}

export interface ReviewTrace {
  task: string;
  rounds: ReviewRound[];
  finalDraft: string;
  /** 是否在达到 maxRounds 后仍未通过(定稿是"尽力而为"的最后一版)。 */
  exhausted: boolean;
}

export interface ReviewingAgentOptions {
  writer: AgentLike;
  reviewer: AgentLike;
  /** 最大打回轮次;到顶仍未过则返回最后一版。默认 2。 */
  maxRounds?: number;
  /** 审核标准(REVIEW.md 内容);空则用内置默认 rubric。 */
  rubric?: string;
  /** 审稿轨迹落点(做法 B:写 transcript);不传则不留痕。 */
  traceSink?: (trace: ReviewTrace) => void;
  /** 把审稿进展(打回/通过)发给 UI 的事件回调(经 SessionManager 的 emit 流出)。 */
  onReviewEvent?: (e: { round: number; verdict: 'PASS' | 'REVISE'; issues: string }) => void;
}

/** 审稿人无自定义 rubric 时的兜底标准。 */
export const DEFAULT_RUBRIC = [
  '- 结论明确:先给结论/推荐,不含糊、不骑墙',
  '- 契合任务:确实回答了用户的诉求,没有跑题或遗漏关键点',
  '- 有据可依:关键论断有依据,不编造事实、不虚构来源',
  '- 结构清晰:该分点/分段的地方分点,便于阅读',
  '- 无明显冗余、重复、自相矛盾',
].join('\n');

const VERDICT_RE = /^\s*VERDICT:\s*(PASS|REVISE)\b/im;

/**
 * 解析审稿人的裁决。首行(或任意行)`VERDICT: PASS|REVISE` 为准;
 * 找不到标记 → 保守判 PASS(fail-open:不因审稿人跑格式而无谓打回;maxRounds 也兜底)。
 * issues = 去掉 VERDICT 行后的正文(修订依据)。
 */
export function parseVerdict(text: string): { pass: boolean; issues: string } {
  const m = VERDICT_RE.exec(text);
  const pass = m ? m[1].toUpperCase() === 'PASS' : true;
  const issues = text.replace(VERDICT_RE, '').trim();
  return { pass, issues };
}

export function buildReviewPrompt(task: string, draft: string, rubric: string): string {
  return [
    '你是严格的审稿人。对照下面的审核标准评审这份草稿,判断它能否作为对用户任务的最终答复。',
    '',
    '## 审核标准',
    rubric.trim() || DEFAULT_RUBRIC,
    '',
    '## 用户任务',
    task,
    '',
    '## 待审草稿',
    draft,
    '',
    '## 输出格式(务必遵守)',
    '第一行必须是 `VERDICT: PASS` 或 `VERDICT: REVISE`。',
    'PASS = 草稿达标可交付;REVISE = 需返工。',
    'REVISE 时,在第二行起逐条列出**具体、可执行**的修改点(指出问题 + 怎么改),不要泛泛而谈。',
  ].join('\n');
}

export function buildRevisePrompt(issues: string): string {
  return [
    '审稿人认为上一版未达标,需按以下意见修订后重新给出**完整**的最终稿(不要只描述改了什么):',
    '',
    issues,
  ].join('\n');
}

export class ReviewingAgent implements AgentLike {
  private cleanHistory: Msg[] = [];
  private readonly maxRounds: number;

  constructor(private readonly opts: ReviewingAgentOptions) {
    this.maxRounds = Math.max(1, opts.maxRounds ?? 2);
  }

  async send(text: string, opts: SendOpts = {}): Promise<string> {
    const events = opts.events ?? {};
    // 包装 writer 的事件:修订轮里绝不发 final:true(否则 UI 会误以为定稿),
    // 真正的 final 由本类在循环结束后统一发。thinking/tool/usage 原样透传。
    const writerEvents: Events = {
      onThinking: events.onThinking,
      onToolRound: events.onToolRound,
      onUsage: events.onUsage,
      onAssistantText: (e) => events.onAssistantText?.({ text: e.text, final: false }),
    };
    const writerOpts: SendOpts = { signal: opts.signal, scope: opts.scope, events: writerEvents };

    let draft = await this.opts.writer.send(text, writerOpts);
    const rounds: ReviewRound[] = [];
    let exhausted = false;

    for (let round = 1; round <= this.maxRounds; round++) {
      this.opts.reviewer.reset?.();
      const rubric = this.opts.rubric ?? '';
      const verdictText = await this.opts.reviewer.send(
        buildReviewPrompt(text, draft, rubric),
        { signal: opts.signal },
      );
      const { pass, issues } = parseVerdict(verdictText);
      rounds.push({ round, verdict: pass ? 'PASS' : 'REVISE', issues, draft });
      this.opts.onReviewEvent?.({ round, verdict: pass ? 'PASS' : 'REVISE', issues });
      events.onToolRound?.({
        name: 'review',
        args: { round },
        ok: pass,
        preview: pass ? `第${round}轮:通过` : `第${round}轮:打回 — ${issues.slice(0, 200)}`,
      });
      if (pass) break;
      if (round === this.maxRounds) {
        exhausted = true;
        break;
      }
      draft = await this.opts.writer.send(buildRevisePrompt(issues), writerOpts);
    }

    // 收尾:发真正的 final;记干净历史(只 [输入, 最终稿]);留痕到 transcript(做法 B)。
    events.onAssistantText?.({ text: draft, final: true });
    this.cleanHistory.push({ role: 'user', content: text }, { role: 'assistant', content: draft });
    this.opts.traceSink?.({ task: text, rounds, finalDraft: draft, exhausted });
    return draft;
  }

  exportHistory(): unknown[] {
    return this.cleanHistory.map((m) => ({ ...m }));
  }

  restoreHistory(messages: unknown[]): void {
    this.cleanHistory = (messages as Msg[])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content ?? '') }));
    // 让 writer 也带上这段干净历史继续对话(pith Agent 会重挂;claude-code 恢复本就
    // 重开 CC session——与现状一致)。
    this.opts.writer.restoreHistory(this.cleanHistory.map((m) => ({ ...m })));
  }

  reset(): void {
    this.cleanHistory = [];
    this.opts.writer.reset?.();
    this.opts.reviewer.reset?.();
  }

  snapshot(): string {
    return this.cleanHistory.map((m) => `**${m.role}**: ${m.content}`).join('\n\n');
  }
}
