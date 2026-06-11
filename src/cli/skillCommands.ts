import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureSkillsDir, type Config } from '../config.js';
import { buildSkillRegistry, loadSkill, type Skill } from '../skills/index.js';

interface BuildArgs {
  configFor: (overrides?: Partial<Config>) => Config;
}

/**
 * 识别 `skill add` 的来源是不是 git。支持三种写法:
 *   - 完整 URL:https://… / git@… / 以 .git 结尾
 *   - GitHub 短名:owner/repo(无路径分隔以外的斜杠、不是本地存在的路径)
 * 返回可直接喂给 `git clone` 的 URL,非 git 源返回 null。
 */
export function resolveGitSource(src: string): string | null {
  if (/^(https?|git|ssh):\/\//.test(src) || /^git@/.test(src) || src.endsWith('.git')) {
    return src;
  }
  // owner/repo 短名:两段均以字母数字开头(GitHub 命名规则),恰好一个斜杠,
  // 且本地不存在同名路径(本地优先)。以字母数字开头的要求把 `./x` `../x`
  // 这类相对路径排除在外 —— 它们是本地路径,不是短名。
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(src) && !fs.existsSync(path.resolve(src))) {
    return `https://github.com/${src}.git`;
  }
  return null;
}

/** git clone --depth 1 到一个临时目录,返回该目录。失败抛错。 */
function cloneToTemp(url: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-skill-'));
  const res = spawnSync('git', ['clone', '--depth', '1', url, tmp], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const stderr = (res.stderr || '').trim();
    throw new Error(`git clone failed${stderr ? `: ${stderr}` : ''}`);
  }
  return tmp;
}

/**
 * 检测 skill 声明的 requires,缺失的二进制打印安装指引(不代装)。
 * 用 `command -v`(POSIX)/where(best-effort)探测 —— 这里直接 spawn 目标 bin 的
 * `--version` 太脆(各 CLI 行为不一),改用 shell 内建 `command -v`。
 */
function checkRequirements(skill: Skill): void {
  if (skill.requires.length === 0) return;
  const missing = skill.requires.filter((r) => {
    const res = spawnSync('command', ['-v', r.bin], { shell: true, stdio: 'ignore' });
    return res.status !== 0;
  });
  if (missing.length === 0) return;
  console.warn(chalk.yellow(`\n⚠ This skill needs ${missing.length} CLI(s) not found on PATH:`));
  for (const m of missing) {
    console.warn(chalk.yellow(`  - ${m.bin}`) + (m.install ? chalk.dim(`   install: ${m.install}`) : ''));
  }
}

/** 安装含 commands 的 skill 时,醒目提示用户它将获得的执行授权。 */
function announceCommands(skill: Skill): void {
  if (skill.commands.length === 0) return;
  console.log(
    chalk.yellow(
      `\n⚠ Skill "${skill.name}" declares executable command(s): ${skill.commands.join(', ')}`,
    ),
  );
  console.log(
    chalk.dim('  The agent will be able to run these after you approve them in the REPL.'),
  );
}

/**
 * 注册 `skill` 子命令族：list / add / remove。
 *
 * skill 是文件系统上的目录（`<skillDir>/<name>/SKILL.md`），无数据库——这些命令
 * 只是对 skillDirs 的便利封装；手动拖目录进去等价于 `skill add`。
 *
 * add 落地到 skillDirs 的第一条（默认 = user-global `<pithWikiHome>/skills`）。
 */
export function buildSkillCommands(program: Command, args: BuildArgs): void {
  const skill = program
    .command('skill')
    .description('Manage installed skills (prompt instruction packages + code tool plugins).');

  skill
    .command('list')
    .description('List discovered skills across skillDirs.')
    .action(async () => {
      const config = args.configFor();
      const warnings: string[] = [];
      const reg = await buildSkillRegistry({
        skillDirs: config.skillDirs,
        onWarn: (m) => warnings.push(m),
      });
      const all = reg.list();
      if (all.length === 0) {
        console.log('No skills found. Searched:');
        for (const d of config.skillDirs) console.log(`  ${d}`);
        console.log('\nDrop a <name>/SKILL.md into one of those dirs, or use `pith-wiki skill add <path>`.');
        return;
      }
      console.log(`Skills (${all.length}):`);
      for (const s of all) {
        console.log(`  ${chalk.cyan(s.name)}  ${s.description}`);
        console.log(chalk.dim(`      ${s.dir}`));
      }
      for (const w of warnings) console.warn(chalk.yellow(`⚠ ${w}`));
    });

  skill
    .command('add <source>')
    .description(
      'Install a skill from a local directory, a git URL, or a GitHub owner/repo short name. ' +
        'The source must contain a SKILL.md.',
    )
    .option('--force', 'Overwrite an existing skill of the same name.')
    .action(async (source: string, opts: { force?: boolean }) => {
      const config = args.configFor();

      // git 源 → clone 到临时目录;本地源 → 直接用。两条路径之后共用校验+复制。
      const gitUrl = resolveGitSource(source);
      let srcDir: string;
      let cleanup: (() => void) | null = null;
      if (gitUrl) {
        try {
          console.log(chalk.dim(`Cloning ${gitUrl} …`));
          srcDir = cloneToTemp(gitUrl);
          cleanup = () => fs.rmSync(srcDir, { recursive: true, force: true });
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exitCode = 1;
          return;
        }
      } else {
        srcDir = path.resolve(source);
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
          console.error(chalk.red(`Not a directory: ${srcDir}`));
          process.exitCode = 1;
          return;
        }
      }

      try {
        // 校验源目录是个合法 skill（frontmatter + 非空正文）。
        let skill: Skill;
        try {
          skill = loadSkill(srcDir);
        } catch (err) {
          console.error(chalk.red(`Invalid skill at ${source}: ${(err as Error).message}`));
          process.exitCode = 1;
          return;
        }

        ensureSkillsDir(config);
        const destRoot = config.skillDirs[0];
        if (!destRoot) {
          console.error(chalk.red('No skillDirs configured to install into.'));
          process.exitCode = 1;
          return;
        }
        const dest = path.join(destRoot, skill.name);
        if (fs.existsSync(dest)) {
          if (!opts.force) {
            console.error(
              chalk.red(`Skill "${skill.name}" already exists at ${dest}. Use --force to overwrite.`),
            );
            process.exitCode = 1;
            return;
          }
          fs.rmSync(dest, { recursive: true, force: true });
        }
        // 不复制 .git（git 源会带一个）—— skill 是纯内容，版本控制元数据无意义。
        fs.cpSync(srcDir, dest, {
          recursive: true,
          filter: (s) => path.basename(s) !== '.git',
        });
        console.log(chalk.green(`Installed skill "${skill.name}" → ${dest}`));
        announceCommands(skill);
        checkRequirements(skill);
      } finally {
        cleanup?.();
      }
    });

  skill
    .command('remove <name>')
    .description('Remove an installed skill by name (deletes its directory).')
    .option('--force', 'Skip the confirmation note and just delete.')
    .action(async (name: string) => {
      const config = args.configFor();
      const reg = await buildSkillRegistry({ skillDirs: config.skillDirs });
      const s = reg.get(name);
      if (!s) {
        console.error(chalk.red(`Skill not found: ${name}`));
        process.exitCode = 1;
        return;
      }
      fs.rmSync(s.dir, { recursive: true, force: true });
      console.log(chalk.green(`Removed skill "${name}" (${s.dir})`));
    });
}
