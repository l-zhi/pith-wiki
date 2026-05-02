import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * 懒加载 `.env`，仅 CLI 入口（`loadConfigFromEnv`）会调用。
 *
 * 加载顺序：项目根 `.env` → `~/.llm-wiki/.env`（override: true，权威源）。
 * 设计意图：避免每个项目根都需要复制一份 .env；让 DEEPSEEK_API_KEY 这类
 * 跨工作区不变的密钥只放一份在 ~/.llm-wiki/.env。
 *
 * 模块加载时不再自动跑 dotenv —— 库消费者 `import { defineConfig } from 'llm-wiki/config'`
 * 不会污染宿主进程的 env。
 *
 * 幂等：第二次调用 no-op，避免覆盖测试或调用方在第一次 load 后手工改的 env。
 */
let dotenvLoaded = false;
function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  dotenv.config();
  dotenv.config({
    path: path.join(os.homedir(), '.llm-wiki', '.env'),
    override: true,
  });
}

/**
 * 多 provider 配置：每个条目对应一个 OpenAI-compatible endpoint。
 *
 * 用法（在 ~/.llm-wiki/config.json 里）：
 *   {
 *     "providers": {
 *       "deepseek": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
 *       "qwen":     { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "apiKeyEnv": "DASHSCOPE_API_KEY" },
 *       "openai":   { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" }
 *     },
 *     "activeProvider": "deepseek"
 *   }
 *
 * 优先级 activeProvider：CLI `--provider` > env `LLM_WIKI_PROVIDER` > 配置文件
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
const ProviderSchema = z.object({
  baseURL: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const ConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseURL: z.string().url(),
  model: z.string().min(1),
  /** Multi-provider map（可选）。空 → 走顶层 apiKey/baseURL/model（v0 行为）。 */
  providers: z.record(z.string(), ProviderSchema).default({}),
  /** 当前激活的 provider key（必须出现在 providers 里）。空 → 不切换。 */
  activeProvider: z.string().optional(),
  workspaceRoot: z.string().min(1),
  wikiRoot: z.string().min(1),
  readOnly: z.boolean(),
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
  /** `queue run` 默认并发数。CLI `--concurrency` 可覆盖。 */
  queueConcurrency: z.number().int().positive(),
  /** 队列级别的最大尝试次数。第 N 次失败后 job 标 dead。 */
  queueMaxAttempts: z.number().int().positive(),
  /**
   * REPL 启动时是否自动起队列 worker（`idleBehavior=wait`）。
   * true（默认）：进 REPL 自动开 worker，本会话内 wiki_queue_add 增的 job 立即被处理。
   * 关掉的方式：CLI `--no-auto-queue`，或 ~/.llm-wiki/config.json 里写 false。
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
   * 关掉的方式：CLI `--no-auto-watch`，或 ~/.llm-wiki/config.json 里写 false。
   */
  watchAutoStart: z.boolean(),
  /**
   * REPL 每次问答自动写入 markdown transcript 的目录。
   * 默认 `<wikiRoot>/output/transcripts/`：和数字化的 wiki 条目同根，但用子目录
   * 屏蔽 LibraryService 的 collection 扫描（scanAll 只读 `<wikiRoot>/<collection>/*.md`
   * 一层，子目录不会被当成 collection）。
   */
  outputDir: z.string().min(1),
  /** REPL 是否记录 transcript（CLI `--no-transcript` 可关）。默认 true。 */
  transcriptEnabled: z.boolean(),
  /**
   * `/digest` slash 命令默认落地的 collection 名（路径 `<wikiRoot>/<digestCollection>/`）。
   * 默认 `output` —— 跟 transcripts 共享同一个 wiki 子目录，但层级是 collection（被索引）。
   */
  digestCollection: z.string().min(1),
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
  maxToolPayloadBytes?: number;
  additionalReadPaths?: string[];
  queueStatePath?: string;
  queueLogDir?: string;
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
}

const DEFAULTS = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxToolPayloadBytes: 100_000,
  queueConcurrency: 2,
  queueMaxAttempts: 3,
  queueAutoStart: true,
  watchAutoStart: true,
  transcriptEnabled: true,
  digestCollection: 'output',
};

