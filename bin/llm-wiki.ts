#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadConfig,
  ensureWikiRoot,
  ensureHistoryDir,
  requireApiKey,
  type Config,
} from '../src/config.js';
import { ZodError } from 'zod';
import { createClient } from '../src/llm/client.js';
import { buildSubcommands } from '../src/cli/subcommands.js';
import { App } from '../src/cli/App.js';

interface GlobalOpts {
  readOnly?: boolean;
  model?: string;
  root?: string;
  /** --read-path 可重复，commander 用 collectPaths 累积。 */
  readPath?: string[];
}

/** commander 自定义 collector：每次出现 --read-path 把值追加到累计数组里。 */
function collectPaths(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();
program
  .name('llm-wiki')
  .description('Karpathy-style LLM wiki CLI (DeepSeek-powered).')
  .version('0.1.0')
  .option('--read-only', 'Disable file writes.')
  .option('--model <name>', 'Override the LLM model.')
  .option('--root <dir>', 'Override the wiki storage root.')
  .option(
    '--read-path <dir>',
    'Additional readable directory (repeatable). Extends read-only sandbox; writes still locked to workspace + wiki.',
    collectPaths,
    [] as string[],
  );

const configFor = (extra: Partial<Config> = {}): Config => {
  const opts = program.opts<GlobalOpts>();
  // --read-path 至少一次时覆盖 env / 配置文件；为空数组时让 loadConfig 走更低优先级源。
  const readPathOverride = opts.readPath && opts.readPath.length > 0 ? opts.readPath : undefined;
  const config = loadConfig({
    readOnly: opts.readOnly,
    model: opts.model,
    wikiRoot: opts.root,
    additionalReadPaths: readPathOverride,
    ...extra,
  });
  ensureWikiRoot(config);
  ensureHistoryDir(config);
  return config;
};

buildSubcommands(program, { configFor });

program
  .command('chat', { isDefault: true })
  .description('Start the interactive REPL (default).')
  .action(async () => {
    let config: Config;
    try {
      config = configFor();
      requireApiKey(config);
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
    const client = createClient(config);
    const instance = render(React.createElement(App, { config, client }));
    await instance.waitUntilExit();
  });

function reportError(err: unknown): void {
  if (err instanceof ZodError) {
    for (const issue of err.issues) {
      console.error(chalk.red(`config: ${issue.path.join('.')} — ${issue.message}`));
    }
  } else {
    console.error(chalk.red((err as Error).message));
  }
}

program.parseAsync(process.argv).catch((err) => {
  reportError(err);
  process.exit(1);
});
