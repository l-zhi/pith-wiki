# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-05-22

首个开源公开发布版。

### 核心能力

- **多 provider 支持**。`providers` 配置表 + `activeProvider` 选择，配合 CLI
  `--provider`、env `PITH_WIKI_PROVIDER`、REPL `/provider` slash 命令任选一种切换。
  DeepSeek / Qwen DashScope / OpenAI / Moonshot Kimi / Zhipu GLM / OpenRouter /
  Groq / 本地 Ollama 等所有 OpenAI-compatible 服务直接接入。
- **`pith-wiki doctor`**：扫库报问题（坏 frontmatter / 孤儿链接 / 跨 collection
  撞 id / 沙箱外 source 路径 / 悬空 `[[concept-id]]` 标注）。`--json` 输出 +
  非零 exit code，可接 CI / pre-commit。明确只读，不做自动修复。
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
- **agent 工具集**：`read_file` / `write_file`（沙箱 + 审批）/ `list_dir` +
  `wiki_ingest` / `wiki_get` / `wiki_query` / `wiki_list` / `wiki_read_source` +
  `wiki_queue_add` / `wiki_queue_status`。`wiki_list` 浏览索引（不返 content）；
  `wiki_read_source` 读 entry 对应的原始文件。
- **CJK bigram tokenization**。中文查询不返空：pure-中文输入走 2-字符滑窗，
  ASCII 仍走 `\W+`；不引入 jieba / segmentit。
- **持久化 link index** `<wikiRoot>/index.json`。冷启动免去全量 scanAll（500
  entries 大库 80ms → 5ms）。基于 collection 目录 mtime 做新鲜度校验。
- **`additionalReadPaths`**：让 LLM 读项目外的笔记 / 参考资料目录但**不允许写**。
  配置可来自 CLI `--read-path`（可重复）、env `PITH_WIKI_READ_PATHS`（JSON 数组或
  分隔符串）、`config.json`。
- **REPL 命令历史与 ↑/↓ 浏览**。`~/.pith-wiki/history` 加载最近 20 条，进入历史
  自动暂存当前草稿。
- **REPL slash 命令实时提示 + Tab 补全**。打 `/` 立即弹出全部 slash 命令清单，
  按前缀过滤；Tab 触发补全（fish/zsh 风格）。
- **SOUL.md persona overlay**。`~/.pith-wiki/SOUL.md` 或 `<workspaceRoot>/SOUL.md`
  自动加载，内容拼到 system prompt 末尾作为风格层。
- **Hydration JSON 抢救**。模型输出非纯 JSON 时三级降级：直接 parse → 剥 markdown
  fence → 取首 `{` 到末 `}` 子串。失败时把 LLM 原始输出捎到队列 job log 供排错。
- **`/queue` 与 `/dashboard` slash 命令**：REPL 内一键看队列状态 / 重渲染启动信息。
- **REPL 终端零闪烁**。`ChatView` 用 Ink `<Static>` 把已完成消息放到 scrollback；
  动态区永远只占几行，不会全屏重绘。

### 关键设计选择

- **数据集中在 `~/.pith-wiki/`**：wiki / config / history / queue state / transcripts
  全在用户 home 下，不沾染 workspace。多 workspace 默认共享同一份知识库；
  `.env` 也默认从 `~/.pith-wiki/.env` 读取（项目根 `.env` 作为 fallback）。
- **CLI-only**（详见 [ADR-0001](docs/adr/0001-cli-only-no-library-mode.md)）：
  不发 npm 库 entry，避免库消费者拖入 ink/react/commander 等 ~20MB 无用依赖。
  未来真有需求时再拆 `@pith-wiki/core` + `@pith-wiki/cli`。
- **Issue-driven roadmap**（详见 [ADR-0002](docs/adr/0002-issue-driven-roadmap.md)）：
  无版本号无时间表；按 GitHub issue 的 +1 与讨论质量决定优先级。
- **平台支持**（详见 [ADR-0003](docs/adr/0003-windows-best-effort.md)）：
  Linux + macOS 一等公民；Windows best-effort，社区 PR 欢迎。
- **Hydration 模式分双线**：文档模式（`ingest` / `wiki_ingest` / 队列）压缩源材料
  丢第一人称；对话模式（`/digest`）强制保留用户提问视角，title / summary 反映
  问的角度而不仅是答案。
- **Hydration 语言保持原文**：system prompt 显式 "SAME PRIMARY LANGUAGE as input"
  + 400 词 / 600 汉字硬上限 + 压缩比目标（稀疏 ≤ 0.3，稠密 ≤ 0.5）+ id/tags
  强制 kebab-case ASCII。中文原文不会被翻译成英文。
- **CI 矩阵**：ubuntu + macos，Node 20 + 22。

### Security

- [SECURITY.md](SECURITY.md)：GHSA 主报告渠道 + 邮箱备用 + best-effort 响应
  （无 SLA）；明确 in-scope / out-of-scope 威胁面。
- [docs/security-model.md](docs/security-model.md)：内部贡献者文档，记录
  `src/tools/` 的沙箱不变量（realpath / symlink reject / approval flow /
  payload truncation），保护后续重构不打破。

### Documentation

- README 英文 TL;DR + 中文主文 + docs 索引导航。
- [docs/quickstart.md](docs/quickstart.md)：5 分钟从 0 到第一条 entry。
- [docs/usage.md](docs/usage.md)：完整 CLI / REPL / queue / watcher / doctor /
  多 provider 手册。
- [docs/repl-workflow.md](docs/repl-workflow.md)：多终端协作 / transcript /
  `/digest` / 日常工作流。
- [docs/config.md](docs/config.md)：配置字段表 + `additionalReadPaths` + 文件落在哪。
- [docs/entry-format.md](docs/entry-format.md)：词条文件 YAML frontmatter 格式。
- [docs/architecture.md](docs/architecture.md)：三件套核心服务 + 数据流图。
- [docs/roadmap.md](docs/roadmap.md)：Likely next / Maybe someday / 明确不做。
- [docs/config.example.json](docs/config.example.json)：完整多 provider 示例。
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献流程。
- 3 个 ADR：CLI-only / issue-driven roadmap / Windows best-effort。
- issue + PR 模板 + GHSA contact-link 路由。

[Unreleased]: https://github.com/l-zhi/pith-wiki/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/l-zhi/pith-wiki/releases/tag/v0.3.0
