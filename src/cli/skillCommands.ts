import fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { type Config } from '../config.js';
import { buildSkillRegistry } from '../skills/index.js';
import { listBundledSkills } from '../skills/bundled.js';
import {
  installSkillFromSource,
  SkillExistsError,
  resolveGitSource,
} from '../skills/install.js';

// resolveGitSource 现在定义在 skills/install.ts;这里 re-export 保持现有导入方。
export { resolveGitSource } from '../skills/install.js';

interface BuildArgs {
  configFor: (overrides?: Partial<Config>) => Config;
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
      const installed = new Set(reg.names());
      // 可装内置 skill（捆绑分发、尚未安装的）—— 提升可发现性。
      const available = listBundledSkills().filter((b) => !installed.has(b.name));

      if (all.length === 0) {
        console.log('No skills installed. Searched:');
        for (const d of config.skillDirs) console.log(`  ${d}`);
      } else {
        console.log(chalk.green(`Installed skills (${all.length}):`));
        for (const s of all) {
          console.log(`  ${s.name}  ${chalk.dim(s.description)}`);
          console.log(chalk.dim(`      ${s.dir}`));
        }
      }
      if (available.length > 0) {
        console.log(
          chalk.yellow('\nAvailable to install (bundled) — `pith-wiki skill add <name>`:'),
        );
        for (const b of available) {
          console.log(`  ${b.name}  ${chalk.dim(b.description)}`);
        }
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
      const gitUrl = resolveGitSource(source);
      if (gitUrl) console.log(chalk.dim(`Cloning ${gitUrl} …`));

      try {
        const result = installSkillFromSource(source, config, { force: opts.force });
        console.log(chalk.green(`Installed skill "${result.skill.name}" → ${result.dest}`));
        if (result.skill.commands.length > 0) {
          console.log(
            chalk.yellow(
              `\n⚠ Skill "${result.skill.name}" declares executable command(s): ${result.skill.commands.join(', ')}`,
            ),
          );
          console.log(
            chalk.dim('  The agent will be able to run these after you approve them in the REPL.'),
          );
        }
        if (result.missingRequires.length > 0) {
          console.warn(
            chalk.yellow(`\n⚠ This skill needs ${result.missingRequires.length} CLI(s) not on PATH:`),
          );
          for (const m of result.missingRequires) {
            console.warn(
              chalk.yellow(`  - ${m.bin}`) + (m.install ? chalk.dim(`   install: ${m.install}`) : ''),
            );
          }
        }
        // 需要 API key 的 skill（如 weread）：引导设置环境变量。
        if (result.missingEnv.length > 0) {
          console.log(
            chalk.yellow(`\n🔑 Set ${result.missingEnv.join(', ')} before using this skill:`),
          );
          console.log(
            chalk.dim(
              `  add it to config.json's "secrets" map (e.g. "secrets": { "${result.missingEnv[0]}": "your-key" })`,
            ),
          );
          if (result.skill.name === 'weread') {
            console.log(
              chalk.dim('  get the weread key at https://weread.qq.com/r/weread-skills (login required)'),
            );
          }
        }
      } catch (err) {
        if (err instanceof SkillExistsError) {
          console.error(chalk.red(`${err.message}. Use --force to overwrite.`));
        } else {
          console.error(chalk.red((err as Error).message));
        }
        process.exitCode = 1;
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
