import fs from 'node:fs';
import { z } from 'zod';
import { resolveSafePath, truncatePayload } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  id: z.string().describe('Wiki entry id (kebab-case slug).'),
  collection: z.string().optional(),
});

/**
 * wiki_read_source：从 entry.source.value 拉原始文件给模型看。
 *
 * 为什么独立成工具而不是让模型组合 wiki_get + read_file：
 *   1. 把 "查 entry → 取 source 路径 → 读文件" 这套组合操作压成一个动作，
 *      减少多轮交互的 token 与延迟（DeepSeek 一次调用大概 500-1500ms）。
 *   2. 路径处理在工具内做沙箱校验，模型不需要知道 additionalReadPaths
 *      / realpath 这些细节。
 *   3. source.type ≠ 'file' 时清晰报错（'url' / 'inline' / 'unknown' 没有原文可读），
 *      而不是让模型去 read_file 一个 URL 字符串再失败。
 */
export const wikiReadSourceTool: ToolDef<typeof params> = {
  name: 'wiki_read_source',
  description:
    "Read the original source file referenced by a wiki entry's `source.value`. Use this when wiki_query / wiki_get's hydrated content is too compressed and you need the full original text. Only works when source.type === 'file'; for url/inline sources returns an error.",
  parameters: params,
  handler: async ({ id, collection }, ctx) => {
    const entry = ctx.library.get(id, collection);
    if (!entry) return { ok: false, error: `Entry not found: ${id}` };

    if (entry.source.type !== 'file' || !entry.source.value) {
      return {
        ok: false,
        error:
          `Entry ${id} has source.type=${entry.source.type}` +
          (entry.source.value ? ` value=${entry.source.value}` : '') +
          ' — no readable source file. Use wiki_get to see the hydrated content, or query its url manually if applicable.',
      };
    }

    const sourcePath = entry.source.value;
    let safe: string;
    try {
      safe = resolveSafePath(sourcePath, 'read', {
        workspaceRoot: ctx.config.workspaceRoot,
        wikiRoot: ctx.config.wikiRoot,
        maxPayloadBytes: ctx.config.maxToolPayloadBytes,
        readOnly: ctx.config.readOnly,
        additionalReadPaths: ctx.config.additionalReadPaths,
      });
    } catch (err) {
      return {
        ok: false,
        error:
          `Source path outside read sandbox: ${sourcePath}\n` +
          `Add it to LLM_WIKI_READ_PATHS or run with --read-path to allow. (${(err as Error).message})`,
      };
    }

    if (!fs.existsSync(safe)) {
      return {
        ok: false,
        error: `Source file no longer exists: ${sourcePath}. The wiki entry may be stale; consider re-ingesting.`,
      };
    }

    const stat = fs.statSync(safe);
    if (stat.isDirectory()) {
      return { ok: false, error: `Source path resolves to a directory: ${sourcePath}` };
    }

    const raw = fs.readFileSync(safe, 'utf8');
    const content = truncatePayload(raw, ctx.config.maxToolPayloadBytes);
    return {
      ok: true,
      id: entry.id,
      title: entry.title,
      source_path: sourcePath,
      bytes: stat.size,
      content,
    };
  },
};
