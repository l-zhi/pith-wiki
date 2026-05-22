# 放弃 npm 库出口，单一 CLI 包

**状态**：accepted（2026-05-22）

## 背景

v0.2 时期项目同时维护两种发布形态：CLI（`bin/llm-wiki`）和 npm 库（`import { LibraryService, Agent, defineConfig } from 'llm-wiki'`，五个 subpath 导出）。库定位允许 Electron / VS Code 插件 / Node 后端直接复用核心三服务。

为保护库消费者免受 CLI 依赖污染，仓库里同时维护了：

- `tsconfig.lib.json` + `tsconfig.cli.json` 双分支构建
- `src/index.ts` + `src/wiki/index.ts` + `src/llm/index.ts` 三个公共 barrel
- `scripts/check-no-cli-leak.mjs` lint，挂到 vitest 强校验"核心层不 import ink/react/commander/chalk/dotenv"
- `tests/exports.test.ts` + `tests/library-api.test.ts` 库契约测试

## 决定

开源前去掉库出口，**只发 CLI 包**。`package.json` 移除 `main` / `types` / `exports` / `sideEffects`，只保留 `bin`。删除上述所有为"库 + CLI 双轨"服务的脚手架代码（约 400 行 TS + 442 行 docs/api.md）。

## 为什么

1. **库消费者付出的依赖代价不合理**。`npm install llm-wiki` 会强制拖入 `ink` / `react` / `commander` / `chalk` / `dotenv` / `ink-text-input` / `ink-spinner` 等 CLI-only 依赖，加上传递依赖约 20-30 MB；嵌入 Electron / VS Code 插件场景里这些代码永远不会被执行
2. **当前没有真实库用户**。这是 solo dev 个人项目，库出口是预防性投入而非响应真实需求
3. **维护成本**：双 tsconfig + 双 barrel + 准拆包 lint + 库契约测试占用注意力远超价值
4. **不影响内部架构**：核心三服务（LibraryService / HydrationService / ContextAssembler）的 framework-agnostic 设计仍然保留，将来真有库需求时按 `@llm-wiki/core` + `@llm-wiki/cli` 拆包即可，机械操作

## 后果

- **库消费者**：暂时没有官方支持。如果有强烈需求，开 issue 描述用例后再考虑拆包
- **未来贡献者警示**：看到 `package.json` 没有 `exports` 字段可能会想"补回来"；这是本 ADR 反对的方向。除非有真实库用例，不要重新引入双轨复杂度
- **可逆性**：将来如真有库需求，按 npm workspace 拆 `@llm-wiki/core` + `@llm-wiki/cli`；ADR-0001 届时标 superseded
