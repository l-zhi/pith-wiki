# 词条文件格式

每个词条是一个带 YAML frontmatter 的 `.md` 文件，路径为
`<wikiRoot>/<collection>/<id>.md`：

```markdown
---
id: agent-retry
collection: tech
title: Agent 重试逻辑
summary: 在失败下重试 agent 工具调用的常见模式。
tags:
  - agent
  - retry
  - reliability
links:
  - error-handling
source:
  type: url
  value: https://...
updated: '2026-04-28T00:00:00.000Z'
compressionRatio: 0.12
---

# Agent 重试逻辑

- 指数退避 + jitter，最多 3-5 次。
- 区分瞬时错误（网络、429、5xx）和终态错误（4xx schema）。
- 只对幂等操作重试。
```

## 字段含义

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | kebab-case 唯一标识（CJK 字符也允许）；同 collection 内唯一，跨 collection 撞名由 [doctor](usage.md#诊断-doctor) 抓出 |
| `collection` | string | 所属 collection 名，等于该词条所在目录 |
| `title` | string | 人类可读标题 |
| `summary` | string | 一句话摘要，用于 list / query 输出和检索召回 |
| `tags` | string[] | 1-6 个标签，参与检索评分 |
| `links` | string[] | 正向链接的 id 列表；反向链接 LibraryService 内存里按需算 |
| `source` | object | 原文出处。`type: 'url' \| 'file' \| 'inline' \| 'unknown'`；`file` 类型的 `value` 是本地路径，`pith-wiki wiki_read_source` 能读回原文 |
| `updated` | string | ISO 8601 时间戳；watcher 改写时更新 |
| `compressionRatio` | number | `content.length / rawContent.length`，可选；调试用 |
| `subpath` | string | 可选；entry 在 collection 目录内的相对子路径（POSIX 风格） |

正文是标准 Markdown body，**没有限制**。LLM 脱水时被引导写成列表 / 短段落 + `[[concept-id]]` 风格的链接标注。

## 设计取舍

- **格式 = 标准 Markdown + YAML**：可以直接用 Obsidian / VS Code 编辑或通过 Git 版本管理，不需要任何 pith-wiki 特定工具
- **反向链接不持久化**：LibraryService 启动时全量扫一次，缓存到内存 `Map<id, {forward, backward}>`，写入时整体失效。避免双写一致性问题
- **`updated` 不锁**：用户手工编辑后这个字段不会自动更新；想触发重新索引扔进 watcher 即可

可被 `pith-wiki doctor` 抓的常见格式问题：见 [usage.md#诊断-doctor](usage.md#诊断-doctor)。
