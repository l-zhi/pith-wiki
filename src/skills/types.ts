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

/** http_allow 里的 host:裸主机名(可含端口),不含 scheme / 路径 / 通配。 */
export const HTTP_HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * skill 自测探针:一条只读的"可用性"检查,由 skill 自己在 frontmatter 声明,
 * 桌面「测试」按钮据此就地验证该 skill 是否真的能用(装了没 / 认证了没 / key 对不对)。
 *   - command:跑一条 skill 自己 commands 白名单内的只读命令,exit 0 = 通过
 *             (如 lark 的 `lark-cli auth status`)。
 *   - http   :打一次 skill 自己 http_allow 内的请求,响应 2xx = 通过
 *             (如 weread 网关 `/_list` ping,顺带验证 auth_env 密钥有效)。
 */
export const SkillProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string().regex(COMMAND_BIN_RE, 'probe command must be a bare binary name'),
    args: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().url('probe url must be a valid https URL'),
    method: z.enum(['GET', 'POST']).default('GET'),
    body: z.string().optional(),
  }),
]);
export type SkillProbe = z.infer<typeof SkillProbeSchema>;

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
  /**
   * 该 skill 允许 agent 经 http_request 工具访问的 host 白名单 + 鉴权声明。
   * 声明即授权:装含 http_allow 的 skill = 同意 agent 在审批后访问这些域名。
   * 密钥从 auth_env 指定的环境变量取,由工具注入,模型永远看不到也改不了。
   */
  http_allow: z
    .array(
      z.object({
        /** 允许访问的 host(可含端口),精确匹配 URL 的 host。 */
        host: z.string().regex(HTTP_HOST_RE, 'http_allow.host must be a bare host (no scheme/path)'),
        /** 鉴权密钥所在的环境变量名;不填则该 host 不注入任何鉴权。 */
        auth_env: z.string().optional(),
        /** 鉴权 header 名,默认 Authorization。 */
        auth_header: z.string().default('Authorization'),
        /** 鉴权前缀,默认 Bearer(=> `Bearer <值>`);设 "" 则裸值(如 X-API-Key: <值>)。 */
        auth_scheme: z.string().default('Bearer'),
      }),
    )
    .default([]),
  /** 可选的自测探针,桌面「测试」按钮用(见 SkillProbeSchema)。 */
  test: SkillProbeSchema.optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillRequirement {
  bin: string;
  install?: string;
}

export interface HttpAllowRule {
  host: string;
  auth_env?: string;
  auth_header: string;
  auth_scheme: string;
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
  /** 该 skill 声明的 HTTP host 白名单 + 鉴权(可能为空)。 */
  httpAllow: HttpAllowRule[];
  /** 可选的自测探针(桌面「测试」按钮)。 */
  test?: SkillProbe;
}
