import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSafePath } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  path: z
    .string()
    .default('.')
    .describe('Directory path relative to the workspace root.'),
});

export const listDirTool: ToolDef<typeof params> = {
  name: 'list_dir',
  description:
    'List files and subdirectories at the given path inside the workspace. Hidden entries (.git, node_modules) are skipped.',
  parameters: params,
  handler: async ({ path: inputPath }, ctx) => {
    const safe = resolveSafePath(inputPath ?? '.', 'read', {
      workspaceRoot: ctx.config.workspaceRoot,
      wikiRoot: ctx.config.wikiRoot,
      maxPayloadBytes: ctx.config.maxToolPayloadBytes,
      readOnly: ctx.config.readOnly,
      additionalReadPaths: ctx.config.additionalReadPaths,
    });
    if (!fs.existsSync(safe)) {
      return { ok: false, error: `Directory does not exist: ${inputPath}` };
    }
    const stat = fs.statSync(safe);
    if (!stat.isDirectory()) {
      return { ok: false, error: `${inputPath} is not a directory.` };
    }
    const skip = new Set(['node_modules', '.git', 'dist', '.DS_Store']);
    const entries = fs
      .readdirSync(safe, { withFileTypes: true })
      .filter((d) => !skip.has(d.name))
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
      }));
    return {
      ok: true,
      path: path.relative(ctx.config.workspaceRoot, safe) || '.',
      entries,
    };
  },
};
