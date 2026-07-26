import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { pithWikiHome } from './paths.js';

/**
 * 把 config.json 的 `secrets` map 灌进 `process.env`。
 *
 * 这是密钥的**唯一持久化源**（取代旧的 `.env` 文件）：DEEPSEEK_API_KEY 这类
 * provider key（被 entry.apiKeyEnv 引用）和 skill 的 http_request auth_env，
 * 运行时都从 process.env 读，这里在 load 时一次性填好。
 *
 * 无条件覆盖（config.json 即权威）；只 set 不 unset——删 key 由写入侧
 * （setSkillEnv 空值分支）显式 delete，re-load 不负责清理残留。
 */
function applySecretsToEnv(secrets: Record<string, string> | undefined): void {
  for (const [k, v] of Object.entries(secrets ?? {})) {
    if (typeof v === 'string') process.env[k] = v;
  }
}

/**
 * 多 provider 配置：每个条目对应一个 OpenAI-compatible endpoint。
 *
 * 用法（在 ~/.pith-wiki/config.json 里）：
 *   {
 *     "providers": {
 *       "deepseek": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
 *       "qwen":     { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "apiKeyEnv": "DASHSCOPE_API_KEY" },
 *       "openai":   { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" }
 *     },
 *     "activeProvider": "deepseek"
 *   }
 *
 * 优先级 activeProvider：CLI `--provider` > env `PITH_WIKI_PROVIDER` > 配置文件
 *
 * 字段：
 *   - apiKey:    字面 key（不推荐写在 config.json 里，会被签入 git）
 *   - apiKeyEnv: env 变量名，loadConfig 时取 process.env[apiKeyEnv]
 *   - baseURL / model：照常
 *
 * 切换 provider 时机：
 *   - CLI 调用：传 `--provider <name>`，整个 process 用这个
 *   - REPL 内：用 `/provider <name>` slash 命令，App.tsx 重建 client + agent
 *     （隐式 reset 对话——不同模型不该共享 history）
 */
