# Architecture

> Companion docs: [PRD](./PRD.md) · [Roadmap](./roadmap.md)

## 1. Layering overview

```
┌──────────────────────────────────────────────────────────┐
│                        Entry (bin/)                       │
│  pith-wiki.ts: commander dispatches → REPL or subcommand  │
└──────────────────────────────────────────────────────────┘
                │                              │
                ▼                              ▼
   ┌────────────────────────┐    ┌────────────────────────┐
   │   src/cli/  (Ink UI)   │    │ src/cli/subcommands.ts │
   │  App.tsx               │    │  ingest / get / list   │
   │  ChatView / InputBox   │    │  / query               │
   │  ToolApproval          │    └────────────────────────┘
   └────────────────────────┘                 │
                │                              │
                ▼                              │
   ┌────────────────────────┐                 │
   │     src/llm/agent.ts   │                 │
   │ chat loop + tool dispatch                │
   └────────────────────────┘                 │
                │                              │
                ▼                              │
   ┌────────────────────────┐                 │
   │      src/tools/*       │                 │
   │ read/write/list_dir    │                 │
   │ wiki_ingest/get/query  │                 │
   └────────────────────────┘                 │
                │                              │
                └──────────────┬───────────────┘
                               ▼
   ┌────────────────────────────────────────────────────┐
   │             src/wiki/  (core services)              │
   │  hydration.ts  ─►  LLM in JSON mode                 │
   │  library.ts    ─►  file CRUD + link index           │
   │  assembler.ts  ─►  tokenize + score + BFS + budget  │
   └────────────────────────────────────────────────────┘
                               │
                               ▼
   ┌────────────────────────────────────────────────────┐
   │   wiki-data/<collection>/<id>.md                    │
   │   (YAML frontmatter + Markdown body)                │
   └────────────────────────────────────────────────────┘
```

## 2. Core data flows

### 2.1 Ingest

```
raw text
   │
   ▼
HydrationService.hydrate()
   │  ├─ inject link candidates (when autoLink=true)
   │  ├─ DeepSeek JSON-mode call
   │  └─ HydrationOutputSchema.parse()
   ▼
Entry object (with metadata)
   │
   ▼
LibraryService.put()
   │  ├─ atomic write: .tmp → rename
   │  └─ invalidate() link index
   ▼
wiki-data/<collection>/<id>.md
```

### 2.2 Query

```
user query string
   │
   ▼
ContextAssembler.query()
   │  ├─ tokenize query
   │  ├─ score every entry (no external index)
   │  ├─ take top-5 seeds
   │  ├─ linkIndex() → BFS depth = 1
   │  └─ pack to token budget
   ▼
{ context: Markdown, referencedEntries: id[] }
```

### 2.3 REPL tool-call loop

```
user input
   │
   ▼
Agent.send()
   │
   ├─► OpenAI.chat.completions.create({ tools, tool_choice: 'auto' })
   │
   ├─► response.tool_calls.length > 0?
   │      ├─ yes: serially exec tools[].handler(), append to messages, loop
   │      └─ no:  append assistant text, break
   │
   └─► onAssistantText / onToolCall / onToolResult / onUsage events
```

## 3. Key modules

### 3.1 LibraryService ([src/wiki/library.ts](../src/wiki/library.ts))

- **Storage layout**: `<wikiRoot>/<collection>/<id>.md`, YAML frontmatter + Markdown body.
- **Link index**: module-level `Map<id, { forward, backward }>`, lazy, invalidated on write.
- **Atomic write**: `fs.writeFileSync(tmp) → fs.renameSync(tmp, target)`; readers never see partial files.
- **macOS quirk**: `/var → /private/var` symlinks normalized via `realpath`.

### 3.2 HydrationService ([src/wiki/hydration.ts](../src/wiki/hydration.ts))

- **Prompt**: inline in the source file; forces Markdown bullets, no fluff, `[[concept-id]]` tagging.
- **JSON mode**: `response_format: { type: 'json_object' }`. **Mutually exclusive with `tools`** on the OpenAI-compatible API.
- **AutoLink**: injects existing entries' `{id, title, summary}` into the prompt as candidate links.
- **Doesn't write to disk**: returns the Entry; the caller decides.

### 3.3 ContextAssembler ([src/wiki/assembler.ts](../src/wiki/assembler.ts))

- **Score formula**: `2 * titleHits + 2 * tagHits + summaryHits + 0.5 * contentHits`.
- **BFS depth = 1**: seed content is guaranteed in; expanded nodes are sorted by seed score.
- **Token budget**: `maxTokens × 4 chars/token × 0.7` — leaves 30% headroom for the rest of the conversation.
- **Truncation**: an entry that alone exceeds the budget is skipped; at least the top seed is preserved.

### 3.4 Agent ([src/llm/agent.ts](../src/llm/agent.ts))

- **Loop condition**: `tool_calls.length > 0`. **Don't trust `finish_reason`.**
- **Serial execution**: p-queue concurrency 1; simplifies error propagation.
- **AbortController**: injected into the OpenAI client; Ctrl+C triggers `abort()`.
- **Error taxonomy**: auth / rate_limit / network / model_error / tool_error.

### 3.5 SafetyLayer ([src/tools/safety.ts](../src/tools/safety.ts))

- **Sandbox roots**: `workspaceRoot ∪ wikiRoot`.
- **Realpath normalization**: for write paths whose parent doesn't exist yet, walk up to the first existing ancestor, realpath that, then re-attach the tail.
- **Symlink rejection**: revalidated after realpath.
- **Payload truncation**: `truncatePayload` for read tools, byte-level cap on what the LLM sees.

## 4. Configuration layer

```
flag (--read-only / --model / --root)
   ▼
env (DEEPSEEK_API_KEY, PITH_WIKI_*)
   ▼
~/.pith-wiki/config.json
   ▼
in-code DEFAULTS
   ▼
zod.parse → Config object (fail-fast at startup on invalid config)
```

## 5. Extension points

| Slot | Interface | Candidate v1+ implementations |
| --- | --- | --- |
| Storage backend | `LibraryService` class | SQLite / Git remote |
| Retrieval algorithm | `ContextAssembler` class | BM25 / embedding hybrid |
| LLM provider | `createClient(config)` | Anthropic / OpenAI / Ollama |
| Tool set | `ALL_TOOLS` array | shell exec / web fetch / git |
| Entry mode | `src/cli/*` | HTTP REST / SDK package |

## 6. Known limitations (v0)

- Single-process read/write; concurrent processes may stale the in-memory index.
- No locking: a user editing in Obsidian while the CLI writes produces last-write-wins.
- Link index scan is O(n); with n > 5000 entries, startup gets slow.
- Tokenization is a naive `\W+` split — unfriendly to Chinese (an entire sentence becomes one token).
