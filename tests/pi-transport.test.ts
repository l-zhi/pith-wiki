/**
 * pi-ai 传输实现（路线 B）：请求/响应映射 + 与安全过滤层的协作。
 *
 * 用 pi-ai 自带的 `fauxProvider()` 做确定性测试：不发网络请求、不需要凭据，
 * 而且 `FauxResponseFactory` 能拿到 pith 真正喂给 pi-ai 的 `Context` ——
 * 于是「pith 的 OpenAI 形状历史 → pi-ai Context」这一步是被真实断言的，不是纸上推演。
 */
import { describe, expect, it } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Context as PiContext,
  type Model as PiModel,
} from '@earendil-works/pi-ai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { Config } from '../src/config.js';
import { createPiAiChatClient, toChatCompletion, toPiContext } from '../src/llm/piAiTransport.js';
import { compilePresets, Sanitizer, wrapClientWithSecurity } from '../src/security/index.js';

const baseConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.example.com',
  model: 'faux-model',
  requestTimeoutMs: 30_000,
  securityEnabled: false,
  transport: 'pi-ai',
} as unknown as Config;

/** 一段典型的 pith 历史：system + user + 带 thinking/tool_calls 的 assistant + tool 结果。 */
const HISTORY: ChatCompletionCreateParamsNonStreaming = {
  model: 'faux-model',
  messages: [
    { role: 'system', content: 'You are pith-wiki.' },
    { role: 'user', content: 'tech 里有什么？' },
    {
      role: 'assistant',
      content: '我查一下。',
      // pith 的历史会把 provider 的 thinking 字段原样带回（DeepSeek 的回传协议）
      reasoning_content: '先列目录',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'wiki_list', arguments: '{"collection":"tech"}' },
        },
      ],
    } as never,
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"items":[]}' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'wiki_list',
        description: 'Browse wiki entries',
        parameters: {
          type: 'object',
          properties: { collection: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ],
  tool_choice: 'auto',
  stream: false,
};

describe('toPiContext — OpenAI 形状历史 → pi-ai Context', () => {
  it('system 抽成 systemPrompt；user/assistant/tool 各自映射', () => {
    const ctx = toPiContext(HISTORY);
    expect(ctx.systemPrompt).toBe('You are pith-wiki.');
    expect(ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
  });

  it('assistant 的 reasoning_content → thinking 块，tool_calls → toolCall 块（参数 parse 回对象）', () => {
    const ctx = toPiContext(HISTORY);
    const assistant = ctx.messages[1] as unknown as { content: Array<Record<string, unknown>> };
    expect(assistant.content.map((c) => c.type)).toEqual(['thinking', 'text', 'toolCall']);
    expect(assistant.content[0].thinking).toBe('先列目录');
    expect(assistant.content[2]).toMatchObject({
      id: 'call_1',
      name: 'wiki_list',
      arguments: { collection: 'tech' },
    });
  });

  it('tool 消息的 toolName 由前面 assistant 的 tool_calls 按 id 反查（OpenAI 形状里没这个字段）', () => {
    const ctx = toPiContext(HISTORY);
    expect(ctx.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'wiki_list',
      isError: false,
    });
  });

  it('工具声明的 JSON Schema 原样透传（pi 侧实测接受普通 JSON Schema）', () => {
    const ctx = toPiContext(HISTORY);
    expect(ctx.tools?.[0]).toMatchObject({ name: 'wiki_list', description: 'Browse wiki entries' });
    expect(ctx.tools?.[0].parameters).toMatchObject({
      type: 'object',
      properties: { collection: { type: 'string' } },
    });
  });

  it('tool_calls 的参数不是合法 JSON 时兜底成 _raw，不让整轮请求崩掉', () => {
    const ctx = toPiContext({
      model: 'm',
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'wiki_get', arguments: '{oops' } },
          ],
        } as never,
      ],
    });
    const assistant = ctx.messages[0] as unknown as { content: Array<Record<string, unknown>> };
    expect(assistant.content[0]).toMatchObject({ name: 'wiki_get', arguments: { _raw: '{oops' } });
  });
});

