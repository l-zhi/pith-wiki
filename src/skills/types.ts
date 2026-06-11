import { z } from 'zod';

/**
 * Skill 子系统的类型 + frontmatter schema。
 *
 * Skill = 一份 SKILL.md(frontmatter + markdown 正文)。正文是"指令负载",模型经
 * `skill` 工具按 name 调出,正文进上下文 → 渐进式披露(Claude Code 同款):平时只
 * 有 name+description 可见,真正调用时才 load 完整正文。
 *
 * skill 不携带可执行代码——但可以通过 `commands` 声明它需要 agent 能执行的
 * 外部 CLI(如 weread / lark-cli)。声明的二进制进入 run_command 工具的白名单,
 * 执行仍需会话内审批(见 docs/adr/0004-cli-skill-exec.md)。frontmatter 里的
 * `type`/`version`/`metadata` 等其他额外字段被 zod 静默忽略(兼容 Claude Code
 * 风格的 SKILL.md)。
 */

/** skill name 允许的字符:字母 / 数字开头,其后可含 `-` `_` `.`。须与所在目录名一致。 */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * commands 里的二进制名:裸名(无路径分隔符 / 空格),与 PATH 查找语义一致。
 * 不允许绝对/相对路径——路径形式会绕过"用户装了什么 CLI 才能跑什么"的心智模型,
 * 且 `../` 形式直接是逃逸向量。
 */
export const COMMAND_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** SKILL.md frontmatter 校验:name / description 必填,commands / requires 可选。 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE, 'skill name must be slug-like (letters/digits/-/_/.)'),
  description: z.string().min(1, 'skill description is required'),
  /**
   * 该 skill 允许 agent 执行的二进制白名单(argv[0] 精确匹配)。
   * 声明即授权额度——安装含 commands 的 skill 等于同意 agent 在审批后运行它们。
   */
  commands: z
    .array(z.string().regex(COMMAND_BIN_RE, 'command must be a bare binary name (no path/space)'))
    .default([]),
  /**
   * 外部依赖声明:`skill add` 时逐项 which 检测,缺失打印 install 指引(不代装)。
   */
  requires: z
    .array(
      z.object({
        bin: z.string().regex(COMMAND_BIN_RE, 'requires.bin must be a bare binary name'),
        install: z.string().optional(),
      }),
    )
    .default([]),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillRequirement {
  bin: string;
  install?: string;
}

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 的 markdown 正文(frontmatter 之后),trim 过。 */
  body: string;
  /** skill 所在目录绝对路径。 */
  dir: string;
  /** 该 skill 声明的可执行二进制白名单(可能为空 —— 纯 prompt skill)。 */
  commands: string[];
  /** 外部 CLI 依赖声明(安装时检测用)。 */
  requires: SkillRequirement[];
}
