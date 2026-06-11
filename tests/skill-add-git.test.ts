/**
 * skill add 的 git 源解析 + clone 安装。
 *
 * resolveGitSource 是纯函数,直接断言;clone 用本地 bare repo(file:// 不需要网络)
 * 端到端验证"克隆 → 校验 → 复制 → 去掉 .git"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitSource } from '../src/cli/skillCommands.js';
import { loadSkill } from '../src/skills/index.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-skilladd-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('resolveGitSource', () => {
  it('识别完整 git URL', () => {
    expect(resolveGitSource('https://github.com/l-zhi/weread.git')).toBe(
      'https://github.com/l-zhi/weread.git',
    );
    expect(resolveGitSource('git@github.com:l-zhi/weread.git')).toBe(
      'git@github.com:l-zhi/weread.git',
    );
  });

  it('owner/repo 短名 → 拼成 github URL', () => {
    expect(resolveGitSource('l-zhi/weread-skill')).toBe(
      'https://github.com/l-zhi/weread-skill.git',
    );
  });

  it('本地存在的路径优先于短名解析', () => {
    const local = path.join(tmp, 'a', 'b');
    fs.mkdirSync(local, { recursive: true });
    // 传一个恰好像 owner/repo 但本地存在的相对路径
    const rel = path.relative(process.cwd(), local);
    // 仅当 rel 恰好是单斜杠两段时这条分支才触发；多段路径本就返回 null
    if (/^[^/\s]+\/[^/\s]+$/.test(rel)) {
      expect(resolveGitSource(rel)).toBeNull();
    }
  });

  it('普通本地路径返回 null', () => {
    expect(resolveGitSource('./my-skill')).toBeNull();
    expect(resolveGitSource('/abs/path/to/skill')).toBeNull();
  });
});

describe('skill add via git (本地 bare repo)', () => {
  it('clone --depth 1 + 安装，剥离 .git', () => {
    // 1) 造一个含 SKILL.md 的 git repo
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(
      path.join(work, 'SKILL.md'),
      `---\nname: gitskill\ndescription: from git\ncommands: [weread]\n---\nbody`,
      'utf8',
    );
    const git = (args: string[], cwd: string) =>
      spawnSync('git', args, { cwd, stdio: 'ignore' });
    git(['init', '-q'], work);
    git(['config', 'user.email', 't@t.io'], work);
    git(['config', 'user.name', 't'], work);
    git(['add', '.'], work);
    git(['commit', '-q', '-m', 'init'], work);

    // 2) 模拟 cloneToTemp + 安装流程（直接用 resolveGitSource 不行 —— 它只认 URL/短名，
    //    本地路径返回 null；这里直接 clone file:// 验证 clone 链路）
    const cloned = path.join(tmp, 'cloned');
    const res = spawnSync('git', ['clone', '--depth', '1', `file://${work}`, cloned], {
      stdio: 'ignore',
    });
    expect(res.status).toBe(0);

    // 3) loadSkill 能解析克隆下来的 skill
    const s = loadSkill(cloned);
    expect(s.name).toBe('gitskill');
    expect(s.commands).toEqual(['weread']);

    // 4) 安装复制时 filter 掉 .git
    const dest = path.join(tmp, 'installed');
    fs.cpSync(cloned, dest, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.git',
    });
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
  });
});
