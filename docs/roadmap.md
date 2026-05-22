# Roadmap

llm-wiki 是 solo dev 维护的开源工具，**没有承诺过的时间表**。

按 [issue](https://github.com/l-zhi/llm-wiki/issues) 上的 reaction count 与
讨论质量决定优先级。本文件分三栏：**Likely next**（短期内可能动手）、
**Maybe someday**（中长期，等真实信号）、**明确不做**（避免 scope creep）。

> 决策机制详见 [ADR-0002](adr/0002-issue-driven-roadmap.md)。

---

## Likely next

短期内可能进入下一个 minor 版本的方向。如果你想推动其中某条，去对应 issue
+1，或开 issue 描述你的具体用例 —— 真实需求会被优先做。

| 主题 | 一句话 | tracking issue |
|---|---|---|
| URL 抓取 | `--url` 真正发 HTTP 拉网页，配 readability 提取正文（目前仅做 source 字段标记） | _未开 — 想推请开 issue_ |
| `llm-wiki update <id>` | 用新原文重新脱水覆盖旧 entry，保留 backlinks | _未开_ |
| `llm-wiki rename <old> <new>` | 改 id 时同步修改所有 `links:` 字段里的引用 | _未开_ |
| `[[concept-id]]` 自动建链补全 | 扫描正文里的 `[[xxx]]` 标记，与 `links` 字段对账并自动补齐（目前由 `doctor` 仅报错不修） | _未开_ |
| `/save <name>` / `/load <name>` | REPL 对话存档与恢复 | _未开_ |
| `doctor --fix` | 当前的 `doctor` 只读；增加自动修复模式（per-problem 审批，沿用 `write_file` 的 `[y/N/a]`） | _未开_ |

> 这些是维护者觉得"最可能下一步动手"的方向，但**没有承诺时间**。等
> 真有 issue 讨论 / +1 / 用户 PR 出现，再确定哪个先做。

---

## Maybe someday

长期方向。一般不主动做，除非用户用真实场景驱动 —— 解释下为什么这么保守：

### HTTP REST 接口

让 llm-wiki 能被远程服务调用（VS Code 插件 / Web 前端 / 其它语言客户端）。
设计上不难（Fastify / Hono 套一层），但**会改变项目定位**：从"个人 CLI"
变成"可部署服务"，工程量翻倍（鉴权、TLS、并发、日志、监控）。

**触发条件**：有人明确说"我要在 X 用例里远程调用 llm-wiki"且讨论清楚需求。

### BM25 评分模式

当前检索是 `2*title + 2*tags + summary + 0.5*content` 的关键词加权 + BFS 链接
展开。BM25 在大库（5000+ entries）下精度更好。

**触发条件**：有人用 1k+ entries 报告检索精度问题，且 issue 里能给出
"BM25 会改善哪条具体 query"的反例。

### 同义词字典

`<wikiRoot>/.synonyms.yml`，把"agent / 智能体 / agent loop"归到一组。tokenize
阶段做替换。

**触发条件**：BM25 之后还没解决精度问题；或中英混合检索有人报告卡顿。

### Embedding 混合检索（明确克制）

向量检索 + 关键词 + 链接遍历的三路合并。但项目哲学（PRD §1.2）明确是
"脱水到 Markdown 后关键词足够"——加 embedding 等于自打嘴巴。

**触发条件**：用户用真实库（不是 toy demo）证明"关键词怎么调都查不准这条"，
且 embedding 能查到。不是"理论上更好"的论证。

### Web UI（不取代 CLI）

只读的 entry 浏览器 + 图谱视图，挂在本地 HTTP 服务上。**不**做编辑（编辑去
Obsidian / VS Code）、**不**做 chat（chat 去 REPL）。

**触发条件**：图谱视图是个真实需求被反复提到 ≥3 次。

### 团队协作

多用户 RBAC、Git 后端、collection 命名空间。会让整个架构脱形（v0 是单机
单用户文件系统模型）。

**触发条件**：有团队场景的具体提案，且作者愿意维护这部分长期功能。

---

## 明确不做（Won't do）

不会接受这类方向的 PR，避免 scope creep 浪费贡献者时间：

- ❌ **取代 Notion / Obsidian** —— 它们有完整 GUI + 插件生态，没法竞争，
  也不该竞争。llm-wiki 跟 Obsidian 是**互补**（Obsidian 编辑 + llm-wiki 脱水检索）。
- ❌ **AI 自动写作平台** —— llm-wiki 是知识库，不是内容生成器。
- ❌ **企业知识库** —— 合规、SSO、审计这些需求会让架构脱形。
- ❌ **通用 RAG 框架** —— 项目哲学跟"通用 RAG"反着来。要通用 RAG 用
  LangChain / LlamaIndex。
- ❌ **GUI 客户端** —— Electron / Tauri 客户端，跨平台维护成本太高，没收益。
- ❌ **多语言 SDK** —— Python / Go / Rust 客户端。CLI + 持久化文件格式
  足够当跨语言协议；想要语言 binding 直接 fork。

---

## 想推动某个方向？

[开 issue](https://github.com/l-zhi/llm-wiki/issues/new?template=feature.md) 描述：

- 你的具体用例（不是"功能上更全"）
- 现在的 workaround 和它的痛点
- 提议的 CLI / API 形态

或者，在已有 issue 上 +1 + 留言补充你的场景 —— 真实信号会被优先做。

[Bug reports](https://github.com/l-zhi/llm-wiki/issues/new?template=bug.md) 永远走快道。
