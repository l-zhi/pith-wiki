# PRD: llm-wiki — Karpathy-style LLM Wiki CLI

> 由 `/to-prd` skill 从对话上下文综合生成。仓库尚未初始化为 git，故以文档形式落盘
> 而非提交为 GitHub issue。可整体复制为未来 issue 的 body。

## Problem Statement

我每天读大量 paper、blog、会议纪要、Slack 对话、自己的草稿，但这些信息散落在十几个工具里，回头几乎不会看第二眼。我尝试过把原文塞进 RAG + 向量库里，期望检索时找得准，结果是：

- 召回噪声大，回答质量被原文冗长程度拖累。
- chunk → embedding → vector store → rerank 链路重得不成比例，调参难。
- 黑盒：检索出了什么、为什么不命中，看不见也改不动。
- 数据格式被工具锁死，换工具就丢历史。

我需要一个轻量、可控、人类可读、能在终端里 chat 着用的工具，把"知识沉淀"这件事做成日常习惯，而不是项目。

## Solution

一个仿 Claude Code 风格的命令行工具：

- **入口**：在终端打 `llm-wiki` 进入富 REPL；也可以用 `llm-wiki ingest|get|list|query` 子命令脚本化。
- **沉淀**：把任意原文（文件、stdin、对话粘贴）扔给它，它调 LLM 把原文**脱水**成一条高密度 Markdown 词条，落地为带 YAML frontmatter 的 `.md` 文件。
- **存储**：每条词条 = 一个 `.md` 文件，存在 `wiki-data/<collection>/<id>.md`，可以用 Obsidian / VS Code / Git 直接消费，**永远人类可读**。
- **检索**：不用 embedding，靠关键词 + 标签 + 链接 BFS 就能装配出可直接喂给任意 LLM 的上下文块。
- **聊**：REPL 里模型可以调用 6 个工具读写文件、查/存 wiki，整个过程沙箱在工作目录内，写入需审批。

哲学：**数据工程优于检索算法**。写入时即处理，让库里每一行都是高价值的，检索就不需要花哨。

## User Stories

### 入库与脱水

1. As a researcher, I want to pipe a long article into the CLI and get a compressed Markdown entry, so that I can save the durable insights without keeping the verbose original.
2. As a developer, I want to point the ingest command at a file path, so that I can sweep my notes folder into the wiki in one shot.
3. As a user, I want hydration to use a JSON-strict LLM mode, so that the parsed entry is reliably structured (id, title, summary, tags, links, content).
4. As a user, I want the hydrator to enforce kebab-case slugs, so that filenames and cross-references stay consistent.
5. As a user, I want a compression ratio reported after each ingest, so that I can sense-check whether the hydrator was aggressive enough.
6. As a user, I want to mark the source of an entry as a URL, file, or inline paste, so that I can later trace where the knowledge came from.
7. As a user, I want auto-link to inject existing entry titles/summaries into the hydration prompt, so that new entries cross-reference my prior knowledge instead of growing as orphans.
8. As a user, I want to disable auto-link with a flag, so that I can ingest fast without the LLM having to consider candidates.
9. As a user, I want hydration to produce Markdown with bullet lists and `[[concept-id]]` cross-refs, so that the body is dense and link-aware.

### 检索与上下文装配

10. As a user, I want to query my wiki in natural language without an LLM call, so that I can get the assembled Markdown context cheaply and locally.
11. As a user, I want title and tag matches to outweigh content matches, so that high-signal hits float to the top.
12. As a user, I want the assembler to expand one hop along forward links from each seed, so that related context shows up automatically.
13. As a user, I want the assembled context capped to a token budget with 30% headroom, so that I can paste it into another LLM without overflow.
14. As a user, I want referenced entry ids returned alongside the context, so that I can audit what got included.
15. As a user, I want backlinks computed lazily from a memory index, so that link integrity isn't a double-write problem.

### 库管理（CRUD）

16. As a user, I want to list all entries or filter by collection, so that I can browse what I've sunk in.
17. As a user, I want to fetch a single entry's full frontmatter and body, so that I can review or copy it.
18. As a user, I want my entry files to be plain Markdown with YAML frontmatter, so that I can hand-edit them in Obsidian or VS Code.
19. As a user, I want writes to be atomic (`.tmp` + rename), so that an interrupted write never leaves a half file.
20. As a user, I want collections to be folders, so that there's no separate registry to maintain.
21. As a user, I want to delete an entry, so that obsolete knowledge doesn't pollute retrieval.

### REPL 体验

