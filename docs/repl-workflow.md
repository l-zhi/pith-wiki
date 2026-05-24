# REPL workflow

> 中文版 → [repl-workflow.zh-CN.md](./repl-workflow.zh-CN.md)

How the REPL, the persistent queue, the watcher, and transcripts compose. In
one sentence: **make hydration-into-the-library a thing that happens by
default — you stop typing commands.**

- [Multi-terminal coordination](#multi-terminal-coordination)
- [Auto transcripts](#auto-transcripts)
- [`/digest` — feed the conversation back into the wiki](#digest--feed-the-conversation-back-into-the-wiki)
- [A typical day-to-day loop](#a-typical-day-to-day-loop)

---

## Multi-terminal coordination

The queue state (`~/.pith-wiki/queue/state.json`) is the **single source of
truth**; the worker holds `state.json.lock` to guarantee **at most one consumer
process at a time**. The pattern:

```bash
# Terminal A: REPL (auto-starts the worker, takes the lock)
pith-wiki

# Terminal B: enqueue any time, no competition for the worker
pith-wiki queue add --collection ... --dir ...
pith-wiki queue status        # check progress whenever you want

# Terminal C: don't start a second worker
pith-wiki queue run           # ❌ "queue is already running (pid=...)"
```

To keep the worker in a separate terminal:

```bash
# Terminal A: REPL, but with the auto-worker disabled
# (QueueIndicator still shows status)
pith-wiki --no-auto-queue

# Terminal B: worker lives here
pith-wiki queue run
```

**Crash recovery**: if the worker dies hard (kill -9 / power loss), any
`running` jobs left in `state.json` are automatically reset to `pending` on the
next `queue run`, with `attempts` preserved. If the lock file's pid no longer
exists, the lock is automatically taken over.

---

## Auto transcripts

The REPL writes every session to
`<wikiRoot>/output/transcripts/<sessionTs>.md`. Putting it under `<wikiRoot>`
is deliberate — it shares the wiki tree's root, but the `transcripts/` subdir
is invisible to `LibraryService`'s collection scan (which only reads
`<wikiRoot>/<collection>/*.md` one level deep; subdirs are ignored).

The content is clean chronological markdown:

```md
# Chat Session 2026-04-30T08:15:32.100Z

- model: `deepseek-chat`
- workspaceRoot: `/Users/.../pith-wiki`
- wikiRoot: `/Users/.../pith-wiki/wiki-data`

---

## 🧑 User · 2026-04-30T08:15:42.500Z

Add everything in inbox to the `reading` queue.

### → tool: wiki_queue_add · 2026-04-30T08:15:43.500Z
```json
{ "collection": "reading", "files": ["..."] }
```

### ✓ tool result: wiki_queue_add
```
{"ok": true, "added": 12}
```

## 🤖 Assistant · 2026-04-30T08:15:45.800Z

Added 12 files to the `reading` queue…

---
```

**Every tool call and result** is preserved — useful for retracing the LLM's
decisions. Written via `appendFileSync` synchronously, so a REPL crash never
loses content. Disable with `--no-transcript` on the command line, or
`"transcriptEnabled": false` in `~/.pith-wiki/config.json`.

---

## `/digest` — feed the conversation back into the wiki

The raw transcript is a verbatim log — no compression, no structure.
`/digest` takes **everything since the last `/reset`** and feeds it to
`HydrationService` (using a dedicated `CONVERSATION_SYSTEM_PROMPT`, not the
document-hydration one), producing a single dense wiki entry under
`<wikiRoot>/<digestCollection>/` (default `output`). From that point on, the
distilled conversation is a first-class entry that `query` / `wiki_query` can
retrieve — next conversation, the LLM can `wiki_query` and pull it back in.
A *write-around-read* feedback loop.

**Conversation mode vs document mode**:
[hydration.ts](../src/wiki/hydration.ts) exposes two prompts. Document mode
(`ingest` / `wiki_ingest` / queue worker) compresses input as source material —
strips first person, drops transition words. **Conversation mode (used by
`/digest`) forcibly preserves the user's framing**: title / summary must
reflect the angle the user asked from, not just summarize the answer.

> Counter-example: user asks about "growth **and the rough patch**"; the
> digest must not flatten it to "growth story" — it must keep "rough patch"
> as the comparison axis the user explicitly chose.

`content` is structured as `## Q: ...` sections in conversational order;
multiple independent topics aren't merged. Tags cover both "the angle the user
asked from" and "the domain of the answer".

```
› /digest                       # default → `output` collection
digesting current conversation into collection "output"…
digest saved: agent-retry-policy (collection=output)
  title: Designing Agent Retry Logic
  tags: agent, retry, reliability
  links: error-handling
  path: /Users/.../wiki-data/output/agent-retry-policy.md

› /digest research-notes        # write to a named collection
› pith-wiki get agent-retry-policy   # confirm what was saved
```

Notes:

- Only user / assistant text and `tool_calls` (name + args) are compressed.
  Raw tool-return byte blobs are excluded — they'd dilute the signal.
- `/digest` doesn't reset the agent; you can keep chatting after digesting.
- Unhappy with the result? `rm <wikiRoot>/<collection>/<id>.md`, or
  `/digest` again for a fresh attempt (may produce a different id).

---

## A typical day-to-day loop

```bash
# 1. Morning: enqueue yesterday's notes
pith-wiki queue add --collection reading --dir ~/Dropbox/notes/inbox

# 2. Open the REPL: chat with the LLM while ingestion runs in the background
pith-wiki
› How many jobs are left?                          # → wiki_queue_status
› Compare PPO and DPO based on my wiki's notes on RLHF.  # → wiki_query
› Add this log snippet to `tech`: <paste>          # → wiki_ingest
                                                   # Worker counts tick along at the bottom
› /digest                         # Distill today's chat back into the wiki

# 3. Quit the REPL (the worker stops; in-flight hydrate is picked up next start
#    via crash-recovery)
› /exit

# 4. Retro: today's full chat lives as markdown in output/transcripts/
ls ~/.pith-wiki/wiki-data/output/transcripts/
```

If you don't want to `queue add` by hand every day,
[configure the watcher](usage.md#directory-watcher) so adds / changes in your
notes folder enqueue automatically and the REPL hydrates them.
