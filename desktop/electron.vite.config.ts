import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 三段构建：
 *   main    — Electron 主进程壳 + Engine（utilityProcess 入口）双 entry。
 *             Engine 直接 import 仓库根 src/ 的领域核心（@pith/core 物理拆包前的
 *             过渡形态，见 ADR-0005）；运行时依赖（openai/zod/…）externalize 到
 *             desktop/node_modules。
 *   preload — contextBridge。sandbox=false（需要 Node 的 EventEmitter），但仍走
 *             contextIsolation，renderer 只见 window.pith。
 *   renderer— React 三栏应用。设计 token CSS 从 design system 复制（src/renderer/src/theme.css）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
        },
      },
    },
    resolve: {
      // 仓库根 src 的 NodeNext 风格 `./x.js` 相对导入由 Vite 的 .js→.ts 解析兜底
      alias: { '@core': resolve(__dirname, '../src') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    // dev server 端口（默认 5173 易与其它本地服务冲突）；strictPort 避免静默顺延又撞上
    server: { port: 5273, strictPort: true },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
