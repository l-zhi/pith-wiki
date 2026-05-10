import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import matter from 'gray-matter';
import OpenAI from 'openai';
import fastGlob from 'fast-glob';
import { requireApiKey, type Config } from '../config.js';
import { LibraryService } from '../wiki/library.js';
import { HydrationService } from '../wiki/hydration.js';
import { ContextAssembler } from '../wiki/assembler.js';
import { runBatch } from '../wiki/batch.js';
import { buildConverterPipeline } from '../wiki/converters/index.js';
import { formatConvertersTable } from './converterFormat.js';
import { collectDashboardData, formatDashboard } from './dashboardData.js';
import { resolveSafePath, SafetyError } from '../tools/safety.js';
import { Source } from '../wiki/types.js';
import { buildQueueCommands, buildWatchCommand } from './queueCommands.js';

interface BuildArgs {
  configFor: (overrides?: Partial<Config>) => Config;
}

export function buildSubcommands(program: Command, args: BuildArgs): void {
  program
    .command('ingest')
    .description('Hydrate raw text into a wiki entry and store it.')
    .requiredOption('--collection <name>', 'Wiki collection (folder).')
    .option('--file <path>', 'Read raw input from a single file.')
    .option('--batch <glob>', 'Glob pattern to match many files (e.g. "papers/*.md").')
    .option('--dir <folder>', 'Recursively ingest all .md files under a folder.')
    .option('--url <url>', 'Tag the source as this URL (does not fetch; pipe content via --file or stdin).')
    .option('--no-auto-link', 'Disable auto-linking against existing entries.')
    .option(
      '--concurrency <n>',
      'Parallel hydration workers (batch mode only).',
      (v) => parseInt(v, 10),
      3,
    )
    .option('--force', 'Re-hydrate files that are already ingested (batch mode only).')
    .option(
      '--converter <name>',
      'Force a specific converter (bypass extension-based resolution).',
    )
    .option('--no-cache', 'Skip the converter result cache (always re-run conversion).')
    .action(async (opts) => {
      const config = args.configFor();
      requireApiKey(config);

      // 三种输入模式互斥：单文件 / glob / 目录。
      const modeFlags = [opts.file, opts.batch, opts.dir].filter(Boolean);
      if (modeFlags.length > 1) {
        console.error(chalk.red('Error: --file, --batch, --dir are mutually exclusive.'));
        process.exitCode = 1;
        return;
      }

      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
      const library = new LibraryService(config.wikiRoot);
      const hydrator = new HydrationService(client, config.model, library);
      // 注意：commander `--no-cache` 会把 opts.cache 解析成 false（默认 true）。
      const cacheConverted = opts.cache !== false && config.cacheConverted;
      const { registry: convRegistry, cache: convCache } = buildConverterPipeline({
        wikiRoot: config.wikiRoot,
        cacheConverted,
      });

      // 公共读沙箱选项：复用 read_file/list_dir 的同款校验，让 ingest 文件路径
      // 必须落在 workspaceRoot ∪ wikiRoot ∪ additionalReadPaths 之内。
      // 防止有人写出 `llm-wiki ingest --file /etc/passwd` 这类调用。
      const readSandbox = {
        workspaceRoot: config.workspaceRoot,
        wikiRoot: config.wikiRoot,
        maxPayloadBytes: config.maxToolPayloadBytes,
        readOnly: config.readOnly,
        additionalReadPaths: config.additionalReadPaths,
      };

      // 批量分支：--batch <glob> 或 --dir <folder>
      if (opts.batch || opts.dir) {
        const allFiles = await enumerateBatchFiles(opts);
        if (allFiles.length === 0) {
          console.error(chalk.yellow('No files matched.'));
          process.exitCode = 1;
          return;
        }

        // 严格校验：批内任一文件越界都立即 abort，让用户先把读沙箱配置改对。
        const outOfSandbox: string[] = [];
        for (const f of allFiles) {
          try {
            resolveSafePath(f, 'read', readSandbox);
          } catch (err) {
            if (err instanceof SafetyError) {
              outOfSandbox.push(f);
            } else {
              throw err;
            }
          }
        }
        if (outOfSandbox.length > 0) {
          console.error(
            chalk.red(
              `Error: ${outOfSandbox.length} file(s) lie outside the read sandbox (workspace + wiki + additionalReadPaths):`,
            ),
          );
          for (const f of outOfSandbox.slice(0, 5)) console.error(chalk.red(`  - ${f}`));
          if (outOfSandbox.length > 5) {
            console.error(chalk.red(`  ... and ${outOfSandbox.length - 5} more`));
          }
          console.error(
            chalk.gray(
              'Add --read-path <dir> or set LLM_WIKI_READ_PATHS to include these locations.',
            ),
          );
          process.exitCode = 1;
          return;
        }

        console.log(chalk.gray(`Found ${allFiles.length} file(s).`));
        const summary = await runBatch({
          files: allFiles,
          collection: opts.collection,
          force: !!opts.force,
          concurrency: Math.max(1, opts.concurrency || 3),
          hydrator,
          library,
          converterRegistry: convRegistry,
          cache: convCache,
          converter: opts.converter,
          log: (line) => console.log(line),
        });
        console.log(chalk.gray('─'.repeat(40)));
        console.log(
          `Summary: ${chalk.green(`${summary.ok} ingested`)} · ${chalk.yellow(`${summary.skipped} skipped`)} · ${chalk.red(`${summary.failed} failed`)}`,
        );
        if (summary.failed > 0) {
          console.log(chalk.red('Failed:'));
          for (const r of summary.results.filter((x) => x.status === 'failed')) {
            console.log(chalk.red(`  - ${r.file}: ${r.reason}`));
          }
        }
        // 全失败或 0 匹配（已上面挡掉）→ exit 1；至少 1 个成功 → exit 0
        if (summary.ok === 0) process.exitCode = 1;
        // 批量 ingest 之后强制刷盘：N 条 put 都进了 cache，让下次启动免去 scanAll
        library.flushIndex();
        return;
      }

      // 单文件分支：--file 通过转换器流水线（PDF/docx/html 等都走得通），
      // stdin 仍按 inline 文本走 hydrator（没有路径无法选转换器）。
      if (opts.file) {
        const absFile = path.resolve(opts.file);
        try {
          resolveSafePath(absFile, 'read', readSandbox);
        } catch (err) {
          if (err instanceof SafetyError) {
            console.error(
              chalk.red(
                `Error: ${absFile} lies outside the read sandbox.\n` +
                  '       Add --read-path <dir> or LLM_WIKI_READ_PATHS to allow it.',
              ),
            );
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        // 复用 runBatch 的转换器 + hydration 流水线，单文件场景就是 files=[absFile]、
        // concurrency=1。dedup 行为也保持一致（已 ingest 过 → skipped）。
        const summary = await runBatch({
          files: [absFile],
          collection: opts.collection,
          force: !!opts.force,
          concurrency: 1,
          hydrator,
          library,
          converterRegistry: convRegistry,
          cache: convCache,
          converter: opts.converter,
          log: (line) => console.log(line),
        });
        if (summary.failed > 0) {
          for (const r of summary.results.filter((x) => x.status === 'failed')) {
            console.log(chalk.red(`  ${r.reason}`));
          }
          process.exitCode = 1;
        }
        if (summary.ok > 0) {
          const saved = library.get(summary.results.find((r) => r.status === 'ok')!.id!, opts.collection);
          if (saved) {
            console.log(chalk.gray('title:'), saved.title);
            console.log(chalk.gray('summary:'), saved.summary);
            console.log(chalk.gray('tags:'), saved.tags.join(', '));
            console.log(chalk.gray('links:'), saved.links.join(', '));
            console.log(
              chalk.gray('compression:'),
              saved.compressionRatio ? saved.compressionRatio.toFixed(3) : 'n/a',
            );
          }
        }
        library.flushIndex();
        return;
      }
      // stdin 分支：纯文本 / markdown 直接喂 hydrator（没有文件路径，转换器不参与）。
      const raw = await readRaw(undefined);
      const source: Source = opts.url ? { type: 'url', value: opts.url } : { type: 'inline' };
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
      library.flushIndex();
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

  program
    .command('converters')
    .description('List file → text converters registered in this build.')
    .action(() => {
      const config = args.configFor();
      const { registry } = buildConverterPipeline({
        wikiRoot: config.wikiRoot,
        cacheConverted: config.cacheConverted,
      });
      console.log(formatConvertersTable(registry));
    });

  program
    .command('status')
    .description('Show wiki collections + watch directories at a glance.')
    .action(async () => {
      const config = args.configFor();
      const { registry } = buildConverterPipeline({
        wikiRoot: config.wikiRoot,
        cacheConverted: config.cacheConverted,
      });
      const data = await collectDashboardData(config, registry);
      console.log(formatDashboard(data));
    });

  buildQueueCommands(program, args);
  buildWatchCommand(program, args);
}

/**
 * 把 --batch <glob> 或 --dir <folder> 展开成绝对路径数组。
 * 都不传时返回 []（理论上不会被调用，但保险起见）。
 *
 * 导出供 queue add 命令复用同一份枚举语义。
 */
export async function enumerateBatchFiles(opts: {
  batch?: string;
  dir?: string;
}): Promise<string[]> {
  if (opts.batch) {
    // fast-glob 默认相对 cwd 解析；absolute=true 直接给绝对路径。
    return fastGlob(opts.batch, {
      absolute: true,
      onlyFiles: true,
      // 默认忽略 dotfiles，与人类直觉一致。
      dot: false,
    });
  }
  if (opts.dir) {
    const absRoot = path.resolve(opts.dir);
    // 递归找所有 .md。fast-glob 的 ** 模式比 fs.readdirSync 递归省事。
    return fastGlob('**/*.md', {
      cwd: absRoot,
      absolute: true,
      onlyFiles: true,
      dot: false,
    });
  }
  return [];
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
