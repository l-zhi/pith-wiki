/**
 * Agent 的 @-mention scope 贯穿：验证本轮 scope
 *   1. 被注入成一条 "[Scoped context …]" preamble（钉死保证）
 *   2. 传到 wiki_query → ctx.assembler.query 时带上 scope（持续收窄）
 *   3. send() 结束后 currentScope 复位为 null
 *
 * 用 mock client（先回一个 wiki_query tool_call，再回最终文本）+ 真实
 * LibraryService/ContextAssembler（spy 其 query 捕获 scope）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Agent } from '../src/llm/agent.js';
import { LibraryService } from '../src/wiki/library.js';
import { ContextAssembler, type QueryScope } from '../src/wiki/assembler.js';
import type { Entry } from '../src/wiki/types.js';

let tmpDir: string;
let lib: LibraryService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-agent-scope-'));
  lib = new LibraryService(tmpDir);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? 'x',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

/** 队列式 mock：按顺序吐 completion；记录每次 messages 入参。 */
function mockClient(responses: unknown[]) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => responses[i++],
      },
    },
  };
}

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

function buildAgent(assembler: ContextAssembler) {
  const ctx = {
    config: {} as never,
    library: lib,
    assembler,
    hydrator: {} as never,
    approvedWritePaths: new Set<string>(),
    requestApproval: async () => 'no' as const,
    converterRegistry: {} as never,
    converterCache: {} as never,
  };
  const client = mockClient([
    toolCallResp('wiki_query', { query: 'agent design', max_tokens: 4000 }),
    finalResp('done'),
  ]);
  return new Agent(client as never, 'test-model', ctx as never);
}

describe('Agent — @-mention scope 贯穿', () => {
  it('集合 scope 注入 preamble，并传到 wiki_query 的 assembler.query', async () => {
    lib.put(entry({ id: 'in-tech', collection: 'tech', title: 'agent design' }));
    lib.put(entry({ id: 'in-life', collection: 'life', title: 'agent design' }));

    const assembler = new ContextAssembler(lib);
    const seen: (QueryScope | undefined)[] = [];
    const orig = assembler.query.bind(assembler);
    assembler.query = (t, m, s) => {
      seen.push(s);
      return orig(t, m, s);
    };

    const agent = buildAgent(assembler);
    const scope: QueryScope = { collections: ['tech'], entryIds: [] };
    await agent.send('@tech/ 总结 agent design', { scope });

    // assembler.query 至少被调用两次（preamble + wiki_query），每次都带集合 scope
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s?.collections).toEqual(['tech']);

    // preamble 作为一条 user 消息注入，且只含 tech 集合内容
    const msgs = (agent as unknown as { messages: ChatCompletionMessageParam[] }).messages;
    const preamble = msgs.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Scoped context'),
    );
    expect(preamble).toBeDefined();
    const text = preamble!.content as string;
    expect(text).toContain('in-tech');
    expect(text).not.toContain('in-life');

    // send 结束后 scope 复位
    expect((agent as unknown as { currentScope: unknown }).currentScope).toBeNull();
  });

  it('无 scope 时不注入 preamble，assembler.query 收到 undefined', async () => {
    lib.put(entry({ id: 'a', collection: 'tech', title: 'agent design' }));
    const assembler = new ContextAssembler(lib);
    const seen: (QueryScope | undefined)[] = [];
    const orig = assembler.query.bind(assembler);
    assembler.query = (t, m, s) => {
      seen.push(s);
      return orig(t, m, s);
    };
    const agent = buildAgent(assembler);
    await agent.send('普通问题', {});

    const msgs = (agent as unknown as { messages: ChatCompletionMessageParam[] }).messages;
    expect(
      msgs.some((m) => typeof m.content === 'string' && m.content.startsWith('[Scoped context')),
    ).toBe(false);
    // 只有 wiki_query 那次调用，scope 为 undefined
    expect(seen).toEqual([undefined]);
  });
});