22. As a user, I want a Claude-Code-style REPL with rich terminal UI, so that long sessions feel native.
23. As a user, I want the model to autonomously call tools (read/write files, query wiki), so that I don't have to switch modes.
24. As a user, I want my first Ctrl+C to cancel the in-flight LLM call without exiting, so that runaway responses don't kill my session.
25. As a user, I want a second Ctrl+C within 1.5s to exit, so that I can leave quickly when I want to.
26. As a user, I want slash commands `/help`, `/clear`, `/reset`, `/exit`, so that I can manage the session without leaving the prompt.
27. As a user, I want a token meter showing cumulative input/output tokens, so that I can keep an eye on cost.
28. As a user, I want command history persisted across sessions, so that I don't have to retype prompts.
29. As a user, I want the model to stream its final reply, so that I see progress on long answers.
30. As a user, I want each tool call printed inline with its name and a result preview, so that I can see what the agent did.

### 安全与权限

31. As a user, I want all file paths sandboxed to my workspace and wiki roots, so that the LLM can't write to `/etc` or read sensitive files outside the project.
32. As a user, I want write operations to require approval the first time a path is used, so that I'm always in the loop.
33. As a user, I want to grant "always-allow" for a path within a session, so that repeated edits don't get fatiguing.
34. As a user, I want a `--read-only` global flag, so that I can run the agent against unfamiliar codebases safely.
35. As a user, I want symlinks evaluated through realpath and rejected if they escape the sandbox, so that link traversal can't smuggle paths.
36. As a user, I want oversized tool payloads truncated to 100KB before being fed to the LLM, so that one `read_file` doesn't blow my context window.

### 子命令（脚本化）

37. As a developer, I want `ingest`, `get`, `list`, `query` subcommands callable from shell scripts, so that I can automate batch sinking.
38. As a developer, I want subcommands that don't call the LLM (`get`, `list`, `query`) to work without an API key, so that I can use them in CI or air-gapped contexts.
39. As a developer, I want to ingest from stdin pipes, so that I can chain `curl ... | llm-wiki ingest`.

### 配置

40. As a user, I want config layered as flag > env > file > defaults, so that I can override per-command without rewriting my config file.
41. As a user, I want zod-validated config with fail-fast at startup, so that misconfiguration is caught before any expensive work.
42. As a user, I want to override the model name and storage root via flags, so that I can keep multiple wikis or experiment with models.

### 错误与可观测

43. As a user, I want errors classified (auth/rate-limit/network/model_error/tool_error), so that messages are actionable.
44. As a user, I want rate-limit errors auto-retried with exponential backoff at most twice, so that transient throttling doesn't break my flow.
45. As a user, I want missing API key reported at startup with a clear remediation, so that I know exactly what to fix.

### 集成

46. As a developer, I want to import the wiki services from another Node project, so that I can reuse hydration/library/assembler outside this CLI.
47. As a contributor, I want unit tests covering library, assembler, and safety, so that refactors are safe.

## Implementation Decisions

### 模块拆分（核心 deep modules）

- **HydrationService** — 输入 raw + collection + autoLink，输出 Entry。封装 LLM 调用、JSON 模式、提示词、zod 验证、压缩比计算。**深模块**：单一公开方法 `hydrate(input)`，背后扛住所有 LLM 兼容性细节。
- **LibraryService** — 文件系统 CRUD + 链接索引。公开方法：`get / put / delete / list / linkIndex / invalidate`。**深模块**：屏蔽原子写、frontmatter 序列化、懒索引构建、macOS realpath 兼容性等所有持久化细节，调用方只看到一个 Entry-domain 接口。
- **ContextAssembler** — 输入查询字符串 + token 预算，输出 `{context, referencedEntries}`。封装 tokenize、评分、BFS、预算装配。**深模块**：从外部看就是 `query(text, maxTokens)`，内部演进到 BM25 或 embedding 时不改接口。
- **SafetyLayer** — `resolveSafePath(input, kind, opts)` + `truncatePayload`。公开两个纯函数，不持有状态。**深模块**：所有沙箱逻辑、symlink 处理、不存在路径的攀升 realpath、payload 截断都在内部。
- **Agent** — 公开 `send(userMessage, opts)` 与 `reset()`，内部维护 messages 数组、循环、tool 分发、AbortController。**深模块**：DeepSeek 工具调用循环的所有 quirks（loop 条件、JSON 模式互斥、串行执行、错误分类）都封装在内。

### 表层模块（thin shells）

- **Tool wrappers** —— `read_file` / `write_file` / `list_dir` / `wiki_ingest` / `wiki_get` / `wiki_query`：每个仅声明 zod 参数 schema 和 handler，handler 直接调用上面的 deep module。这种"参数声明 + 一行调用"的薄壳是有意为之，让工具集合可以被 LLM 通过 function calling 调用。
- **CLI 子命令注册器** —— commander 把 `ingest/get/list/query` 注册到 program，每个 action 也是薄壳调用 deep module。
- **Ink REPL 组件** —— `App` / `ChatView` / `InputBox` / `ToolApproval` / `TokenMeter`。React 风格的视图，状态全在 `App`，子组件无副作用。

