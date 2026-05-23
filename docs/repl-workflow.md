# REPL 工作流

REPL + 持久化队列 + watcher + transcript 配合在一起的玩法。一句话说就是：
**让脱水入库变成默认会发生的事，不用每次手敲命令**。

- [多终端协作](#多终端协作)
- [自动 transcript](#自动-transcript)
- [`/digest` —— 对话回灌 wiki](#digest--对话回灌-wiki)
- [典型 day-to-day 工作流](#典型-day-to-day-工作流)

---

## 多终端协作

队列状态 (`~/.pith-wiki/queue/state.json`) 是**单一真相**；worker 通过
`state.json.lock` 文件保证**同一时刻只有一个进程在消费**。可以这么协作：

```bash
# 终端 A：REPL（自动起 worker，持锁）
pith-wiki

# 终端 B：随时往队列里塞，不抢 worker
pith-wiki queue add --collection ... --dir ...
pith-wiki queue status        # 任何时候看进度都行

# 终端 C：千万别再起 worker
pith-wiki queue run           # ❌ 会报 "queue is already running (pid=...)"
```

如果想把 worker 留在另一个独立终端：

```bash
# 终端 A：REPL，关掉自动 worker（QueueIndicator 仍展示状态）
pith-wiki --no-auto-queue

# 终端 B：worker 在这边
pith-wiki queue run
```

**崩溃恢复**：worker 异常退出（kill -9 / 断电）时，`state.json` 上残留的
`running` job 会在下次 `queue run` 启动时被自动重置为 `pending`，attempts 不变；
锁文件中的 pid 已不存在时也会被自动接管。

---

## 自动 transcript

REPL 默认把每次 session 写到 `<wikiRoot>/output/transcripts/<sessionTs>.md`。
路径选在 `<wikiRoot>` 下是有意为之——和数字化的 wiki 条目共享同一棵树根，
但用 `transcripts/` 子目录屏蔽 `LibraryService` 的 collection 扫描（它只读
`<wikiRoot>/<collection>/*.md` 一层，子目录被忽略）。

内容是规整的 markdown，按时间顺序：

```md
# Chat Session 2026-04-30T08:15:32.100Z

- model: `deepseek-chat`
- workspaceRoot: `/Users/.../pith-wiki`
- wikiRoot: `/Users/.../pith-wiki/wiki-data`

---

## 🧑 User · 2026-04-30T08:15:42.500Z

把 inbox 里的 md 加到 reading 队列

### → tool: wiki_queue_add · 2026-04-30T08:15:43.500Z
```json
{ "collection": "reading", "files": ["..."] }
```

### ✓ tool result: wiki_queue_add
```
{"ok": true, "added": 12}
```

## 🤖 Assistant · 2026-04-30T08:15:45.800Z

已经把 12 个文件加到 reading 队列了…

---
```

每次回合的**所有工具调用与结果**都会保留，方便复盘 LLM 的决策路径。
用 `appendFileSync` 同步落盘——REPL 异常退出也不会丢内容。
关掉：CLI 加 `--no-transcript`，或在 `~/.pith-wiki/config.json` 里
`"transcriptEnabled": false`。

---

## `/digest` —— 对话回灌 wiki

raw transcript 是逐字对话记录，没有压缩、没有结构化。`/digest` 在 REPL 里把
**自上次 `/reset` 起的全部对话**喂给 `HydrationService`（用专门的
`CONVERSATION_SYSTEM_PROMPT`，不是文档脱水那套），产出一条规整的高密度
wiki entry，落到 `<wikiRoot>/<digestCollection>/`（默认 collection 名 `output`）。
从此这条对话的精华就成了可被 `query` / `wiki_query` 检索的正式条目，下次
聊天 LLM 都能用 `wiki_query` 把它捞回来——一个 *write-around-read* 的反馈环。

**Conversation 模式 vs 文档模式**：[hydration.ts](../src/wiki/hydration.ts) 暴露两套
prompt。文档模式（`ingest` / `wiki_ingest` / 队列 worker）把输入当源材料压缩，
丢第一人称、丢转场词。**对话模式（`/digest` 专用）强制保留用户提问的视角**，
title / summary 必须反映用户问的角度而不是仅总结答案：

> 反例：用户问"成长**和低谷期**"，digest 不能笼统压成"成长经历"——
> 必须保留"低谷期"这个用户主动选择的对比维度。

`content` 用 `## Q: ...` 段按对话顺序排列，多个独立话题不被合并；tags 同时覆盖
"用户问的角度"和"答案的领域"。

```
> /digest                       # 默认落到 output collection
digesting current conversation into collection "output"…
digest saved: agent-retry-policy (collection=output)
  title: Agent 重试逻辑设计
  tags: agent, retry, reliability
  links: error-handling
  path: /Users/.../wiki-data/output/agent-retry-policy.md

> /digest research-notes        # 落到指定 collection
> pith-wiki get agent-retry-policy   # 验证保存的内容
```

注意：

- 只压缩 user / assistant 文本和 `tool_calls`（名字 + 参数），原始 tool 返回的
  长 byte-blob 不进 digest，免得稀释。
- digest 不会 reset agent，摘要后还能继续聊。
- 如果对生成结果不满意，直接 `rm <wikiRoot>/<collection>/<id>.md` 即可
  （或重新 `/digest` 让 LLM 再压一遍，可能产出不同 id）。

---

## 典型 day-to-day 工作流

```bash
# 1. 早上：把昨天攒的笔记入队
pith-wiki queue add --collection reading --dir ~/Dropbox/notes/inbox

# 2. 进 REPL：一边跟 LLM 聊，一边后台 ingest
pith-wiki
> 队列还剩多少？                  # → wiki_queue_status
> 帮我看下 wiki 里关于 RLHF 的条目，对比 PPO 和 DPO   # → wiki_query
> 把这段日志加进 tech：<贴日志>   # → wiki_ingest
                                  # 同时底部 worker 数字一直在跳
> /digest                         # 这一轮的精华灌回 wiki，下次能查到

# 3. 退出 REPL（worker 跟着停；在飞 hydrate 下次启动崩溃恢复路径捡回来）
> /exit

# 4. 复盘：output/transcripts/ 里就是今天对话的完整 markdown
ls ~/.pith-wiki/wiki-data/output/transcripts/
```

如果你不想每天手动 `queue add`，[配 watcher](usage.md#目录监听-watcher) 让笔记目录的新增 / 修改
自动入队，REPL 自动消化。
