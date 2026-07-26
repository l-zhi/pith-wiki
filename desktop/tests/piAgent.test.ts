import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiStream, splitJsonLines, PiAgent, type StreamEvents } from '../src/engine/piAgent.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'pi-json-mode.jsonl',
);

/** 把字符串行数组变成 async iterable，模拟 pi stdout 的逐行 JSONL 输出。 */
async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}

/** 把整段文本按任意切片喂进来，模拟 stdout 的 chunk 边界不落在行边界上。 */
async function* chunks(arr: string[]): AsyncIterable<string> {
  for (const c of arr) yield c;
}

/**
 * 一次「调用桥接的 wiki_list → 基于结果作答」的典型 `pi --mode json` 序列。
 * 事件形状按 pi 0.82.1 的 docs/json.md + dist/modes/print-mode.js（逐条 JSON.stringify(event)，
 * 首行是 sessionManager.getHeader()）构造。
 */
const TRANSCRIPT = [
  JSON.stringify({ type: 'session', version: 3, id: 'e5b1c0de-1111-2222-3333-444455556666', cwd: '/home/u/.pith-wiki' }),
  JSON.stringify({ type: 'agent_start' }),
  JSON.stringify({ type: 'turn_start' }),
  // 第一轮：先说要查，再发 toolCall
  JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '我查一下 ' },
  }),
  JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tech 集合。' },
  }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先列出 tech 里的条目' },
        { type: 'text', text: '我查一下 tech 集合。' },
        { type: 'toolCall', id: 'call_1', name: 'wiki_list', arguments: { collection: 'tech', limit: 2 } },
      ],
      usage: { input: 1200, output: 40, totalTokens: 1240 },
      stopReason: 'toolUse',
    },
  }),
  JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'call_1',
    toolName: 'wiki_list',
    args: { collection: 'tech', limit: 2 },
  }),
  JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'wiki_list',
    result: {
      content: [{ type: 'text', text: '{"ok":true,"items":[{"id":"deepseek-v4","title":"DeepSeek-V4 预览版"}]}' }],
      details: {},
    },
    isError: false,
  }),
  JSON.stringify({ type: 'turn_end' }),
  JSON.stringify({ type: 'turn_start' }),
  // 第二轮：正式答案
  JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tech 里有 DeepSeek-V4 预览版。' },
  }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'tech 里有 DeepSeek-V4 预览版。' }],
      usage: { input: 1500, output: 60, totalTokens: 1560 },
      stopReason: 'stop',
    },
  }),
  JSON.stringify({ type: 'turn_end' }),
  JSON.stringify({ type: 'agent_end', messages: [] }),
];

describe('parsePiStream', () => {
  it('提取最终文本、session id、累加 usage 与桥接工具调用', async () => {
    const toolRounds: Array<{ name: string; args: unknown; ok: boolean; preview: string }> = [];
    const thinking: string[] = [];
    let lastStreamed = '';
    const events: StreamEvents = {
      onToolRound: (e) => toolRounds.push(e),
      onThinking: (e) => thinking.push(e.text),
      onAssistantText: (e) => {
        if (!e.final) lastStreamed = e.text;
      },
    };

    const result = await parsePiStream(lines(TRANSCRIPT), events);

    expect(result.sessionId).toBe('e5b1c0de-1111-2222-3333-444455556666');
    // finalText = 最后一条 assistant 正文（不是中间的「我查一下」）
    expect(result.finalText).toBe('tech 里有 DeepSeek-V4 预览版。');
    expect(result.isError).toBe(false);
    // usage 跨轮累加
    expect(result.usage).toEqual({ inputTokens: 2700, outputTokens: 100 });
    // 流式回放包含两轮拼接
    expect(lastStreamed).toContain('我查一下 tech 集合。');
    expect(lastStreamed).toContain('tech 里有 DeepSeek-V4 预览版。');
    expect(thinking).toEqual(['先列出 tech 里的条目']);
    expect(toolRounds).toHaveLength(1);
    expect(toolRounds[0]).toMatchObject({
      name: 'wiki_list',
      args: { collection: 'tech', limit: 2 },
      ok: true,
    });
    expect(toolRounds[0].preview).toContain('deepseek-v4');
  });

  it('stopReason=error 时标记失败并带出错误信息', async () => {
    const result = await parsePiStream(
      lines([
        JSON.stringify({ type: 'session', id: 's1' }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            usage: { input: 10, output: 0 },
            stopReason: 'error',
            errorMessage: 'no credentials for provider anthropic',
          },
        }),
      ]),
    );
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('no credentials for provider anthropic');
    expect(result.finalText).toBe('');
  });

  it('工具调用只有 start 没有 end（流中断）时兜底补发一条失败工具行', async () => {
    const toolRounds: Array<{ name: string; ok: boolean }> = [];
    await parsePiStream(
      lines([
        JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'wiki_query', args: { q: 'x' } }),
      ]),
      { onToolRound: (e) => toolRounds.push({ name: e.name, ok: e.ok }) },
    );
    expect(toolRounds).toEqual([{ name: 'wiki_query', ok: false }]);
  });

  it('忽略非 JSON 噪声行', async () => {
    const result = await parsePiStream(
      lines([
        'Loaded 3 skills',
        JSON.stringify({ type: 'session', id: 's2' }),
        '',
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 }, stopReason: 'stop' },
        }),
      ]),
    );
    expect(result.sessionId).toBe('s2');
    expect(result.finalText).toBe('ok');
  });
});

