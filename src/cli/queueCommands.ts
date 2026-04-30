import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import OpenAI from 'openai';
import {
  ensureQueueDirs,
  ensureWikiRoot,
  requireApiKey,
  type Config,
} from '../config.js';
import { LibraryService } from '../wiki/library.js';
import { HydrationService } from '../wiki/hydration.js';
import {
  deriveJobId,
  pushEvent,
  type QueueJob,
  type QueueState,
} from '../wiki/queue/state.js';
import { QueueLockedError, QueueStore } from '../wiki/queue/store.js';
import { runQueue } from '../wiki/queue/runner.js';
import { resolveSafePath, SafetyError } from '../tools/safety.js';
import { enumerateBatchFiles } from './subcommands.js';

interface BuildArgs {
  configFor: (overrides?: Partial<Config>) => Config;
}

/**
 * 注册 `queue` 子命令族：add / status / run / clear / retry。
 *
 * 这一组命令共享一个 QueueStore，但只有 `queue run` 取锁；其他命令直接读/写
 * state 文件。两者的并发风险在 store.ts 注释里说明。
 */
export function buildQueueCommands(program: Command, args: BuildArgs): void {
  const queue = program.command('queue').description('Manage the persistent ingest queue.');

  // ---------- queue add ----------
  queue
    .command('add')
    .description('Enqueue files for later wiki ingestion.')
    .requiredOption('--collection <name>', 'Wiki collection (folder).')
    .option('--file <path>', 'Single file.')
    .option('--batch <glob>', 'Glob pattern (e.g. "papers/*.md").')
    .option('--dir <folder>', 'Recursively enqueue all .md files under a folder.')
    .option('--force', 'Re-enqueue files already completed (resets attempts).')
    .action(async (opts) => {
      const config = args.configFor();
      ensureWikiRoot(config);
      ensureQueueDirs(config);

      const modes = [opts.file, opts.batch, opts.dir].filter(Boolean);
      if (modes.length === 0) {
        console.error(chalk.red('Error: provide one of --file, --batch, --dir.'));
        process.exitCode = 1;
        return;
      }
      if (modes.length > 1) {
        console.error(chalk.red('Error: --file, --batch, --dir are mutually exclusive.'));
        process.exitCode = 1;
        return;
      }

      // 读沙箱校验：复用 ingest 同款逻辑——队列里的文件以后被 worker 读取，
      // 必须在沙箱内（workspace ∪ wiki ∪ additionalReadPaths）。
      const readSandbox = {
        workspaceRoot: config.workspaceRoot,
        wikiRoot: config.wikiRoot,
        maxPayloadBytes: config.maxToolPayloadBytes,
        readOnly: config.readOnly,
        additionalReadPaths: config.additionalReadPaths,
      };

      let files: string[];
      if (opts.file) {
        files = [path.resolve(opts.file)];
      } else {
        files = await enumerateBatchFiles(opts);
      }
      if (files.length === 0) {
        console.error(chalk.yellow('No files matched.'));
        process.exitCode = 1;
        return;
      }

      const outOfSandbox: string[] = [];
      for (const f of files) {
        try {
          resolveSafePath(f, 'read', readSandbox);
        } catch (err) {
          if (err instanceof SafetyError) outOfSandbox.push(f);
          else throw err;
        }
      }
      if (outOfSandbox.length > 0) {
        console.error(
          chalk.red(
            `Error: ${outOfSandbox.length} file(s) lie outside the read sandbox.`,
          ),
        );
        for (const f of outOfSandbox.slice(0, 5)) console.error(chalk.red(`  - ${f}`));
        if (outOfSandbox.length > 5) {
          console.error(chalk.red(`  ... and ${outOfSandbox.length - 5} more`));
        }
        process.exitCode = 1;
        return;
      }

      const store = new QueueStore(config.queueStatePath);
      let added = 0;
      let reset = 0;
      let skipped = 0;
      store.mutate((s) => {
        for (const file of files) {
          const id = deriveJobId(file, opts.collection);
          const existing = s.jobs[id];
          if (!existing) {
            const job: QueueJob = {
              id,
              file,
              collection: opts.collection,
              force: !!opts.force,
              status: 'pending',
              attempts: 0,
              enqueuedAt: new Date().toISOString(),
            };
            s.jobs[id] = job;
            pushEvent(s, { ts: job.enqueuedAt, jobId: id, kind: 'enqueued' });
            added += 1;
            continue;
          }
          if (opts.force) {
            existing.status = 'pending';
            existing.attempts = 0;
            existing.lastError = undefined;
            existing.startedAt = undefined;
            existing.completedAt = undefined;
            existing.finalEntryId = undefined;
            existing.nextEarliestRunAt = undefined;
            existing.force = true;
            pushEvent(s, {
              ts: new Date().toISOString(),
              jobId: id,
              kind: 'enqueued',
              msg: 're-enqueued via --force',
            });
            reset += 1;
          } else {
            skipped += 1;
          }
        }
      });

      console.log(
        `${chalk.green(`enqueued: ${added}`)}, ${chalk.cyan(`reset: ${reset}`)}, ${chalk.gray(`skipped: ${skipped}`)} (state=${store.path})`,
      );
    });

  // ---------- queue status ----------
  queue
    .command('status')
    .description('Show queue progress.')
    .option('--json', 'Emit machine-readable JSON.')
    .action((opts) => {
      const config = args.configFor();
      ensureQueueDirs(config);
      const store = new QueueStore(config.queueStatePath);
      const state = store.load();

      if (opts.json) {
        console.log(JSON.stringify(formatStatusJson(state), null, 2));
        return;
      }

      const counts = countByStatus(state);
      console.log(
        `pending: ${chalk.cyan(counts.pending)}  running: ${chalk.yellow(counts.running)}  ` +
          `completed: ${chalk.green(counts.completed)}  dead: ${chalk.red(counts.dead)}  ` +
          `(state=${store.path})`,
      );

      const running = Object.values(state.jobs).filter((j) => j.status === 'running');
      if (running.length) {
        console.log(chalk.gray('\nrunning:'));
        for (const j of running) {
          console.log(`  ${chalk.yellow(j.id)} ${j.file} attempts=${j.attempts} startedAt=${j.startedAt ?? '?'}`);
        }
      }

      const dead = Object.values(state.jobs).filter((j) => j.status === 'dead');
      if (dead.length) {
        console.log(chalk.gray('\ndead:'));
        for (const j of dead) {
          console.log(`  ${chalk.red(j.id)} ${j.file} attempts=${j.attempts} lastError=${j.lastError ?? '?'}`);
        }
      }

      const recent = state.events.slice(-10);
      if (recent.length) {
        console.log(chalk.gray('\nlast events:'));
        for (const ev of recent) {
          console.log(`  ${ev.ts} ${ev.kind.padEnd(9)} ${ev.jobId}${ev.msg ? ` — ${ev.msg}` : ''}`);
        }
      }
    });

  // ---------- queue run ----------
  queue
    .command('run')
    .description('Start the queue worker (foreground; Ctrl-C drains gracefully).')
    .option(
      '--concurrency <n>',
      'Override config queueConcurrency.',
      (v) => parseInt(v, 10),
    )
    .action(async (opts) => {
      const config = args.configFor();
      requireApiKey(config);
      ensureWikiRoot(config);
      ensureQueueDirs(config);

      const store = new QueueStore(config.queueStatePath);
      let release: (() => void) | null = null;
      try {
        release = store.acquireLock();
      } catch (err) {
        if (err instanceof QueueLockedError) {
          console.error(chalk.red(`Error: ${err.message}. Stop the other worker before starting a new one.`));
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
      const library = new LibraryService(config.wikiRoot);
      const hydrator = new HydrationService(client, config.model, library);

      const ac = new AbortController();
      const onSignal = (sig: string) => () => {
        console.error(chalk.yellow(`\nreceived ${sig}, draining in-flight jobs...`));
        ac.abort();
      };
      const sigInt = onSignal('SIGINT');
      const sigTerm = onSignal('SIGTERM');
      process.on('SIGINT', sigInt);
      process.on('SIGTERM', sigTerm);

      const concurrency = Math.max(1, opts.concurrency || config.queueConcurrency);

      try {
        const summary = await runQueue({
          store,
          hydrator,
          library,
          concurrency,
          maxAttempts: config.queueMaxAttempts,
          backoffMs: [5_000, 30_000, 120_000],
          logDir: config.queueLogDir,
          signal: ac.signal,
          log: (line) => console.log(line),
        });
        console.log(chalk.gray('─'.repeat(40)));
        console.log(
          `Summary: ${chalk.green(`${summary.ok} ok`)} · ${chalk.red(`${summary.dead} dead`)} · ${chalk.yellow(`${summary.cancelled} cancelled`)}`,
        );
        if (summary.dead > 0) process.exitCode = 1;
      } finally {
        process.off('SIGINT', sigInt);
        process.off('SIGTERM', sigTerm);
        release?.();
      }
    });

  // ---------- queue clear ----------
  queue
    .command('clear')
    .description('Remove jobs from the queue state by status (default: completed).')
    .option('--completed', 'Remove completed jobs (default if no flag).')
    .option('--dead', 'Remove dead jobs.')
    .option('--all', 'Remove all jobs (pending/running included). Use with caution.')
    .action((opts) => {
      const config = args.configFor();
      ensureQueueDirs(config);
      const store = new QueueStore(config.queueStatePath);

      const removeCompleted = !!opts.completed || (!opts.completed && !opts.dead && !opts.all);
      const removeDead = !!opts.dead || !!opts.all;
      const removeAll = !!opts.all;

      let removed = 0;
      store.mutate((s) => {
        for (const id of Object.keys(s.jobs)) {
          const j = s.jobs[id];
          const drop =
            (removeAll) ||
            (removeCompleted && j.status === 'completed') ||
            (removeDead && j.status === 'dead');
          if (drop) {
            delete s.jobs[id];
            removed += 1;
          }
        }
      });
      console.log(chalk.green(`removed ${removed} job(s)`));
    });

  // ---------- queue retry ----------
  queue
    .command('retry [ids...]')
    .description('Reset failed/dead jobs back to pending.')
    .option('--all-dead', 'Retry every dead job.')
    .action((ids: string[], opts) => {
      const config = args.configFor();
      ensureQueueDirs(config);
      const store = new QueueStore(config.queueStatePath);

      let reset = 0;
      let notFound: string[] = [];
      store.mutate((s) => {
        const targets = new Set<string>(ids);
        if (opts.allDead) {
          for (const j of Object.values(s.jobs)) if (j.status === 'dead') targets.add(j.id);
        }
        if (targets.size === 0) return;
        for (const id of targets) {
          const j = s.jobs[id];
          if (!j) {
            notFound.push(id);
            continue;
          }
          j.status = 'pending';
          j.attempts = 0;
          j.lastError = undefined;
          j.startedAt = undefined;
          j.completedAt = undefined;
          j.nextEarliestRunAt = undefined;
          pushEvent(s, {
            ts: new Date().toISOString(),
            jobId: id,
            kind: 'reset',
            msg: 'manual retry',
          });
          reset += 1;
        }
      });
      console.log(chalk.green(`reset ${reset} job(s) to pending`));
      if (notFound.length) {
        console.error(chalk.yellow(`unknown jobIds: ${notFound.join(', ')}`));
        process.exitCode = 1;
      }
      if (reset === 0 && !opts.allDead && ids.length === 0) {
        console.error(chalk.gray('Nothing to retry. Pass <id...> or --all-dead.'));
      }
    });
}

function countByStatus(state: QueueState): Record<'pending' | 'running' | 'completed' | 'dead', number> {
  const counts = { pending: 0, running: 0, completed: 0, dead: 0 };
  for (const j of Object.values(state.jobs)) counts[j.status] += 1;
  return counts;
}

export interface StatusJson {
  counts: ReturnType<typeof countByStatus>;
  running: QueueJob[];
  dead: QueueJob[];
  recentEvents: QueueState['events'];
  statePath?: string;
}

export function formatStatusJson(state: QueueState): StatusJson {
  return {
    counts: countByStatus(state),
    running: Object.values(state.jobs).filter((j) => j.status === 'running'),
    dead: Object.values(state.jobs).filter((j) => j.status === 'dead'),
    recentEvents: state.events.slice(-10),
  };
}
