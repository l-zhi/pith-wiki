import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSafePath, SafetyError } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  path: z
    .string()
    .describe(
      'Target path, relative to the wiki output dir (<wikiRoot>/output). Writes are confined there — you cannot write to the current working directory or project.',
    ),
  content: z.string().describe('Full file content to write. Existing file is overwritten.'),
});

export const writeFileTool: ToolDef<typeof params> = {
  name: 'write_file',
  description:
    "Write a UTF-8 text file into the wiki output directory (<wikiRoot>/output). Paths are relative to and confined to that dir. No approval prompt — the output dir is pith-wiki's own scratch space, not the user's working directory.",
  parameters: params,
  handler: async ({ path: inputPath, content }, ctx) => {
    let safe: string;
    try {
      // 写入硬收敛到 <wikiRoot>/output：agent 的产物落在 pith-wiki 自己的输出区，
      // 不污染用户运行 pith-wiki 的当前目录/项目。既然写不出这个受控目录，就不再
      // 逐次审批（审批本是防乱写用户文件；收敛后已无此风险，免审批更顺手）。
      const writeRoot = path.join(ctx.config.wikiRoot, 'output');
      safe = resolveSafePath(inputPath, 'write', {
        workspaceRoot: ctx.config.workspaceRoot,
        wikiRoot: ctx.config.wikiRoot,
        writeRoot,
        maxPayloadBytes: ctx.config.maxToolPayloadBytes,
        readOnly: ctx.config.readOnly,
      });
    } catch (err) {
      if (err instanceof SafetyError) return { ok: false, error: err.message };
      throw err;
    }

    fs.mkdirSync(path.dirname(safe), { recursive: true });
    const tmp = `${safe}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, safe);
    // 返回实际落点（绝对路径），让模型/用户清楚写到了 output 区的哪里。
    return { ok: true, path: safe, bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
};
