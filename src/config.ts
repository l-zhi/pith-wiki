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
