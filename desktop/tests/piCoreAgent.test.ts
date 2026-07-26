/**
 * PiCoreAgent（迁移路线 A 的 tracer bullet）：pi-agent-core 的 agent loop 跑 pith 的工具、
 * 对外仍是 AgentLike、历史仍是 OpenAI 形状。
 *
 * 用 pi-ai 的 `fauxProvider()` 驱动**真实的 pi-agent-core Agent**（不是 mock 掉 loop）：
 * 脚本化响应 → 真的走 tool 执行 → 真的产出事件流。安全用例用**真实的 Sanitizer +
 * 流式还原器**，因此「脱敏出站 / 还原入站」在这条新链路上是被验证过的，不是承诺。
 */
import { describe, expect, it } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Api,
  type Context as PiContext,
  type Model as PiModel,
} from '@earendil-works/pi-ai';
import { compilePresets, Sanitizer } from '@core/security/index.js';
import { createStreamRestorer } from '@core/security/streamRestore.js';
import { PiCoreAgent, type PiCoreToolSpec, type StreamEvents } from '../src/engine/piCoreAgent.js';

const PHONE = '13800138000';

/** 一个 pith 风味的假工具：返回任意 JSON（pith 语义），记录被调用的参数。 */
function wikiListTool(): { spec: PiCoreToolSpec; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    spec: {
      name: 'wiki_list',
      description: 'Browse wiki entries',
      parameters: {
        type: 'object',
        properties: { collection: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
      execute: async (args) => {
        calls.push(args);
        return { ok: true, total_matched: 1, items: [{ id: 'deepseek-v4', title: 'DeepSeek-V4 预览版' }] };
      },
    },
  };
}

function setup(opts: { maxToolTurns?: number; withSecurity?: boolean } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as unknown as PiModel<Api>;
  const tool = wikiListTool();

  const sanitizer = new Sanitizer(
    compilePresets({ phone: 'mask', idCard: 'off', bankCard: 'off', email: 'off', apiKey: 'off' }),
  );
  const security = opts.withSecurity
    ? {
        maskText: (t: string) => sanitizer.sanitize(t).text,
        restoreText: (t: string) => sanitizer.restore(t).text,
        createRestorer: () => createStreamRestorer(sanitizer),
      }
    : undefined;

  const agent = new PiCoreAgent({
    models,
    model,
    systemPrompt: 'You are pith-wiki.',
    tools: [tool.spec],
    ...(opts.maxToolTurns ? { maxToolTurns: opts.maxToolTurns } : {}),
    ...(security ? { security } : {}),
  });
  return { faux, agent, tool, sanitizer };
}

function collect(): { events: StreamEvents; rounds: Array<{ name: string; ok: boolean; preview: string }>; thinking: string[]; usage: Array<{ inputTokens: number; outputTokens: number }>; streamed: string[] } {
  const rounds: Array<{ name: string; ok: boolean; preview: string }> = [];
  const thinking: string[] = [];
  const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
  const streamed: string[] = [];
  return {
    rounds,
    thinking,
    usage,
    streamed,
    events: {
      onToolRound: (e) => rounds.push({ name: e.name, ok: e.ok, preview: e.preview }),
      onThinking: (e) => thinking.push(e.text),
      onUsage: (u) => usage.push(u),
      onAssistantText: (e) => {
        if (!e.final) streamed.push(e.text);
      },
    },
  };
}

describe('PiCoreAgent — pi-agent-core loop 跑 pith 工具', () => {
  it('工具轮 → 最终答复：事件、工具执行、OpenAI 形状历史都对', async () => {
    const { faux, agent, tool } = setup();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxThinking('先列目录'), fauxText('我查一下。'), fauxToolCall('wiki_list', { collection: 'tech' }, { id: 'c1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('tech 里有 DeepSeek-V4 预览版。')]),
    ]);

    const c = collect();
    const answer = await agent.send('tech 里有什么？', { events: c.events });

    expect(answer).toBe('tech 里有 DeepSeek-V4 预览版。');
    // 工具真的被执行了（参数经 pi 校验后透传到 pith 语义的 execute）
    expect(tool.calls).toEqual([{ collection: 'tech' }]);
    expect(c.rounds).toHaveLength(1);
    expect(c.rounds[0]).toMatchObject({ name: 'wiki_list', ok: true });
    expect(c.rounds[0].preview).toContain('total_matched');
    expect(c.thinking).toEqual(['先列目录']);
    // 流式回放至少发过一次中间态
    expect(c.streamed.length).toBeGreaterThan(0);
    expect(c.usage.length).toBeGreaterThan(0);

    // 历史翻回 pith 的内部标准形状：既有 JSONL 持久化 / deriveDisplay 可直接吃
    const history = agent.exportHistory() as Array<Record<string, unknown>>;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const assistant = history[1];
    expect(assistant.reasoning_content).toBe('先列目录');
    const calls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
    expect(calls[0]).toMatchObject({ id: 'c1' });
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ collection: 'tech' });
    expect(history[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('maxToolTurns 触顶后拒绝新工具调用（对齐 pith 的 maxSteps 语义）', async () => {
    const { faux, agent, tool } = setup({ maxToolTurns: 1 });
    // 连续两轮都想调工具，第三轮才作答
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('wiki_list', { collection: 'a' }, { id: 'c1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('wiki_list', { collection: 'b' }, { id: 'c2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('信息够了：a 里有 1 条。')]),
    ]);

    const c = collect();
    const answer = await agent.send('查两次', { events: c.events });

    expect(answer).toBe('信息够了：a 里有 1 条。');
    // 第一轮放行、第二轮被 beforeToolCall 阻断 → 真实执行只发生一次
    expect(tool.calls).toEqual([{ collection: 'a' }]);
    const blocked = c.rounds.filter((r) => !r.ok);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].preview).toMatch(/上限|不要再调用/);
  });

  it('安全层：出站只见占位符，UI 与落盘历史都是原文', async () => {
    const { faux, agent } = setup({ withSecurity: true });
    const seen: PiContext[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        // 模型按占位符复述（真实模型被 system note 要求原样保留占位符）
        return fauxAssistantMessage([fauxText('记下了，号码是 [PHONE_1]')]);
      },
    ]);

    const c = collect();
    const answer = await agent.send(`我的手机号是 ${PHONE}`, { events: c.events });

    // 出站：pi（进而 provider）只看到占位符
    const outbound = seen[0].messages[0] as unknown as { content: unknown };
    expect(JSON.stringify(outbound.content)).not.toContain(PHONE);
    expect(JSON.stringify(outbound.content)).toContain('[PHONE_1]');
    // 入站：UI 与最终答复是原文
    expect(answer).toBe(`记下了，号码是 ${PHONE}`);
    // 落盘历史也是原文（与 pith 现有语义一致：不出机器，但本地存原文）
    const history = agent.exportHistory() as Array<Record<string, unknown>>;
    expect(JSON.stringify(history)).toContain(PHONE);
  });

  it('流式增量里被切断的占位符也能还原（spike 3 在这条链路上生效）', async () => {
    const { faux, agent, sanitizer } = setup({ withSecurity: true });
    // 让 faux 逐 token 吐出，占位符必然被切开（tokenSize 默认很小）
    const masked = sanitizer.sanitize(`号码 ${PHONE} 收到`).text;
    faux.setResponses([fauxAssistantMessage([fauxText(masked)])]);

    const c = collect();
    const answer = await agent.send('复述一下', { events: c.events });

    expect(answer).toBe(`号码 ${PHONE} 收到`);
    // 中间态里不应出现半个占位符残片（如 [PHO）
    for (const s of c.streamed) expect(s).not.toMatch(/\[PHO(?!NE_1\])/);
    // 且还原确实发生在**流式过程中**（不是等 message_end 才补）
    expect(c.streamed.some((s) => s.includes(PHONE))).toBe(true);
  });

  it('restoreHistory：OpenAI 形状历史 → pi 状态 → 再导出保持等价（会话恢复）', async () => {
    const { agent } = setup();
    const stored = [
      { role: 'user', content: '之前问过什么？' },
      {
        role: 'assistant',
        content: '你问过 tech 集合。',
        reasoning_content: '回忆一下',
      },
    ];
    agent.restoreHistory(stored);
    const back = agent.exportHistory() as Array<Record<string, unknown>>;
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ role: 'user', content: '之前问过什么？' });
    expect(back[1]).toMatchObject({
      role: 'assistant',
      content: '你问过 tech 集合。',
      reasoning_content: '回忆一下',
    });
  });

  it('reset 清空历史但保留 system prompt', async () => {
    const { faux, agent } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
    await agent.send('hi');
    expect(agent.exportHistory().length).toBeGreaterThan(0);
    agent.reset();
    expect(agent.exportHistory()).toEqual([]);
    expect(agent.snapshot()).toBe('');
  });
});