describe('parsePiStream — 真机抓取回放', () => {
  /**
   * fixtures/pi-json-mode.jsonl 是**真实** `pi --mode json` 的输出（pi 0.82.1，本机实测：
   * 桥接扩展挂上 pith-mcp → 模型调 wiki_list → 基于结果作答；LLM 端点是本地假的
   * openai-completions 服务，因此无需任何凭据即可复现）。手写 fixture 会不知不觉跑偏，
   * 这条用例锁住真实事件形状。
   */
  it('按任意 chunk 边界喂真实抓取，仍能还原答案/session/usage/工具调用', async () => {
    const raw = fs.readFileSync(FIXTURE, 'utf8');
    // 7 字节一切：确保 chunk 边界落在行中间、JSON 中间、甚至多字节 UTF-8 字符边界附近
    async function* sliced(): AsyncIterable<string> {
      for (let i = 0; i < raw.length; i += 7) yield raw.slice(i, i + 7);
    }
    const rounds: Array<{ name: string; ok: boolean; preview: string }> = [];
    const result = await parsePiStream(splitJsonLines(sliced()), {
      onToolRound: (e) => rounds.push({ name: e.name, ok: e.ok, preview: e.preview }),
    });

    expect(result.sessionId).toBe('019f9f8f-6b3e-7718-ab2c-f104d1d2c1ce');
    expect(result.finalText).toBe('知识库里有：DeepSeek-V4 预览版');
    expect(result.isError).toBe(false);
    // 两轮 usage 累加（120+300 / 20+15）
    expect(result.usage).toEqual({ inputTokens: 420, outputTokens: 35 });
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('wiki_list');
    expect(rounds[0].ok).toBe(true);
    // 工具结果来自真实 pith-mcp（经桥接扩展），不是 mock
    expect(rounds[0].preview).toContain('"total_matched":1');
  });
});

describe('splitJsonLines', () => {
  it('跨 chunk 边界拼行，只按 \\n 切，容忍 \\r\\n', async () => {
    const out: string[] = [];
    for await (const line of splitJsonLines(chunks(['{"a":1}\n{"b":', '2}\r\n{"c":3}']))) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('不在 U+2028 / U+2029 处断行（node:readline 会切，所以这里不能用它）', async () => {
    // U+2028/U+2029 在 JSON 字符串里合法，且 JSON.stringify 不转义它们 —— 知识库正文完全
    // 可能带（PDF/网页转换来的文本尤其常见）。通用 line reader 会在这里断行，把一条事件
    // 切成两半解析失败；pi 的 rpc.md 明确点了 node:readline 这个坑。
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const text = `a${LS}b${PS}c`;
    const payload = JSON.stringify({ type: 'x', text });
    expect(payload).toContain(LS); // 确认 fixture 真的带了裸分隔符
    const out: string[] = [];
    for await (const line of splitJsonLines(chunks([`${payload}\n`]))) out.push(line);
    expect(out).toEqual([payload]);
    expect((JSON.parse(out[0]) as { text: string }).text).toBe(text);
  });
});

describe('PiAgent.buildArgs', () => {
  const base = {
    binary: 'pi',
    model: 'anthropic/claude-opus-4-5:high',
    systemPrompt: '你是 pith 的检索助手',
    bridgePath: '/home/u/.pith-wiki/pi/pith-mcp-bridge.mjs',
    env: {},
    sessionDir: '/home/u/.pith-wiki/pi-sessions',
  };

  it('首轮：不带 --session，带桥接扩展与确定性 flag', () => {
    const args = new PiAgent(base).buildArgs('你好');
    expect(args.slice(0, 2)).toEqual(['--mode', 'json']);
    expect(args).toContain('--session-dir');
    expect(args).not.toContain('--session');
    expect(args).toContain('--model');
    expect(args).toContain('anthropic/claude-opus-4-5:high');
    expect(args).toContain('--append-system-prompt');
    // 只加载 pith 桥接扩展，忽略用户全局扩展 / project-local 资源 / 上下文文件
    expect(args).toContain('--no-extensions');
    expect(args).toContain('-e');
    expect(args).toContain(base.bridgePath);
    expect(args).toContain('-na');
    expect(args).toContain('-nc');
    // prompt 是最后一个位置参数
    expect(args[args.length - 1]).toBe('你好');
  });

  it('空 model / 无 bridge / 无 apiKey 时不带对应 flag', () => {
    const args = new PiAgent({ ...base, model: '', bridgePath: undefined }).buildArgs('hi');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--api-key');
    expect(args).toContain('--no-extensions'); // 仍然禁用发现，保持确定性
  });

  it('配了 apiKey 时传 --api-key（按量计费；不配则走 pi 的 OAuth 订阅）', () => {
    const args = new PiAgent({ ...base, apiKey: 'sk-test' }).buildArgs('hi');
    expect(args).toContain('--api-key');
    expect(args[args.indexOf('--api-key') + 1]).toBe('sk-test');
  });
});
