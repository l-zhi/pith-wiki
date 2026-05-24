import os from 'node:os';
import path from 'node:path';

/**
 * 用户级"home"目录：放 .env、config.json、wiki-data/、queue/、history、SOUL.md。
 *
 * 默认 `~/.pith-wiki/`。通过 `PITH_WIKI_HOME` 环境变量可以整套挪走——典型用途是
 * 并行一个开发环境（`PITH_WIKI_HOME=~/.pith-wiki-dev` 配合 `bin/pith-wiki-dev`），
 * 避免 dev 调试污染 prod 数据。
 *
 * 懒求值（不缓存）：测试里 monkey-patch `os.homedir` 或动态改 env 都能立刻生效。
 */
export function pithWikiHome(): string {
  const override = process.env.PITH_WIKI_HOME;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.pith-wiki');
}