const ProviderSchema = z
  .object({
    /**
     * provider 类型：
     *   - `openai`（默认）：OpenAI 兼容 HTTP endpoint，走 chat.completions（现有全部）。
     *   - `claude-code`：委托本机 `claude` CLI（headless + pith-mcp），复用订阅额度。
     *   - `codex`：委托本机 `codex` CLI（`codex exec --json` + pith-mcp 经 `-c` 内联注册），
     *     复用 ChatGPT/Codex 订阅额度。与 claude-code 同为「委托型 CLI」provider。
     *   - `pi`：委托本机 `pi` CLI（`pi --mode json`）。pi 无内置 MCP，知识库经 pith 自动生成的
     *     桥接扩展（`-e <home>/pi/pith-mcp-bridge.mjs`）挂上；复用 pi 的 OAuth 订阅
     *     （Claude Pro/Max、GitHub Copilot、xAI 等，`pi` 里 /login 写 ~/.pi/agent/auth.json）。
     *     三者同为「委托型 CLI」provider，仅供桌面端 chat 使用；hydration/queue 仍需一个
     *     openai provider。
     */
    kind: z.enum(['openai', 'claude-code', 'codex', 'pi']).default('openai'),
    /** OpenAI 兼容端点。openai 类型必填；claude-code 不需要（可省）。 */
    baseURL: z.string().url().optional(),
    model: z.string().min(1),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    /**
     * 该 provider 的 endpoint 是否支持 `response_format: { type: 'json_object' }`。
     * 缺省视为 true（DeepSeek 官方 / OpenAI / Qwen 等主流 chat endpoint 都支持）。
     *
     * 已知需要设 false 的场景：
     *   - 火山引擎 Ark `/api/coding/v3` 端点（DeepSeek-V4-Flash 等）—— 直接返回 HTTP 400，
     *     连参数都不接受
     *   - 部分本地推理框架（llama.cpp server / 旧版 vllm）
     *
     * 关掉后 HydrationService 不再传 `response_format`，靠 hydration.ts 内的 extractJson
     * 三级抢救 (直 parse → 剥 markdown fence → 找首{...末}) 兜底解析非严格 JSON 输出。
     */
    supportsJsonMode: z.boolean().optional(),
    /** 委托型 CLI（claude-code/codex/pi）共用：可执行路径（默认 'claude'/'codex'/'pi'，PATH 里能找到就不用填）。 */
    binary: z.string().optional(),
    /** claude-code 专属：走订阅的 OAuth token（`claude setup-token` 生成；设置页填写）。codex 走 `codex login` 写的 ~/.codex/auth.json，不用此字段。 */
    oauthToken: z.string().optional(),
    /** claude-code 专属：从该 env 变量读 OAuth token（oauthToken 的替代，避免明文落 config）。 */
    oauthTokenEnv: z.string().optional(),
    /**
     * 委托型 CLI（claude-code/codex/pi）共用：指向 pith-mcp 的配置文件路径（如 ~/pith-mcp.json）。
     * claude-code 作为 `--mcp-config <file>` 直接传入；codex 读它拿 command/args/env，翻成
     * `-c mcp_servers.pith.*` 内联覆盖（codex 无 --mcp-config 文件标志）；pi 读它把
     * command/args/env 经环境变量交给桥接扩展（pi 完全没有 MCP）。一份配置三个 CLI 共用。
     */
    mcpConfigPath: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'openai' && !v.baseURL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseURL is required for openai providers',
        path: ['baseURL'],
      });
    }
  });
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const ConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseURL: z.string().url(),
  model: z.string().min(1),
  /**
   * 当前 active provider 是否支持 `response_format: json_object`。默认 true。
   * 由 applyActiveProvider 从 ProviderSchema.supportsJsonMode 折下来；缺省即 true。
   * 顶层（无 provider）的 v0 用法也走默认 true（DeepSeek 官方端点支持）。
   */
  supportsJsonMode: z.boolean().default(true),
  /**
   * 当前 active provider 的类型（由 applyActiveProvider 从 entry.kind 折下来）。
   * claude-code/codex/pi → 桌面端该会话走委托 agent（spawn 对应 CLI），不走 chat.completions。
   */
  providerKind: z.enum(['openai', 'claude-code', 'codex', 'pi']).default('openai'),
  /** Multi-provider map（可选）。空 → 走顶层 apiKey/baseURL/model（v0 行为）。 */
  providers: z.record(z.string(), ProviderSchema).default({}),
  /**
   * 密钥 map（KEY → 明文值）：唯一持久化源，取代 `.env`。load 时灌进 process.env，
   * 供 provider 的 apiKeyEnv / skill 的 http_request auth_env 在运行时读取。
   * 桌面端 setSkillEnv 与 UI 写入都落到这里。
   */
  secrets: z.record(z.string(), z.string()).default({}),
  /** 当前激活的 provider key（必须出现在 providers 里）。空 → 不切换。聊天用。 */
  activeProvider: z.string().optional(),
  /**
   * 水合（hydration / queue / digest）专用 provider key。空 → 自动选第一个 openai provider。
   * 让「聊天切到 claude-code」时，后台水合仍走一个 API provider —— claude-code 不适合
   * 批量 JSON 水合，也会很快耗尽订阅额度。
   */
  hydrationProvider: z.string().optional(),
  /**
   * 审稿模式（ReviewingAgent）专用 reviewer provider key。空 → reviewer 与 writer 同 provider。
   * 可指向 openai（独立 API client）或委托型 CLI（claude-code/codex，每轮 spawn 该 CLI 当 reviewer）。
   */
  reviewProvider: z.string().optional(),
  workspaceRoot: z.string().min(1),
  wikiRoot: z.string().min(1),
  readOnly: z.boolean(),
  /**
   * 单次 LLM 请求的超时（毫秒）。默认 120_000（2 分钟）。
   * OpenAI SDK 自身默认是 10 分钟——对自建 / OpenAI 兼容端点挂起的情况太长，
   * REPL 会一直转圈直到那时才报错。可在 config.json 或 PITH_WIKI_TIMEOUT_MS 调整。
   * SDK 仍会按默认重试策略对超时/网络错误重试。
   */
  requestTimeoutMs: z.number().int().positive(),
  /**
   * agent tool-loop 的最大轮数，默认 25。聚合+写入这类 agentic 任务
   * （如定时日报：查 pith + 飞书 + 微信读书后再 write_file 落盘）轮数消耗大，
   * 太低会在轮到写文件前就触顶，导致模型只描述步骤却没真正写入。
   * 触顶后 Agent 仍会强制收尾出一段文本答复，但副作用（写文件/入库）会丢失。
   * 可在 config.json 或 PITH_WIKI_MAX_STEPS 调整。
   */
  maxSteps: z.number().int().positive(),
  /** 审稿模式（ReviewingAgent，桌面端）最大打回轮次。默认 2；到顶返回最后一版。 */
  reviewMaxRounds: z.number().int().min(1).max(5).default(2),
  /**
   * run_command 工具的默认超时（毫秒），默认 60_000。单次工具调用可用
   * timeout_ms 参数覆盖。超时先 SIGTERM、5s 后 SIGKILL。
   */
  commandTimeoutMs: z.number().int().positive(),
  /** http_request 工具的默认超时（毫秒），默认 30_000。单次可用 timeout_ms 覆盖。 */
  httpTimeoutMs: z.number().int().positive(),
  maxToolPayloadBytes: z.number().int().positive(),
  historyFile: z.string().min(1),
  /**
   * 额外的可读目录列表（绝对路径）。
   * 仅扩展读权限：read_file / list_dir 工具会接受落在其中任意一条之内的路径。
   * 写工具（write_file）不受此项影响——写仍只能落在 workspaceRoot 或 wikiRoot 内。
   * 目的：让 LLM 能查阅项目外的资料目录（笔记、参考文档等）但不会动到它们。
   */
  additionalReadPaths: z.array(z.string()).default([]),
  /** 持久化 ingest 队列状态文件的绝对路径。 */
  queueStatePath: z.string().min(1),
  /** 每个 job 的独立 log 文件存放目录（绝对路径）。 */
  queueLogDir: z.string().min(1),
  /** 定时任务状态文件的绝对路径（默认 ~/.pith-wiki/schedule/state.json）。 */
  scheduleStatePath: z.string().min(1),
  /** `queue run` 默认并发数。CLI `--concurrency` 可覆盖。 */
  queueConcurrency: z.number().int().positive(),
  /** 队列级别的最大尝试次数。第 N 次失败后 job 标 dead。 */
  queueMaxAttempts: z.number().int().positive(),
  /**
   * REPL 启动时是否自动起队列 worker（`idleBehavior=wait`）。
   * true（默认）：进 REPL 自动开 worker，本会话内 wiki_queue_add 增的 job 立即被处理。
   * 关掉的方式：CLI `--no-auto-queue`，或 ~/.pith-wiki/config.json 里写 false。
   */
  queueAutoStart: z.boolean(),
  /**
   * 监听目录配置：每个条目对应一棵被 watcher 实时跟踪的源目录。
   * 默认为空 → 不监听。配了路径 + watchAutoStart=true → REPL 启动时自动起 watcher。
   *
   * 字段语义（详见 src/wiki/queue/watcher.ts 的注释）：
   *   - path: 源目录绝对路径（支持 `~/`）。绝不能与 wikiRoot 重叠，避免自写循环。
   *   - collection: 固定 collection 名（与 collectionFromSubdir 二选一）。
   *   - collectionFromSubdir: true 时按一级子目录名做 collection。
   *   - fallbackCollection: 文件直接在 watch root 下、或子目录名非法时的兜底。
   *   - subdirAlias: 子目录名 → collection 名的可选映射（改名工具，中文目录可不填）。
   *   - initialScan: 启动时把目录里已有 .md 全部入队（已 ingest 过的会被 dedup 跳过）。
   *   - ignore: 用户额外的 micromatch glob，并入 DEFAULT_IGNORED 一起忽略。
   */
  watchDirs: z
    .array(
      z.object({
        path: z.string().min(1),
        collection: z.string().optional(),
        collectionFromSubdir: z.boolean().default(false),
        fallbackCollection: z.string().optional(),
        subdirAlias: z.record(z.string(), z.string()).default({}),
        initialScan: z.boolean().default(false),
        ignore: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /**
   * REPL 启动时是否同时起 watcher（前提是 watchDirs 非空）。
   * 关掉的方式：CLI `--no-auto-watch`，或 ~/.pith-wiki/config.json 里写 false。
   */
  watchAutoStart: z.boolean(),
  /**
   * REPL 每次问答自动写入 markdown transcript 的目录。
   * 默认 `<wikiRoot>/output/transcripts/`：和数字化的 wiki 条目同根（digest 落
   * `<wikiRoot>/output/*.md`，被索引）。注意 scanAll 是**递归**的，会一路扫进任意深度
   * 的子目录——所以光放进子目录并不能屏蔽，必须显式跳过：这个路径作为 ignoredDirs
   * 传给 LibraryService，把整棵 transcripts 子树排除在扫描 / 检索 / 新鲜度计算之外
   * （见 src/wiki/library.ts 的 LibraryServiceOptions.ignoredDirs）。
   */
  outputDir: z.string().min(1),
  /** REPL 是否记录 transcript（CLI `--no-transcript` 可关）。默认 true。 */
  transcriptEnabled: z.boolean(),
  /**
   * `/digest` slash 命令默认落地的 collection 名（路径 `<wikiRoot>/<digestCollection>/`）。
   * 默认 `output` —— 跟 transcripts 共享同一个 wiki 子目录，但层级是 collection（被索引）。
   */
  digestCollection: z.string().min(1),
  /**
   * 是否把转换器输出（PDF→md 之类）写入 `<wikiRoot>/.cache/converters/`。
   * 默认 true：避免重复解析。CLI `--no-cache` 可关。
   */
  cacheConverted: z.boolean(),
  /**
   * SOUL.md 路径——显式指定时只读这一份，不再查默认位置。
   *
   * 解析在 src/llm/soul.ts 内做：显式 > PITH_WIKI_SOUL env > 默认双层
   *   (~/.pith-wiki/SOUL.md + <workspaceRoot>/SOUL.md)。
   * 内容拼到 Agent 的 system prompt 末尾作为 voice/style 层。
   */
  soulFile: z.string().optional(),
  /**
   * skill 发现目录列表（绝对路径）。每个目录下的 `<name>/SKILL.md` 会被自动发现。
   *
   * 默认双层（与 soulFile 同构）：`<pithWikiHome>/skills`（跨工作区的"我的技能"）
   * + `<workspaceRoot>/skills`（项目本地）。后者排在后面 → 同名时覆盖前者。
   * 每个 skill 是一份 SKILL.md（纯指令，渐进式披露）。实际扫描在 src/skills/ 内做。
   */
  skillDirs: z.array(z.string()).default([]),
  /**
   * 数据安全模块总开关。开启后所有 LLM 出站请求经过过滤：block 级规则命中
   * 拒发，mask 级命中替换为可还原占位符（响应落盘/展示前还原）。
   * 默认 **true**（安全默认开，显式 opt-out：PITH_WIKI_SECURITY=0 或配置 false）。
   */
  securityEnabled: z.boolean().default(true),
  /**
   * 安全规则文件列表（绝对路径）。默认双层（与 soulFile/skillDirs 同构）：
   * `<pithWikiHome>/security.json` + `<workspaceRoot>/security.json`，union 合并
   * （自定义规则全部生效；preset 冲突时取更严格的）。文件不存在不报错 ——
   * securityEnabled=true 且无文件时只跑内置 PII 预设（全部 mask）。
   * 实际读盘 + 编译在 src/security/rules.ts 内做。
   */
  securityRulesFiles: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ConfigOverrides {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  providers?: Record<string, ProviderConfig>;
  activeProvider?: string;
  workspaceRoot?: string;
  wikiRoot?: string;
  readOnly?: boolean;
  requestTimeoutMs?: number;
  maxSteps?: number;
  commandTimeoutMs?: number;
  httpTimeoutMs?: number;
  maxToolPayloadBytes?: number;
  additionalReadPaths?: string[];
  queueStatePath?: string;
  queueLogDir?: string;
  scheduleStatePath?: string;
  queueConcurrency?: number;
  queueMaxAttempts?: number;
  queueAutoStart?: boolean;
  watchDirs?: Array<{
    path: string;
    collection?: string;
    collectionFromSubdir?: boolean;
    fallbackCollection?: string;
    subdirAlias?: Record<string, string>;
    initialScan?: boolean;
    ignore?: string[];
  }>;
  watchAutoStart?: boolean;
  outputDir?: string;
  transcriptEnabled?: boolean;
  digestCollection?: string;
  cacheConverted?: boolean;
  soulFile?: string;
  skillDirs?: string[];
  securityEnabled?: boolean;
  securityRulesFiles?: string[];
}

const DEFAULTS = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  requestTimeoutMs: 120_000,
  maxSteps: 25,
  reviewMaxRounds: 2,
  commandTimeoutMs: 60_000,
  httpTimeoutMs: 30_000,
  maxToolPayloadBytes: 100_000,
  queueConcurrency: 2,
  queueMaxAttempts: 3,
  queueAutoStart: true,
  watchAutoStart: true,
  transcriptEnabled: true,
  digestCollection: 'output',
  cacheConverted: true,
};

/**
 * 读取持久化 config 文件。
 *
 * 默认路径：`~/.pith-wiki/config.json`。
 * 测试 / 嵌入场景：通过 `PITH_WIKI_CONFIG_PATH` env 改向；指向不存在的文件等价于"没有 config"。
 * 这条 env 主要给 vitest 用：让 `npm test` 在维护者本机不被真实 config 污染。
 *
 * 找不到文件不抛错（这是常态：用户没建过 config）；JSON 解析失败必须抛（用户写错了要立刻知道）。
 */
function loadFileConfig(): Partial<Config> {
  const file = process.env.PITH_WIKI_CONFIG_PATH ?? path.join(pithWikiHome(), 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
  }
}

/**
 * 三态布尔 env 解析：'true'/'1' → true，'false'/'0' → false，其余（含未设置）→ undefined。
 * undefined 让优先级链继续往下落（file → 默认值）。默认开的开关需要显式 off 入口，
 * 单靠 truthy 判断做不到。
 */
function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

/**
 * 把 `~` 或 `~/foo` 展开成 `<homedir>/foo`。
 * 注意：仅识别字面量 `~` 开头，不展开任意 user 的 home（不支持 `~user/`）。
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 把环境变量里的"路径列表"解析成数组。
 *
 * 支持两种语法（自动判别）：
 *   1. JSON 数组：以 `[` 开头，例 `["~/notes", "~/papers"]`
 *   2. 分隔符串：用 path.delimiter 分隔（POSIX 是 `:`，Windows 是 `;`），
 *      例 `~/notes:/Users/me/papers`
 *
 * 两种语法都自动做 `~/` 展开，便于 `.env` 里跨机器复用配置。
 *
 * 导出供 tests/config.test.ts 直接单元测试，loadConfig 内部只用环境变量值喂它。
 */
export function parseReadPathsFromEnv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let items: string[];
  // 既识别 `[`（数组）也识别 `{`（对象）作为"JSON 入口"，对象会被立即拒绝。
  // 这样用户写错语法时拿到的是清晰错误，而不是被悄悄按分隔符切片成奇怪 paths。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `PITH_WIKI_READ_PATHS looks like JSON but failed to parse: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `PITH_WIKI_READ_PATHS JSON value must be a string array, got ${typeof parsed}`,
      );
    }
    items = parsed.map((v) => {
      if (typeof v !== 'string') {
        throw new Error(`PITH_WIKI_READ_PATHS array entry is not a string: ${JSON.stringify(v)}`);
      }
      return v;
    });
  } else {
    items = trimmed.split(path.delimiter);
  }

  const cleaned = items.map((s) => expandHome(s.trim())).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/**
 * 解析 env 里的正整数（如超时毫秒）。空 / 非数字 / 非正 → undefined（交给后续兜底链），
 * 不抛错：env 写歪不该让整个 CLI 起不来，静默回落到默认更稳妥。
 */
