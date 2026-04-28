# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-04-28

首个脚手架版本。

### Added

- **Ink 富终端 REPL**：`App` / `ChatView` / `InputBox` / `ToolApproval` / `TokenMeter`
  组件，Ctrl+C 双击退出 + 单击取消在飞 LLM 调用，slash 命令 `/help` `/clear`
  `/reset` `/exit`，对话历史持久化到 `~/.llm-wiki/history`。
- **DeepSeek 工具调用循环**（`src/llm/agent.ts`）：OpenAI 风格 function calling，
  串行执行（p-queue），AbortController 注入，错误分类
  （auth / rate_limit / network / model_error / tool_error），429 指数退避自动重试 ≤2 次。
- **6 个 LLM 工具**：`read_file`、`write_file`（沙箱 + 审批）、`list_dir`、
  `wiki_ingest`、`wiki_get`、`wiki_query`。
- **Wiki 三件套核心服务**：
  - `HydrationService` —— 用 DeepSeek JSON 模式把原文压缩成 Entry。
  - `LibraryService` —— 文件 CRUD + 原子写 + 懒加载内存反链索引（正向链接落盘、
    反向计算）。
  - `ContextAssembler` —— tokenize + 加权评分（title × 2、tags × 2、summary × 1、
    content × 0.5）+ top-5 种子 + BFS 1 层链接展开 + token 预算拼接。
- **CLI 子命令**：`ingest --collection ... [--file|--url|stdin]`、`get <id>`、
  `list`、`query "..."`，与 LLM 工具共用同一份 `wiki/*` 实现。
- **路径沙箱**：`workspaceRoot ∪ wikiRoot` 的 realpath 校验，符号链接逃逸拒绝，
  写入审批（`y` / `a` / `n`），`--read-only` 全局禁写，工具回灌 100KB 截断。
- **分层配置**：CLI flag > env > `~/.llm-wiki/config.json` > 默认，zod 校验，
  启动时 fail-fast。
- **测试**：vitest 覆盖 `library` / `assembler` / `safety`，共 16 个用例。
- **文档**：[README](./README.md)、[PRD](./docs/PRD.md)、[架构](./docs/architecture.md)、
  [API](./docs/api.md)、[Roadmap](./docs/roadmap.md)、[PRD-issue](./docs/PRD-issue.md)。

### Known limitations

- 仅 DeepSeek（OpenAI 兼容接口），未抽象多 provider。
- 中文 tokenization 简单按 `\W+` 切分，对中英混合查询精度有限。
- 链接索引每次启动全量扫描，未持久化（适用于 < 1k entry）。
- `[[concept-id]]` 自动建链补全未实现。
- 没有 HTTP REST 接口。

[Unreleased]: https://github.com/l-zhi/llm-wiki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/l-zhi/llm-wiki/releases/tag/v0.1.0
