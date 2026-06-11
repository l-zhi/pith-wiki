/**
 * skill 安装/卸载核心（src/skills/install.ts）单测。
 * CLI 子命令与 REPL /skill add|remove 共用这层 —— 在此焊死行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installSkillFromSource,
  removeSkillByName,
  SkillExistsError,
} from '../src/skills/install.js';
import type { Config } from '../src/config.js';

let tmp: string;
let skillsRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-install-'));
  skillsRoot = path.join(tmp, 'skills');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 最小 Config，只填 install 用到的 skillDirs。 */
function cfg(): Config {
  return { skillDirs: [skillsRoot] } as unknown as Config;
}

/** 在 tmp 下造一个源 skill 目录，返回路径。 */
function srcSkill(name: string, extraFrontmatter = ''): string {
  const dir = path.join(tmp, 'src', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: d\n${extraFrontmatter}---\nbody`,
    'utf8',
  );
  return dir;
}

describe('installSkillFromSource — 本地源', () => {
  it('安装合法 skill 到 skillDirs[0]', () => {
    const src = srcSkill('alpha');
    const r = installSkillFromSource(src, cfg());
    expect(r.skill.name).toBe('alpha');
    expect(r.dest).toBe(path.join(skillsRoot, 'alpha'));
    expect(fs.existsSync(path.join(r.dest, 'SKILL.md'))).toBe(true);
    expect(r.fromGit).toBe(false);
  });

  it('解析 commands 并返回缺失的 requires', () => {
    const src = srcSkill(
      'beta',
      'commands: [echo]\nrequires:\n  - bin: definitely-missing-xyz\n    install: brew install foo\n',
    );
    const r = installSkillFromSource(src, cfg());
    expect(r.skill.commands).toEqual(['echo']);
    expect(r.missingRequires.map((m) => m.bin)).toContain('definitely-missing-xyz');
  });

  it('已存在同名且未 force → SkillExistsError', () => {
    const src = srcSkill('gamma');
    installSkillFromSource(src, cfg());
    expect(() => installSkillFromSource(src, cfg())).toThrow(SkillExistsError);
  });

  it('force 覆盖已存在', () => {
    const src = srcSkill('delta');
    installSkillFromSource(src, cfg());
    expect(() => installSkillFromSource(src, cfg(), { force: true })).not.toThrow();
  });

  it('非 skill 目录（无 SKILL.md）抛错', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => installSkillFromSource(empty, cfg())).toThrow();
  });

  it('不存在的路径抛错', () => {
    expect(() => installSkillFromSource(path.join(tmp, 'nope'), cfg())).toThrow(/Not a directory/);
  });
});

describe('removeSkillByName', () => {
  it('删掉已安装 skill 目录', () => {
    installSkillFromSource(srcSkill('eps'), cfg());
    const r = removeSkillByName('eps', cfg());
    expect(r?.name).toBe('eps');
    expect(fs.existsSync(path.join(skillsRoot, 'eps'))).toBe(false);
  });

  it('不存在 → null', () => {
    expect(removeSkillByName('ghost', cfg())).toBeNull();
  });

  it('name 含路径片段不会越界删除', () => {
    // ../ 会被 path.join 归一化到 skillsRoot 之外 → 拒绝
    const outside = path.join(tmp, 'victim');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), 'x', 'utf8');
    expect(removeSkillByName('../victim', cfg())).toBeNull();
    expect(fs.existsSync(outside)).toBe(true);
  });
});
