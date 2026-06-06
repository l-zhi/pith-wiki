import { z } from 'zod';
import type { AnyToolDef, ToolDef } from './index.js';
import type { SkillRegistry } from '../skills/registry.js';

const params = z.object({
  name: z.string().describe('The exact name of the skill to load (see the list in this tool description).'),
});

/**
 * `skill` 工具:把一个 skill 的正文调进上下文(Claude Code 的 Skill 工具同款)。
 *
 * 渐进式披露:可用 skill 的 name + description 被 baked 进本工具的 description(模型一眼可见),
 * 但完整指令正文只在模型真的调用 skill(name) 时才作为 tool result 返回、进入上下文。
 *
 * 工厂函数:description 依赖运行时的 registry 目录,所以在 Agent 构造时按 registry 现造一个。
 */
export function makeSkillTool(registry: SkillRegistry): AnyToolDef {
  const catalog = registry.catalog();
  const description =
    'Load a named skill — a reusable instruction package. Call this when the user request matches one of ' +
    'the skills below; the skill\'s full instructions are returned as the result, then follow them. ' +
    'Available skills:\n' +
    (catalog || '(none installed)');

  const tool: ToolDef<typeof params> = {
    name: 'skill',
    description,
    parameters: params,
    handler: async ({ name }, ctx) => {
      const skill = ctx.skillRegistry.get(name);
      if (!skill) {
        return {
          ok: false,
          error: `Unknown skill: ${name}. Available: ${ctx.skillRegistry.names().join(', ') || '(none)'}`,
        };
      }
      return { ok: true, name: skill.name, instructions: skill.body };
    },
  };
  return tool;
}