### 关键架构决策

- **正向链接持久化在 frontmatter，反向链接不落盘** —— 反链通过懒加载的内存索引在读时计算，写入触发 invalidate。避免双写一致性问题（特别是 LLM 通过 `write_file` 直接编辑 entry 时）。
- **HydrationService 与工具调用互斥** —— DeepSeek 已知问题：`response_format: json_object` 与 `tools` 同时指定时会丢 `tool_calls`。Hydration 用 JSON 模式但**不带工具**；REPL agent 带工具但**不开** JSON 模式。
- **LLM 循环条件 = `tool_calls.length > 0`** —— 不信任 `finish_reason`（DeepSeek 偶尔返回 `stop` 同时附带非空 `tool_calls`）。
- **工具调用串行执行** —— 通过 `p-queue concurrency=1`。正确性优先，简化错误路径与回填顺序。
- **流式仅用于无工具调用的最终回答** —— streaming 与 tool_calls deltas 共存时碎片拼接复杂；v0 简化：本轮可能产生工具调用时禁用 stream，纯文本回答时启用。
- **配置优先级**：CLI flag > env > `~/.llm-wiki/config.json` > 内置默认。zod 校验合并后的对象，启动时 fail-fast。
- **API Key 仅在需要 LLM 的路径上强制** —— `list/get/query` 子命令不需要 key。

### 数据契约

- **Entry**：`{ id, collection, title, summary, tags[], links[], content, source: {type, value?}, updated (ISO), compressionRatio? }`。
- **id** 必须匹配 `^[a-z0-9][a-z0-9-]*$`（kebab-case slug，等同于文件名）。
- **collection** 等于子目录名；新建 collection = 新建子目录。
- **source.type** 枚举：`url | file | inline | unknown`。
- **HydrationOutput**（LLM 返回）= Entry 的子集（不含 source/updated/compressionRatio），其余字段由 HydrationService 填充。

### 接口契约（CLI）

- `llm-wiki`（默认）→ Ink REPL。
- `llm-wiki ingest --collection <c> [--file|--url|-] [--no-auto-link]`。
- `llm-wiki get <id> [--collection <c>]`。
- `llm-wiki list [--collection <c>]`。
- `llm-wiki query <text> [--max-tokens <n>]`。
- 全局 flag：`--read-only` / `--model <name>` / `--root <dir>` / `-V` / `-h`。

### 接口契约（LLM 工具）

工具集合通过 OpenAI 风格 function calling 暴露。每个工具的参数都是 zod schema，handler 接收 parsed 参数 + ToolContext。手写最小 zodToJsonSchema 转换器（仅支持 string/number/boolean/array/enum/optional/default/object）—— 不引入 `zod-to-json-schema` 依赖。

### 安全

- 路径硬沙箱：所有 read/write/list 经 `resolveSafePath`，必须落在 `workspaceRoot ∪ wikiRoot` 之内（realpath 后比较）。
- 写入审批：首次写入路径触发 `[y/N/a]` 弹窗；`a` 加入 session allowlist。
- `--read-only`：所有写工具直接拒绝。
- Tool payload truncation：读结果超过 `maxToolPayloadBytes`（默认 100KB）时尾部追加 `…[truncated N bytes]`。

### 错误处理

- 错误分类：`auth (401/403) | rate_limit (429) | network (5xx, ECONN, fetch) | model_error | tool_error | unknown`。
- 401/403 立即报告（不重试）。
- 429 / 5xx 指数退避自动重试 ≤ 2 次。
- 工具内部错误捕获后以 `{ ok: false, error }` 回灌给 LLM，让模型继续推理而不是终止循环。

## Testing Decisions

### 测试哲学

- **只测外部行为，不测实现细节。** 比如 LibraryService 的测试断言"put 后 get 拿得到、删除后 get 拿不到、改了 forward links 反向索引会变"——而不是断言"内部 `entryCache` 的 size 等于 N"。
- **每个 deep module 独立测试**：用 `tmpdir` 隔离文件系统副作用，每个测试 setup/teardown 自己的临时目录，避免共享状态。
- **不 mock LLM**：HydrationService 和 Agent 是 integration-level，v0 不写单元测试（要么真实调 LLM 要么 mock 整个 OpenAI client，两者都不算单元测试）。改为靠手工验收。
- **不测 Ink 组件**：Ink 的渲染需要 PTY mock，性价比低；UI 通过手工烟测覆盖。

### 模块覆盖

