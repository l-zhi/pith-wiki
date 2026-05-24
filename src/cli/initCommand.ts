/**
 * `pith-wiki init` —— 一次性初始化 `~/.pith-wiki/`。
 *
 * 把"mkdir + 写最小化 .env + 可选 config.json + chmod 600"几步压成单一命令。
 *
 * 设计原则：
 *   - **最小输出**：默认只写 `.env` 里**一行** `<PROVIDER>_API_KEY=...`。其余字段
 *     （baseURL/model/watchDirs/...）走 zod 默认或写入 `config.json`，新用户的
 *     `.env` 不再是一坨注释墙。
 *   - **按需写 config.json**：deepseek（默认 provider）+ 无 watch 目录 → 不写
 *     config.json，全靠代码里的 DEFAULTS。选了其它 provider 或加了 watch 目录
 *     才落 config.json，让"零配置"路径真的零配置。
 *   - **幂等**：默认不覆盖已存在的 `.env` / `config.json`。`--force` 才会盖
 *     （带 `.pre-init.bak` 备份）。
 *   - **可脚本化**：所有交互问题都有等价 flag（`--provider` / `--api-key` /
 *     `--watch-dir`），CI 一行 setup 完成。交互层在另一个文件里
 *     （[./initInteractive.ts](./initInteractive.ts)），保证此处纯逻辑、可单测。
 *   - **chmod 600**：模板里有占位符，但用户填完真 key 后这个权限位很重要——
 *     主动设上去而不是依赖 umask。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import fastGlob from 'fast-glob';
import { pithWikiHome } from '../paths.js';

/**
 * watcher 默认会识别这几种扩展（跟 src/wiki/converters/builtin/*.ts 里各转换器
 * 声明的 extensions 一致）。在这里复刻一份只是给 init 的"会扫几个文件"预览用——
 * 不引入 buildConverterPipeline 以避免 init 出错时拖垮 converter 注册（init 本身
 * 该尽量不依赖业务模块）。
 *
 * 如果未来加新 converter，记得同步这条数组。脱节的后果只是预览数偏小，**不影响
 * 实际 hydrate**（实际 watcher 仍按 converter 注册的扩展行事）。
 */
const WATCH_PREVIEW_EXTS = ['md', 'markdown', 'txt', 'text', 'pdf', 'docx', 'htm', 'html', 'eml'];

/** 预览扫描的上限：超过就停止计数显示 "10000+"，避免在大 vault 上 init 卡死。 */
const WATCH_PREVIEW_FILE_CAP = 10_000;

/**
 * 内置 provider 目录。覆盖中文用户最常用的 5 家 OpenAI-compatible endpoint。
 *
 * 选 5 而不是更多：装这条目录的成本是双倍的——既要保证 URL/model 名 stay current，
 * 又要在交互菜单里不长到吓人。这 5 家市占率 + 中文社区覆盖最高。
 *
 * 用户要加别的（Ollama 本地、自托管 vLLM、Zhipu、MiniMax 等）：手动编辑
 * `config.json` 的 `providers` 表即可，参见 [docs/config.example.json]。
 *
 * 字段语义：
 *   - id:        命令行 `--provider <id>` / 配置文件 activeProvider 用的名字
 *   - label:     交互菜单里的人类可读标签
 *   - baseURL:   OpenAI-compatible endpoint
 *   - model:     默认 chat 模型——hydrate 的 JSON mode 用的也是它
 *   - apiKeyEnv: `.env` 里那一行的变量名
 *
 * 添加新 provider 时务必同步 [docs/config.example.json]，那是用户参考的源头。
 */
export interface ProviderTemplate {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
}

export const PROVIDER_CATALOG: ProviderTemplate[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek (cheapest, recommended)',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (multi-model proxy)',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    apiKeyEnv: 'MOONSHOT_API_KEY',
  },
];

export const DEFAULT_PROVIDER_ID = 'deepseek';

/** 按 id 查 provider；未知 id 抛 Error。调用方应已经验证过参数。 */
export function lookupProvider(id: string): ProviderTemplate {
  const p = PROVIDER_CATALOG.find((p) => p.id === id);
  if (!p) {
    throw new Error(
      `Unknown provider "${id}". Known: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')}`,
    );
  }
  return p;
}

