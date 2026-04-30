import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

// `.env` 加载顺序：项目根的 .env 先（fallback / 首次 setup 仍走传统约定），
// 然后 ~/.llm-wiki/.env 以 `override: true` 覆盖——用户自己的 home .env 是
// 权威源，跨 workspace 共用。两个都不存在时 dotenv 静默 no-op。
//
// 设计意图：避免每个项目根都需要复制一份 .env；让 DEEPSEEK_API_KEY 这类
// 跨工作区不变的密钥只放一份在 ~/.llm-wiki/.env。
dotenv.config();
dotenv.config({
  path: path.join(os.homedir(), '.llm-wiki', '.env'),
  override: true,
});

const ConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseURL: z.string().url(),
  model: z.string().min(1),
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

export function loadConfig(overrides: ConfigOverrides = {}): Config {
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
  };

  return ConfigSchema.parse(merged);
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
