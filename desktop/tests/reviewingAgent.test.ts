import { describe, expect, it, vi } from 'vitest';
import {
  ReviewingAgent,
  parseVerdict,
  buildReviewPrompt,
  DEFAULT_RUBRIC,
  type ReviewTrace,
} from '../src/engine/reviewingAgent';
import type { AgentLike } from '../src/engine/sessionManager';

/** 可编程的假 agent:按预置的响应队列逐次返回;记录收到的 send 文本。 */
class FakeAgent implements AgentLike {
  history: { role: string; content: string }[] = [];
  sent: string[] = [];
  resets = 0;
  private i = 0;
  constructor(private readonly responses: string[]) {}
  async send(text: string, opts: Parameters<AgentLike['send']>[1] = {}): Promise<string> {
    this.sent.push(text);
    const out = this.responses[Math.min(this.i, this.responses.length - 1)];
    this.i++;
    // 模拟流式:先 partial 再 final(true)——ReviewingAgent 应把 writer 的 final 降级
    opts.events?.onAssistantText?.({ text: out, final: true });
    return out;
  }
  exportHistory(): unknown[] {
    return this.history;
  }
  restoreHistory(m: unknown[]): void {
    this.history = m as { role: string; content: string }[];
  }
  reset(): void {
    // 只记录 reset 次数；不重置脚本响应指针——测试要模拟"每轮审给不同裁决"，
    // 而 reviewer 每轮都会被 reset，指针若跟着归零就永远拿第一条响应。
    this.resets++;
  }
}

describe('parseVerdict', () => {
  it('VERDICT: PASS → pass=true', () => {
    expect(parseVerdict('VERDICT: PASS\n很好').pass).toBe(true);
  });
  it('VERDICT: REVISE → pass=false，issues 去掉裁决行', () => {
    const r = parseVerdict('VERDICT: REVISE\n- 结论不清\n- 缺依据');
    expect(r.pass).toBe(false);
    expect(r.issues).toBe('- 结论不清\n- 缺依据');
  });
  it('大小写 / 前导空格容错', () => {
    expect(parseVerdict('  verdict:  pass ').pass).toBe(true);
  });
  it('没有 VERDICT 标记 → fail-open 判 PASS', () => {
    expect(parseVerdict('这看起来不错').pass).toBe(true);
  });
});

describe('buildReviewPrompt', () => {
  it('空 rubric → 用内置默认', () => {
    const p = buildReviewPrompt('任务', '草稿', '');
    expect(p).toContain(DEFAULT_RUBRIC.split('\n')[0]);
    expect(p).toContain('任务');
    expect(p).toContain('草稿');
  });
  it('自定义 rubric 被用上', () => {
    expect(buildReviewPrompt('t', 'd', '- 必须押韵')).toContain('- 必须押韵');
  });
});

describe('ReviewingAgent', () => {
  it('一次通过：writer 调 1 次，reviewer 调 1 次，无修订', async () => {
    const writer = new FakeAgent(['草稿A']);
    const reviewer = new FakeAgent(['VERDICT: PASS']);
    const a = new ReviewingAgent({ writer, reviewer });
    const out = await a.send('写点东西');
    expect(out).toBe('草稿A');
    expect(writer.sent).toEqual(['写点东西']); // 没有第二次修订
    expect(reviewer.sent.length).toBe(1);
  });

  it('打回一次后通过：writer 调 2 次（初稿+修订），第二稿是最终答案', async () => {
    const writer = new FakeAgent(['初稿', '改进稿']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\n- 结论不清', 'VERDICT: PASS']);
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 3 });
    const out = await a.send('任务');
    expect(out).toBe('改进稿');
    expect(writer.sent[0]).toBe('任务');
    expect(writer.sent[1]).toContain('结论不清'); // 修订提示带上了审稿意见
    expect(reviewer.sent.length).toBe(2);
  });

  it('一直不过：达到 maxRounds 就停，返回最后一版，标记 exhausted', async () => {
    const writer = new FakeAgent(['v1', 'v2', 'v3', 'v4']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\nx']);
    let trace: ReviewTrace | undefined;
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 2, traceSink: (t) => (trace = t) });
    const out = await a.send('任务');
    // maxRounds=2：初稿→审(打回)→改→审(打回，第2轮到顶就停)。writer 调 2 次。
    expect(writer.sent.length).toBe(2);
    expect(out).toBe('v2');
    expect(trace?.exhausted).toBe(true);
    expect(trace?.rounds.length).toBe(2);
  });

  it('reviewer 每轮 reset（独立上下文）', async () => {
    const writer = new FakeAgent(['a', 'b', 'c']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\nx', 'VERDICT: PASS']);
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 3 });
    await a.send('t');
    expect(reviewer.resets).toBe(2); // 两轮审各 reset 一次
  });

  it('折叠历史：exportHistory 只留 [输入, 最终稿]，不含修订轮', async () => {
    const writer = new FakeAgent(['初稿', '终稿']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\nx', 'VERDICT: PASS']);
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 3 });
    await a.send('我的任务');
    expect(a.exportHistory()).toEqual([
      { role: 'user', content: '我的任务' },
      { role: 'assistant', content: '终稿' },
    ]);
  });

  it('留痕：traceSink 收到每轮草稿+意见+最终稿', async () => {
    const writer = new FakeAgent(['初稿', '终稿']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\n- 加依据', 'VERDICT: PASS']);
    let trace: ReviewTrace | undefined;
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 3, traceSink: (t) => (trace = t) });
    await a.send('任务X');
    expect(trace?.task).toBe('任务X');
    expect(trace?.finalDraft).toBe('终稿');
    expect(trace?.exhausted).toBe(false);
    expect(trace?.rounds[0]).toMatchObject({ round: 1, verdict: 'REVISE', draft: '初稿' });
    expect(trace?.rounds[0].issues).toContain('加依据');
    expect(trace?.rounds[1]).toMatchObject({ round: 2, verdict: 'PASS', draft: '终稿' });
  });

  it('writer 的中途 final 被降级，只有循环结束发一次真正的 final', async () => {
    const writer = new FakeAgent(['初稿', '终稿']);
    const reviewer = new FakeAgent(['VERDICT: REVISE\nx', 'VERDICT: PASS']);
    const finals: string[] = [];
    const a = new ReviewingAgent({ writer, reviewer, maxRounds: 3 });
    await a.send('t', {
      events: {
        onAssistantText: (e) => {
          if (e.final) finals.push(e.text);
        },
      },
    });
    expect(finals).toEqual(['终稿']); // 只有最终稿被标 final
  });

  it('restoreHistory：恢复 clean 历史并回灌 writer', async () => {
    const writer = new FakeAgent(['x']);
    const reviewer = new FakeAgent(['VERDICT: PASS']);
    const a = new ReviewingAgent({ writer, reviewer });
    const restoreSpy = vi.spyOn(writer, 'restoreHistory');
    a.restoreHistory([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: '应被过滤' },
    ]);
    expect(a.exportHistory()).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(restoreSpy).toHaveBeenCalled();
  });
});
