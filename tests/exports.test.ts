/**
 * 公共库出口契约测试。
 *
 * 目的：保证 5 个 subpath 都能正常 import，且每条都导出关键的命名符号。
 * 任何 step 2 入口文件被误删 / re-export 漏写都会在这里立刻断。
 *
 * 注：这个测试走的是源码路径（`../src/...`），用 vitest 的 ESM 解析器。
 * 包发布形态的端到端校验（`npm install <tgz>` + 5 个 subpath import）放在
 * scripts/check-no-cli-leak.mjs（产物层）+ Checkpoint B 手动验证。
 */
import { describe, expect, it } from 'vitest';

describe('llm-wiki public exports', () => {
  it('main entry re-exports core API', async () => {
    const m = await import('../src/index.js');
    // 三层服务
    expect(typeof m.LibraryService).toBe('function');
    expect(typeof m.HydrationService).toBe('function');
    expect(typeof m.ContextAssembler).toBe('function');
    // Agent + client
    expect(typeof m.Agent).toBe('function');
    expect(typeof m.AgentError).toBe('function');
    expect(typeof m.createClient).toBe('function');
    expect(typeof m.defaultSystemPrompt).toBe('string');
    // tools
    expect(typeof m.buildContext).toBe('function');
    expect(typeof m.toolsForOpenAI).toBe('function');
    expect(Array.isArray(m.ALL_TOOLS)).toBe(true);
    expect(m.TOOL_REGISTRY instanceof Map).toBe(true);
    // config
    expect(typeof m.defineConfig).toBe('function');
  });

  it('llm-wiki/wiki subpath', async () => {
    const m = await import('../src/wiki/index.js');
    expect(typeof m.LibraryService).toBe('function');
    expect(typeof m.HydrationService).toBe('function');
    expect(typeof m.ContextAssembler).toBe('function');
    expect(typeof m.runBatch).toBe('function');
    // schemas
    expect(typeof m.EntrySchema.parse).toBe('function');
    expect(typeof m.SourceSchema.parse).toBe('function');
    expect(typeof m.HydrationOutputSchema.parse).toBe('function');
  });

  it('llm-wiki/agent subpath', async () => {
    const m = await import('../src/llm/index.js');
    expect(typeof m.Agent).toBe('function');
    expect(typeof m.AgentError).toBe('function');
    expect(typeof m.createClient).toBe('function');
    expect(typeof m.defaultSystemPrompt).toBe('string');
    expect(m.defaultSystemPrompt.length).toBeGreaterThan(100);
    // 中性化检查：去掉了 "CLI assistant" 字面措辞
    expect(m.defaultSystemPrompt).not.toContain('CLI assistant');
  });

  it('llm-wiki/tools subpath', async () => {
    const m = await import('../src/tools/index.js');
    expect(typeof m.buildContext).toBe('function');
    expect(typeof m.toolsForOpenAI).toBe('function');
    expect(Array.isArray(m.ALL_TOOLS)).toBe(true);
    expect(m.ALL_TOOLS.length).toBeGreaterThan(0);
    expect(m.TOOL_REGISTRY instanceof Map).toBe(true);
    // 每个工具至少有 name / description / parameters / handler
    for (const t of m.ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.parameters.parse).toBe('function');
      expect(typeof t.handler).toBe('function');
    }
  });

  it('llm-wiki/config subpath', async () => {
    const m = await import('../src/config.js');
    expect(typeof m.defineConfig).toBe('function');
    expect(typeof m.loadConfigFromEnv).toBe('function');
    expect(typeof m.loadConfig).toBe('function'); // deprecated 别名
    // applyActiveProvider / parseReadPathsFromEnv 是 sub-helper
    expect(typeof m.applyActiveProvider).toBe('function');
    expect(typeof m.parseReadPathsFromEnv).toBe('function');
  });
});
