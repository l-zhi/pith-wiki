# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-05-22

首个开源公开发布版。从 0.1.0 起的所有内部迭代收口成一个版本。

### Added

- **多 provider 支持**。`providers` 配置表 + `activeProvider` 选择，配合 CLI
  `--provider`、env `LLM_WIKI_PROVIDER`、REPL `/provider` slash 命令任选一种切换。
  DeepSeek / Qwen DashScope / OpenAI / Moonshot Kimi / Zhipu GLM / OpenRouter /
  Groq / 本地 Ollama 等所有 OpenAI-compatible 服务直接接入。
- **`llm-wiki doctor`**：扫库报问题（坏 frontmatter / 孤儿链接 / 跨 collection
  撞 id / 沙箱外 source 路径 / 悬空 `[[concept-id]]` 标注）。`--json` 输出 +
  非零 exit code，可接 CI / pre-commit。明确只读，`--fix` 推到下一版。
- **持久化 ingest 队列**。`queue add` / `status` / `run` / `clear` / `retry`
  子命令族 + REPL `wiki_queue_add` / `wiki_queue_status` 工具。崩溃恢复、跨进程
  锁、指数退避（5s / 30s / 2min）、独立 job 日志。
- **目录监听 watcher**。配 `watchDirs` 之后，往笔记目录（Obsidian vault / inbox
  目录等）添加 `.md` 文件会自动入队 → hydrate → 落盘。支持固定 collection、
  按一级子目录名做 collection、`subdirAlias` 改名映射。
- **`/digest [collection]` slash 命令**。把当前 REPL 对话（自上次 `/reset` 起）
  整理成 wiki entry 入库，对话精华成为可被检索的正式条目。
- **自动 transcripts**。每个 REPL session 落一份 markdown 到
  `<wikiRoot>/output/transcripts/`，按时间顺序记录 user / tool call / tool
  result / assistant；同步写盘，崩溃不丢。
- **REPL 启动时自动起 queue worker**。"聊天 + 后台 ingest" 单进程同时跑；状态栏
  实时显示 `pending / running / done`。CLI `--no-auto-queue` 关。
- **文件转换器子系统**。`.md` / `.txt` / `.pdf`（pdf-parse）/ `.docx`（mammoth）/
  `.html`（turndown）/ `.eml`（mailparser）按扩展名自动选；可被 host 注册自定义。
  转换结果落 `.cache/converters/` sidecar 避免重复解析。`.eml` 在 turndown 前
  先剥 Outlook / Foxmail 的 `<style>` / mso CSS / base64 内嵌图等噪声。
- **批量 ingest**：`--batch <glob>` 和 `--dir <folder>`，带 `--concurrency`、
  429 自动退避、源路径去重；批内 id 冲突自动追加后缀，不静默覆盖。
- **agent 新工具 `wiki_list` / `wiki_read_source`**。`wiki_list` 浏览索引（id /
  title / summary / tags），不返 content；`wiki_read_source` 读 entry 对应的
  原始文件（沿 source.value 或 converter sidecar）。
- **CJK bigram tokenization**。中文查询不再返空。pure-中文输入走 2-字符滑窗，
  ASCII 仍走 `\W+`；不引入 jieba / segmentit。
- **持久化 link index** `<wikiRoot>/index.json`。冷启动免去全量 scanAll（500
  entries 大库 80ms → 5ms）。基于 collection 目录 mtime 做新鲜度校验。
- **`additionalReadPaths`**：让 LLM 读项目外的笔记 / 参考资料目录（笔记库、paper
  归档）但**不允许写**。配置可来自 CLI `--read-path`（可重复）、env
  `LLM_WIKI_READ_PATHS`（JSON 数组或分隔符串）、`config.json`。
- **REPL 命令历史与 ↑/↓ 浏览**。`~/.llm-wiki/history` 加载最近 20 条，进入历史
  自动暂存当前草稿。
- **REPL slash 命令实时提示 + Tab 补全**。打 `/` 立即弹出全部 slash 命令清单，
  按前缀过滤；Tab 触发补全（fish/zsh 风格）。
- **SOUL.md persona overlay**。`~/.llm-wiki/SOUL.md` 或 `<workspaceRoot>/SOUL.md`
  自动加载，内容拼到 system prompt 末尾作为风格层。
- **Hydration JSON 抢救**。模型输出非纯 JSON 时三级降级：直接 parse → 剥 markdown
  fence → 取首 `{` 到末 `}` 子串。失败时把 LLM 原始输出捎到队列 job log 供排错。
- **`/queue` 与 `/dashboard` slash 命令**：REPL 内一键看队列状态 / 重渲染启动信息。

### Changed

- **`wikiRoot` 默认值挪到 `~/.llm-wiki/wiki-data/`**。旧默认是
  `<workspaceRoot>/wiki-data/`，容易被无意提交进项目仓库且多 workspace 无法共享。
  新默认让所有本地数据集中在 `~/.llm-wiki/`。
- **`.env` 默认从 `~/.llm-wiki/.env` 读取**（覆盖项目根 `.env`）。`DEEPSEEK_API_KEY`
  这类跨 workspace 不变的密钥只需放一份在 home。
- **项目改成单一 CLI 包**。不再暴露 `LibraryService` / `Agent` 作为 npm 库 entry
  point（详见 [ADR-0001](docs/adr/0001-cli-only-no-library-mode.md)）。
- **CI 矩阵加 macOS**（之前只跑 ubuntu）；明确 Windows 标 best-effort
  （详见 [ADR-0003](docs/adr/0003-windows-best-effort.md)）。
