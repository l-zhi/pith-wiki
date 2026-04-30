/**
 * Agent.snapshot() / hasContent() 单元测试。
 *
 * 不跑真实的 LLM 调用——直接构造 Agent，然后用类型断言注入 messages 数组，
 * 验证 snapshot 的格式化逻辑。/digest 命令的端到端集成依赖这些纯函数行为。
 */
import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Agent } from '../src/llm/agent.js';

interface AgentInternal {
  messages: ChatCompletionMessageParam[];
}

function makeAgent(): { agent: Agent; internal: AgentInternal } {
  // OpenAI client / model / toolCtx 在 snapshot/hasContent 路径上根本不被 touch，
  // 用 stub 即可，类型上吃 `as never`。
  const agent = new Agent({} as never, 'test-model', {} as never);
  const internal = agent as unknown as AgentInternal;
  return { agent, internal };
}

describe('Agent.hasContent', () => {
  it('reset 后只剩 system prompt → false', () => {
    const { agent } = makeAgent();
    expect(agent.hasContent()).toBe(false);
  });

  it('reset() 之后再次为 false', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: 'hi' });
    expect(agent.hasContent()).toBe(true);
    agent.reset();
    expect(agent.hasContent()).toBe(false);
  });

  it('有 user 消息 → true', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: 'hello' });
    expect(agent.hasContent()).toBe(true);
  });
});

describe('Agent.snapshot', () => {
  it('reset 状态下返回空串', () => {
    const { agent } = makeAgent();
    expect(agent.snapshot()).toBe('');
  });

  it('user + assistant 一对消息按顺序出现', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: '把这段加进 wiki' });
    internal.messages.push({ role: 'assistant', content: '好的，我先用 wiki_query 查一下' });

    const out = agent.snapshot();
    expect(out).toContain('## User');
    expect(out).toContain('把这段加进 wiki');
    expect(out).toContain('## Assistant');
    expect(out).toContain('好的，我先用 wiki_query 查一下');
    expect(out.indexOf('## User')).toBeLessThan(out.indexOf('## Assistant'));
  });

  it('包含 tool_calls 时把 tool 名 + 参数附在 assistant 段后面', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: '看 inbox' });
    internal.messages.push({
      role: 'assistant',
      content: 'looking',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'list_dir', arguments: '{"path":"~/notes/inbox"}' },
        },
      ],
    });

    const out = agent.snapshot();
    expect(out).toContain('### Tool: list_dir');
    expect(out).toContain('"path":"~/notes/inbox"');
  });

  it('tool 角色的原始返回值不被引入（避免噪声）', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: 'hi' });
    internal.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'wiki_query', arguments: '{}' },
        },
      ],
    });
    internal.messages.push({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"ok":true,"hugePayload":"..."}',
    });
    internal.messages.push({ role: 'assistant', content: 'final answer' });

    const out = agent.snapshot();
    expect(out).toContain('final answer');
    // raw tool 返回值不应直接在 snapshot 里出现
    expect(out).not.toContain('hugePayload');
  });

  it('空 content 的 assistant 消息只携带 tool_calls 时不输出空 ## Assistant 段', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: 'go' });
    internal.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'x',
          type: 'function',
          function: { name: 'list_dir', arguments: '{}' },
        },
      ],
    });

    const out = agent.snapshot();
    // tool 段在；assistant 标题不应该出现，因为 content 是空
    expect(out).toContain('### Tool: list_dir');
    expect(out).not.toContain('## Assistant');
  });

  it('多轮对话的顺序被保留', () => {
    const { agent, internal } = makeAgent();
    internal.messages.push({ role: 'user', content: 'turn1-user' });
    internal.messages.push({ role: 'assistant', content: 'turn1-asst' });
    internal.messages.push({ role: 'user', content: 'turn2-user' });
    internal.messages.push({ role: 'assistant', content: 'turn2-asst' });

    const out = agent.snapshot();
    expect(out.indexOf('turn1-user')).toBeLessThan(out.indexOf('turn1-asst'));
    expect(out.indexOf('turn1-asst')).toBeLessThan(out.indexOf('turn2-user'));
    expect(out.indexOf('turn2-user')).toBeLessThan(out.indexOf('turn2-asst'));
  });
});
