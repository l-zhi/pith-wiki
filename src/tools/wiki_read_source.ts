import fs from 'node:fs';
import { z } from 'zod';
import { resolveSafePath, truncatePayload } from './safety.js';
import type { ToolDef } from './index.js';

const params = z.object({
  id: z.string().describe('Wiki entry id (kebab-case ASCII or CJK characters).'),
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
    "Read the full original source behind a wiki entry. For PDF/DOCX/HTML entries this returns the converter's markdown sidecar (cache_path) — that's the LLM-readable form; for plain .md/.txt entries it returns the file at source.value. Use this when wiki_query / wiki_get's hydrated content is too compressed and you need the full text. Only works when source.type === 'file'; for url/inline returns an error.",
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

    // PDF / DOCX / HTML / TXT (non-passthrough converters) 都不能直接 utf8 解码；
    // 优先读 converter sidecar（.cache 下的 .md），拿到的是 LLM 可读的 markdown。
    // markdown / text passthrough：cachePath 缺省，回落到 source.value 行为不变。
    const cachePath = entry.source.cachePath;
    const readPath = cachePath ?? entry.source.value;
    const usingCache = !!cachePath;
    let safe: string;
    try {
      safe = resolveSafePath(readPath, 'read', {
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
          `${usingCache ? 'Cache sidecar' : 'Source path'} outside read sandbox: ${readPath}\n` +
          `Add it to LLM_WIKI_READ_PATHS or run with --read-path to allow. (${(err as Error).message})`,
      };
    }

    if (!fs.existsSync(safe)) {
      // Sidecar 可能被用户手动删掉了 —— 回退到原始 source.value 再试一次（仅当
      // 原始路径是 markdown 或文本时才有意义，但还是尝试一下，让用户拿到点东西
      // 总比硬失败强；如果是 PDF/DOCX 二进制会读出乱码，调用方自行判断 convertedBy）。
      if (usingCache) {
        return {
          ok: false,
          error:
            `Cache sidecar missing: ${readPath} (original source: ${entry.source.value}).\n` +
            'The entry may need re-ingesting to regenerate the sidecar.',
        };
      }
      return {
        ok: false,
        error: `Source file no longer exists: ${readPath}. The wiki entry may be stale; consider re-ingesting.`,
      };
    }

    const stat = fs.statSync(safe);
    if (stat.isDirectory()) {
      return { ok: false, error: `Source path resolves to a directory: ${readPath}` };
    }

    const raw = fs.readFileSync(safe, 'utf8');
    const content = truncatePayload(raw, ctx.config.maxToolPayloadBytes);
    return {
      ok: true,
      id: entry.id,
      title: entry.title,
      source_path: entry.source.value,
      cache_path: cachePath,
      read_from: usingCache ? 'cache' : 'source',
      converted_by: entry.source.convertedBy,
      bytes: stat.size,
      content,
    };
  },
};
