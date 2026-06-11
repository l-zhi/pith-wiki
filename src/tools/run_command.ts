import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDef } from './index.js';
import { truncatePayload } from './safety.js';

/**
 * run_command:执行已安装 skill 声明过的外部 CLI(weread / lark-cli 之类)。
 *
 * 三层闸门(详见 docs/adr/0004-cli-skill-exec.md):
 *   1. 白名单 —— command 必须 ∈ skillRegistry.allowedCommands()(所有已装 skill
 *      的 frontmatter `commands` 并集)。白名单为空时本工具根本不挂载。
 *   2. 审批 —— 每个新 binary 首次执行经 ctx.requestCommandApproval 询问(y/a/n,
 *      与 write_file 同款语义;`a` 按 binary 粒度入 approvedCommands)。
 *      没有审批通道的路径(CLI 子命令 / queue worker)直接拒绝 —— 执行命令比
 *      写文件危险一级,不沿用 write_file 的"子命令旁路"先例。
 *   3. 兜底 —— spawn(shell:false) 杜绝注入;stdin=ignore(交互式命令立即失败而
 *      不是挂死);超时 SIGTERM→SIGKILL;输出 truncatePayload 截断。
 */

const SIGKILL_GRACE_MS = 5_000;

const params = z.object({
  command: z
    .string()
    .describe('Binary name to run (must be declared in an installed skill\'s `commands`).'),
  args: z.array(z.string()).default([]).describe('Arguments, passed as-is (no shell parsing).'),
  timeout_ms: z
    .number()
    .optional()
    .describe('Override the default command timeout (milliseconds).'),
});

export interface RunCommandResult {
  ok: boolean;
  exitCode?: number | null;
  /** stdout + stderr 合并(stderr 段带前缀标注),truncate 过。 */
  output?: string;
  error?: string;
  timedOut?: boolean;
}

export const runCommandTool: ToolDef<typeof params> = {
  name: 'run_command',
  description:
    'Run an external CLI command that an installed skill has declared (e.g. weread, lark-cli). ' +
    'Only declared binaries are allowed; each binary needs user approval once per session. ' +
    'Args are passed directly to the process — there is NO shell, so pipes/redirection/globbing do not work. ' +
    'The command runs non-interactively (stdin closed) with a timeout; stdout+stderr and the exit code are returned.',
  parameters: params,
  handler: async ({ command, args, timeout_ms }, ctx): Promise<RunCommandResult> => {
    // 闸门 1:白名单(运行时取并集 —— 注册表是会话内不变的,语义等同启动时快照)
    const allowed = ctx.skillRegistry.allowedCommands();
    if (!allowed.has(command)) {
      const list = [...allowed].sort().join(', ') || '(none)';
      return {
        ok: false,
        error: `Command "${command}" is not declared by any installed skill. Allowed: ${list}`,
      };
    }

    // 闸门 2:审批。无审批通道 = 非交互路径,拒绝执行。
    if (!ctx.approvedCommands.has(command)) {
      if (!ctx.requestCommandApproval) {
        return {
          ok: false,
          error:
            'Command execution requires interactive approval and is only available in the REPL.',
        };
      }
      const argvPreview = [command, ...args].join(' ');
      const answer = await ctx.requestCommandApproval(command, argvPreview);
      if (answer === 'no') return { ok: false, error: 'User declined to run the command.' };
      if (answer === 'always') ctx.approvedCommands.add(command);
    }

    const timeoutMs = timeout_ms ?? ctx.config.commandTimeoutMs;
    const maxBytes = ctx.config.maxToolPayloadBytes;

    return new Promise<RunCommandResult>((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          shell: false,
          cwd: ctx.config.workspaceRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, error: `Failed to spawn ${command}: ${(err as Error).message}` });
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let collected = 0;
      let timedOut = false;
      let settled = false;

      // 收集上限放宽到 2×maxBytes:截断由 truncatePayload 统一做(带说明后缀),
      // 这里只防失控进程把内存打爆。
      const collect = (buf: Buffer[]) => (chunk: Buffer) => {
        if (collected < maxBytes * 2) {
          buf.push(chunk);
          collected += chunk.length;
        }
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS).unref();
      }, timeoutMs);

      const finish = (result: RunCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve(result);
      };

      child.on('error', (err) => {
        // 最常见:ENOENT(CLI 没装)。给模型一个能转述给用户的信息。
        finish({ ok: false, error: `Failed to run ${command}: ${err.message}` });
      });

      child.on('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8');
        const errText = Buffer.concat(stderr).toString('utf8');
        const combined =
          out + (errText ? `${out ? '\n' : ''}--- stderr ---\n${errText}` : '');
        finish({
          ok: !timedOut && code === 0,
          exitCode: code,
          output: truncatePayload(combined, maxBytes),
          ...(timedOut ? { timedOut: true, error: `Timed out after ${timeoutMs}ms` } : {}),
          ...(!timedOut && code !== 0 ? { error: `Exited with code ${code}` } : {}),
        });
      });
    });
  },
};
