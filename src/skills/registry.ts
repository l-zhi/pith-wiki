import type { Skill } from './types.js';

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
}
