/**
 * Hydration system prompt 内容断言。
 *
 * 这套测试不调 LLM、不测脱水质量，只断言 prompt 文本里包含
 * 几条"不可回退"的硬约束。如果有人改 prompt 时不小心删掉了
 * 语言保持或字数上限，这里会立刻 fail。
 *
 * 背景：v0.1 时观察到中文 README ingest 后被翻译成英文（issue #6），
 * 修复方式是在 prompt 里加显式的语言保持 + 硬性字数上限。
 * 这些断言把那次修复"焊死"，避免回退。
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/wiki/hydration.js';

describe('Hydration SYSTEM_PROMPT — 不可回退的硬约束', () => {
  it('包含语言保持要求（避免中文输入被翻译成英文）', () => {
    // 关键词必须存在；具体措辞可以变，但概念必须在。
    expect(SYSTEM_PROMPT).toMatch(/SAME PRIMARY LANGUAGE|same.*language/i);
    expect(SYSTEM_PROMPT).toMatch(/Chinese.*Chinese|do not translate/i);
  });

  it('包含字数硬上限（不再是 "aim for"）', () => {
    // 必须出现 400 这个数字 + "must"/"under" 表达的硬约束。
    expect(SYSTEM_PROMPT).toMatch(/400/);
    expect(SYSTEM_PROMPT).toMatch(/must|MUST/);
  });

  it('包含 CJK 字符量的提示（中文按字符数估算）', () => {
    // 中文不能用英文 word 数衡量；prompt 应给出对应字符上限。
    expect(SYSTEM_PROMPT).toMatch(/Chinese characters|CJK/);
  });

  it('要求 ids 和 tags 保持 kebab-case ASCII（即使输入是中文）', () => {
    // 这是为了让中文条目的文件名 / 链接仍然兼容文件系统与 URL。
    expect(SYSTEM_PROMPT).toMatch(/kebab-case/);
    expect(SYSTEM_PROMPT).toMatch(/ASCII|lowercase/i);
  });

  it('明确压缩比预期，分稠密源与稀疏源', () => {
    expect(SYSTEM_PROMPT).toMatch(/compression/i);
    // 至少出现一个具体的比率数字（0.3 或 0.5）。
    expect(SYSTEM_PROMPT).toMatch(/0\.[35]|30%|50%/);
  });

  it('要求 [[concept-id]] 内联引用格式', () => {
    expect(SYSTEM_PROMPT).toContain('[[concept-id]]');
  });

  it('要求严格 JSON 输出，禁止 code fence 与额外文本', () => {
    expect(SYSTEM_PROMPT).toMatch(/STRICT JSON/i);
    expect(SYSTEM_PROMPT).toMatch(/no code fences|no commentary/i);
  });

  it('JSON shape 模板包含全部 6 个必需字段', () => {
    for (const field of ['id', 'title', 'summary', 'tags', 'links', 'content']) {
      expect(SYSTEM_PROMPT).toContain(`"${field}"`);
    }
  });

  it('禁止 marketing 语言、转场词、第一人称', () => {
    // 这条约束保证脱水产物是"中性陈述"，便于二次混入其他 prompt。
    expect(SYSTEM_PROMPT).toMatch(/marketing|transitions|first-person/i);
  });
});
