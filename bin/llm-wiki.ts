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
}

const program = new Command();
program
  .name('llm-wiki')
  .description('Karpathy-style LLM wiki CLI (DeepSeek-powered).')
  .version('0.1.0')
  .option('--read-only', 'Disable file writes.')
  .option('--model <name>', 'Override the LLM model.')
  .option('--root <dir>', 'Override the wiki storage root.');

const configFor = (extra: Partial<Config> = {}): Config => {
  const opts = program.opts<GlobalOpts>();
  const config = loadConfig({
    readOnly: opts.readOnly,
    model: opts.model,
    wikiRoot: opts.root,
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