export function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * CLI 入口的配置加载：读 `~/.pith-wiki/config.json`（或 `PITH_WIKI_CONFIG_PATH` 指向的文件）、
 * env 变量，再叠加显式 overrides，zod 校验后返回。config.json 的 `secrets` map
 * 会先灌进 process.env（密钥唯一源，取代旧 `.env`）。
 */
export function loadConfigFromEnv(overrides: ConfigOverrides = {}): Config {
  const file = loadFileConfig();
  // 密钥唯一源：把 config.json 的 secrets 灌进 process.env，必须在下面读
  // process.env.DEEPSEEK_API_KEY / applyActiveProvider(→entry.apiKeyEnv) 之前。
  applySecretsToEnv(file.secrets);
  const cwd = process.cwd();
  const workspaceRoot =
    overrides.workspaceRoot ?? process.env.PITH_WIKI_WORKSPACE ?? file.workspaceRoot ?? cwd;
  // wikiRoot 默认放在 ~/.pith-wiki/wiki-data：与队列状态、命令历史、配置同源在
  // 用户 home 下。这样多个 workspace 共享同一份 wiki，且 git 不会无意把数据
  // 提交进项目仓库（旧默认 <workspaceRoot>/wiki-data 容易误入版本控制）。
  // 想把 wiki 跟 workspace 绑在一起的用户可设 PITH_WIKI_ROOT 或配置文件。
  const wikiRoot =
    overrides.wikiRoot ??
    process.env.PITH_WIKI_ROOT ??
    file.wikiRoot ??
    path.join(pithWikiHome(), 'wiki-data');
  const resolvedWikiRoot = path.resolve(wikiRoot);

  // additionalReadPaths：CLI flag > env > 配置文件 > 空数组。
  // 一旦提供，所有路径都先做 `~/` 展开，再规范化为绝对路径（相对路径相对 cwd）。
  const additionalReadPathsRaw =
    overrides.additionalReadPaths ??
    parseReadPathsFromEnv(process.env.PITH_WIKI_READ_PATHS) ??
    file.additionalReadPaths ??
    [];
  const additionalReadPaths = additionalReadPathsRaw.map((p) => path.resolve(expandHome(p)));

  // skillDirs：CLI flag > env (PITH_WIKI_SKILLS) > 配置文件 > 默认双层。
  // 默认与 soulFile 同构：user-global 在前、project-local 在后（同名覆盖）。
  // 所有路径做 `~/` 展开 + 绝对化（相对路径相对 cwd）。
  const defaultSkillDirs = [
    path.join(pithWikiHome(), 'skills'),
    path.join(path.resolve(workspaceRoot), 'skills'),
  ];
  const skillDirsRaw =
    overrides.skillDirs ??
    parseReadPathsFromEnv(process.env.PITH_WIKI_SKILLS) ??
    file.skillDirs ??
    defaultSkillDirs;
  const skillDirs = skillDirsRaw.map((p) => path.resolve(expandHome(p)));

  // securityRulesFiles：CLI flag > env (PITH_WIKI_SECURITY_RULES) > 配置文件 > 默认双层。
  // 与 skillDirs 同构：user-global 在前、project-local 在后；合并语义在 rules.ts（union）。
  const defaultSecurityRulesFiles = [
    path.join(pithWikiHome(), 'security.json'),
    path.join(path.resolve(workspaceRoot), 'security.json'),
  ];
  const securityRulesFilesRaw =
    overrides.securityRulesFiles ??
    parseReadPathsFromEnv(process.env.PITH_WIKI_SECURITY_RULES) ??
    file.securityRulesFiles ??
    defaultSecurityRulesFiles;
  const securityRulesFiles = securityRulesFilesRaw.map((p) => path.resolve(expandHome(p)));

  // 队列相关默认路径都在 ~/.pith-wiki/queue/ 下。
  // 优先级与其他字段一致：CLI flag > 配置文件 > 默认。env 暂不引入，避免接口表面过大。
  const defaultQueueDir = path.join(pithWikiHome(), 'queue');
  const queueStatePath = path.resolve(
    expandHome(
      overrides.queueStatePath ?? file.queueStatePath ?? path.join(defaultQueueDir, 'state.json'),
    ),
  );
  const queueLogDir = path.resolve(
    expandHome(overrides.queueLogDir ?? file.queueLogDir ?? path.join(defaultQueueDir, 'logs')),
  );
  const scheduleStatePath = path.resolve(
    expandHome(
      overrides.scheduleStatePath ??
        file.scheduleStatePath ??
        path.join(pithWikiHome(), 'schedule', 'state.json'),
    ),
  );

  const merged = {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? file.apiKey ?? '',
    baseURL:
      overrides.baseURL ?? process.env.PITH_WIKI_BASE_URL ?? file.baseURL ?? DEFAULTS.baseURL,
    model: overrides.model ?? process.env.PITH_WIKI_MODEL ?? file.model ?? DEFAULTS.model,
    workspaceRoot: path.resolve(workspaceRoot),
    wikiRoot: resolvedWikiRoot,
    readOnly:
      overrides.readOnly ??
      (process.env.PITH_WIKI_READ_ONLY === 'true' ? true : undefined) ??
      file.readOnly ??
      false,
    requestTimeoutMs:
      overrides.requestTimeoutMs ??
      parsePositiveIntEnv(process.env.PITH_WIKI_TIMEOUT_MS) ??
      file.requestTimeoutMs ??
      DEFAULTS.requestTimeoutMs,
    maxSteps:
      overrides.maxSteps ??
      parsePositiveIntEnv(process.env.PITH_WIKI_MAX_STEPS) ??
      file.maxSteps ??
      DEFAULTS.maxSteps,
    reviewMaxRounds: file.reviewMaxRounds ?? DEFAULTS.reviewMaxRounds,
    commandTimeoutMs:
      overrides.commandTimeoutMs ?? file.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    httpTimeoutMs: overrides.httpTimeoutMs ?? file.httpTimeoutMs ?? DEFAULTS.httpTimeoutMs,
    maxToolPayloadBytes:
      overrides.maxToolPayloadBytes ?? file.maxToolPayloadBytes ?? DEFAULTS.maxToolPayloadBytes,
    historyFile: path.join(pithWikiHome(), 'history'),
    additionalReadPaths,
    queueStatePath,
    queueLogDir,
    scheduleStatePath,
    queueConcurrency:
      overrides.queueConcurrency ?? file.queueConcurrency ?? DEFAULTS.queueConcurrency,
    queueMaxAttempts:
      overrides.queueMaxAttempts ?? file.queueMaxAttempts ?? DEFAULTS.queueMaxAttempts,
    queueAutoStart:
      overrides.queueAutoStart ?? file.queueAutoStart ?? DEFAULTS.queueAutoStart,
    // watchDirs：CLI overrides > 配置文件 > []。环境变量先不引入（结构太复杂，
    // 不像单条路径列表那么自然）；CLI 也只在 `pith-wiki watch` 命令里用 flag 覆盖。
    // 路径里的 ~/ 在 schema parse 之后再展开（loadConfig 末尾统一处理）。
    watchDirs: overrides.watchDirs ?? file.watchDirs ?? [],
    watchAutoStart:
      overrides.watchAutoStart ?? file.watchAutoStart ?? DEFAULTS.watchAutoStart,
    // 默认放在 <wikiRoot>/output/transcripts/：raw transcripts 和 digest 条目共享 wiki 树根。
    // scanAll 递归扫描，子目录挡不住——这个路径会作为 ignoredDirs 传给 LibraryService 显式跳过。
    outputDir: path.resolve(
      expandHome(
        overrides.outputDir ??
          file.outputDir ??
          path.join(resolvedWikiRoot, 'output', 'transcripts'),
      ),
    ),
    transcriptEnabled:
      overrides.transcriptEnabled ?? file.transcriptEnabled ?? DEFAULTS.transcriptEnabled,
    digestCollection:
      overrides.digestCollection ?? file.digestCollection ?? DEFAULTS.digestCollection,
    cacheConverted:
      overrides.cacheConverted ?? file.cacheConverted ?? DEFAULTS.cacheConverted,
    // SOUL.md：显式 CLI 覆盖 > env > file（指定 file 也算"explicit"，不再走默认双层）
    // 实际读盘 + ~/展开在 src/llm/soul.ts 内，避免 config schema 持有读盘副作用
    soulFile:
      overrides.soulFile ?? process.env.PITH_WIKI_SOUL ?? file.soulFile ?? undefined,
    skillDirs,
    securityEnabled:
      overrides.securityEnabled ?? parseBoolEnv(process.env.PITH_WIKI_SECURITY) ?? file.securityEnabled ?? true,
    securityRulesFiles,
    // 顶层 supportsJsonMode 仅在没用 provider map 的 v0 场景下直接生效；
    // 用了 activeProvider 时会被 applyActiveProvider 用 entry 的同名字段覆盖。
    // 这里走 file 字段（无 CLI/env 入口，结构小且改动频率低）。
    supportsJsonMode: file.supportsJsonMode,
    // multi-provider：providers 表来自 file（不接受 env，结构复杂），activeProvider
    // 走 CLI > env > file。Zod 校验之后再 overlay 到顶层 apiKey/baseURL/model。
    providers: overrides.providers ?? file.providers ?? {},
    activeProvider:
      overrides.activeProvider ?? process.env.PITH_WIKI_PROVIDER ?? file.activeProvider,
    // hydrationProvider 之前漏进 merged，导致 config.hydrationProvider 恒为 undefined、
    // pickHydrationProvider 永远回退到第一个 openai（水合选择器形同虚设）。一并补上。
    hydrationProvider: file.hydrationProvider,
    reviewProvider: file.reviewProvider,
    secrets: file.secrets ?? {},
  };

  const parsed = ConfigSchema.parse(merged);
  // schema 校验后统一对 watchDirs 的 path 做 ~/ 展开 + 绝对化。放在这里而不是 schema
  // transform 里，是为了让 ZodError 报错时显示用户原写的路径，便于排查。
  parsed.watchDirs = parsed.watchDirs.map((wd) => ({
    ...wd,
    path: path.resolve(expandHome(wd.path)),
  }));
  // 应用 active provider：把对应 entry 的 apiKey/baseURL/model 覆盖到顶层，
  // 让现有调用方（agent / hydrator）继续读 config.apiKey 等字段不需要改。
  return applyActiveProvider(parsed);
}

