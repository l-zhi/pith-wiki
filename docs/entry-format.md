# Entry file format

Each entry is a `.md` file with YAML frontmatter, stored at
`<wikiRoot>/<collection>/<id>.md`:

```markdown
---
id: agent-retry
collection: tech
title: Agent retry logic
summary: Common patterns for retrying agent tool calls under failure.
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

# Agent retry logic

- Exponential backoff + jitter, max 3–5 attempts.
- Distinguish transient (network, 429, 5xx) from terminal (4xx schema) errors.
- Only retry idempotent operations.
```

## Field reference

| Field | Type | Meaning |
|---|---|---|
| `id` | string | kebab-case unique identifier (CJK characters allowed); unique within a collection; cross-collection collisions are surfaced by [`doctor`](usage.md#doctor) |
| `collection` | string | Collection name; equals the directory the entry lives in |
| `title` | string | Human-readable title |
| `summary` | string | One-sentence summary; used in `list` / `query` output and retrieval scoring |
| `tags` | string[] | 1–6 tags; factor into retrieval score |
| `links` | string[] | Forward-link ids; back-links are computed lazily in `LibraryService` memory |
| `source` | object | Original source. `type: 'url' \| 'file' \| 'inline' \| 'unknown'`; for `file` the `value` is a local path that `pith-wiki wiki_read_source` can read back |
| `updated` | string | ISO 8601 timestamp; the watcher refreshes this on re-ingest |
| `compressionRatio` | number | `content.length / rawContent.length`; optional, debugging only |
| `subpath` | string | Optional; entry's path within the collection directory (POSIX style) |

The body is plain Markdown — **no restrictions**. During hydration the LLM is
guided toward bullet lists / short paragraphs and `[[concept-id]]`-style link
annotations.

## Design trade-offs

- **Format = standard Markdown + YAML**: edit in Obsidian / VS Code, version
  with Git, no pith-wiki-specific tooling required.
- **Back-links are not persisted**: `LibraryService` scans once at startup,
  caches a `Map<id, {forward, backward}>` in memory, invalidates wholesale on
  any write. Avoids double-write consistency problems.
- **`updated` is not locked**: if you hand-edit, this field doesn't auto-bump.
  To force re-indexing, drop the file into the watcher and let it re-enqueue.

For common format problems `pith-wiki doctor` catches, see
[usage.md#doctor](usage.md#doctor).
