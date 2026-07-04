/**
 * `pith-wiki init` 的交互层。
 *
 * 跟 [./initCommand.ts](./initCommand.ts) 分文件是为了把"问问题"和"动文件"解耦：
 *   - initCommand.ts: 纯逻辑（输入选项 → 输出 InitResult），可单测，被 init.test.ts 覆盖
 *   - initInteractive.ts: I/O 边界（readline 问答），手动 smoke test 即可，无单测
 *
 * 不用 ink（REPL 用的那套）是故意的——init 是一次性 5 行问答，readline 已够；
 * ink 启动开销 + 全屏 takeover 给"我就装一下"的体验添堵。
 *
 * 没有 TTY（stdin 不是终端，例如 `echo y | pith-wiki init`）时跳过所有提问，
 * 直接走 silent 默认值。这样脚本化场景行为可预测。
 *
 * 配色原则（吃过 chalk.gray 在深色终端等于透明的亏）：
 *   - 标题用 chalk.bold（默认前景色 + 加粗），任何主题都看得见
 *   - 序号 / 默认值标记 / 路径 echo 用 chalk.cyan，醒目
 *   - 描述性 sub-text 用 chalk.dim（终端自己控制对比度，比写死 gray 稳）
 *   - readline 的提示符部分**不上色**：终端会用默认前景色，永远可读
 */
import readline from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_CATALOG,
  type InitOptions,
  type ProviderTemplate,
} from './initCommand.js';

/**
 * 在 TTY 上交互收集 provider / apiKey / watchDir / initialScan 四件事。
 *
 * 各问题语义：
 *   - **provider**: 选 PROVIDER_CATALOG 里某项。回车 = DEFAULT_PROVIDER_ID（deepseek）。
 *   - **apiKey**: 回车 = 跳过（保留占位符，让用户后续手编辑）。
 *   - **watchDir**: 回车 = 跳过（不写 watchDirs）。否则做 `~/` 展开 + 简单存在性检查。
 *   - **initialScan**: 仅 watchDir 有值时问。默认 Y——init 时设 watch-dir 的语义就是
 *     "把这个目录入库"，存量不扫等于白设。
 *
 * "已经传了 flag 的字段" 不再提问——CI 半交互场景友好（`--api-key $KEY` 后只剩
 * provider / watchDir 要问）。完全没 flag → 全问。
 *
 * 不在这里调 runInit；返回 InitOptions 让调用方决定何时落盘——方便上层在出错时
 * 回滚或附加额外校验。
 */
export async function promptInitOptions(base: InitOptions): Promise<InitOptions> {
  // 没 TTY 直接放弃问问题——脚本化场景应给齐 flag 或接受 silent 默认值。
  if (!process.stdin.isTTY) return base;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const collected: InitOptions = { ...base };

    if (collected.provider === undefined) {
      collected.provider = await askProvider(rl);
    }

    const providerObj =
      PROVIDER_CATALOG.find((p) => p.id === collected.provider) ??
      PROVIDER_CATALOG.find((p) => p.id === DEFAULT_PROVIDER_ID)!;

    if (collected.apiKey === undefined) {
      collected.apiKey = await askApiKey(rl, providerObj);
    }

    if (collected.watchDir === undefined) {
      collected.watchDir = await askWatchDir(rl);
    }

    // 只有真定了 watch-dir 才问 initialScan——没 watch-dir 时这个字段无意义。
    // 已经传了 --no-initial-scan 的话 base.initialScan 是 false，跳过提问。
    if (collected.watchDir && collected.initialScan === undefined) {
      collected.initialScan = await askInitialScan(rl);
    }

    return collected;
  } finally {
    rl.close();
  }
}

async function askProvider(rl: readline.Interface): Promise<string> {
  console.log('\n' + chalk.bold('Select an LLM provider:'));
  PROVIDER_CATALOG.forEach((p, i) => {
    const marker = p.id === DEFAULT_PROVIDER_ID ? chalk.cyan(' ← default') : '';
    console.log(`  ${chalk.cyan(String(i + 1))}. ${p.label}${marker}`);
  });
  console.log(
    chalk.dim('  Other (ollama / zhipu / minimax …) → skip here, edit config.json after init.'),
  );

  while (true) {
    // 提示符本身不上色——交给终端用默认前景色；highlight 加在范围数字上
    const ans = (await rl.question(`  Pick [${chalk.cyan('1-5')}] or Enter for default: `)).trim();
    if (!ans) return DEFAULT_PROVIDER_ID;
    const idx = Number(ans);
    if (Number.isInteger(idx) && idx >= 1 && idx <= PROVIDER_CATALOG.length) {
      return PROVIDER_CATALOG[idx - 1]!.id;
    }
    const byId = PROVIDER_CATALOG.find((p) => p.id === ans.toLowerCase());
    if (byId) return byId.id;
    console.log(chalk.yellow(`  Invalid input "${ans}", try again.`));
  }
}

async function askApiKey(
  rl: readline.Interface,
  provider: ProviderTemplate,
): Promise<string | undefined> {
  console.log('\n' + chalk.bold(`Enter your ${provider.label} API key:`));
  console.log(
    chalk.dim('  Will be written to config.json as the ') +
      chalk.cyan(`"${provider.id}"`) +
      chalk.dim(' provider\'s "apiKey". Press Enter to skip and edit later.'),
  );
  const ans = (await rl.question('  API key: ')).trim();
  return ans || undefined;
}

async function askWatchDir(rl: readline.Interface): Promise<string | undefined> {
  console.log('\n' + chalk.bold('Auto-watch directory (optional):'));
  console.log(
    chalk.dim('  New / changed .md / .pdf / .docx / … files will be auto-queued and hydrated.'),
  );
  console.log(
    chalk.dim('  Typical use: point at your Obsidian vault or Inbox folder. Press Enter to skip.'),
  );
  const ans = (await rl.question(`  Path (${chalk.cyan('~/foo')} expands): `)).trim();
  if (!ans) return undefined;

  const expanded =
    ans === '~'
      ? os.homedir()
      : ans.startsWith('~/') || ans.startsWith('~\\')
        ? path.join(os.homedir(), ans.slice(2))
        : ans;
  return expanded;
}

async function askInitialScan(rl: readline.Interface): Promise<boolean> {
  console.log('\n' + chalk.bold('Scan existing files now?'));
  console.log(
    chalk.dim('  ') +
      chalk.cyan('Y') +
      chalk.dim(' = on next REPL start, queue all existing .md / .pdf / … for hydration'),
  );
  console.log(
    chalk.dim('  ') +
      chalk.cyan('n') +
      chalk.dim(' = only watch new files; ingest existing ones later with `pith-wiki ingest --dir …`'),
  );
  const ans = (await rl.question(`  Scan? [${chalk.cyan('Y')}/n]: `)).trim().toLowerCase();
  if (ans === 'n' || ans === 'no') return false;
  return true;
}
