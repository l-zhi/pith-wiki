import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSafePath, SafetyError } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  path: z.string().describe('Target path (relative to workspace, or absolute inside it).'),
  content: z.string().describe('Full file content to write. Existing file is overwritten.'),
});

export const writeFileTool: ToolDef<typeof params> = {
  name: 'write_file',
  description:
    'Write a UTF-8 text file. Sandboxed to the workspace root; the user must approve the write.',
  parameters: params,
  handler: async ({ path: inputPath, content }, ctx) => {
    let safe: string;
    try {
      safe = resolveSafePath(inputPath, 'write', {
        workspaceRoot: ctx.config.workspaceRoot,
        wikiRoot: ctx.config.wikiRoot,
        maxPayloadBytes: ctx.config.maxToolPayloadBytes,
        readOnly: ctx.config.readOnly,
      });
    } catch (err) {
      if (err instanceof SafetyError) return { ok: false, error: err.message };
      throw err;
    }

    if (!ctx.approvedWritePaths.has(safe)) {
      const previewSlice = content.slice(0, 400);
      const preview = previewSlice + (content.length > 400 ? '\n…' : '');
      const answer = await ctx.requestApproval(safe, preview);
      if (answer === 'no') {
        return { ok: false, error: 'User declined the write.' };
      }
      if (answer === 'always') {
        ctx.approvedWritePaths.add(safe);
      }
    }

    fs.mkdirSync(path.dirname(safe), { recursive: true });
    const tmp = `${safe}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, safe);
    return { ok: true, path: inputPath, bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
};
