import fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import matter from 'gray-matter';
import OpenAI from 'openai';
import { requireApiKey, type Config } from '../config.js';
import { LibraryService } from '../wiki/library.js';
import { HydrationService } from '../wiki/hydration.js';
import { ContextAssembler } from '../wiki/assembler.js';
import { Source } from '../wiki/types.js';

interface BuildArgs {
  configFor: (overrides?: Partial<Config>) => Config;
}

export function buildSubcommands(program: Command, args: BuildArgs): void {
  program
    .command('ingest')
    .description('Hydrate raw text into a wiki entry and store it.')
    .requiredOption('--collection <name>', 'Wiki collection (folder).')
    .option('--file <path>', 'Read raw input from a file.')
    .option('--url <url>', 'Tag the source as this URL (does not fetch; pipe content via --file or stdin).')
    .option('--no-auto-link', 'Disable auto-linking against existing entries.')
    .action(async (opts) => {
      const config = args.configFor();
      requireApiKey(config);
      const raw = await readRaw(opts.file);
      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
      const library = new LibraryService(config.wikiRoot);
      const hydrator = new HydrationService(client, config.model, library);
      const source: Source = opts.url
        ? { type: 'url', value: opts.url }
        : opts.file
          ? { type: 'file', value: opts.file }
          : { type: 'inline' };
      const entry = await hydrator.hydrate({
        rawContent: raw,
        collectionId: opts.collection,
        autoLink: opts.autoLink !== false,
        source,
      });
      const saved = library.put(entry);
      console.log(chalk.green('✓ ingested'), chalk.bold(saved.id));
      console.log(chalk.gray('title:'), saved.title);
      console.log(chalk.gray('summary:'), saved.summary);
      console.log(chalk.gray('tags:'), saved.tags.join(', '));
      console.log(chalk.gray('links:'), saved.links.join(', '));
      console.log(
        chalk.gray('compression:'),
        saved.compressionRatio ? saved.compressionRatio.toFixed(3) : 'n/a',
      );
    });

  program
    .command('get <id>')
    .description('Print a wiki entry.')
    .option('--collection <name>')
    .action((id, opts) => {
      const config = args.configFor();
      const library = new LibraryService(config.wikiRoot);
      const entry = library.get(id, opts.collection);
      if (!entry) {
        console.error(chalk.red(`Entry not found: ${id}`));
        process.exitCode = 1;
        return;
      }
      const { content, ...rest } = entry;
      const front = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      console.log(chalk.gray(matter.stringify('', front).trim()));
      console.log();
      console.log(content);
      const backlinks = library.linkIndex().get(entry.id)?.backward ?? [];
      if (backlinks.length) {
        console.log();
        console.log(chalk.gray('backlinks:'), backlinks.join(', '));
      }
    });

  program
    .command('list')
    .description('List wiki entries.')
    .option('--collection <name>')
    .action((opts) => {
      const config = args.configFor();
      const library = new LibraryService(config.wikiRoot);
      const entries = library.list(opts.collection);
      if (entries.length === 0) {
        console.log(chalk.gray('(no entries)'));
        return;
      }
      for (const e of entries) {
        console.log(
          `${chalk.cyan(e.id)}  ${chalk.gray(`[${e.collection}]`)}  ${e.title}` +
            (e.tags.length ? `  ${chalk.gray(`#${e.tags.join(' #')}`)}` : ''),
        );
      }
    });

  program
    .command('query <text>')
    .description('Assemble Markdown context from related entries.')
    .option('--max-tokens <n>', 'Token budget.', (v) => parseInt(v, 10), 4000)
    .action((text, opts) => {
      const config = args.configFor();
      const library = new LibraryService(config.wikiRoot);
      const assembler = new ContextAssembler(library);
      const result = assembler.query(text, opts.maxTokens);
      if (result.referencedEntries.length === 0) {
        console.log(chalk.gray('(no matching entries)'));
        return;
      }
      console.log(chalk.gray('referenced:'), result.referencedEntries.join(', '));
      console.log();
      console.log(result.context);
    });
}

async function readRaw(file?: string): Promise<string> {
  if (file) return fs.readFileSync(file, 'utf8');
  if (process.stdin.isTTY) {
    throw new Error('Provide --file <path>, or pipe content via stdin.');
  }
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}
