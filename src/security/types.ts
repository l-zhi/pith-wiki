import { z } from 'zod';

/**
 * 数据安全模块的类型 + 规则文件 schema。
 *
 * 规则文件（security.json）声明两类内容：
 *   - presets: 内置 PII 检测器的逐项开关（mask / block / off），缺省全部 mask
 *   - rules:   用户自定义规则（关键词字面量或正则），分 mask / block 两级
 *
 * 语义分级：
 *   - block: 出站请求中命中 → 整个请求拒发（抛 SecurityBlockError）
 *   - mask:  命中片段替换为可还原占位符（如 [PHONE_1]）后继续发送
 */

/** 占位符 label 形状：大写字母开头，后续大写/数字/下划线。还原正则依赖这个约束。 */
export const LABEL_RE = /^[A-Z][A-Z0-9_]*$/;

/** 还原扫描用：匹配 [LABEL_N] 形式的占位符。 */
export const PLACEHOLDER_RE = /\[([A-Z][A-Z0-9_]*)_(\d+)\]/g;

export const RuleActionSchema = z.enum(['mask', 'block']);
export type RuleAction = z.infer<typeof RuleActionSchema>;

/** preset 的三态：mask（脱敏）/ block（阻断）/ off（关闭该检测器）。 */
export const PresetStateSchema = z.enum(['mask', 'block', 'off']);
export type PresetState = z.infer<typeof PresetStateSchema>;

export const PRESET_NAMES = ['phone', 'idCard', 'bankCard', 'email', 'apiKey'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** security.json 的形状。未知字段拒绝（写错键名要立刻知道，而不是被静默忽略）。 */
export const SecurityRulesFileSchema = z
  .object({
    presets: z
      .object({
        phone: PresetStateSchema.optional(),
        idCard: PresetStateSchema.optional(),
        bankCard: PresetStateSchema.optional(),
        email: PresetStateSchema.optional(),
        apiKey: PresetStateSchema.optional(),
      })
      .strict()
      .optional(),
    rules: z
      .array(
        z.object({
          /** 关键词字面量；regex=true 时按正则源码解释（不带 flag，编译时统一加 g）。 */
          pattern: z.string().min(1),
          action: RuleActionSchema,
          regex: z.boolean().default(false),
          /** 占位符 label（缺省 KEYWORD）。必须大写，因为还原正则只认 [A-Z…_N]。 */
          label: z.string().regex(LABEL_RE, 'label must be UPPER_SNAKE_CASE').optional(),
        }),
      )
      .default([]),
  })
  .strict();

export type SecurityRulesFile = z.infer<typeof SecurityRulesFileSchema>;

/** 编译后的运行时规则。presets 与自定义规则统一成这一种形状。 */
export interface CompiledRule {
  label: string;
  action: RuleAction;
  /** 必须带 g flag —— sanitize 用 replace 全局扫描。 */
  pattern: RegExp;
  /** 命中后的二次校验（如银行卡 Luhn），false → 当作未命中。 */
  validate?: (match: string) => boolean;
  /** 人类可读来源，用于 block 报错与告警：`preset:phone` / `file:<path>#<idx>`。 */
  source: string;
}

/** block 级命中的描述。sample 是截断后的命中片段，避免在报错里回显全文。 */
export interface BlockHit {
  label: string;
  source: string;
  sample: string;
}