function loadFileConfig(): Partial<Config> {
  const file = path.join(os.homedir(), '.llm-wiki', 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
  }
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
        `LLM_WIKI_READ_PATHS looks like JSON but failed to parse: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `LLM_WIKI_READ_PATHS JSON value must be a string array, got ${typeof parsed}`,
      );
    }
    items = parsed.map((v) => {
      if (typeof v !== 'string') {
        throw new Error(`LLM_WIKI_READ_PATHS array entry is not a string: ${JSON.stringify(v)}`);
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
 * CLI 入口的配置加载：读 `.env`、`~/.llm-wiki/config.json`、env 变量，
 * 再叠加显式 overrides，zod 校验后返回。
 *
 * 仅 CLI 用——库消费者请用 `defineConfig`，那是纯函数，无副作用。
 */
export function loadConfigFromEnv(overrides: ConfigOverrides = {}): Config {
  loadDotenvOnce();
  const file = loadFileConfig();
  const cwd = process.cwd();
  const workspaceRoot =
    overrides.workspaceRoot ?? process.env.LLM_WIKI_WORKSPACE ?? file.workspaceRoot ?? cwd;
  // wikiRoot 默认放在 ~/.llm-wiki/wiki-data：与队列状态、命令历史、配置同源在
  // 用户 home 下。这样多个 workspace 共享同一份 wiki，且 git 不会无意把数据
  // 提交进项目仓库（旧默认 <workspaceRoot>/wiki-data 容易误入版本控制）。
  // 想把 wiki 跟 workspace 绑在一起的用户可设 LLM_WIKI_ROOT 或配置文件。
  const wikiRoot =
    overrides.wikiRoot ??
    process.env.LLM_WIKI_ROOT ??
    file.wikiRoot ??
    path.join(os.homedir(), '.llm-wiki', 'wiki-data');
  const resolvedWikiRoot = path.resolve(wikiRoot);

  // additionalReadPaths：CLI flag > env > 配置文件 > 空数组。
  // 一旦提供，所有路径都先做 `~/` 展开，再规范化为绝对路径（相对路径相对 cwd）。
  const additionalReadPathsRaw =
    overrides.additionalReadPaths ??
    parseReadPathsFromEnv(process.env.LLM_WIKI_READ_PATHS) ??
    file.additionalReadPaths ??
    [];
  const additionalReadPaths = additionalReadPathsRaw.map((p) => path.resolve(expandHome(p)));

  // 队列相关默认路径都在 ~/.llm-wiki/queue/ 下。
  // 优先级与其他字段一致：CLI flag > 配置文件 > 默认。env 暂不引入，避免接口表面过大。
  const defaultQueueDir = path.join(os.homedir(), '.llm-wiki', 'queue');
  const queueStatePath = path.resolve(
    expandHome(
      overrides.queueStatePath ?? file.queueStatePath ?? path.join(defaultQueueDir, 'state.json'),
    ),
  );
  const queueLogDir = path.resolve(
    expandHome(overrides.queueLogDir ?? file.queueLogDir ?? path.join(defaultQueueDir, 'logs')),
  );

  const merged = {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? file.apiKey ?? '',
    baseURL:
      overrides.baseURL ?? process.env.LLM_WIKI_BASE_URL ?? file.baseURL ?? DEFAULTS.baseURL,
    model: overrides.model ?? process.env.LLM_WIKI_MODEL ?? file.model ?? DEFAULTS.model,
    workspaceRoot: path.resolve(workspaceRoot),
    wikiRoot: resolvedWikiRoot,
    readOnly:
      overrides.readOnly ??
      (process.env.LLM_WIKI_READ_ONLY === 'true' ? true : undefined) ??
      file.readOnly ??
      false,
    maxToolPayloadBytes:
      overrides.maxToolPayloadBytes ?? file.maxToolPayloadBytes ?? DEFAULTS.maxToolPayloadBytes,
    historyFile: path.join(os.homedir(), '.llm-wiki', 'history'),
    additionalReadPaths,
    queueStatePath,
    queueLogDir,
    queueConcurrency:
      overrides.queueConcurrency ?? file.queueConcurrency ?? DEFAULTS.queueConcurrency,
    queueMaxAttempts:
      overrides.queueMaxAttempts ?? file.queueMaxAttempts ?? DEFAULTS.queueMaxAttempts,
    queueAutoStart:
      overrides.queueAutoStart ?? file.queueAutoStart ?? DEFAULTS.queueAutoStart,
    // watchDirs：CLI overrides > 配置文件 > []。环境变量先不引入（结构太复杂，
    // 不像单条路径列表那么自然）；CLI 也只在 `llm-wiki watch` 命令里用 flag 覆盖。
    // 路径里的 ~/ 在 schema parse 之后再展开（loadConfig 末尾统一处理）。
    watchDirs: overrides.watchDirs ?? file.watchDirs ?? [],
    watchAutoStart:
      overrides.watchAutoStart ?? file.watchAutoStart ?? DEFAULTS.watchAutoStart,
    // 默认放在 <wikiRoot>/output/transcripts/：raw transcripts 和 digest 条目共享 wiki 树根，
    // 但 transcripts 落在子目录里，不会被 LibraryService 当成 collection 来扫
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
    // multi-provider：providers 表来自 file（不接受 env，结构复杂），activeProvider
    // 走 CLI > env > file。Zod 校验之后再 overlay 到顶层 apiKey/baseURL/model。
    providers: overrides.providers ?? file.providers ?? {},
    activeProvider:
      overrides.activeProvider ?? process.env.LLM_WIKI_PROVIDER ?? file.activeProvider,
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
 * 库（嵌入）模式的配置工厂。**纯函数**：不读 `.env`、不读 `~/.llm-wiki/config.json`、
 * 不读 `process.env`、不写文件系统。只把传入的 input 与默认值合并、做 zod 校验。
 *
 * 与 `loadConfigFromEnv` 的关键差别：
 *   - 必填：`apiKey`、`baseURL`、`model`、`wikiRoot`
 *   - `workspaceRoot` 缺省 = `wikiRoot`
 *   - 队列 / history / output 等路径默认派生自 `wikiRoot`，**不**落到 `~/.llm-wiki/`
 *     —— 嵌入应用的数据应集中在它自己规划的目录里
 *   - 不应用 dotenv，宿主进程的 env 不会被污染
 *
 * 示例：
 *   const config = defineConfig({
 *     apiKey: 'sk-...',
 *     baseURL: 'https://api.deepseek.com',
 *     model: 'deepseek-chat',
 *     wikiRoot: '/path/to/wiki',
 *   });
 */
export interface DefineConfigInput {
  apiKey: string;
  baseURL: string;
  model: string;
  wikiRoot: string;
  workspaceRoot?: string;
  providers?: Record<string, ProviderConfig>;
  activeProvider?: string;
  readOnly?: boolean;
  maxToolPayloadBytes?: number;
  additionalReadPaths?: string[];
  historyFile?: string;
  queueStatePath?: string;
  queueLogDir?: string;
  queueConcurrency?: number;
  queueMaxAttempts?: number;
  queueAutoStart?: boolean;
  watchDirs?: ConfigOverrides['watchDirs'];
  watchAutoStart?: boolean;
  outputDir?: string;
  transcriptEnabled?: boolean;
  digestCollection?: string;
}

export function defineConfig(input: DefineConfigInput): Config {
  const wikiRoot = path.resolve(expandHome(input.wikiRoot));
  const workspaceRoot = path.resolve(expandHome(input.workspaceRoot ?? wikiRoot));
  const queueDir = path.join(wikiRoot, '.queue');
  const merged = {
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    model: input.model,
    workspaceRoot,
    wikiRoot,
    readOnly: input.readOnly ?? false,
    maxToolPayloadBytes: input.maxToolPayloadBytes ?? DEFAULTS.maxToolPayloadBytes,
    historyFile: path.resolve(expandHome(input.historyFile ?? path.join(wikiRoot, '.history'))),
    additionalReadPaths: (input.additionalReadPaths ?? []).map((p) =>
      path.resolve(expandHome(p)),
    ),
    queueStatePath: path.resolve(
      expandHome(input.queueStatePath ?? path.join(queueDir, 'state.json')),
    ),
    queueLogDir: path.resolve(expandHome(input.queueLogDir ?? path.join(queueDir, 'logs'))),
    queueConcurrency: input.queueConcurrency ?? DEFAULTS.queueConcurrency,
    queueMaxAttempts: input.queueMaxAttempts ?? DEFAULTS.queueMaxAttempts,
    queueAutoStart: input.queueAutoStart ?? DEFAULTS.queueAutoStart,
    watchDirs: input.watchDirs ?? [],
    watchAutoStart: input.watchAutoStart ?? DEFAULTS.watchAutoStart,
    outputDir: path.resolve(
      expandHome(input.outputDir ?? path.join(wikiRoot, 'output', 'transcripts')),
    ),
    transcriptEnabled: input.transcriptEnabled ?? DEFAULTS.transcriptEnabled,
    digestCollection: input.digestCollection ?? DEFAULTS.digestCollection,
    providers: input.providers ?? {},
    activeProvider: input.activeProvider,
  };
  const parsed = ConfigSchema.parse(merged);
  parsed.watchDirs = parsed.watchDirs.map((wd) => ({
    ...wd,
    path: path.resolve(expandHome(wd.path)),
  }));
  return applyActiveProvider(parsed);
}

/**
 * 把 entry.apiKey / apiKeyEnv 折成最终的 apiKey 字符串。
 * 优先级：字面 apiKey > env[apiKeyEnv]。两者都没给 → 空串。
 */
export function resolveProviderEntry(entry: ProviderConfig): {
  apiKey: string;
  baseURL: string;
  model: string;
} {
  const fromEnv = entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] ?? '') : '';
  const apiKey = entry.apiKey && entry.apiKey.length > 0 ? entry.apiKey : fromEnv;
  return { apiKey, baseURL: entry.baseURL, model: entry.model };
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
  };
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

export function requireApiKey(config: Config): void {
  if (!config.apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is required for this command. Set it in .env or as an environment variable.',
    );
  }
}
