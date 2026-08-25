#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadConfigFromEnv,
  ensureWikiRoot,
  ensureHistoryDir,
  requireChatProvider,
  type Config,
} from '../src/config.js';
import { ZodError } from 'zod';
import { buildSubcommands } from '../src/cli/subcommands.js';
import { App } from '../src/cli/App.js';
import { readPackageVersion } from '../src/version.js';

interface GlobalOpts {
  readOnly?: boolean;
  model?: string;
  root?: string;
  /** --read-path 可重复，commander 用 collectPaths 累积。 */
  readPath?: string[];
  /** --provider <name>：选 config.providers 里某条作为 active 入口。 */
  provider?: string;
}

/** commander 自定义 collector：每次出现 --read-path 把值追加到累计数组里。 */
function collectPaths(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();
program
  .name('pith-wiki')
  .description(
    'Karpathy-style LLM knowledge base CLI — hydrate docs into dense Markdown entries, retrieve by keyword + link traversal.',
  )
  .version(readPackageVersion())
  .option('--read-only', 'Disable file writes.')
  .option('--model <name>', 'Override the LLM model.')
  .option('--root <dir>', 'Override the wiki storage root.')
  .option(
    '--read-path <dir>',
    'Additional readable directory (repeatable). Extends read-only sandbox; writes still locked to workspace + wiki.',
    collectPaths,
    [] as string[],
  )
  .option(
    '--provider <name>',
    'Use a named provider entry from config.providers (overrides PITH_WIKI_PROVIDER and config.activeProvider).',
  );

const configFor = (extra: Partial<Config> = {}): Config => {
  const opts = program.opts<GlobalOpts>();
  // --read-path 至少一次时覆盖 env / 配置文件；为空数组时让 loadConfigFromEnv 走更低优先级源。
  const readPathOverride = opts.readPath && opts.readPath.length > 0 ? opts.readPath : undefined;
  const config = loadConfigFromEnv({
    readOnly: opts.readOnly,
    model: opts.model,
    wikiRoot: opts.root,
    additionalReadPaths: readPathOverride,
    activeProvider: opts.provider,
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
  .option('--no-auto-queue', 'Do not auto-start the queue worker in this REPL session.')
  .option(
    '--no-auto-watch',
    'Do not auto-start directory watchers in this REPL session (config.watchDirs).',
  )
  .option('--no-transcript', 'Do not write a markdown transcript of this session to outputDir.')
  .action(async (chatOpts) => {
    let config: Config;
    try {
      // commander 把 --no-auto-queue / --no-auto-watch / --no-transcript 解析为
      // autoQueue=false / autoWatch=false / transcript=false。仅在显式给出时覆盖。
      const overrides: Partial<Config> = {};
      if (chatOpts.autoQueue === false) overrides.queueAutoStart = false;
      if (chatOpts.autoWatch === false) overrides.watchAutoStart = false;
      if (chatOpts.transcript === false) overrides.transcriptEnabled = false;
      config = configFor(overrides);
      requireChatProvider(config);
    } catch (err) {
      reportError(err);
      process.exit(1);
    }
    // App 自己持有 client：REPL 内 /provider 切换需要重建 client + agent，
    // 留给 App 统一控制（bin 只负责传初始 config）。
    const instance = render(React.createElement(App, { config }));
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
