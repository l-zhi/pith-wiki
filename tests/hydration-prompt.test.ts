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
import { CONVERSATION_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../src/wiki/hydration.js';

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

/**
 * Conversation digest 专用 prompt。/digest 命令用这个；它的关键不变量
 * 与 SYSTEM_PROMPT 不同：必须保留用户提问的视角，不能把对话当成单边材料压缩。
 *
 * 背景：用户反馈"问了成长和低谷期，digest 出来却是成长经历"——
 * 这套断言把"问题视角不可丢失"焊死。
 */
describe('CONVERSATION_SYSTEM_PROMPT — Q&A 不可回退的硬约束', () => {
  it('显式说明输入是 user/assistant 多轮对话', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/## User/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/## Assistant/);
  });

  it('强制保留用户提问的视角，不能只总结回复', () => {
    // 关键不变量：title/summary 必须反映"用户问了什么"
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/PRESERVE THE QUESTION|preserve the question/i);
    // 应明确禁止"只总结 assistant"
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/NOT to summarize only|only the assistant/i);
  });

  it('显式举出"成长和低谷期 → 成长经历"反例（具体不变量）', () => {
    // 把用户原话举的例子焊死，避免改 prompt 时不小心把这条"经验教训"删掉
    expect(CONVERSATION_SYSTEM_PROMPT).toContain('成长和低谷期');
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/成长经历/);
  });

  it('要求 content 用 Q/A 段结构按对话顺序保留', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/## Q:/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/order|conversational order/i);
  });

  it('tags 同时覆盖用户问的角度和答案的领域', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/angle.*domain|both/i);
  });

  it('保留语言（不翻译）', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/SAME PRIMARY LANGUAGE|same.*language/i);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/Chinese.*Chinese|do not translate/i);
  });

  it('字数硬上限（同 SYSTEM_PROMPT 一致）', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/400/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/Chinese characters|CJK/);
  });

  it('严格 JSON 输出 + 6 个字段', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/STRICT JSON/i);
    for (const field of ['id', 'title', 'summary', 'tags', 'links', 'content']) {
      expect(CONVERSATION_SYSTEM_PROMPT).toContain(`"${field}"`);
    }
  });

  it('id / tags 仍是 kebab-case ASCII（即使对话是中文）', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/kebab-case/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/ASCII|lowercase/i);
  });
});
