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
import { HydrationService, sanitizeHydrationInput } from '../src/wiki/hydration.js';
import { LibraryService } from '../src/wiki/library.js';
import type { Entry } from '../src/wiki/types.js';

interface MockCall {
  systemPrompt: string;
  userMessage: string;
  // 整个入参 —— 让断言"是否传了 response_format"这类外围参数也能 cover
  params: Record<string, unknown>;
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
    calls.push({ systemPrompt: sys, userMessage: usr, params: params as Record<string, unknown> });
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

describe('hydrate — supportsJsonMode 开关', () => {
  it('默认（4th arg 省略）→ 传 response_format=json_object', async () => {
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(calls[0].params.response_format).toEqual({ type: 'json_object' });
  });

  it('supportsJsonMode=false → 完全不传 response_format（给 doubao coding endpoint 类）', async () => {
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib, false);

    await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(calls[0].params).not.toHaveProperty('response_format');
  });

  it('supportsJsonMode=false 时 plan pass 也不传 response_format', async () => {
    // 长文 + 默认 document 模式 → 触发 plan
    const planResp = JSON.stringify({ outline: ['a', 'b'], target_chars: 600 });
    const { client, calls } = makeMockClient([planResp, validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib, false);

    await hydrator.hydrate({
      rawContent: 'long '.repeat(700),
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].params).not.toHaveProperty('response_format'); // plan call
    expect(calls[1].params).not.toHaveProperty('response_format'); // write call
  });

  it('supportsJsonMode=false 下，LLM 包 markdown fence 的输出仍能被 extractJson 救出', async () => {
    // 模拟非严格 JSON mode 下模型的典型输出：套上 ```json ... ```
    const fenced = '好的，这是结果：\n```json\n' + validOutput + '\n```';
    const { client } = makeMockClient([fenced]);
    const hydrator = new HydrationService(client, 'test-model', lib, false);

    const out = await hydrator.hydrate({
      rawContent: 'x',
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(out.id).toBe('test-entry'); // extractJson 剥 fence 成功
  });
});

describe('hydrate — JSON 自修复轮（repairJsonViaModel）', () => {
  // 病灶样本：summary 字符串值内有未转义的西文双引号（doubao prompt 模式实测形态）
  const brokenOutput =
    '{"id": "test-entry", "title": "Test", "summary": "挂在"深圳市赞达贸易"名下", "tags": ["t1"], "links": [], "content": "# Test"}';
  const repairedOutput = JSON.stringify({
    id: 'test-entry',
    title: 'Test',
    summary: '挂在"深圳市赞达贸易"名下',
    tags: ['t1'],
    links: [],
    content: '# Test',
  });

  it('首轮输出非法 JSON → 自动追加修复轮，修好即成功', async () => {
    const { client, calls } = makeMockClient([brokenOutput, repairedOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib);

    const out = await hydrator.hydrate({
      rawContent: 'short content',
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    expect(out.summary).toBe('挂在"深圳市赞达贸易"名下');
    expect(calls).toHaveLength(2); // 写入轮 + 修复轮
    // 修复轮收到的就是原始坏输出，且 system prompt 是修复器指令
    expect(calls[1].userMessage).toBe(brokenOutput);
    expect(calls[1].systemPrompt).toContain('JSON syntax repairer');
  });

  it('修复轮仍不合法 → 回抛原始 HydrationJsonError（带原始 raw）', async () => {
    const { client, calls } = makeMockClient([brokenOutput, 'still { not json']);
    const hydrator = new HydrationService(client, 'test-model', lib);

    await expect(
      hydrator.hydrate({
        rawContent: 'short content',
        source: { type: 'inline' },
        collectionId: 'tech',
      }),
    ).rejects.toMatchObject({ name: 'HydrationJsonError', rawResponse: brokenOutput });
    expect(calls).toHaveLength(2); // 只修一次，不无限重试
  });
});

describe('sanitizeHydrationInput — 剥图 + 截断', () => {
  const dataUri = 'data:image/png;base64,' + 'A'.repeat(400);

  it('剥掉 markdown data:URI 图片，换成 [image]', () => {
    const { text, strippedImages } = sanitizeHydrationInput(`前\n![截图](${dataUri})\n后`);
    expect(text).toBe('前\n[image]\n后');
    expect(strippedImages).toBe(true);
    expect(text).not.toContain('base64');
  });

  it('剥掉 HTML <img src="data:…"> 与裸露的超长 base64', () => {
    expect(sanitizeHydrationInput(`<img alt="x" src="${dataUri}">`).text).toBe('[image]');
    expect(sanitizeHydrationInput(`噪声 ${dataUri} 噪声`).text).toBe('噪声 [image] 噪声');
  });

  it('保留普通 http 图片链接（不是 token 炸弹）', () => {
    const md = '![logo](https://ex.com/a.png)';
    expect(sanitizeHydrationInput(md).text).toBe(md);
  });

  it('超过上限则截断并加省略标注', () => {
    const { text, truncated } = sanitizeHydrationInput('x'.repeat(100), 40);
    expect(truncated).toBe(true);
    expect(text.startsWith('x'.repeat(40))).toBe(true);
    expect(text).toContain('truncated: 60 chars omitted');
  });

  it('未超限且无图片 → 原样返回', () => {
    const { text, truncated, strippedImages } = sanitizeHydrationInput('干净短文本');
    expect(text).toBe('干净短文本');
    expect(truncated).toBe(false);
    expect(strippedImages).toBe(false);
  });
});

describe('hydrate — 输入清洗贯穿到请求', () => {
  it('base64 图片被剥、超长被截断后才进 user message', async () => {
    const { client, calls } = makeMockClient([validOutput]);
    const hydrator = new HydrationService(client, 'test-model', lib, true, 500);
    const bomb = 'data:image/png;base64,' + 'A'.repeat(5000);
    await hydrator.hydrate({
      rawContent: `开头\n![图](${bomb})\n` + '正文'.repeat(1000),
      source: { type: 'inline' },
      collectionId: 'tech',
    });
    const msg = calls[0].userMessage;
    expect(msg).not.toContain('base64'); // 图片已剥
    expect(msg).toContain('[image]');
    expect(msg).toContain('truncated'); // 超 500 字符已截断
  });
});
