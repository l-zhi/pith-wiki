/**
 * pith 世界 → pi-agent-core 世界的接线（bootstrap 用的就是这两个函数本体）。
 *
 * 重点验证：适配后**跑的还是 pith 原来的 handler 和 ToolContext** —— 沙箱、审批、
 * skill 注册表这些能力是「跟着 ctx 过去的」，不是在 pi 那侧重建的。
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS, type AnyToolDef, type ToolContext } from '@core/tools/index.js';
import { buildScopePreamble, toToolSpecs } from '../src/engine/piCoreWiring.js';

function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    assembler: { query: () => ({ context: '', references: [] }) },
    ...overrides,
  } as unknown as ToolContext;
}

const echoTool: AnyToolDef = {
  name: 'echo',
  description: 'Echo back',
  parameters: z.object({
    text: z.string(),
    times: z.number().int().default(1),
  }),
  handler: async (args: { text: string; times: number }, ctx: ToolContext) => ({
    ok: true,
    said: args.text.repeat(args.times),
    sawCtx: Boolean(ctx),
  }),
};

describe('toToolSpecs', () => {
  it('保留名字/描述并把 zod 转成 JSON Schema（用真实的核心工具，走生产同一条路）', () => {
    // 注意：必须用**核心层**的工具做这条断言。`toolsForOpenAI` 的手写转换器靠
    // `instanceof z.ZodObject` 判类型，而 desktop 有自己的一份 zod 副本 —— 用测试里
    // 现造的 zod schema 会因为跨副本 instanceof 失败而退化成 `{}`。生产路径上工具
    // 全部来自核心层（ALL_TOOLS + core 造的 extraTools），与 toolsForOpenAI 同一份 zod。
    const wikiList = ALL_TOOLS.find((t) => t.name === 'wiki_list')!;
    const [spec] = toToolSpecs([wikiList], fakeCtx());
    expect(spec.name).toBe('wiki_list');
    expect(spec.description.length).toBeGreaterThan(0);
    expect(spec.parameters).toMatchObject({
      type: 'object',
      properties: { collection: { type: 'string' }, tags: { type: 'array' } },
    });
    // limit 有 default → 非必填
    expect((spec.parameters as { required: string[] }).required).not.toContain('limit');
  });

  it('execute 调的是 pith 原 handler，且拿到的是 zod 解析后的值（default 已填充）', async () => {
    const [spec] = toToolSpecs([echoTool], fakeCtx());
    const result = (await spec.execute({ text: 'ab' })) as Record<string, unknown>;
    expect(result).toEqual({ ok: true, said: 'ab', sawCtx: true });
  });

  it('ctx 原样透传 —— 审批/沙箱这些能力跟着 ctx 过去，不在 pi 侧重建', async () => {
    const requestCommandApproval = vi.fn(async () => 'no' as const);
    const probeTool: AnyToolDef = {
      name: 'probe',
      description: 'probe ctx',
      parameters: z.object({}),
      handler: async (_args: unknown, ctx: ToolContext) => {
        await ctx.requestCommandApproval?.('ls', 'ls -la');
        return { ok: true };
      },
    };
    const [spec] = toToolSpecs([probeTool], fakeCtx({ requestCommandApproval }));
    await spec.execute({});
    expect(requestCommandApproval).toHaveBeenCalledWith('ls', 'ls -la');
  });

  it('参数不合法 → 返回 pith 语义的错误对象（不 throw，让模型自我纠正）', async () => {
    const [spec] = toToolSpecs([echoTool], fakeCtx());
    const result = (await spec.execute({ times: 'oops' })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Invalid arguments/);
  });

  it('handler 抛错 → 同样收敛成错误对象', async () => {
    const boom: AnyToolDef = {
      name: 'boom',
      description: 'always throws',
      parameters: z.object({}),
      handler: async () => {
        throw new Error('disk on fire');
      },
    };
    const [spec] = toToolSpecs([boom], fakeCtx());
    expect(await spec.execute({})).toEqual({ ok: false, error: 'disk on fire' });
  });
});

describe('buildScopePreamble', () => {
  it('空 scope → 空串（不注入）', () => {
    expect(buildScopePreamble(fakeCtx(), 'q', { collections: [], folders: [], entryIds: [] })).toBe('');
  });

  it('召回为空 → 空串（别塞一段没内容的说明）', () => {
    const ctx = fakeCtx({
      assembler: { query: () => ({ context: '', references: [] }) },
    } as unknown as Partial<ToolContext>);
    expect(buildScopePreamble(ctx, 'q', { collections: ['tech'], folders: [], entryIds: [] })).toBe('');
  });

  it('有召回 → 渲染成带范围说明的前置上下文', () => {
    const query = vi.fn(() => ({ context: '## deepseek-v4\n正文…', references: [] }));
    const ctx = fakeCtx({ assembler: { query } } as unknown as Partial<ToolContext>);
    const out = buildScopePreamble(ctx, '有什么？', {
      collections: ['tech'],
      folders: [],
      entryIds: ['deepseek-v4'],
    });
    expect(query).toHaveBeenCalledWith('有什么？', 4000, {
      collections: ['tech'],
      folders: [],
      entryIds: ['deepseek-v4'],
    });
    expect(out).toContain('collections: tech');
    expect(out).toContain('pinned entries: deepseek-v4');
    expect(out).toContain('## deepseek-v4');
  });
});
