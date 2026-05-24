import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取 package.json 的 version 字段——`--version` 输出的事实来源。
 *
 * 为什么运行时读而不是 `import pkg from '../package.json'`：后者会被 TS 当作 source
 * 拖进 `dist/` 编译产物，把 package.json 复制成 `dist/package.json`，反而打乱发布。
 *
 * 路径策略：从本文件所在目录（`import.meta.url`，不被 npm bin shim 的 realpath 干扰）
 * 向上找最近的 `package.json`。这样三种部署形态下都对：
 *   - tsx dev：             `<repo>/src/version.ts`           → `<repo>/package.json`
 *   - 编译产物 dist：       `<pkg>/dist/src/version.js`       → `<pkg>/package.json`
 *   - 全局 npm install：    `<global>/lib/node_modules/pith-wiki/dist/src/version.js`
 *                          → `<global>/lib/node_modules/pith-wiki/package.json`
 *
 * 读不到回落到 `'unknown'`：`--version` 不应该把 CLI 崩了。导出参数 `fromFile`
 * 仅供测试 monkey-patch 起点目录用，生产代码不要传。
 */
export function readPackageVersion(fromFile?: string): string {
  try {
    let dir = path.dirname(fromFile ?? fileURLToPath(import.meta.url));
    // 向上探 6 层够覆盖 `dist/src/...` 这类深度，再多就说明仓库结构错了
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
        return pkg.version ?? 'unknown';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // 文件系统根了
      dir = parent;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
