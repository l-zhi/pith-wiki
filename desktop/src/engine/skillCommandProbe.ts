import type { ToolContext } from '@core/tools/index.js';
import { runCommandTool, type RunCommandResult } from '@core/tools/run_command.js';
import type { SkillTestResultDTO } from '../shared/protocol.js';
import { cliEnvironment } from './cliEnvironment.js';

/** Refresh before probing; the same Engine PATH is used by existing chats afterward. */
export async function runSkillCommandProbe(
  command: string,
  args: string[],
  ctx: ToolContext,
  environment: { refresh(): Promise<void> } = cliEnvironment,
): Promise<SkillTestResultDTO> {
  await environment.refresh();
  const result = await runCommandTool.handler({ command, args }, ctx) as RunCommandResult;
  const output = (result.output ?? '').trim();
  return {
    ok: result.ok,
    // Keep runtime/auth diagnostics: a generic exit code used to hide all stderr.
    detail: [result.error, output].filter(Boolean).join('\n').slice(0, 1600)
      || `exit ${result.exitCode ?? '?'}`,
  };
}