/**
 * @deprecated 改用 `loadConfigFromEnv`。本别名只为旧调用方兼容保留，将在
 * v0.3 移除。语义没变。
 */
export const loadConfig = loadConfigFromEnv;

/**
 * 把 entry.apiKey / apiKeyEnv 折成最终的 apiKey 字符串。
 * 优先级：字面 apiKey > env[apiKeyEnv]。两者都没给 → 空串。
 */
export function resolveProviderEntry(entry: ProviderConfig): {
  apiKey: string;
  baseURL: string;
  model: string;
  supportsJsonMode: boolean;
} {
  const fromEnv = entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] ?? '') : '';
  const apiKey = entry.apiKey && entry.apiKey.length > 0 ? entry.apiKey : fromEnv;
  // entry 未声明视为支持 —— 主流 chat endpoint 都支持，关掉是例外不是默认
  const supportsJsonMode = entry.supportsJsonMode ?? true;
  // 委托型 CLI（claude-code/codex/pi）不走 HTTP，但顶层 baseURL 必须是合法 URL（createClient
  // 会 new OpenAI，即便该 client 从不被调用）——给占位地址兜底。pi 是 provider-agnostic
  // （真实端点由 pi 自己按 --model / auth.json 决定），故用一个明显不可达的占位域名。
  const baseURL =
    entry.baseURL ??
    (entry.kind === 'claude-code'
      ? 'https://api.anthropic.com'
      : entry.kind === 'codex'
        ? 'https://api.openai.com'
        : entry.kind === 'pi'
          ? 'https://pi.invalid'
          : '');
  return { apiKey, baseURL, model: entry.model, supportsJsonMode };
}