| 模块 | 测试 | 关键场景 |
| --- | --- | --- |
| LibraryService | ✅ | put/get round-trip、reverse-link 计算与失效、按 collection 过滤、delete |
| ContextAssembler | ✅ | 空查询返回空、title 命中权重高于 content、forward link BFS 1 层、token 预算截断 |
| SafetyLayer | ✅ | 工作区内路径接受、wiki root 内路径接受、外部路径拒绝、symlink 逃逸拒绝、readOnly 拒绝写、不存在路径的写允许 |
| HydrationService | ❌ | 需要 LLM；通过 `ingest` 子命令手工验收 |
| Agent | ❌ | 需要 LLM；通过 REPL 手工验收 |
| Ink 组件 | ❌ | 通过 `llm-wiki` 启动手工验收 |

### 工具与约定

- **vitest**（一次性 + watch 模式）；项目已配置 `npm test` 与 `npm run test:watch`。
- **Prior art / 模式**：每个测试文件 `beforeEach` 创建 `mkdtempSync` tmpdir，`afterEach` `rmSync(..., {recursive, force})`。库实例直接 new、不走 DI 容器，因为构造函数本身就是简单依赖注入。
- **冒烟测试**：`npm run build && node dist/bin/llm-wiki.js --help` 手动跑一次确认入口可执行；这一项不进 vitest 因为属于打包级验证。

## Out of Scope

- **Embeddings / 向量库 / BM25** —— v0 明确不做；v1.0 才考虑可选 BM25，v2.0 才考虑混合 embedding。
- **HTTP REST 接口** —— v0 仅 CLI + SDK；v1.0 计划。
- **多模型 provider 抽象** —— v0 锁定 DeepSeek（OpenAI 兼容接口）；v1.0 才扩到 OpenAI / Anthropic / Ollama。
- **多用户、权限、SSO、审计** —— 单用户单机，永久不做企业向。
- **Web UI** —— v0 没 GUI；v2.0 才考虑作为查看器，**不取代** CLI/REPL。
- **PDF / URL 自动抓取** —— `--url` 仅作为 source 标记，不发起 HTTP 请求；用户需自行 `curl | llm-wiki ingest`。
- **并发 tool_calls 执行** —— v0 串行；v1+ 才评估，错误传播很难做对。
- **写入前 diff 预览** —— v0.2 计划，v0 仅显示新内容前 400 字。
- **`/save` `/load` 会话快照** —— v0.2 计划。
- **持久化链接索引** —— v0 启动时全量扫描，v1 才落盘 `.index.json`。
- **`[[concept-id]]` 自动建链补全** —— v0.2 计划。
- **`llm-wiki doctor` 诊断子命令** —— v0.2 计划。
- **多语言（中文）tokenization 优化** —— v0 简单 `\W+` 切分，中英混合查询精度有限；v1+ 接 jieba 之类的分词器。

## Further Notes

### 已知的实现踩坑（实施过程中遇到的，留档供未来重构参考）

- **gray-matter 把 YAML 日期反解析成 JS `Date`**：从 `.md` 读回时需要把 `Date` 对象 `toISOString()` 后再交给 zod 校验，否则 schema（要求 string）会失败。
- **macOS `/var` → `/private/var` 软链接**：sandbox 校验时如果只 realpath 待校验路径而不 realpath roots，会误判越界。修复：root 也要走 realpath，比较时用 realpath 后的版本。
- **不存在的写目标**：`fs.realpathSync` 在路径不存在时抛错。需要"沿目录树向上找已存在的根，再 realpath，再拼回缺失尾部"——避免新建子目录的写入被误拒。
- **zod 泛型协变**：`ToolDef<typeof params>[]` 不能直接收纳到 `ToolDef<ZodTypeAny>[]`。v0 用 `ToolDef<any>` 别名规避，未来 v1 重构时考虑用 `ToolDef<z.ZodType>` 配合更严的内部转换器。
- **YAML 不能 dump `undefined`**：`matter.stringify` 在 frontmatter 含 undefined 字段时报 `unacceptable kind of an object to dump`。put 与 get 都要先 `Object.fromEntries(Object.entries(x).filter(([,v]) => v !== undefined))` 过滤。

### DeepSeek 兼容性总结

- ✅ OpenAI 风格 chat completions / tools / tool_calls 在 `deepseek-chat` 上工作。
- ✅ `response_format: json_object` 工作。
- ❌ JSON mode + tools **不能同时使用**，会丢 tool_calls。
- ⚠️ `tool_choice: "required"` 表现不一致，**仅用 `"auto"`**。
- ⚠️ Streaming + tool_calls：deltas 碎片化复杂；v0 简化为只在最终回答时流式。
- ⚠️ 偶尔 `finish_reason: "stop"` 与非空 `tool_calls` 共存——以 `tool_calls.length` 为准。

### 相关文档

- 完整产品规格视角的 PRD：[docs/PRD.md](./PRD.md)
- 架构设计：[docs/architecture.md](./architecture.md)
- API 与 CLI 契约：[docs/api.md](./api.md)
- Roadmap：[docs/roadmap.md](./roadmap.md)
- 项目根 README：[README.md](../README.md)
