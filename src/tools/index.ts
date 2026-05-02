import { z } from 'zod';
import type OpenAI from 'openai';
import type { Config } from '../config.js';
import { LibraryService } from '../wiki/library.js';
import { ContextAssembler } from '../wiki/assembler.js';
import { HydrationService } from '../wiki/hydration.js';
import { readFileTool } from './read_file.js';
import { writeFileTool } from './write_file.js';
import { listDirTool } from './list_dir.js';
import { wikiIngestTool } from './wiki_ingest.js';
import { wikiGetTool } from './wiki_get.js';
import { wikiQueryTool } from './wiki_query.js';
import { wikiListTool } from './wiki_list.js';
import { wikiReadSourceTool } from './wiki_read_source.js';
import { wikiQueueAddTool } from './wiki_queue_add.js';
import { wikiQueueStatusTool } from './wiki_queue_status.js';

export type ApprovalAnswer = 'yes' | 'no' | 'always';

export interface ToolContext {
  config: Config;
  library: LibraryService;
  assembler: ContextAssembler;
  hydrator: HydrationService;
  approvedWritePaths: Set<string>;
  requestApproval: (path: string, preview: string) => Promise<ApprovalAnswer>;
}

export interface ToolDef<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: P;
  handler: (args: z.infer<P>, ctx: ToolContext) => Promise<unknown>;
}

export function buildContext(
  config: Config,
  client: OpenAI,
  requestApproval: ToolContext['requestApproval'],
  /**
   * 可选传入一个已经构造好的 LibraryService。
   *
   * 默认（不传）会自己 new 一个，用于 CLI 子命令这种"一次调用 → 退出"的场景。
   * REPL 会传入它自己持有的实例，这样 agent 工具的 library 和队列 worker /
   * watcher 的 library 共用同一份 in-memory cache，避免：
   *   - 两个 cache 互不感知（worker put → agent 的 wiki_list 拿不到新条目）
   *   - 两份 index.json 写入互相覆盖
   */
  library?: LibraryService,
): ToolContext {
  const lib = library ?? new LibraryService(config.wikiRoot);
  const assembler = new ContextAssembler(lib);
  const hydrator = new HydrationService(client, config.model, lib);
  return {
    config,
    library: lib,
    assembler,
    hydrator,
    approvedWritePaths: new Set(),
    requestApproval,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export const ALL_TOOLS: AnyToolDef[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  wikiIngestTool,
  wikiGetTool,
  wikiQueryTool,
  wikiListTool,
  wikiReadSourceTool,
  wikiQueueAddTool,
  wikiQueueStatusTool,
];

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal hand-rolled converter for the small set of zod constructs we use.
  // Avoids the zod-to-json-schema dep for v0.
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options };
  }
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema.removeDefault());
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      const isOptional =
        value instanceof z.ZodOptional || value instanceof z.ZodDefault;
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }
  return {};
}

/**
 * 把工具列表转成 OpenAI Chat Completions API 期待的 tool 描述结构。
 *
 * 不传参数 → 使用内置 ALL_TOOLS。Agent 在合并 `extraTools` 时显式传入
 * 合并后的列表，让宿主追加的工具一起被喂给 LLM。
 */
export function toolsForOpenAI(tools: AnyToolDef[] = ALL_TOOLS) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    },
  }));
}

export const TOOL_REGISTRY: Map<string, AnyToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
