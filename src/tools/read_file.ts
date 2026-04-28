import fs from 'node:fs';
import { z } from 'zod';
import { resolveSafePath, truncatePayload } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  path: z.string().describe('Path relative to the workspace root, or an absolute path inside it.'),
});

export const readFileTool: ToolDef<typeof params> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace. Returns the file contents (truncated if very large).',
  parameters: params,
  handler: async ({ path: inputPath }, ctx) => {
    const safe = resolveSafePath(inputPath, 'read', {
      workspaceRoot: ctx.config.workspaceRoot,
      wikiRoot: ctx.config.wikiRoot,
      maxPayloadBytes: ctx.config.maxToolPayloadBytes,
      readOnly: ctx.config.readOnly,
      additionalReadPaths: ctx.config.additionalReadPaths,
    });
    if (!fs.existsSync(safe)) {
      return { ok: false, error: `File does not exist: ${inputPath}` };
    }
    const stat = fs.statSync(safe);
    if (stat.isDirectory()) {
      return { ok: false, error: `${inputPath} is a directory; use list_dir instead.` };
    }
    const raw = fs.readFileSync(safe, 'utf8');
    const content = truncatePayload(raw, ctx.config.maxToolPayloadBytes);
    return { ok: true, path: inputPath, bytes: stat.size, content };
  },
};
