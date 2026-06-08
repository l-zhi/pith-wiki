import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureSkillsDir, type Config } from '../config.js';
import { buildSkillRegistry, loadSkill } from '../skills/index.js';

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
    .command('add <path>')
    .description('Install a skill by copying its directory (containing SKILL.md) into the user skills dir.')
    .option('--force', 'Overwrite an existing skill of the same name.')
    .action(async (srcPath: string, opts: { force?: boolean }) => {
      const config = args.configFor();
      const src = path.resolve(srcPath);
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
        console.error(chalk.red(`Not a directory: ${src}`));
        process.exitCode = 1;
        return;
      }
      // 校验源目录是个合法 skill（frontmatter + 非空正文）。
      let name: string;
      try {
        name = loadSkill(src).name;
      } catch (err) {
        console.error(chalk.red(`Invalid skill at ${src}: ${(err as Error).message}`));
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
      const dest = path.join(destRoot, name);
      if (fs.existsSync(dest)) {
        if (!opts.force) {
          console.error(chalk.red(`Skill "${name}" already exists at ${dest}. Use --force to overwrite.`));
          process.exitCode = 1;
          return;
        }
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.cpSync(src, dest, { recursive: true });
      console.log(chalk.green(`Installed skill "${name}" → ${dest}`));
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
