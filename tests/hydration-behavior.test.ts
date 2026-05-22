/**
 * Hydration 行为测试（mock OpenAI，断言 prompt 拼装 / plan 触发 / 候选预筛）。
 *
 * 与 hydration-prompt.test.ts 互补：那边焊死 prompt 文本，这边焊死行为。
 *   - 候选预筛：pool > TOP_N 时按 scoring 挑 top-N，pool ≤ TOP_N 时全送
 *   - plan pass：仅长文 + document 模式触发；plan 失败 → 单次回退
 *   - conversation 模式始终单次（plan 跳过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { HydrationService } from '../src/wiki/hydration.js';
import { LibraryService } from '../src/wiki/library.js';
import type { Entry } from '../src/wiki/types.js';

interface MockCall {
  systemPrompt: string;
  userMessage: string;
}

/**
 * 最小 mock：每次 chat.completions.create 按队列返回预设响应，并记录入参。
 * 不模拟 streaming / token usage——hydrator 只关心 content 字段。
 */
function makeMockClient(responses: string[]): { client: OpenAI; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const create = vi.fn(async (params: { messages: Array<{ role: string; content: string }> }) => {
    const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
    const usr = params.messages.find((m) => m.role === 'user')?.content ?? '';
    calls.push({ systemPrompt: sys, userMessage: usr });
    const text = responses[i++] ?? responses[responses.length - 1];
    return {
      choices: [{ message: { content: text, role: 'assistant' }, finish_reason: 'stop', index: 0 }],
    };
  });
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    calls,
  };
}

const validOutput = JSON.stringify({
  id: 'test-entry',
  title: 'Test',
  summary: 'summary',
  tags: ['t1'],
  links: [],
  content: '# Test\n- bullet',
});

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    title: o.title ?? '',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? '',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

let tmpDir: string;
let lib: LibraryService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-hyd-'));
  lib = new LibraryService(tmpDir);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('hydrate — 候选 link 预筛', () => {
  it('pool ≤ TOP_N (12) 时全部候选送进 prompt，不筛', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      entry({ id: `c${i}`, title: `entry ${i}`, summary: `s${i}` }),
    );
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: 'short content', // 短 → 不触发 plan
      source: { type: 'inline' },
      collectionId: 'tech',
      linkCandidates: candidates,
    });

    expect(calls).toHaveLength(1); // 短文 + 无 plan = 1 次 LLM call
    // 全部 10 个候选 id 都出现在 user message 里
    for (let i = 0; i < 10; i++) {
      expect(calls[0].userMessage).toContain(`c${i}`);
    }
  });

  it('pool > TOP_N (12) 时按相关性筛 top-N，无关 entry 不入 prompt', async () => {
    // 12 个相关 entry（content 含 "rust"）+ 5 个无关
    const relevant = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `rust-${i}`, title: 'rust internals', content: 'rust rust rust' }),
    );
    const irrelevant = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `unrelated-${i}`, title: 'cooking', content: 'recipe' }),
    );
    const candidates = [...relevant, ...irrelevant];
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: 'a primer on rust ownership',
      source: { type: 'inline' },
      collectionId: 'tech',
      linkCandidates: candidates,
    });

    const userMsg = calls[0].userMessage;
    // 所有相关候选应入选（恰好 12 个等于 TOP_N）
    for (let i = 0; i < 12; i++) expect(userMsg).toContain(`rust-${i}`);
    // 无关候选不应出现
    for (let i = 0; i < 5; i++) expect(userMsg).not.toContain(`unrelated-${i}`);
  });
});

