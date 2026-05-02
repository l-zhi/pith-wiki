/**
 * 嵌入用例端到端冒烟测试。
 *
 * 模拟一个 Electron / Node 后端宿主把 llm-wiki 当库用：
 *   defineConfig → LibraryService → buildContext → Agent 构造
 *
 * 不真打 LLM（用 mock OpenAI client），只验：
 *   - defineConfig 是纯函数：不读 process.env、不读家目录配置
 *   - LibraryService 在自定义 wikiRoot 下能 put/get/list
 *   - buildContext 把 requestApproval 回调正确装到 ToolContext
 *   - Agent 构造接受 options（systemPrompt / extraTools / maxSteps）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineConfig,
  LibraryService,
  ContextAssembler,
  buildContext,
  Agent,
  defaultSystemPrompt,
  type ToolDef,
  type ApprovalAnswer,
} from '../src/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-lib-api-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('defineConfig (库模式纯函数)', () => {
  it('用最小输入构造 Config，不读 env', () => {
    // 故意把一个干扰 env 留着——defineConfig 不该读它
    const before = process.env.LLM_WIKI_BASE_URL;
    process.env.LLM_WIKI_BASE_URL = 'https://from-env.example.com';
    try {
      const config = defineConfig({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        wikiRoot: tmpDir,
      });
      expect(config.apiKey).toBe('sk-test');
      expect(config.baseURL).toBe('https://api.deepseek.com'); // 不被 env 干扰
      expect(config.model).toBe('deepseek-chat');
      expect(config.wikiRoot).toBe(path.resolve(tmpDir));
      expect(config.workspaceRoot).toBe(path.resolve(tmpDir)); // 默认 = wikiRoot
    } finally {
      if (before === undefined) delete process.env.LLM_WIKI_BASE_URL;
      else process.env.LLM_WIKI_BASE_URL = before;
    }
  });

  it('队列 / output / history 路径默认派生自 wikiRoot（不落到 ~/.llm-wiki/）', () => {
    const config = defineConfig({
      apiKey: 'sk',
      baseURL: 'https://x',
      model: 'm',
      wikiRoot: tmpDir,
    });
    expect(config.queueStatePath).toBe(path.join(tmpDir, '.queue', 'state.json'));
    expect(config.queueLogDir).toBe(path.join(tmpDir, '.queue', 'logs'));
    expect(config.historyFile).toBe(path.join(tmpDir, '.history'));
    expect(config.outputDir).toBe(path.join(tmpDir, 'output', 'transcripts'));
    // 不应该出现 ~/.llm-wiki 字样
    expect(config.queueStatePath).not.toContain('.llm-wiki');
    expect(config.outputDir).not.toContain('.llm-wiki');
  });
});

describe('LibraryService 嵌入用法', () => {
  it('在自定义 wikiRoot 下 put/get/list', () => {
    const lib = new LibraryService(tmpDir);
    lib.put({
      id: 'react-hooks',
      collection: 'tech',
      title: 'React Hooks',
      summary: 'useState 与陷阱',
      tags: ['react'],
      links: [],
      content: '...内容...',
      source: { type: 'inline' },
      updated: new Date().toISOString(),
    });
    const got = lib.get('react-hooks', 'tech');
    expect(got?.title).toBe('React Hooks');
    expect(lib.list('tech').map((e) => e.id)).toContain('react-hooks');
  });
});

describe('ContextAssembler 不需要 LLM 也能用', () => {
  it('keyword 检索返回 context + references', () => {
    const lib = new LibraryService(tmpDir);
    lib.put({
      id: 'rag-basics',
      collection: 'ai',
      title: 'RAG 基础',
      summary: '检索增强生成的核心思想',
      tags: ['rag', 'llm'],
      links: [],
      content: 'RAG 是把检索拼到生成前面的范式。',
      source: { type: 'inline' },
      updated: new Date().toISOString(),
    });
    const assembler = new ContextAssembler(lib);
    const result = assembler.query('RAG');
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references[0]?.id).toBe('rag-basics');
  });
});

describe('buildContext 把 requestApproval 回调装好', () => {
  it('回调被原样持有，可后续触发', () => {
    const config = defineConfig({
      apiKey: 'sk',
      baseURL: 'https://x',
      model: 'm',
      wikiRoot: tmpDir,
    });
    const fakeClient = {} as never; // ContextAssembler/HydrationService 接受任意 OpenAI 类型
    const calls: Array<{ p: string; preview: string }> = [];
    const ctx = buildContext(
      config,
      fakeClient,
      async (p: string, preview: string): Promise<ApprovalAnswer> => {
        calls.push({ p, preview });
        return 'no';
      },
    );
    expect(typeof ctx.requestApproval).toBe('function');
    // 模拟工具调用层触发
    ctx.requestApproval('/tmp/x.md', 'preview content');
    expect(calls).toEqual([{ p: '/tmp/x.md', preview: 'preview content' }]);
  });
});

describe('Agent options 注入', () => {
  it('自定义 systemPrompt 会替换默认，extraTools 加入注册表', () => {
    const config = defineConfig({
      apiKey: 'sk',
      baseURL: 'https://x',
      model: 'm',
      wikiRoot: tmpDir,
    });
    const fakeClient = {} as never;
    const ctx = buildContext(config, fakeClient, async () => 'no');

    const myParam = z.object({ msg: z.string() });
    const myTool: ToolDef<typeof myParam> = {
      name: 'my_custom_tool',
      description: 'A host-injected tool',
      parameters: myParam,
      handler: async () => ({ ok: true }),
    };

    const agent = new Agent(fakeClient, config.model, ctx, {
      systemPrompt: 'You are MyApp.',
      maxSteps: 5,
      extraTools: [myTool],
    });

    // hasContent() 在 reset 之后只剩 system 消息 → false
    expect(agent.hasContent()).toBe(false);
    // 默认 prompt 与自定义 prompt 不同
    expect(defaultSystemPrompt).not.toContain('MyApp');
  });
});
