import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseCodexStream, readPithMcpSpec, type StreamEvents } from '../src/engine/codexAgent.js';

/** 把字符串行数组变成 async iterable，模拟 codex stdout 的逐行 JSONL 输出。 */
async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}

describe('readPithMcpSpec', () => {
  it('读取共享 pith MCP 配置并规范化 args/env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-codex-mcp-'));
    const file = path.join(dir, 'pith-mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          pith: { command: 'node', args: ['server.js', 7], env: { PITH_WIKI_HOME: '/tmp/pith' } },
        },
      }),
    );
    expect(readPithMcpSpec(file)).toEqual({
      command: 'node',
      args: ['server.js', '7'],
      env: { PITH_WIKI_HOME: '/tmp/pith' },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('配置缺失时返回 undefined，Codex 仍可无 MCP 聊天', () => {
    expect(readPithMcpSpec('/definitely/missing/pith-mcp.json')).toBeUndefined();
  });
});

/**
 * 一次「调用 mcp__pith__wiki_list → 基于结果回答」的典型 codex exec --json 序列。
 * 逐行取自 P0 实测抓取（codex-cli 0.145.0，见 docs/PRD-codex-integration.md §2.5）。
 */
const TRANSCRIPT = [
  JSON.stringify({ type: 'thread.started', thread_id: '019f9277-4507-74c3-ba5b-a22c791a7716' }),
  JSON.stringify({ type: 'turn.started' }),
  // 模型先发一条「我要调工具」的 agent_message（预告），再发真正答案
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: '我会调用 wiki_list，限定 tech，最多 2 条。',
    },
  }),
  JSON.stringify({
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'mcp_tool_call',
      server: 'pith',
      tool: 'wiki_list',
      arguments: { collection: 'tech', limit: 2 },
      result: null,
      error: null,
      status: 'in_progress',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'mcp_tool_call',
      server: 'pith',
      tool: 'wiki_list',
      arguments: { collection: 'tech', limit: 2 },
      result: {
        content: [
          {
            type: 'text',
            text: '{"ok":true,"items":[{"id":"deepseek-v4","title":"DeepSeek-V4 预览版"}]}',
          },
        ],
        structured_content: null,
      },
      error: null,
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: 'tech 里有关于 DeepSeek-V4 预览版的条目。' },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 63723,
      cached_input_tokens: 40448,
      cache_write_input_tokens: 0,
      output_tokens: 169,
      reasoning_output_tokens: 31,
    },
  }),
];

describe('parseCodexStream', () => {
  it('提取最终文本、thread_id、usage 与 MCP 工具调用', async () => {
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

    const res = await parseCodexStream(lines(TRANSCRIPT), events);

    // finalText = 最后一条 agent_message（真正的答案，不含预告）
    expect(res.finalText).toBe('tech 里有关于 DeepSeek-V4 预览版的条目。');
    expect(res.sessionId).toBe('019f9277-4507-74c3-ba5b-a22c791a7716');
    expect(res.isError).toBe(false);
    expect(res.usage).toEqual({ inputTokens: 63723, outputTokens: 169 });

    // MCP 工具调用：名字 = item.tool，入参原样，配对结果后 ok=true 且 preview 带真实数据
    expect(toolRounds).toHaveLength(1);
    expect(toolRounds[0].name).toBe('wiki_list');
    expect(toolRounds[0].args).toEqual({ collection: 'tech', limit: 2 });
    expect(toolRounds[0].ok).toBe(true);
    expect(toolRounds[0].preview).toContain('DeepSeek-V4');

    // 流式文本累积（含预告 + 答案，parseCodexStream 不发 final；final 由 send() 收尾时发）
    expect(lastStreamed).toContain('我会调用 wiki_list');
    expect(lastStreamed).toContain('tech 里有关于 DeepSeek-V4');
    expect(finalEmitted).toBeNull();
    expect(usages.at(-1)).toEqual({ inputTokens: 63723, outputTokens: 169 });
  });

  it('MCP 调用被取消 → ok=false，preview 带错误信息', async () => {
    const rounds: Array<{ name: string; ok: boolean; preview: string }> = [];
    const res = await parseCodexStream(
      lines([
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'i1',
            type: 'mcp_tool_call',
            server: 'pith',
            tool: 'wiki_list',
            arguments: { collection: 'tech' },
            status: 'in_progress',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'i1',
            type: 'mcp_tool_call',
            server: 'pith',
            tool: 'wiki_list',
            arguments: { collection: 'tech' },
            result: null,
            error: { message: 'user cancelled MCP tool call' },
            status: 'failed',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'i2', type: 'agent_message', text: '调用被取消。' },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
      { onToolRound: (e) => rounds.push({ name: e.name, ok: e.ok, preview: e.preview }) },
    );
    expect(res.finalText).toBe('调用被取消。');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('wiki_list');
    expect(rounds[0].ok).toBe(false);
    expect(rounds[0].preview).toContain('user cancelled MCP tool call');
  });

  it('command_execution 映射为 shell 工具行', async () => {
    const rounds: Array<{ name: string; args: unknown; ok: boolean; preview: string }> = [];
    await parseCodexStream(
      lines([
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'ls -la',
            aggregated_output: 'total 0\n.',
            exit_code: 0,
            status: 'completed',
          },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
      {
        onToolRound: (e) =>
          rounds.push({ name: e.name, args: e.args, ok: e.ok, preview: e.preview }),
      },
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('shell');
    expect(rounds[0].args).toEqual({ command: 'ls -la' });
    expect(rounds[0].ok).toBe(true);
    expect(rounds[0].preview).toContain('total 0');
  });

  it('reasoning item → onThinking', async () => {
    const thoughts: string[] = [];
    await parseCodexStream(
      lines([
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'r1', type: 'reasoning', text: '先看有哪些工具' },
        }),
        JSON.stringify({ type: 'turn.completed', usage: {} }),
      ]),
      { onThinking: (e) => thoughts.push(e.text) },
    );
    expect(thoughts).toEqual(['先看有哪些工具']);
  });

  it('error 事件 → isError 且带 message', async () => {
    const res = await parseCodexStream(
      lines([
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'error', message: 'usage limit exceeded' }),
      ]),
    );
    expect(res.isError).toBe(true);
    expect(res.errorMessage).toBe('usage limit exceeded');
  });

  it('流末仍未配对的 mcp_tool_call → 兜底补发（ok=false，空 preview）', async () => {
    const rounds: Array<{ name: string; ok: boolean; preview: string }> = [];
    await parseCodexStream(
      lines([
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'i9',
            type: 'mcp_tool_call',
            server: 'pith',
            tool: 'wiki_grep',
            arguments: { patterns: ['x'] },
            status: 'in_progress',
          },
        }),
        // 没有对应的 item.completed 就直接 turn.completed
        JSON.stringify({ type: 'turn.completed', usage: {} }),
      ]),
      { onToolRound: (e) => rounds.push({ name: e.name, ok: e.ok, preview: e.preview }) },
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('wiki_grep');
    expect(rounds[0].ok).toBe(false);
    expect(rounds[0].preview).toBe('');
  });

  it('忽略非 JSON 噪声行', async () => {
    const res = await parseCodexStream(
      lines([
        '',
        'not json',
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        JSON.stringify({ type: 'turn.completed', usage: {} }),
        '',
      ]),
    );
    expect(res.finalText).toBe('ok');
  });
});