export interface InitOptions {
  /** 覆盖已存在的 `.env` / `config.json`；默认 false。 */
  force?: boolean;
  /** Provider id（PROVIDER_CATALOG 里的某项）。缺省 deepseek。 */
  provider?: string;
  /** API key 字面值——填入 `.env` 里 `<envName>=<key>` 那一行。不传则保留占位符。 */
  apiKey?: string;
  /**
   * watch 目录绝对路径或 `~/foo`。给了就在 config.json 里写一条
   * watchDirs 入口（collectionFromSubdir=true，initialScan 看 initialScan 选项）。
   * 不给 → 不写 watchDirs。
   */
  watchDir?: string;
  /**
   * watch 目录里**已经存在的文件**在 REPL 启动时是否自动入队 hydrate。
   * 默认 `true`——init 时设 watch-dir 的语义就是"把这个目录纳入知识库"，
   * 不扫一遍存量等于白设。担心 token 账单的用户可以 `--no-initial-scan` 关掉，
   * 之后再用 `pith-wiki ingest --dir ...` 手动选择性入库。
   * 仅在 `watchDir` 也设了时被 renderConfigJson 用到。
   */
  initialScan?: boolean;
  /** 测试用：覆盖默认的 home（生产固定 `~/.pith-wiki/` / `PITH_WIKI_HOME`）。 */
  homeDirOverride?: string;
}

export interface InitResult {
  /** `.env` 写入或拒写的路径。 */
  envFile: string;
  /** `config.json` 写入的路径，只有真写了才有。 */
  configFile?: string;
  /** `.env` 这次真写了吗？（false = 已存在 + 没 force） */
  wrote: boolean;
  /** `config.json` 这次真写了吗？（没要求写 / 已存在 + 没 force 都是 false） */
  wroteConfig: boolean;
  /** `.env` 旧版本的备份（仅 force 覆盖时）。 */
  backupFile?: string;
  /** `config.json` 旧版本的备份（仅 force 覆盖时）。 */
  configBackupFile?: string;
  /** 选中的 provider（即使没传也会 echo 默认值，方便 formatInitResult 拼提示）。 */
  provider: ProviderTemplate;
  /**
   * watch 目录的预览扫描结果——仅在"配了 watchDir 且 initialScan=true"时填充。
   * 让 formatInitResult 能给用户提前打招呼"REPL 启动后会立刻入队 N 个文件"，
   * 避免"加了 watch 但好像什么都没发生"那种困惑。capped=true 表示命中了
   * WATCH_PREVIEW_FILE_CAP 上限，UI 应显示成 "N+" 而不是确切数字。
   */
  watchDirPreview?: {
    /** 绝对路径（`~/` 已展开），供输出展示。 */
    absPath: string;
    count: number;
    capped: boolean;
    /** 目录不存在 / 无权限 / 其它异常：count 一定是 0，UI 应警告"路径不存在"。 */
    missing: boolean;
  };
}

/**
 * 把 `~/foo` / `~` 字面量展开成 home-relative 绝对路径。
 * 简单复刻 src/config.ts 里的 expandHome，避免循环依赖配置层。
 */
