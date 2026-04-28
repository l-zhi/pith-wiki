import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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
}

const DEFAULTS = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxToolPayloadBytes: 100_000,
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
  const wikiRoot =
    overrides.wikiRoot ??
    process.env.LLM_WIKI_ROOT ??
    file.wikiRoot ??
    path.join(workspaceRoot, 'wiki-data');

  // additionalReadPaths：CLI flag > env > 配置文件 > 空数组。
  // 一旦提供，所有路径都先做 `~/` 展开，再规范化为绝对路径（相对路径相对 cwd）。
  const additionalReadPathsRaw =
    overrides.additionalReadPaths ??
    parseReadPathsFromEnv(process.env.LLM_WIKI_READ_PATHS) ??
    file.additionalReadPaths ??
    [];
  const additionalReadPaths = additionalReadPathsRaw.map((p) => path.resolve(expandHome(p)));

  const merged = {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? file.apiKey ?? '',
    baseURL:
      overrides.baseURL ?? process.env.LLM_WIKI_BASE_URL ?? file.baseURL ?? DEFAULTS.baseURL,
    model: overrides.model ?? process.env.LLM_WIKI_MODEL ?? file.model ?? DEFAULTS.model,
    workspaceRoot: path.resolve(workspaceRoot),
    wikiRoot: path.resolve(wikiRoot),
    readOnly:
      overrides.readOnly ??
      (process.env.LLM_WIKI_READ_ONLY === 'true' ? true : undefined) ??
      file.readOnly ??
      false,
    maxToolPayloadBytes:
      overrides.maxToolPayloadBytes ?? file.maxToolPayloadBytes ?? DEFAULTS.maxToolPayloadBytes,
    historyFile: path.join(os.homedir(), '.llm-wiki', 'history'),
    additionalReadPaths,
  };

  return ConfigSchema.parse(merged);
}

export function ensureWikiRoot(config: Config): void {
  fs.mkdirSync(config.wikiRoot, { recursive: true });
}

export function ensureHistoryDir(config: Config): void {
  fs.mkdirSync(path.dirname(config.historyFile), { recursive: true });
}

export function requireApiKey(config: Config): void {
  if (!config.apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is required for this command. Set it in .env or as an environment variable.',
    );
  }
}
