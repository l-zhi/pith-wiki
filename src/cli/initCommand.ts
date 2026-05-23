/**
 * `pith-wiki init` —— 一次性初始化 `~/.pith-wiki/`。
 *
 * 把"mkdir + cp .env.example + chmod 600"三步压成单一命令。README 安装段从此
 * 不再要求新用户手敲 shell 串。
 *
 * 设计原则：
 *   - **幂等**：默认不覆盖已存在的 `.env`，要 `--force` 才会盖（带 .pre-init.bak 备份）。
 *   - **不依赖 .env.example 文件**：模板内嵌在源码里。`.env.example` 是历史 setup 文档，
 *     未来想改默认模板只改这里一处。
 *   - **可脚本化**：`--api-key <key>` 让 CI / 自动化流程一行非交互完成 setup。
 *   - **chmod 600**：模板里有"sk-xxx" 占位符，但用户填完真 key 后这个权限位很重要——
 *     主动设上去而不是依赖 umask。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';

/**
 * 内嵌的 `.env` 模板。跟仓库根的 `.env.example` 保持同步——更新一处时另一处也要改。
 * 选择内嵌而不是运行时读 `.env.example` 是因为：
 *   1. 全局 `npm install -g pith-wiki` 后，`.env.example` 不在 `files`/`dist` 里（按
 *      package.json 的 files 字段，npm 包只含 dist + README + LICENSE）。
 *   2. 内嵌可以保证 init 永远不会因为模板缺失而挂掉。
 */
const ENV_TEMPLATE = `# Provider API keys。具体 baseURL/model 在 ~/.pith-wiki/config.json 的 providers 表里
# 配；这里只放 key（apiKeyEnv 引用的变量名）。
#
# DeepSeek（默认 provider；最便宜的选择）
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx

# 其它 OpenAI-compatible provider 的 key（按需取消注释）
# DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx     # 阿里 Qwen
# OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
# MOONSHOT_API_KEY=sk-xxxxxxxxxxxxxxxx      # Moonshot Kimi
# ZHIPU_API_KEY=xxxxxxxxxxxxxxxx            # Zhipu GLM
# OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxx
# GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx

# 切 provider 的方式：CLI \`--provider <name>\` > 这里的 PITH_WIKI_PROVIDER > config.json 的 activeProvider。
# REPL 内可用 \`/provider <name>\` 热切（会重置当前对话）。
# PITH_WIKI_PROVIDER=deepseek

# 顶层兜底覆盖（仅当不用 providers 表时生效；与 activeProvider 二选一）。
# PITH_WIKI_MODEL=deepseek-chat
# PITH_WIKI_BASE_URL=https://api.deepseek.com
# PITH_WIKI_ROOT=./wiki-data
# PITH_WIKI_READ_ONLY=false

# 额外可读目录列表。两种语法都支持，自动判别：
#
#   1) JSON 数组（推荐——一眼看清是数组语义，~ 自动展开成 home 目录）：
# PITH_WIKI_READ_PATHS=["~/notes", "~/research/papers"]
#
#   2) path.delimiter 分隔（POSIX 是 ":", Windows 是 ";"）：
# PITH_WIKI_READ_PATHS=/Users/me/notes:/Users/me/research/papers
#
# 这些目录的文件可被 read_file / list_dir 读到，且 ingest --file / --batch / --dir
# 必须落在它们之一（或 cwd / wikiRoot）之内才允许入库。
# write_file 永远不会写到这些目录——它们是只读的"参考资料源"。
`;

export interface InitOptions {
  /** 覆盖已存在的 .env；默认 false（拒绝覆盖以防误删用户的真 key）。 */
  force?: boolean;
  /**
   * 如果给了，把 `DEEPSEEK_API_KEY=sk-xxxxxx` 这一行替换成真实 key。
   * 适合 CI / 一行 setup（`pith-wiki init --api-key $DEEPSEEK_API_KEY`）。
   * 不给的话用户后续手工编辑 `.env`。
   */
  apiKey?: string;
  /**
   * 覆盖默认的 home 目录（仅测试用——生产场景固定 `~/.pith-wiki/`）。
   */
  homeDirOverride?: string;
}

export interface InitResult {
  /** 写入 / 即将写入的绝对文件路径。 */
  envFile: string;
  /** 是否真的写了 .env（false = 已存在且没传 force，跳过）。 */
  wrote: boolean;
  /** 写入前如果 `.env` 已存在，本次有没有备份；undefined = 没创建备份。 */
  backupFile?: string;
}

/**
 * 执行 init。返回结构化结果——CLI 层负责把它格式化成 stdout / exit code。
 *
 * 流程：
 *   1. 确保 `~/.pith-wiki/` 存在（mkdir -p）。
 *   2. 检查 `.env` 是否存在：
 *      - 存在 + 没 force → 不写，wrote=false，返回（CLI 报 exit 1 + 提示）。
 *      - 存在 + force → 备份到 `.env.pre-init.bak`，然后覆盖。
 *      - 不存在 → 直接写。
 *   3. 渲染模板：如果传了 apiKey，把 `DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx` 这条
 *      占位符替换成真实 key。
 *   4. chmod 600（仅文件 owner 可读写）。
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const homeDir = opts.homeDirOverride ?? path.join(os.homedir(), '.pith-wiki');
  const envFile = path.join(homeDir, '.env');

  fs.mkdirSync(homeDir, { recursive: true });

  let backupFile: string | undefined;
  if (fs.existsSync(envFile)) {
    if (!opts.force) {
      return { envFile, wrote: false };
    }
    backupFile = `${envFile}.pre-init.bak`;
    fs.copyFileSync(envFile, backupFile);
  }

  const content = opts.apiKey
    ? ENV_TEMPLATE.replace(
        /^DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx$/m,
        `DEEPSEEK_API_KEY=${opts.apiKey}`,
      )
    : ENV_TEMPLATE;

  fs.writeFileSync(envFile, content, { encoding: 'utf8', mode: 0o600 });
  // mode 选项在某些 Node 版本下对已存在文件不生效；显式 chmod 兜底。
  fs.chmodSync(envFile, 0o600);

  return { envFile, wrote: true, backupFile };
}

/**
 * 人类可读的输出。被 src/cli/subcommands.ts 调用，CLI 层只负责打印 + 设 exit code。
 */
export function formatInitResult(result: InitResult, opts: InitOptions = {}): string {
  if (!result.wrote) {
    return [
      chalk.yellow(`✗ refusing to overwrite existing ${result.envFile}`),
      chalk.gray(`  pass --force to back it up (to .env.pre-init.bak) and rewrite from template`),
    ].join('\n');
  }
  const lines: string[] = [chalk.green(`✓ wrote ${result.envFile}`)];
  if (result.backupFile) {
    lines.push(chalk.gray(`  backup: ${result.backupFile}`));
  }
  if (opts.apiKey) {
    lines.push(chalk.gray(`  DEEPSEEK_API_KEY filled inline; you can edit other provider keys later`));
  } else {
    lines.push(chalk.gray(`  next: edit it and fill DEEPSEEK_API_KEY (or another provider's key)`));
  }
  return lines.join('\n');
}