- **统一 npm，移除 pnpm**。`npm test` / `npm run dev` / `npm run build`。
- **transcript outputDir 挪进 wikiRoot 树**：默认 `<wikiRoot>/output/transcripts/`。
- **新增 lint / format 命令**：`npm run lint`（ESLint）+ `npm run format`（Prettier）。
  保守配置：现有代码 warning 不挂红，新代码不该再加。

### Fixed

- **REPL 终端闪烁**。`ChatView` 把已完成消息放到 Ink `<Static>` 里，渲染一次
  写入 scrollback，永不重绘；动态区永远只占几行。
- **Hydration 语言漂移**：v0.1 的 system prompt 没有"保持源语言"约束，导致中文
  原文被翻译成英文。新 prompt 显式 "SAME PRIMARY LANGUAGE as input" + 400 词 /
  600 汉字硬上限 + 压缩比目标（稀疏 ≤ 0.3，稠密 ≤ 0.5）+ id/tags 强制
  kebab-case ASCII。
- **`/digest` 把对话当单边材料压缩**：用户视角丢失（"成长**和低谷期**" → 笼统"成长经历"）。
  新增 `CONVERSATION_SYSTEM_PROMPT`，硬约束 "PRESERVE THE QUESTION"，按 `## Q:` 段
  保留对话顺序。
- **ingest 源文件路径未做沙箱校验**：`llm-wiki ingest --file /etc/passwd` 之前
  能跳过 `read_file` 沙箱直接读任意系统文件，安全漏洞已修。
- **StatusBar 一系列 bugs**：cursor drift（不止 2 行的 live area 漂走）、repaint
  loop（无限滚回 history）、ink-spinner 触发 stack print（去掉 spinner 解决）。
- **测试隔离**：`tests/config.test.ts` 不再读维护者本机 `~/.llm-wiki/config.json`；
  通过 `LLM_WIKI_CONFIG_PATH` env 把整个文件级 isolation 锁死。
- **队列 ENOENT 源文件 → silent skip**：之前会失败重试 3 次后归 dead，浪费 retry 预算。
- **Hydration id 自愈**：模型偶尔输出包含全角字符 / 下划线的非法 id；只要其它字段
  都过，用 `deriveIdFromFilename` 兜底重 parse，不让 hydration 整条挂掉。
- **commander `--no-cache` 解析**：默认 `cacheConverted: true` 时 `--no-cache`
  正确关掉转换器缓存。

### Security

- **新增 [SECURITY.md](SECURITY.md)**：GHSA 主报告渠道 + 邮箱备用 + best-effort
  响应（无 SLA）；明确 in-scope / out-of-scope 威胁面。
- **新增 [docs/security-model.md](docs/security-model.md)**：内部贡献者文档，记录
  `src/tools/` 的沙箱不变量（realpath / symlink reject / approval flow /
  payload truncation），保护后续重构不打破。

### Documentation

- **README 英文 TL;DR**：开头 80 字英文 hook，方便 HN / Reddit / Lobsters 流量。
- **新增 [docs/quickstart.md](docs/quickstart.md)**：5 分钟从 0 到第一条 entry。
- **新增 [CONTRIBUTING.md](CONTRIBUTING.md)**：setup / 命令 / commit 风格 / PR flow。
- **新增 issue / PR 模板**（`.github/ISSUE_TEMPLATE/`）及 GHSA 路由的 contact links。
- **重写 [docs/roadmap.md](docs/roadmap.md)**：三栏 Likely next / Maybe someday /
  不做，无版本号无时间表（详见 [ADR-0002](docs/adr/0002-issue-driven-roadmap.md)）。
- **3 个 ADR**：CLI-only、issue-driven roadmap、Windows best-effort。
- **新增 [docs/config.example.json](docs/config.example.json)**：完整多 provider
  示例 + watchDirs + queue 配置，可直接 copy 到 `~/.llm-wiki/config.json`。
- **README 加诊断 / 队列 / watcher / `/digest` / transcript 段**；架构图同步更新。

### Removed

- **库模式 / npm package 入口**（详见 ADR-0001）。`src/index.ts` + barrel exports +
  `defineConfig` + `tsconfig.lib.json` 删除。库消费者改装 CLI 直接 `spawn`，或等
  未来真有需求时拆 `@llm-wiki/core` + `@llm-wiki/cli`。
- **pnpm-lock.yaml**：统一用 npm。
- **`scripts/check-no-cli-leak.mjs`** 拆包纪律 lint（已不需要，因为不再分库 / CLI）。
- **`docs/api.md`** 库 API 文档。

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
- **路径沙箱**：`workspaceRoot ∪ wikiRoot` 的 realpath 校验，符号链接逃逸拒绝,
  写入审批（`y` / `a` / `n`），`--read-only` 全局禁写，工具回灌 100KB 截断。
- **分层配置**：CLI flag > env > `~/.llm-wiki/config.json` > 默认，zod 校验，
  启动时 fail-fast。
- **测试**：vitest 覆盖 `library` / `assembler` / `safety`，共 16 个用例。
- **文档**：[README](./README.md)、[PRD](./docs/PRD.md)、[架构](./docs/architecture.md)、
  [Roadmap](./docs/roadmap.md)、[PRD-issue](./docs/PRD-issue.md)。

### Known limitations

- 仅 DeepSeek（OpenAI 兼容接口），未抽象多 provider。
- 中文 tokenization 简单按 `\W+` 切分，对中英混合查询精度有限。
- 链接索引每次启动全量扫描，未持久化（适用于 < 1k entry）。
- `[[concept-id]]` 自动建链补全未实现。
- 没有 HTTP REST 接口。

[Unreleased]: https://github.com/l-zhi/llm-wiki/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/l-zhi/llm-wiki/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/l-zhi/llm-wiki/releases/tag/v0.1.0
