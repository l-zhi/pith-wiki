import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 桌面端 vitest 配置（`cd desktop && npm test` 用）。只做一件事：把桌面端 engine 用的 `@core/*` 别名指到仓库根 `src/`。
 *
 * 为什么需要：`desktop/src/engine/*` 通过 `@core/*` import 核心层（别名定义在
 * electron.vite.config.ts + tsconfig.node.json 里，vitest 看不到）。以前桌面端测试能过是
 * 因为那些 import 都是 `import type`（运行期被擦掉）；一旦 engine 模块有**运行期**的
 * `@core` import（piCoreAgent 需要核心层的消息映射器），不给别名就会解析失败。
 * 其余配置全部保持 vitest 默认（include/exclude 不动，避免影响既有 59 个测试文件的收集）。
 */
export default defineConfig({
  resolve: {
    alias: { '@core': resolve(__dirname, '../src') },
  },
});