/**
 * 把 activeProvider 指向的 entry 覆盖到顶层 apiKey/baseURL/model。
 * 没设 activeProvider，或 providers map 里找不到该 key → 原样返回（v0 单一 provider 行为）。
 *
 * 显式找不到 entry 但 activeProvider 非空 → 抛 Error。这是用户明确选择的 provider
 * 不存在；silent fallback 容易让人 debug 半天。
 */
export function applyActiveProvider(parsed: Config): Config {
  const name = parsed.activeProvider;
  if (!name) return parsed;
  const entry = parsed.providers[name];
  if (!entry) {
    throw new Error(
      `activeProvider="${name}" not found in providers map. ` +
        `Configured: ${Object.keys(parsed.providers).join(', ') || '(empty)'}`,
    );
  }
  const resolved = resolveProviderEntry(entry);
  return {
    ...parsed,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    model: resolved.model,
    supportsJsonMode: resolved.supportsJsonMode,
    providerKind: entry.kind ?? 'openai',
  };
}

/**
 * 选水合用的 provider entry：显式 `hydrationProvider` > 第一个 openai 类 provider。
 * 都没有 → undefined（调用方回退到顶层 config，即 v0 单 provider 行为）。
 * 委托型 CLI（claude-code/codex/pi）永不入选（它们不能做批量 JSON 水合）。
 */
