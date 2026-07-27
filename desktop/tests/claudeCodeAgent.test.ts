import { describe, it, expect } from 'vitest';
import {
  ClaudeCodeAgent,
  parseClaudeStream,
  DEFAULT_ALLOWED_TOOLS,
  type StreamEvents,
} from '../src/engine/claudeCodeAgent.js';

describe('DEFAULT_ALLOWED_TOOLS', () => {
  it('默认放行 pith MCP + 飞书(lark-cli) + 微信读书(curl)', () => {
    const tools = DEFAULT_ALLOWED_TOOLS.split(',');
    expect(tools).toContain('mcp__pith__*');
    expect(tools).toContain('Bash(lark-cli:*)'); // 飞书
    expect(tools).toContain('Bash(curl:*)'); // 微信读书网关
  });
});

/** 把字符串行数组变成 async iterable，模拟 claude stdout 的逐行输出。 */
async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}

/** 一次"调用 mcp__pith__wiki_query → 基于结果回答"的典型 stream-json 序列。 */
const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'sess-123',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'mcp__pith__wiki_query' },
    },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"忘川' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '七诀"}' } },
  }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  // 工具结果作为独立的顶层 user 消息（tool_result 块）回来，按 tool_use_id 配对。
  JSON.stringify({
    type: 'user',
    session_id: 'sess-123',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: '{"ok":true,"results":[{"id":"忘川七诀","title":"忘川七诀"}]}',
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你的库里' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '有《忘川七诀》。' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 500, output_tokens: 30 } },
  }),
  JSON.stringify({
    type: 'result',
    result: '你的库里有《忘川七诀》。',
    session_id: 'sess-123',
    usage: { input_tokens: 500, output_tokens: 30 },
    total_cost_usd: 0.001,
  }),
];

describe('parseClaudeStream', () => {
  it('extracts final text, session id, usage and tool call', async () => {
    const toolRounds: Array<{ name: string; args: unknown; ok: boolean; preview: string }> = [];
    let lastStreamed = '';
    let finalEmitted: string | null = null;
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const events: StreamEvents = {
      onToolRound: (e) =>
        toolRounds.push({ name: e.name, args: e.args, ok: e.ok, preview: e.preview }),
      onAssistantText: (e) => {
        if (e.final) finalEmitted = e.text;
        else lastStreamed = e.text;
      },
      onUsage: (u) => usages.push(u),
    };

    const res = await parseClaudeStream(lines(TRANSCRIPT), events);

    expect(res.finalText).toBe('你的库里有《忘川七诀》。');
    expect(res.sessionId).toBe('sess-123');
    expect(res.isError).toBe(false);
    expect(res.usage).toEqual({ inputTokens: 500, outputTokens: 30 });

    // 工具名去掉 mcp__pith__ 前缀，入参 JSON 拼接还原
    expect(toolRounds).toHaveLength(1);
    expect(toolRounds[0].name).toBe('wiki_query');
    expect(toolRounds[0].args).toEqual({ query: '忘川七诀' });
    // 关键回归：tool_result 配对后 preview 带上真实结果、ok=true（此前恒为空串）
    expect(toolRounds[0].ok).toBe(true);
    expect(toolRounds[0].preview).toContain('忘川七诀');

    // 流式文本逐步累积（parseClaudeStream 不发 final，final 由 send() 收尾时发）
    expect(lastStreamed).toBe('你的库里有《忘川七诀》。');
    expect(finalEmitted).toBeNull();
    expect(usages.at(-1)).toEqual({ inputTokens: 500, outputTokens: 30 });
  });

  it('marks tool round failed and carries preview when tool_result is_error', async () => {
    const rounds: Array<{ ok: boolean; preview: string }> = [];
    await parseClaudeStream(
      lines([
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_x', name: 'mcp__pith__wiki_get' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"nope"}' } },
        }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call_x', is_error: true, content: [{ type: 'text', text: 'not found' }] },
            ],
          },
        }),
        JSON.stringify({ type: 'result', result: '没找到', session_id: 's' }),
      ]),
      { onToolRound: (e) => rounds.push({ ok: e.ok, preview: e.preview }) },
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].ok).toBe(false);
    expect(rounds[0].preview).toBe('not found');
  });

  it('flushes unpaired tool calls at stream end with empty preview', async () => {
    const rounds: Array<{ name: string; preview: string }> = [];
    await parseClaudeStream(
      lines([
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_y', name: 'mcp__pith__wiki_grep' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"patterns":["x"]}' } },
        }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        // 没有 tool_result 就直接 result 收尾 → 兜底补发
        JSON.stringify({ type: 'result', result: 'done', session_id: 's' }),
      ]),
      { onToolRound: (e) => rounds.push({ name: e.name, preview: e.preview }) },
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('wiki_grep');
    expect(rounds[0].preview).toBe('');
  });

  it('flags is_error from the result event', async () => {
    const res = await parseClaudeStream(
      lines([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
        JSON.stringify({ type: 'result', result: 'API Error: 401', is_error: true, session_id: 's' }),
      ]),
    );
    expect(res.isError).toBe(true);
    expect(res.finalText).toBe('API Error: 401');
  });

  it('falls back to streamed text when result has no result field', async () => {
    const res = await parseClaudeStream(
      lines([
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        }),
        JSON.stringify({ type: 'result', session_id: 's' }),
      ]),
    );
    expect(res.finalText).toBe('hello');
  });

  it('ignores non-JSON noise lines', async () => {
    const res = await parseClaudeStream(
      lines(['', 'not json', JSON.stringify({ type: 'result', result: 'ok' }), '']),
    );
    expect(res.finalText).toBe('ok');
  });
});

describe('ClaudeCodeAgent.buildArgs — 与用户 CC 环境的隔离', () => {
  const base = {
    binary: 'claude',
    model: 'opus',
    systemPrompt: 'pith 检索人设',
    mcpConfigPath: '/home/u/pith-mcp.json',
    env: {},
    cwd: '/home/u/.pith-wiki',
  };

  it('默认 standard：屏蔽其它 MCP / skills / 用户级 settings（订阅仍可用）', () => {
    const args = new ClaudeCodeAgent(base).buildArgs('hi');
    expect(args).toContain('--strict-mcp-config'); // 只用 pith 的 MCP
    expect(args).toContain('--disable-slash-commands'); // 不加载用户的 skills
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project'); // 不吃用户级 settings
    expect(args).not.toContain('--bare'); // 不能加：--bare 会掐掉 OAuth = 放弃订阅
    // pith 自己的装配照旧
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(base.mcpConfigPath);
    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('bare：额外屏蔽 CLAUDE.md/hooks/plugin（代价是放弃订阅，见注释）', () => {
    const args = new ClaudeCodeAgent({ ...base, isolation: 'bare' }).buildArgs('hi');
    expect(args).toContain('--bare');
    expect(args).toContain('--strict-mcp-config');
  });

  it('off：完全继承用户环境（想让 pith 会话用上自己那套 skills 时）', () => {
    const args = new ClaudeCodeAgent({ ...base, isolation: 'off' }).buildArgs('hi');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--disable-slash-commands');
    expect(args).not.toContain('--setting-sources');
  });

  it('resume 轮仍带隔离标志（否则第二轮就把用户环境放进来了）', () => {
    const agent = new ClaudeCodeAgent(base);
    (agent as unknown as { ccSessionId: string }).ccSessionId = 'sess-1';
    const args = agent.buildArgs('next');
    expect(args).toContain('--resume');
    expect(args).toContain('--strict-mcp-config');
  });
});
