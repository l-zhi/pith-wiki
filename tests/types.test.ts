/**
 * Schema 校验单元测试。
 *
 * 测试范围（仅外部行为）：
 * - EntrySchema：id 正则、必填字段、默认值、Date 字段拒绝
 * - SourceSchema：type 枚举校验
 * - HydrationOutputSchema：与 Entry 共享的 id 规则
 *
 * Schema 是数据契约，错误的输入应该在边界处就被拒绝，
 * 不能让 LLM 返回的脏数据流到 LibraryService 把整个库写坏。
 */
import { describe, expect, it } from 'vitest';
import { EntrySchema, HydrationOutputSchema, SourceSchema } from '../src/wiki/types.js';

describe('EntrySchema — id 校验', () => {
  it('接受标准 kebab-case id', () => {
    const result = EntrySchema.safeParse({
      id: 'agent-retry-policy',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('接受单字母 id', () => {
    // ^[a-z0-9][a-z0-9-]*$ 允许长度 1。
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('接受以数字开头的 id', () => {
    // ^[a-z0-9] 允许首字符是数字。
    const result = EntrySchema.safeParse({
      id: '2024-trends',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('拒绝包含大写字母的 id', () => {
    const result = EntrySchema.safeParse({
      id: 'Agent-Design',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝包含空格的 id', () => {
    const result = EntrySchema.safeParse({
      id: 'agent design',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝以连字符开头的 id', () => {
    const result = EntrySchema.safeParse({
      id: '-bad',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝空字符串 id', () => {
    const result = EntrySchema.safeParse({
      id: '',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('接受纯中文 id（用于源文件名是中文的场景）', () => {
    const result = EntrySchema.safeParse({
      id: '成长经历',
      collection: 'tech',
      title: '成长经历',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('接受中文 + ASCII 连字符混合 id', () => {
    const result = EntrySchema.safeParse({
      id: '成长-2025',
      collection: 'tech',
      title: '成长',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('拒绝带空格的中文 id（文件名安全约束）', () => {
    const result = EntrySchema.safeParse({
      id: '成长 经历',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝带点的 id（避免与文件扩展名混淆）', () => {
    const result = EntrySchema.safeParse({
      id: '成长.记录',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝大写 ASCII id（保持 kebab-case 视觉一致性）', () => {
    const result = EntrySchema.safeParse({
      id: 'MyEntry',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('拒绝下划线（应该用连字符）', () => {
    const result = EntrySchema.safeParse({
      id: 'agent_design',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('EntrySchema — 默认值和必填', () => {
  it('summary、tags、links 缺省时填默认值', () => {
    const result = EntrySchema.parse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.summary).toBe('');
    expect(result.tags).toEqual([]);
    expect(result.links).toEqual([]);
    // source 也有默认值。
    expect(result.source).toEqual({ type: 'unknown' });
  });

  it('title 必填且不可为空字符串', () => {
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: '',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('collection 必填且不可为空', () => {
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: '',
      title: 'A',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('updated 字段必须是字符串（拒绝 Date 对象）', () => {
    // 这条用例锁定一个真实踩过的坑：gray-matter 反解析 YAML 日期会得到 Date 实例，
    // schema 必须严格要求 string，library 层负责归一化。
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      content: 'x',
      updated: new Date(), // 这里故意传 Date 对象
    });
    expect(result.success).toBe(false);
  });
});

describe('EntrySchema — 中文与 Unicode 字段', () => {
  it('title 接受中文', () => {
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'Agent 设计模式与可靠性',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('summary 接受中文长句', () => {
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      summary: '这是一个用于测试的中文摘要，包含标点符号、空格 以及英文 mix。',
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('tags 接受中文数组', () => {
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      tags: ['可靠性', '设计模式', 'design-pattern'],
      content: 'x',
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('content 接受任意 Markdown 与中文混排', () => {
    const md = `# 标题\n\n- 第一条\n- 第二条\n\n\`\`\`ts\nconst foo = '中文字符串';\n\`\`\``;
    const result = EntrySchema.safeParse({
      id: 'a',
      collection: 'tech',
      title: 'A',
      content: md,
      updated: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('EntrySchema — compressionRatio', () => {
  it('compressionRatio 在 [0, 1] 范围内被接受', () => {
    expect(
      EntrySchema.safeParse({
        id: 'a',
        collection: 'tech',
        title: 'A',
        content: 'x',
        updated: new Date().toISOString(),
        compressionRatio: 0.5,
      }).success,
    ).toBe(true);
  });

  it('compressionRatio 为 0 被接受（理论极限）', () => {
    expect(
      EntrySchema.safeParse({
        id: 'a',
        collection: 'tech',
        title: 'A',
        content: 'x',
        updated: new Date().toISOString(),
        compressionRatio: 0,
      }).success,
    ).toBe(true);
  });

  it('compressionRatio 大于 1 被拒绝', () => {
    expect(
      EntrySchema.safeParse({
        id: 'a',
        collection: 'tech',
        title: 'A',
        content: 'x',
        updated: new Date().toISOString(),
        compressionRatio: 1.5,
      }).success,
    ).toBe(false);
  });

  it('compressionRatio 缺省可以省略', () => {
    expect(
      EntrySchema.safeParse({
        id: 'a',
        collection: 'tech',
        title: 'A',
        content: 'x',
        updated: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });
});

describe('SourceSchema', () => {
  it('type=url 且带 value 被接受', () => {
    const result = SourceSchema.safeParse({ type: 'url', value: 'https://example.com' });
    expect(result.success).toBe(true);
  });

  it('type=inline 不带 value 被接受', () => {
    const result = SourceSchema.safeParse({ type: 'inline' });
    expect(result.success).toBe(true);
  });

  it('未知 type 被拒绝（枚举强约束）', () => {
    const result = SourceSchema.safeParse({ type: 'foo' });
    expect(result.success).toBe(false);
  });

  it('四种合法 type 全部通过', () => {
    for (const type of ['url', 'file', 'inline', 'unknown'] as const) {
      expect(SourceSchema.safeParse({ type }).success).toBe(true);
    }
  });
});

describe('HydrationOutputSchema', () => {
  it('完整 LLM 输出被接受', () => {
    const result = HydrationOutputSchema.safeParse({
      id: 'agent-retry',
      title: 'Agent 重试逻辑',
      summary: '在失败下重试 agent 工具调用的常见模式。',
      tags: ['agent', 'retry'],
      links: ['error-handling'],
      content: '# Agent 重试逻辑\n- 指数退避 + jitter',
    });
    expect(result.success).toBe(true);
  });

  it('summary、tags、links 缺省时填默认值', () => {
    // LLM 偶尔会偷懒不返回这些字段，schema 不应让整个流水线挂掉。
    const result = HydrationOutputSchema.parse({
      id: 'a',
      title: 'A',
      content: 'x',
    });
    expect(result.summary).toBe('');
    expect(result.tags).toEqual([]);
    expect(result.links).toEqual([]);
  });

  it('content 必填且不可为空（脱水必须输出有内容）', () => {
    const result = HydrationOutputSchema.safeParse({
      id: 'a',
      title: 'A',
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('id 共享 EntrySchema 的 kebab-case 规则', () => {
    const result = HydrationOutputSchema.safeParse({
      id: 'Agent-Design', // 大写
      title: 'A',
      content: 'x',
    });
    expect(result.success).toBe(false);
  });
});
