import type { ScopeDTO } from '../shared/protocol.js';
import { toolsForOpenAI, type AnyToolDef, type ToolContext } from '@core/tools/index.js';
import type { PiCoreToolSpec } from './piCoreAgent.js';

/**
 * pith 世界 → pi-agent-core 世界的适配件（路线 A 的宿主装配）。
 *
 * 单独成文件的理由：bootstrap 已经很长，而这两个函数是**接线的核心语义**
 * （工具怎么过去、@-mention 怎么过去），需要被单测和 smoke 脚本直接复用真实实现，
 * 不能靠在别处抄一份等价代码。
 */

/**
 * pith 的 ToolDef（zod 参数 + 返回任意 JSON）→ pi-agent-core 能吃的 PiCoreToolSpec
 * （JSON Schema 参数 + 返回任意 JSON）。
 *
 * 关键点：**execute 里调的是 pith 原来的 handler，ctx 也是原来的那个** —— 于是沙箱
 * （safety.ts 的 realpath 校验）、run_command 的逐 binary 审批、skill 注册表、
 * schedule service 全都原样生效，不需要在 pi 那侧重建任何东西。
 *
 * 参数仍过 zod：pi 用 JSON Schema 做了一遍校验，但 pith 的 handler 拿到的必须是 zod
 * 解析后的值（default 填充、coerce 都在 zod 里）。校验失败按 pith 语义返回错误对象
 * （不 throw）—— 模型据此自我纠正，与内置 Agent 行为一致。
 */
export function toToolSpecs(tools: AnyToolDef[], ctx: ToolContext): PiCoreToolSpec[] {
  const declared = toolsForOpenAI(tools);
  return tools.map((def, i) => ({
    name: def.name,
    description: declared[i].function.description ?? '',
    parameters: (declared[i].function.parameters ?? {}) as Record<string, unknown>,
    execute: async (args: unknown) => {
      let parsed: unknown;
      try {
        parsed = def.parameters.parse(args ?? {});
      } catch (err) {
        return { ok: false, error: `Invalid arguments: ${(err as Error).message}` };
      }
      try {
        return await def.handler(parsed as never, ctx);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  }));
}

/**
 * `@`-mention 的范围钉死：用 scope 预算一段上下文，渲染成一条说明性前置消息。
 * 与 pith 内置 Agent 的 buildScopePreamble 同语义（那边是私有方法，这里为 pi-core 复刻）。
 * 返回空串 → 不注入。
 */
export function buildScopePreamble(ctx: ToolContext, question: string, scope: ScopeDTO): string {
  const collections = scope.collections ?? [];
  const folders = scope.folders ?? [];
  const entryIds = scope.entryIds ?? [];
  if (!collections.length && !folders.length && !entryIds.length) return '';
  const result = ctx.assembler.query(question, 4000, { collections, folders, entryIds });
  if (!result.context) return '';
  const hints: string[] = [];
  if (collections.length) hints.push(`collections: ${collections.join(', ')}`);
  if (folders.length) hints.push(`folders: ${folders.map((f) => `${f.collection}/${f.subpath}`).join(', ')}`);
  if (entryIds.length) hints.push(`pinned entries: ${entryIds.join(', ')}`);
  return (
    `[Scoped context for this question — ${hints.join(' · ')}. ` +
    `Answer primarily from the entries below; use wiki_query (already scoped) only if you need more.]\n\n` +
    result.context
  );
}
