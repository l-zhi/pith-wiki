/**
 * 准拆包纪律的运行时防线。
 *
 * 把 scripts/check-no-cli-leak.mjs 拉到 vitest 里跑，让 `pnpm test` 自动校验：
 *   - 核心层源码无 ink/react/commander/chalk/dotenv import（dotenv 仅 config.ts 白名单）
 *   - dist/ 产物无相同字面量（如果已构建过）
 *
 * 将来拆 `@llm-wiki/core` + `@llm-wiki/cli` 时，这条测试就是搬家完成的判据。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('check-no-cli-leak', () => {
  it('核心层不依赖 CLI/UI 层（源码 + 产物）', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/check-no-cli-leak.mjs')],
      { encoding: 'utf8', cwd: repoRoot },
    );
    if (result.status !== 0) {
      // 把脚本输出原样塞进失败信息，便于直接看违规细节
      throw new Error(
        `check-no-cli-leak.mjs exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });
});
