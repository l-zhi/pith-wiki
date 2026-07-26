import { z } from 'zod';
import type { ChatClient } from '../llm/transport.js';
import type { Config } from '../config.js';
import { LibraryService } from '../wiki/library.js';
import { ContextAssembler, type QueryScope } from '../wiki/assembler.js';
import { HydrationService } from '../wiki/hydration.js';
import {
  buildConverterPipeline,
  type Converter,
  type ConverterRegistry,
  type ConverterCache,
} from '../wiki/converters/index.js';
import { SkillRegistry } from '../skills/registry.js';
import type { ScheduleService } from '../schedule/service.js';
import { readFileTool } from './read_file.js';
import { writeFileTool } from './write_file.js';
import { listDirTool } from './list_dir.js';
import { wikiIngestTool } from './wiki_ingest.js';
import { wikiGetTool } from './wiki_get.js';
import { wikiQueryTool } from './wiki_query.js';
import { wikiGrepTool } from './wiki_grep.js';
import { wikiListTool } from './wiki_list.js';
import { wikiReadSourceTool } from './wiki_read_source.js';
import { wikiQueueAddTool } from './wiki_queue_add.js';
import { wikiQueueStatusTool } from './wiki_queue_status.js';

export type ApprovalAnswer = 'yes' | 'no' | 'always';

/**
 * 本会话的触发来源。`scheduled` = 定时任务无人值守跑的；`interactive` = 用户在
 * REPL/桌面端主动对话。wiki_ingest 据此给产出条目盖来源 tag（scheduled/manual）。
 */
export type RunOrigin = 'scheduled' | 'interactive';

export interface ToolContext {
  config: Config;
  library: LibraryService;
  assembler: ContextAssembler;
  hydrator: HydrationService;
  /** 会话触发来源；缺省构造（buildContext 不传）视为 interactive。 */
  origin: RunOrigin;
  approvedWritePaths: Set<string>;
  requestApproval: (path: string, preview: string) => Promise<ApprovalAnswer>;
  /**
   * 会话内已放行的命令二进制（run_command 审批答 `a` 后加入）。
   * 与 approvedWritePaths 同生命周期：ctx 存活期间累积。
   */
  approvedCommands: Set<string>;
  /**
   * 命令执行审批通道。仅 REPL 注入（有 UI 才能审批）；缺省 undefined →
   * run_command 直接拒绝 —— 执行命令比写文件危险一级，非交互路径不沿用
   * write_file 的"子命令旁路"先例。
   */
  requestCommandApproval?: (command: string, argvPreview: string) => Promise<ApprovalAnswer>;
  /** 转换器注册表。批量 ingest / 队列 worker / wiki_ingest 工具都从这里取。 */
  converterRegistry: ConverterRegistry;
  /** 转换结果缓存（按 cacheConverted 决定是 FS 还是 Null 实现）。 */
  converterCache: ConverterCache;
  /**
   * skill 注册表。`skill` 工具据此把 prompt skill 的正文调进上下文。
   * 缺省（未经 BuildContextExtras 注入）时是一个空 registry —— CLI 子命令这种
   * 不需要 skill 的一次性路径零开销。
   */
  skillRegistry: SkillRegistry;
  /**
   * 定时任务服务。仅桌面 engine 注入（它是触发宿主）；缺省 undefined →
   * schedule_* 工具返回「仅桌面可用」。见 src/schedule/service.ts。
   */
  scheduleService?: ScheduleService;
  /**
   * 本轮检索范围（REPL `@`-mention 解析得到）。仅在该轮的 tool 调用里出现：
   * Agent 把它 spread 进一份 per-turn ctx 副本。wiki_query 据此收窄召回。
   * 缺省 undefined → 整库召回（CLI / 旧路径零影响）。
   */
  scope?: QueryScope;
}

export interface ToolDef<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: P;
  handler: (args: z.infer<P>, ctx: ToolContext) => Promise<unknown>;
}

export interface BuildContextExtras {
  /** 宿主注入的额外转换器（priority 默认 100，自然覆盖内置）。 */
  converters?: Converter[];
  /**
   * 已经建好的 registry + cache。如果提供就直接用（用于 REPL/CLI 多处复用同
   * 一份），否则 buildContext 内部会按 config.cacheConverted + extras.converters
   * 现建一份。
   */
  converterRegistry?: ConverterRegistry;
  converterCache?: ConverterCache;
  /**
   * 已建好的 skill 注册表。REPL 在 mount 时 await buildSkillRegistry 后传入；
   * 不传则 buildContext 用一个空 registry 兜底。
   */
  skillRegistry?: SkillRegistry;
  /** 命令执行审批通道（仅 REPL 提供）。见 ToolContext.requestCommandApproval。 */
  requestCommandApproval?: ToolContext['requestCommandApproval'];
  /** 定时任务服务（仅桌面 engine 提供）。见 ToolContext.scheduleService。 */
  scheduleService?: ScheduleService;
  /** 会话触发来源；缺省 'interactive'。见 ToolContext.origin。 */
  origin?: RunOrigin;
}

export function buildContext(
  config: Config,
  client: ChatClient,
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
  extras: BuildContextExtras = {},
): ToolContext {
  const lib = library ?? new LibraryService(config.wikiRoot, { ignoredDirs: [config.outputDir] });
  const assembler = new ContextAssembler(lib);
  const hydrator = new HydrationService(client, config.model, lib, config.supportsJsonMode);
  let registry: ConverterRegistry;
  let cache: ConverterCache;
  if (extras.converterRegistry && extras.converterCache) {
    registry = extras.converterRegistry;
    cache = extras.converterCache;
  } else {
    const built = buildConverterPipeline({
      wikiRoot: config.wikiRoot,
      cacheConverted: config.cacheConverted,
      extras: extras.converters,
    });
    registry = extras.converterRegistry ?? built.registry;
    cache = extras.converterCache ?? built.cache;
  }
  return {
    config,
    library: lib,
    assembler,
    hydrator,
    origin: extras.origin ?? 'interactive',
    approvedWritePaths: new Set(),
    requestApproval,
    approvedCommands: new Set(),
    requestCommandApproval: extras.requestCommandApproval,
    converterRegistry: registry,
    converterCache: cache,
    skillRegistry: extras.skillRegistry ?? new SkillRegistry(),
    scheduleService: extras.scheduleService,
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
  wikiGrepTool,
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
      const isOptional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
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

export const TOOL_REGISTRY: Map<string, AnyToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));
