# Roadmap

> 配套文档：[PRD](./PRD.md) · [架构](./architecture.md) · [API 设计](./api.md)

## 版本节奏

| 版本 | 主题 | 预估时间 | 状态 |
| --- | --- | --- | --- |
| v0.1 | 脚手架：核心三服务 + Ink REPL | — | ✅ 已交付 |
| v0.2 | 易用性补全：诊断、diff 预览、自动建链 | ~2 周 | 🟡 规划中 |
| v0.3 | 多输入源 + 批量处理 | ~3 周 | ⚪ |
| v1.0 | HTTP REST + 多模型 + BM25 | ~2 个月 | ⚪ |
| v2.0 | 可选 embedding 混合检索 + Web UI | ~6 个月 | ⚪ |

---

## v0.1 ✅（已交付）

- Ink 富终端 REPL（Ctrl+C 取消、token 计量、历史持久化）
- DeepSeek 工具调用循环（OpenAI 风格 function calling，串行执行）
- 6 个工具：`read_file`、`write_file`、`list_dir`、`wiki_ingest`、`wiki_get`、`wiki_query`
- 4 个子命令：`ingest`、`get`、`list`、`query`
- 三个核心服务：HydrationService、LibraryService、ContextAssembler
- 路径沙箱 + 写入审批
- 16 个单元测试（library / assembler / safety）
- zod 校验的分层配置

---

## v0.2 🟡（短期）

**主题**：把脚手架打磨到日常顺手能用。

### 必做

- [ ] **`llm-wiki doctor`**：扫描 `wiki-data/`，报告 frontmatter 格式错误、孤儿链接（指向不存在的 id）、重复 id。
- [ ] **写入前 diff 预览**：`write_file` 审批弹窗显示与现有文件的差异（chalk 着色），而不是只显示新内容。
- [ ] **`[[concept-id]]` 自动建链补全**：扫描 `content` 中的 `[[xxx]]` 标记，与 `links` 字段对账并修复。
- [ ] **`/save <name>`、`/load <name>`**：把 REPL 对话保存/恢复到 `~/.llm-wiki/sessions/`。

### 可选

- [ ] **Markdown 渲染**：REPL 内对模型返回的 Markdown 做基本渲染（粗体、列表、代码块）。
- [ ] **`--dry-run`**：`ingest` 子命令仅打印生成的 entry，不落盘。

### 用户故事

> 作为一个用了一周积累 50+ 词条的用户，我想运行 `llm-wiki doctor` 一眼看出哪些条目有问题，并在 REPL 里安全地批量改写。

---

## v0.3 ⚪（中近期）

**主题**：批量处理 + 输入源扩展。

- [ ] **`llm-wiki ingest --batch <pattern>`**：对 glob 匹配的所有文件并发脱水入库（带速率限制）。
- [ ] **URL 抓取**：`--url` 真正发起 HTTP 请求并 readability 提取正文。
- [ ] **PDF 输入**：`--file foo.pdf` 自动文本提取。
- [ ] **`llm-wiki update <id>`**：用新原文重新脱水覆盖旧 entry，保留 backlinks。
- [ ] **`llm-wiki rename <old> <new>`**：改 id 时同步修改所有引用了它的 entry 的 `links` 字段。

---

## v1.0 ⚪（中期）

**主题**：从单机 CLI 走向"可被外部调用的服务"。

### HTTP REST 接口

- [ ] `POST /wiki/ingest`、`GET /wiki/entries/:id`、`POST /wiki/query-context`、`GET /wiki/list`。
- [ ] OpenAPI 3.1 schema 自动生成。
- [ ] 简单的 API key 鉴权。
- [ ] 框架候选：Fastify（更轻）vs Hono（更现代），决策见 [ADR](#待写-adr)。

### 多模型支持

- [ ] 模型 provider 抽象层：DeepSeek / OpenAI / Anthropic / Ollama。
- [ ] 配置层增加 `provider` 字段：`{ provider: 'anthropic', model: 'claude-3-5-sonnet' }`。
- [ ] Hydration 提示词按模型微调（部分模型不支持 JSON mode，用结构化输出 fallback）。

### 检索增强

- [ ] **持久化 link index**：`wiki-data/.index.json`，启动时验证并按需重建。
- [ ] **BM25 评分模式**：作为可选项保留关键词模式作为默认。
- [ ] **同义词字典**：`wiki-data/.synonyms.yml` 支持基本归一化。

### 性能

- [ ] entry 数量上 10k 时启动 < 2s（增量扫描 mtime）。
- [ ] `query` 端到端 < 100ms（在 1k entry 范围内）。

---

## v2.0 ⚪（远期）

**主题**：从"个人玩具"到"小团队工具"。

### 可选 embedding 混合检索

- [ ] 增加 `embedding` 字段到 frontmatter（可选，默认关闭）。
- [ ] 检索流：关键词召回 → embedding rerank → 链接展开。
- [ ] 选 provider：本地 `nomic-embed-text` via Ollama / OpenAI text-embedding-3-small。
- [ ] **不取代关键词模式**：让用户选；混合模式在小库里反而不如纯关键词。

### Web UI

- [ ] React + Tailwind 单页应用，挂在本地 HTTP 服务上。
- [ ] 功能上 = `list` + `get` + `query` 的可视化版，**不取代 CLI/REPL**。
- [ ] 支持图谱视图（基于 forward/backward links）。

### 协作

- [ ] 多用户支持（基本 RBAC）。
- [ ] Git 后端：`wiki-data/` 直接是 Git 仓库，PR 流程审批新词条。
- [ ] 团队 collection 命名空间。

---

## 长期不做

明确放弃的方向：

- ❌ **取代 Notion / Obsidian**：这俩有完整的 GUI 和插件生态，竞争没意义。
- ❌ **AI 自动写作平台**：llm-wiki 是知识库，不是内容生成器。
- ❌ **企业知识库**：合规、SSO、审计这些需求会让架构脱形。
- ❌ **通用 RAG 框架**：哲学不一样；想要通用 RAG 用 LangChain / LlamaIndex。

---

## 决策记录（ADR）

随着版本演进将单独维护：

- [ ] ADR-001: 为什么不用 embedding（v0.1 时记录）
- [ ] ADR-002: 反向链接计算 vs 持久化（v0.1）
- [ ] ADR-003: HTTP 框架选型（Fastify vs Hono，v1.0）
- [ ] ADR-004: 多模型 provider 抽象（v1.0）
- [ ] ADR-005: Embedding 选型与开关策略（v2.0）

---

## 反馈与优先级调整

里程碑顺序会根据真实使用反馈调整。如果你在用：

- **撞到痛点** → 提 issue（暂未配 GitHub），目前在 [PRD §8](./PRD.md#8-风险与开放问题) 维护。
- **想要的功能不在路线图上** → 先评估是否落在"长期不做"清单里；不在的话考虑加进 v0.x。