export function pickHydrationProvider(config: Config): ProviderConfig | undefined {
  const isOpenai = (e: ProviderConfig) => (e.kind ?? 'openai') === 'openai';
  if (config.hydrationProvider) {
    const e = config.providers[config.hydrationProvider];
    if (e && isOpenai(e)) return e;
  }
  for (const e of Object.values(config.providers)) {
    if (isOpenai(e)) return e;
  }
  return undefined;
}

export function ensureWikiRoot(config: Config): void {
  fs.mkdirSync(config.wikiRoot, { recursive: true });
}

export function ensureHistoryDir(config: Config): void {
  fs.mkdirSync(path.dirname(config.historyFile), { recursive: true });
}

/** 创建持久化队列需要的目录（state 文件父目录、log 目录）。 */
export function ensureQueueDirs(config: Config): void {
  fs.mkdirSync(path.dirname(config.queueStatePath), { recursive: true });
  fs.mkdirSync(config.queueLogDir, { recursive: true });
}

/** 创建 transcript 输出目录。 */
export function ensureOutputDir(config: Config): void {
  fs.mkdirSync(config.outputDir, { recursive: true });
}

/**
 * 创建 skill 发现目录（默认双层的第一条 = user-global，作为 `skill add` 的落地目标）。
 * skillDirs 为空时 no-op。其余目录不强制创建——用户没建就当没有 skill。
 */
