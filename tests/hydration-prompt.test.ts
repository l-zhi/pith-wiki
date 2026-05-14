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
import { CONVERSATION_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../src/wiki/hydration.js';

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

  it('tags 保持 kebab-case ASCII（即使输入是中文）— 跨语言过滤一致性', () => {
    // tags 仍是 kebab-case ASCII：不同语言的内容也能用同一组 tag 过滤。
    expect(SYSTEM_PROMPT).toMatch(/Tags.*lowercase ASCII|Tags.*kebab/);
  });

  it('ID 命名按源语言分流：中文源 → 中文 id；英文源 → kebab-case ASCII', () => {
    // 核心变化：filename / content 是中文时允许 id 用汉字，便于文件系统里直接
    // 看到"成长经历.md"这种自然命名，而不是"cheng-zhang-jing-li.md"。
    expect(SYSTEM_PROMPT).toMatch(/ID NAMING/);
    expect(SYSTEM_PROMPT).toMatch(/predominantly Chinese|Han characters/);
    // 给一个具体例子焊死意图
    expect(SYSTEM_PROMPT).toMatch(/成长经历|成长/);
    // 仍要保留 kebab-case ASCII 作为兜底（英文/混合 Latin 走这条）
    expect(SYSTEM_PROMPT).toMatch(/kebab-case ASCII/);
  });

  it('ID 必须保留源文件名的特异性，不能压成单一钩子词', () => {
    // 背景：实际用户反馈中观察到模型把"成本1500，估值1000万？死了么APP凭什么火了"
    // 压成单一的"死了么"，丢失了成本/估值/凭什么火三个关键角度。
    // 这条断言把"反例 + 正例"焊死，避免改 prompt 时把这条经验删掉。
    expect(SYSTEM_PROMPT).toMatch(/preserve.*specificity|specificity rule/i);
    // 反例存在
    expect(SYSTEM_PROMPT).toContain('死了么');
    // 长度建议（让 LLM 知道 4-6 字"够短就好"是错的）
    expect(SYSTEM_PROMPT).toMatch(/6-14|6 to 14/);
    // 明确的 BAD 标识，模型才能识别这是反例
    expect(SYSTEM_PROMPT).toMatch(/Anti-pattern|BAD|❌/);
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

  it('tags 仍是 kebab-case ASCII（即使对话是中文）— 跨语言过滤一致性', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/Tags.*lowercase ASCII|Tags.*kebab/);
  });

  it('对话 id 按主语言分流：中文对话 → 中文 id；英文对话 → kebab-case ASCII', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/ID NAMING/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/predominantly Chinese|Han characters/);
    // 给一个具体例子焊死意图（对应"成长与低谷期"那个具体不变量）
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/成长与低谷期|成长/);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/kebab-case ASCII/);
  });

  it('对话 id 同样要保留问题特异性，不能压成单一短词', () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/specificity rule|preserve.*question/i);
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/6-14|6 to 14/);
    // 反例：成长 → 丢了 "低谷期" 角度
    expect(CONVERSATION_SYSTEM_PROMPT).toMatch(/Bad|BAD|❌/);
  });
});

/**
 * Plan pass 专用 prompt。长文档（≥ 3000 字符）走 plan-then-write 两遍生成，
 * 这里焊死 plan 阶段必须出的 outline + target_chars + 保持源语言三条。
 */
describe('PLAN_SYSTEM_PROMPT — 长文规划阶段的硬约束', () => {
  it('要求严格 JSON 输出', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/STRICT JSON/i);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/no code fences|no commentary/i);
  });

  it('JSON shape 包含 outline + target_chars 两个字段', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('"outline"');
    expect(PLAN_SYSTEM_PROMPT).toContain('"target_chars"');
  });

  it('outline 限制 3-7 节，避免过细或过粗', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/3-7/);
  });

  it('保留源语言（heading 不翻译）', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/SAME PRIMARY LANGUAGE|same.*language/i);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/do not translate|Chinese.*Chinese/i);
  });

  it('target_chars 有上限约束（避免规划出 5000 字大长文）', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/1000|under 1000/);
  });

  it('禁止凭空虚构源没支持的章节', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/DO NOT invent|don'?t invent|does(n'?| not) support/i);
  });
});