describe('toChatCompletion — pi-ai AssistantMessage → OpenAI 形状', () => {
  it('text/thinking/toolCall 分别落到 content / reasoning_content / tool_calls', () => {
    const msg = fauxAssistantMessage(
      [
        fauxThinking('想一下'),
        fauxText('答案'),
        fauxToolCall('wiki_get', { id: 'x' }, { id: 'c9' }),
      ],
      { stopReason: 'toolUse' },
    );
    const completion = toChatCompletion(msg, 'faux-model');
    const choice = completion.choices[0];
    const message = choice.message as unknown as Record<string, unknown>;
    expect(message.content).toBe('答案');
    expect(message.reasoning_content).toBe('想一下');
    expect(choice.finish_reason).toBe('tool_calls');
    const calls = message.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('c9');
    // arguments 必须是 JSON 字符串（Agent 侧会 JSON.parse 后交给 zod 校验）
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ id: 'x' });
  });

  it('usage 映射成 prompt_tokens / completion_tokens（Agent 的 onUsage 读这两个）', () => {
    const msg = fauxAssistantMessage([fauxText('hi')]);
    msg.usage = {
      input: 120,
      output: 34,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 154,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const completion = toChatCompletion(msg, 'faux-model');
    expect(completion.usage).toMatchObject({
      prompt_tokens: 120,
      completion_tokens: 34,
      total_tokens: 154,
    });
  });
});

/** 造一个注入了 faux provider 的 pi-ai client，并暴露它收到的 Context。 */
function fauxClient(config: Config = baseConfig) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const client = createPiAiChatClient(config, {
    models,
    model: model as unknown as PiModel<'openai-completions'>,
  });
  return { faux, client, model };
}

describe('createPiAiChatClient — 端到端（faux provider）', () => {
  it('把 pith 的请求翻成 pi-ai 调用，再把响应翻回 OpenAI 形状', async () => {
    const { faux, client } = fauxClient();
    const seen: PiContext[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxText('tech 里有 1 条。')]);
      },
    ]);

    const completion = await client.chat.completions.create(HISTORY);

    // pith 真正喂给 pi-ai 的 Context（不是纸上推演）
    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).toBe('You are pith-wiki.');
    expect(seen[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(seen[0].tools?.map((t) => t.name)).toEqual(['wiki_list']);
    // 回程是 Agent 能直接消费的 OpenAI 形状
    expect(completion.choices[0].message.content).toBe('tech 里有 1 条。');
    expect(completion.choices[0].finish_reason).toBe('stop');
  });

  it('response_format（JSON 模式）直接报错——水合必须走 openai SDK，不静默降级', async () => {
    const { client } = fauxClient();
    await expect(
      client.chat.completions.create({
        ...HISTORY,
        response_format: { type: 'json_object' },
      }),
    ).rejects.toThrow(/response_format|JSON mode/i);
  });

  it('stopReason=error → 抛错（pi-ai 用「错误消息」表达失败，pith 的 Agent 期望抛）', async () => {
    const { faux, client } = fauxClient();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'HTTP 401 unauthorized' }),
    ]);
    await expect(client.chat.completions.create(HISTORY)).rejects.toThrow(/401/);
  });

  it('stopReason=aborted → 抛 name=AbortError（Agent 靠这个透传 Ctrl+C）', async () => {
    const { faux, client } = fauxClient();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted by user' }),
    ]);
    await expect(client.chat.completions.create(HISTORY)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('安全过滤层覆盖 pi-ai 传输（ChatClient 同形的意义）', () => {
  it('出站脱敏：pi-ai 只看到占位符；入站还原：调用方拿回真实值', async () => {
    const PHONE = '13800138000';
    const { faux, client: raw } = fauxClient();
    const sanitizer = new Sanitizer(
      compilePresets({
        phone: 'mask',
        idCard: 'off',
        bankCard: 'off',
        email: 'off',
        apiKey: 'off',
      }),
    );
    const client = wrapClientWithSecurity(raw, sanitizer, { onNotice: () => {} });

    const seen: PiContext[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxText('记下了，号码是 [PHONE_1]')]);
      },
    ]);

    const completion = await client.chat.completions.create({
      model: 'faux-model',
      stream: false,
      messages: [
        { role: 'system', content: 'You are pith-wiki.' },
        { role: 'user', content: `我的手机号是 ${PHONE}` },
      ],
    });

    // 出站：真实号码没有离开本机
    const userMsg = seen[0].messages[0] as unknown as { content: string };
    expect(userMsg.content).not.toContain(PHONE);
    expect(userMsg.content).toContain('[PHONE_1]');
    // 入站：占位符被还原成原值
    expect(completion.choices[0].message.content).toBe(`记下了，号码是 ${PHONE}`);
  });
});