export function ensureSkillsDir(config: Config): void {
  const first = config.skillDirs[0];
  if (first) fs.mkdirSync(first, { recursive: true });
}

export function requireApiKey(config: Config): void {
  // claude-code / codex 是委托型 provider，只有桌面端 engine 实现了 spawn 对应 CLI 的路径；
  // CLI（REPL / 子命令）的 createClient 只会 new OpenAI 连占位端点、必然失败。
  // 与其放行后在第一条消息处报一个难懂的鉴权错，不如此处 fail-fast 给出切换指引。
  // dev REPL 默认读 ~/.pith-wiki-dev/config.json——桌面 dev 把 activeProvider 设成
  // 委托型 provider 时，共用同一个 home 的 CLI 会继承到这个不支持的 provider。
  if (config.providerKind !== 'openai') {
    const name = config.activeProvider ?? config.providerKind;
    throw new Error(
      `provider "${name}" (kind: ${config.providerKind}) is desktop-only — the CLI cannot delegate to the ${config.providerKind} binary. ` +
        `Switch to an OpenAI-compatible provider for the CLI: pass --provider <name>, set PITH_WIKI_PROVIDER=<name>, ` +
        `or change "activeProvider" in the config.json under your pith-wiki home.`,
    );
  }
  if (config.apiKey) return;
  // 报出"当前激活的 provider 真正需要哪个 env"，而不是永远硬编码 DEEPSEEK_API_KEY。
  // 例如 activeProvider=doubao 时缺的是 DOUBAO_API_KEY——硬编码文案会把用户引向错的变量。
  const name = config.activeProvider;
  const entry = name ? config.providers?.[name] : undefined;
  const envVar = entry?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const who = name ? `provider "${name}"` : 'this command';
  throw new Error(
    `No API key for ${who}. Add a literal "apiKey" to its providers entry in config.json` +
      (entry ? '' : ` (under your pith-wiki home)`) +
      `, or put "${envVar}" in config.json's "secrets" map.`,
  );
}