function expandHomeLite(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 预览扫描——给"加了 watchDir + initialScan=true 时 REPL 启动会入队 N 个文件"
 * 的提示提供数字。失败时返回 missing:true 让 UI 显示 warning 而不是炸 init。
 *
 * 为什么 sync：runInit 本身是 sync 的，让它继续保持原签名比 sneak-in async 更稳。
 * 大 vault 下这个 sync glob 可能费 1-2 秒——可以接受，init 一次性操作而已；
 * WATCH_PREVIEW_FILE_CAP 也提前截断了不会太离谱。
 */
export function previewWatchDir(watchDir: string): InitResult['watchDirPreview'] {
  const absPath = path.resolve(expandHomeLite(watchDir));
  if (!fs.existsSync(absPath)) {
    return { absPath, count: 0, capped: false, missing: true };
  }
  try {
    // 大括号 glob 把 9 个扩展打成一个 pattern，让 fast-glob 一次 traverse。
    // dot:false 跟 watcher 一致——隐藏文件默认不入库；不暴露给 UI 否则太多噪音。
    const matches = fastGlob.sync(`**/*.{${WATCH_PREVIEW_EXTS.join(',')}}`, {
      cwd: absPath,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      // 命中上限即停——fast-glob 没原生 limit，所以我们后面手动截断。
      followSymbolicLinks: false,
    });
    const capped = matches.length > WATCH_PREVIEW_FILE_CAP;
    return {
      absPath,
      count: capped ? WATCH_PREVIEW_FILE_CAP : matches.length,
      capped,
      missing: false,
    };
  } catch {
    return { absPath, count: 0, capped: false, missing: true };
  }
}

/** 渲染 `.env` 文件内容——最小化，只放被选 provider 的那一行。 */
export function renderEnv(provider: ProviderTemplate, apiKey: string | undefined): string {
  const key = apiKey ?? 'sk-xxxxxxxxxxxxxxxx';
  // 一行注释 + 一行 KV——故意不写第二个 provider 的 commented-out 模板：
  // 用户想加别的 key 自己 append 即可，模板里挂太多注释反而是噪音。
  return `# pith-wiki API keys. chmod 600. Edit values, don't commit this file.
${provider.apiKeyEnv}=${key}
`;
}

/**
 * 渲染 `config.json`。只在"非默认 provider 或有 watch 目录"时才被调用。
 *
 * 写最小 schema：providers map 里只放被选 provider 这一条 + activeProvider + 可选
 * watchDirs。其它字段（queue / outputDir / transcriptEnabled / ...）走代码默认，
 * 用户进阶时手动加，参见 [docs/config.example.json]。
 *
 * 不引入既有 config.json 合并逻辑：如果用户已有 config.json，由调用方走 force/
 * backup 流程决定是否覆盖——避免在这里做"猜用户想保留什么"的隐式行为。
 */
export function renderConfigJson(
  provider: ProviderTemplate,
  watchDir: string | undefined,
  initialScan = true,
): string {
  const config: Record<string, unknown> = {
    providers: {
      [provider.id]: {
        baseURL: provider.baseURL,
        model: provider.model,
        apiKeyEnv: provider.apiKeyEnv,
      },
    },
    activeProvider: provider.id,
  };
  if (watchDir) {
    config.watchDirs = [
      {
        path: watchDir,
        // collectionFromSubdir=true：把 watchDir 下第一层子目录名当 collection。
        // 这是 Obsidian-vault 类用法的默认期望（按笔记本顶层分目录）。
        collectionFromSubdir: true,
        // initialScan：默认 true。在 init 时设 watch-dir 的人 99% 想立刻把存量
        // 入库；老设计写死 false 导致"加了 watch 但什么都没发生"的体验问题。
        // 想要细粒度控制的人显式 `--no-initial-scan` 即可。
        initialScan,
      },
    ];
    // 也把 watchDir 加进 additionalReadPaths——watcher 的安全沙箱默认只允许
    // workspaceRoot ∪ wikiRoot 内，不在的目录直接报 "watch path outside read
    // sandbox" 然后 watcher 静默挂掉（在 REPL 里错误进 setMessages，但
    // dashboard 按 config 还显示 watch 1/1，给"加了但没动"的诡异错觉）。
    // 用户在 init 里明确要 watch 这个目录 → 默认就应允许读它。
    config.additionalReadPaths = [watchDir];
  }
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * 执行 init。返回结构化结果——CLI 层负责把它格式化成 stdout / exit code。
 *
 * 流程：
 *   1. 解析 provider（默认 deepseek）。
 *   2. mkdir -p homeDir。
 *   3. `.env`：存在 + 无 force → 不写；存在 + force → 备份；不存在 → 直接写。
 *   4. `config.json`：仅当 provider != 默认 或 watchDir 被传，且按同样 force/backup 逻辑。
 *   5. chmod 600 .env（owner-only）。config.json 是普通可读文件，不限。
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const provider = lookupProvider(opts.provider ?? DEFAULT_PROVIDER_ID);
  const homeDir = opts.homeDirOverride ?? pithWikiHome();
  const envFile = path.join(homeDir, '.env');
  const configFile = path.join(homeDir, 'config.json');

  fs.mkdirSync(homeDir, { recursive: true });

  // --- .env ---
  let backupFile: string | undefined;
  let wrote = false;
  if (fs.existsSync(envFile)) {
    if (opts.force) {
      backupFile = `${envFile}.pre-init.bak`;
      fs.copyFileSync(envFile, backupFile);
      fs.writeFileSync(envFile, renderEnv(provider, opts.apiKey), { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(envFile, 0o600);
      wrote = true;
    }
    // 否则 wrote=false，沿用旧 .env 不动
  } else {
    fs.writeFileSync(envFile, renderEnv(provider, opts.apiKey), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    wrote = true;
  }

  // --- config.json（按需）---
  const needsConfig = provider.id !== DEFAULT_PROVIDER_ID || !!opts.watchDir;
  let configBackupFile: string | undefined;
  let wroteConfig = false;
  let configFileOut: string | undefined;
  if (needsConfig) {
    configFileOut = configFile;
    const exists = fs.existsSync(configFile);
    if (!exists || opts.force) {
      if (exists) {
        configBackupFile = `${configFile}.pre-init.bak`;
        fs.copyFileSync(configFile, configBackupFile);
      }
      // initialScan 默认 true（仅当 watchDir 设了才有意义；renderConfigJson 内部
      // 也只有有 watchDir 时才会用到这个值）。
      fs.writeFileSync(
        configFile,
        renderConfigJson(provider, opts.watchDir, opts.initialScan ?? true),
        'utf8',
      );
      wroteConfig = true;
    }
  }

  // watch 目录的预览扫描：只在"用户真的设了 watchDir 且 initialScan 没被显式关掉"
  // 时做。这样 formatInitResult 可以告诉用户"REPL 启动后会入队 N 个文件"，
  // 避免"加了 watch 但什么都没发生"的疑惑。
  const willScan = !!opts.watchDir && (opts.initialScan ?? true);
  const watchDirPreview = willScan ? previewWatchDir(opts.watchDir!) : undefined;

  return {
    envFile,
    configFile: configFileOut,
    wrote,
    wroteConfig,
    backupFile,
    configBackupFile,
    provider,
    watchDirPreview,
  };
}

/**
 * 人类可读输出。被 [./subcommands.ts](./subcommands.ts) / [./initInteractive.ts](./initInteractive.ts)
 * 调用，CLI 层只负责打印 + 设 exit code。
 *
 * 排版原则：每个真发生的动作一行。"next step" 单独成段，让用户一眼看到要做什么。
 */
export function formatInitResult(result: InitResult, opts: InitOptions = {}): string {
  const lines: string[] = [];

  if (!result.wrote && !result.wroteConfig) {
    lines.push(chalk.yellow(`✗ nothing written: ${result.envFile} already exists`));
    lines.push(
      chalk.dim(`  pass --force to back it up (to .env.pre-init.bak) and rewrite from template`),
    );
    return lines.join('\n');
  }

  if (result.wrote) {
    lines.push(chalk.green(`✓ ${result.envFile}`));
    if (result.backupFile) lines.push(chalk.dim(`  backup: ${result.backupFile}`));
  } else if (result.wroteConfig) {
    // .env 已存在没动，但 config.json 写了——单独提示，避免用户以为 .env 也被改了
    lines.push(chalk.yellow(`• .env unchanged (already exists; --force to rewrite)`));
  }

  if (result.wroteConfig && result.configFile) {
    lines.push(chalk.green(`✓ ${result.configFile}`));
    if (result.configBackupFile) lines.push(chalk.dim(`  backup: ${result.configBackupFile}`));
  }

  // next-step 提示
  lines.push('');
  if (opts.apiKey) {
    lines.push(chalk.dim(`  ${result.provider.apiKeyEnv} filled inline. You're good to go:`));
  } else {
    lines.push(
      chalk.dim(
        `  next: edit ${result.envFile} and fill ${result.provider.apiKeyEnv}=<your-key>`,
      ),
    );
  }
  lines.push(chalk.dim(`  then run: pith-wiki    (or: pith-wiki list / query "..." — no key needed)`));

  // watch 目录预览：让"加了 watch-dir 但好像没动静"的疑惑消失在 init 阶段。
  if (result.watchDirPreview) {
    const { absPath, count, capped, missing } = result.watchDirPreview;
    lines.push('');
    if (missing) {
      lines.push(
        chalk.yellow(
          `  ⚠ watch dir does not exist yet: ${absPath}`,
        ),
      );
      lines.push(
        chalk.dim(
          `    create it before starting REPL, or watcher will skip it silently`,
        ),
      );
    } else if (count === 0) {
      lines.push(
        chalk.dim(
          `  → ${absPath} has no supported files yet (.${WATCH_PREVIEW_EXTS.join(' .')})`,
        ),
      );
      lines.push(chalk.dim(`    REPL will queue new files as you add them`));
    } else {
      const num = capped ? `${count}+` : String(count);
      lines.push(
        chalk.cyan(
          `  → ${absPath} will queue ${num} existing file${count === 1 ? '' : 's'} on next REPL start`,
        ),
      );
      lines.push(
        chalk.dim(`    (re-run with --no-initial-scan to skip the first sweep)`),
      );
    }
  }

  return lines.join('\n');
}
