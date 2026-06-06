import { z } from 'zod';

/**
 * Skill 子系统的类型 + frontmatter schema。
 *
 * Skill = 一份 SKILL.md(frontmatter + markdown 正文)。正文是"指令负载",模型经
 * `skill` 工具按 name 调出,正文进上下文 → 渐进式披露(Claude Code 同款):平时只
 * 有 name+description 可见,真正调用时才 load 完整正文。
 *
 * 纯 prompt skill —— 不执行代码。frontmatter 里的 `type`/`version`/`metadata` 等
 * 额外字段会被 zod 静默忽略(兼容 Claude Code 风格的 SKILL.md)。
 */

/** skill name 允许的字符:字母 / 数字开头,其后可含 `-` `_` `.`。须与所在目录名一致。 */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** SKILL.md frontmatter 校验:name / description 必填,其余字段忽略。 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE, 'skill name must be slug-like (letters/digits/-/_/.)'),
  description: z.string().min(1, 'skill description is required'),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 的 markdown 正文(frontmatter 之后),trim 过。 */
  body: string;
  /** skill 所在目录绝对路径。 */
  dir: string;
}