describe('hydrate — plan pass 触发条件', () => {
  it('短文档（< 3000 字符）不触发 plan，只 1 次 LLM call', async () => {
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: 'a'.repeat(500),
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].userMessage).not.toContain('Plan');
  });

  it('长文档（≥ 3000 字符）触发 plan，2 次 LLM call，第二次 user message 含 outline', async () => {
    const planResp = JSON.stringify({
      outline: ['定义', '机制', '权衡'],
      target_chars: 600,
    });
    const { client, calls } = makeMockClient([planResp, validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: 'long content '.repeat(500),
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(calls).toHaveLength(2);
    // 第一次走 PLAN_SYSTEM_PROMPT
    expect(calls[0].systemPrompt).toContain('wiki outliner');
    // 第二次走 SYSTEM_PROMPT，且 user message 注入了 outline + target
    expect(calls[1].systemPrompt).toContain('knowledge curator');
    expect(calls[1].userMessage).toContain('Plan');
    expect(calls[1].userMessage).toContain('1. 定义');
    expect(calls[1].userMessage).toContain('2. 机制');
    expect(calls[1].userMessage).toContain('3. 权衡');
    expect(calls[1].userMessage).toContain('600');
  });

  it('plan 返回非法 JSON → 静默回退到单次模式', async () => {
    // plan 返回非法 JSON；write 返回正常输出
    const { client, calls } = makeMockClient(['not valid json {', validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: 'long content '.repeat(500),
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(entry.id).toBe('test-entry'); // 仍然成功
    expect(calls).toHaveLength(2); // plan 调过一次（即使失败）
    expect(calls[1].userMessage).not.toContain('Plan'); // 但 write user message 里没有 plan 块
  });

  it('conversation 模式即使长也不触发 plan', async () => {
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: '## User\n问题\n\n## Assistant\n回答 '.repeat(500),
      source: { type: 'inline' },
      collectionId: 'tech',
      mode: 'conversation',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toContain('Q&A conversation');
    expect(calls[0].userMessage).not.toContain('Plan');
  });
});

describe('hydrate — id 工程化覆盖（文件源走 filename 派生）', () => {
  it('文件源 + 中文 filename：id 走 filename 派生，忽略 LLM 选的短钩子词', async () => {
    // 模拟 LLM 偷懒只产 "死了么"——派生层应该把它替换成完整 filename
    const lazyLLM = JSON.stringify({
      id: '死了么',
      title: '死了么 APP 复盘',
      summary: 'x',
      tags: ['app'],
      links: [],
      content: '# 死了么\n- 内容',
    });
    const { client } = makeMockClient([lazyLLM]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: '关于死了么 APP 的复盘文章',
      source: { type: 'file', value: '/path/to/source.md' },
      collectionId: 'tech',
      filenameHint: '成本1500，估值1000万？"死了么"APP凭什么火了.md',
    });

    // id 应该包含 filename 里所有关键信号，不止 "死了么"
    expect(entry.id).toContain('成本1500');
    expect(entry.id).toContain('估值1000万');
    expect(entry.id).toContain('死了么');
    expect(entry.id).toContain('app凭什么火了');
    expect(entry.id).not.toBe('死了么'); // 关键反例
  });

  it('inline 源：id 走 LLM 选的（没 filename 可派生）', async () => {
    const llmOutput = JSON.stringify({
      id: 'inline-entry-id',
      title: 'T',
      summary: 's',
      tags: ['t'],
      links: [],
      content: '# T',
    });
    const { client } = makeMockClient([llmOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'inline' },
      collectionId: 'tech',
      // 注意：故意没传 filenameHint
    });

    expect(entry.id).toBe('inline-entry-id');
  });

  it('文件源但 filenameHint 缺失：回退到 LLM id', async () => {
    const llmOutput = JSON.stringify({
      id: 'llm-fallback',
      title: 'T',
      summary: 's',
      tags: ['t'],
      links: [],
      content: '# T',
    });
    const { client } = makeMockClient([llmOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'file', value: '/path/to/source.md' },
      collectionId: 'tech',
      // filenameHint 故意没传（调用方代码 bug 时也要降级而非崩）
    });

    expect(entry.id).toBe('llm-fallback');
  });

  it('文件源 + filename 全是标点：派生为空 → 回退到 LLM id', async () => {
    const llmOutput = JSON.stringify({
      id: 'llm-saves-the-day',
      title: 'T',
      summary: 's',
      tags: ['t'],
      links: [],
      content: '# T',
    });
    const { client } = makeMockClient([llmOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'file', value: '/path/to/x.md' },
      collectionId: 'tech',
      filenameHint: '！？，.md', // 派生后 = ""
    });

    expect(entry.id).toBe('llm-saves-the-day');
  });

  it('conversation 模式即使有 filename 也走 LLM id（语义不同，不该被 filename 锚定）', async () => {
    // 防御性：conversation 通常没 filename，但即便有，也该让 LLM 按"问题视角"选 id，
    // 而不是被一个无关 filename 控制。当前实现：source.type='file' 才覆盖，所以
    // inline-source conversation 自然走 LLM。这条用 inline 源 + filename 锁住意图。
    const llmOutput = JSON.stringify({
      id: '成长与低谷期反思',
      title: 'T',
      summary: 's',
      tags: ['t'],
      links: [],
      content: '# T',
    });
    const { client } = makeMockClient([llmOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const entry = await hydrator.hydrate({
      rawContent: '## User\n成长和低谷期？\n## Assistant\n答',
      source: { type: 'inline' },
      collectionId: 'tech',
      mode: 'conversation',
      filenameHint: '无关文件.md', // 不应被采纳
    });

    expect(entry.id).toBe('成长与低谷期反思');
  });
});
