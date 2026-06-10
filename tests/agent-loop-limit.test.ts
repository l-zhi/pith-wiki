/**
 * tool loop 触顶（maxSteps）后的兜底收尾行为：
 *   1. 模型每轮都返回 tool_call、永不收口 → 跑满 maxSteps 后，Agent 自动发起
 *      一次"不带 tools"的强制收尾请求，把那一轮的文本作为正式答案返回，
 *      并触发 onAssistantText({final:true})——绝不静默返回空串。
 *   2. 连强制收尾都返回空文本 → 抛 AgentError('model_error')，依旧不静默。
 *
 * 用最小 mock client（记录每次 create 的入参，断言收尾那次确实没带 tools）。
 */
import { describe, expect, it } from 'vitest';
import { Agent, AgentError } from '../src/llm/agent.js';

function toolCallResp(name: string, args: object) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}
function finalResp(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

/** ctx 里只放 send() 实际会碰到的字段；wiki_list 不依赖 assembler/scope。 */
function buildCtx() {
  return {
    config: {} as never,
    library: { listEntries: () => [] } as never,
    assembler: { query: () => ({ context: '', references: [] }) } as never,
    hydrator: {} as never,
    approvedWritePaths: new Set<string>(),
    requestApproval: async () => 'no' as const,
    converterRegistry: {} as never,
    converterCache: {} as never,
  };
}

describe('Agent — tool loop 触顶兜底', () => {
  it('跑满 maxSteps 仍在调工具 → 强制收尾一轮（不带 tools），返回最终答案', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    // 永远回 tool_call；最后一条是强制收尾用的 finalResp
    const responses = [
      toolCallResp('wiki_list', {}),
      toolCallResp('wiki_list', {}),
      finalResp('已达上限，基于已知信息作答'),
    ];
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            calls.push(body);
            return responses[i++];
          },
        },
      },
    };

    const finals: string[] = [];
    const agent = new Agent(client as never, 'm', buildCtx() as never, { maxSteps: 2 });
    const out = await agent.send('问题', {
      events: { onAssistantText: ({ text, final }) => final && finals.push(text) },
    });

    expect(out).toBe('已达上限，基于已知信息作答');
    expect(finals).toEqual(['已达上限，基于已知信息作答']);
    // 前两次（loop 内）带 tools，第三次（强制收尾）不带
    expect(calls).toHaveLength(3);
    expect(calls[0].tools).toBeDefined();
    expect(calls[1].tools).toBeDefined();
    expect(calls[2].tools).toBeUndefined();
    // 收尾前注入了一条"别再调工具"的 user 提示
    const lastMsgs = calls[2].messages as Array<{ role: string; content: string }>;
    expect(lastMsgs.some((m) => m.role === 'user' && m.content.includes('工具调用轮数上限'))).toBe(
      true,
    );
  });

  it('强制收尾仍返回空文本 → 抛 AgentError，不静默返回空串', async () => {
    let i = 0;
    const responses = [toolCallResp('wiki_list', {}), finalResp('')];
    const client = {
      chat: { completions: { create: async () => responses[i++] } },
    };
    const agent = new Agent(client as never, 'm', buildCtx() as never, { maxSteps: 1 });
    await expect(agent.send('问题', {})).rejects.toBeInstanceOf(AgentError);
  });
});
