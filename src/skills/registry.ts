import type { Skill, HttpAllowRule } from './types.js';

/**
 * Skill 注册表。建模自 ConverterRegistry:按 name 去重,后注册覆盖先注册。
 *
 * buildSkillRegistry 按 skillDirs 顺序注册,所以 **后面的目录覆盖前面的同名 skill**
 * (默认 project-local 在 user-global 之后 → 项目本地胜出)。
 */
export class SkillRegistry {
  private readonly byName = new Map<string, Skill>();

  register(skill: Skill): void {
    this.byName.set(skill.name, skill);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  list(): Skill[] {
    return Array.from(this.byName.values());
  }

  names(): string[] {
    return Array.from(this.byName.keys());
  }

  /**
   * skill 目录(name — description),baked 进 `skill` 工具的 description,
   * 让模型知道有哪些 skill 可调。无 skill → 空串。
   */
  catalog(): string {
    const skills = this.list();
    if (skills.length === 0) return '';
    return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  }

  /**
   * 所有已注册 skill 声明的可执行二进制并集 —— run_command 工具的白名单。
   * 空集 = 没有任何 skill 声明过 commands → run_command 不挂载。
   */
  allowedCommands(): Set<string> {
    const out = new Set<string>();
    for (const s of this.list()) for (const c of s.commands) out.add(c);
    return out;
  }

  /**
   * 所有已注册 skill 声明的 HTTP host 白名单 → 鉴权规则映射 —— http_request 工具
   * 据此放行 + 注入鉴权。空 map = 没有 skill 声明过 http_allow → 工具不挂载。
   * 同 host 被多个 skill 声明时,后注册者覆盖(与 register 的 name 覆盖语义一致)。
   */
  allowedHosts(): Map<string, HttpAllowRule> {
    const out = new Map<string, HttpAllowRule>();
    for (const s of this.list()) for (const r of s.httpAllow) out.set(r.host, r);
    return out;
  }
}
