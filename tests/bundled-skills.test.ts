/**
 * 内置（捆绑）skill 单测：listBundledSkills / resolveBundledSkill（注入临时
 * baseDir 隔离），加一组针对仓库真实 bundled-skills/ 的集成断言（weread 在内）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listBundledSkills,
  resolveBundledSkill,
  BUNDLED_SKILLS_DIR,
} from '../src/skills/bundled.js';
import { installSkillFromSource } from '../src/skills/install.js';
import type { Config } from '../src/config.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-bundled-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mk(base: string, name: string, md: string) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
}

describe('listBundledSkills（注入 baseDir）', () => {
  it('列出捆绑目录里的 skill（name + description）', () => {
    mk(tmp, 'a', '---\nname: a\ndescription: skill A\n---\nbody');
    mk(tmp, 'b', '---\nname: b\ndescription: skill B\n---\nbody');
    const list = listBundledSkills(tmp).sort((x, y) => x.name.localeCompare(y.name));
    expect(list.map((s) => s.name)).toEqual(['a', 'b']);
    expect(list[0].description).toBe('skill A');
  });

  it('缺 SKILL.md 的目录、坏 frontmatter 都跳过', () => {
    fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
    mk(tmp, 'good', '---\nname: good\ndescription: d\n---\nbody');
    const list = listBundledSkills(tmp);
    expect(list.map((s) => s.name)).toEqual(['good']);
  });

  it('目录不存在 → 空数组', () => {
    expect(listBundledSkills(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('resolveBundledSkill（注入 baseDir）', () => {
  it('按 name 命中返回目录', () => {
    mk(tmp, 'weread', '---\nname: weread\ndescription: d\n---\nbody');
    expect(resolveBundledSkill('weread', tmp)).toBe(path.join(tmp, 'weread'));
  });

  it('不存在 → null', () => {
    expect(resolveBundledSkill('ghost', tmp)).toBeNull();
  });

  it('越界名（../）不命中', () => {
    expect(resolveBundledSkill('../etc', tmp)).toBeNull();
  });
});

describe('仓库真实 bundled-skills（集成）', () => {
  it('weread 内置 skill 存在且声明 http_allow', () => {
    const dir = resolveBundledSkill('weread');
    expect(dir).toBeTruthy();
    expect(BUNDLED_SKILLS_DIR.endsWith('bundled-skills')).toBe(true);
    expect(listBundledSkills().some((s) => s.name === 'weread')).toBe(true);
  });

  it('skill add 内置名 weread → 从捆绑目录安装（零下载）', () => {
    const skillsRoot = path.join(tmp, 'skills');
    const config = { skillDirs: [skillsRoot] } as unknown as Config;
    const r = installSkillFromSource('weread', config);
    expect(r.source).toBe('bundled');
    expect(r.skill.name).toBe('weread');
    expect(r.skill.httpAllow.map((h) => h.host)).toContain('i.weread.qq.com');
    expect(fs.existsSync(path.join(skillsRoot, 'weread', 'SKILL.md'))).toBe(true);
  });
});
