import os from 'node:os';
import path from 'node:path';

/**
 * 是否从源码（tsx）启动 —— 即"开发环境"。
 *
 * 判据是入口脚本（`process.argv[1]`）的扩展名：
 *   - `npm run dev` / `bun run dev` / `tsx bin/pith-wiki.ts` → 入口是 `.ts` → true
 *   - 编译后的 `dist/bin/pith-wiki.js`（含 npm 安装包、`npm start`）→ `.js` → false
 *   - vitest 的入口是 `.../vitest/dist/workers/forks.js`（`.js`）→ false，
 *     所以测试始终走线上默认（`~/.pith-wiki`），依赖该默认值的用例不受影响。
 *
 * 用入口扩展名而非 `import.meta.url`：前者反映"用户实际敲了哪个文件"，能把
 * "用户直接跑我们的 .ts CLI"和"vitest 在跑我们的代码"区分开。
 */
function isDevEntrypoint(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.endsWith('.ts');
}

/**
 * 用户级"home"目录：放 .env、config.json、wiki-data/、queue/、history、SOUL.md。
 *
 * 解析顺序：
 *   1. `PITH_WIKI_HOME` 环境变量（显式覆盖，最高优先）—— 典型用途是 `bin/pith-wiki-dev`
 *      包装脚本，或一次性 `PITH_WIKI_HOME=/tmp/scratch ...`，或测试隔离。
 *   2. 开发环境（从源码经 tsx 启动，见 isDevEntrypoint）→ `~/.pith-wiki-dev/`，
 *      避免 dev 调试污染 prod 数据。
 *   3. 默认（编译后的 dist / npm 安装包）→ `~/.pith-wiki/`。
 *
 * 懒求值（不缓存）：测试里 monkey-patch `os.homedir` 或动态改 env 都能立刻生效。
 */
export function pithWikiHome(): string {
  const override = process.env.PITH_WIKI_HOME;
  if (override && override.trim()) return override;
  const dir = isDevEntrypoint() ? '.pith-wiki-dev' : '.pith-wiki';
  return path.join(os.homedir(), dir);
}
