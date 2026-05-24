# Usage

> 中文版 → [usage.zh-CN.md](./usage.zh-CN.md)

Detailed CLI commands, REPL usage, and per-subsystem toggles. New users should
read [quickstart](quickstart.md) first; come back here to look up specific
commands.

- [Initialize (`init`)](#initialize-init)
- [REPL](#repl)
- [Synchronous ingest](#synchronous-ingest)
- [Persistent queue](#persistent-queue)
- [Directory watcher](#directory-watcher)
- [Retrieval](#retrieval)
- [Doctor](#doctor)
- [Switching providers](#switching-providers)
- [Global flags](#global-flags)

---

## Initialize (`init`)

One-shot setup of `~/.pith-wiki/`: create the directory, write a minimal `.env`,
optionally write a `config.json`, `chmod 600` the secret. **Run this once after install.**

Interactive (default when stdin is a TTY):

```bash
pith-wiki init
# Prompts you for: provider (1–5) → API key → watch directory → initial scan?
# Press Enter on any step to skip / accept the default.
```

Non-interactive (CI / scripted):

```bash
pith-wiki init --provider deepseek \
               --api-key sk-xxxxxxxxxxxxxxxx \
               --watch-dir ~/Obsidian \
               --no-prompt
```

Flags:

| Flag | Effect |
|---|---|
| `--force` | Overwrite existing `.env` / `config.json` (each backed up to `.pre-init.bak`). |
| `--provider <id>` | Skip the provider picker. One of: `deepseek`, `openai`, `openrouter`, `qwen`, `kimi`. |
| `--api-key <key>` | Inline the API key into `.env`'s `<PROVIDER>_API_KEY=` line. |
| `--watch-dir <path>` | Set the auto-watch directory (also added to `additionalReadPaths`). `~/` expands. |
| `--no-initial-scan` | With `--watch-dir`: don't sweep existing files on first REPL start. |
| `--no-prompt` | Skip interactive prompts even on a TTY. Use defaults + whatever flags you passed. |

Behaviour:

- **Idempotent**: refuses to overwrite an existing `.env` / `config.json` (exit 1).
- **`--force`**: backs each file up to `*.pre-init.bak`, then overwrites.
- **Minimal `.env`**: just `<PROVIDER>_API_KEY=<value>` plus one comment line.
- **Conditional `config.json`**: only written when you pick a non-default
  provider, or set a watch directory. Default (`deepseek`, no watch) → no
  `config.json` at all; defaults take over.

For all 5 supported providers, see [Switching providers](#switching-providers) below.

---

## REPL

The interactive REPL (Ink-based terminal UI):

```bash
pith-wiki                  # after global install
# or from source:
npm run dev
```

One REPL process does **three things at once**:

1. You chat with the LLM (agent calls tools).
2. A persistent queue worker picks up `pending` jobs in the background.
3. Every turn is logged to `output/<sessionTs>.md` as a markdown transcript.

A bottom-line dashboard shows live queue status:

```
queue: worker · 3 pending · 1 running · 12 done
```

Slash commands inside the REPL:

| Command | Effect |
|---|---|
| `/help` | Show help. |
| `/clear` | Clear screen only (agent context preserved). |
| `/reset` | Wipe agent conversation context (subsequent `/digest` only sees post-reset content). |
| `/transcript` | Print the path to this session's markdown transcript. |
| `/digest [collection]` | Distill the current conversation (since the last `/reset`) into a wiki entry under `<wikiRoot>/<collection>/`. Defaults to `digestCollection` (default `output`). |
| `/queue` | Show current queue status. |
| `/dashboard` | Re-render the startup dashboard. |
| `/provider [name]` | List / switch providers (see [Switching providers](#switching-providers)). |
| `/exit` | Quit the REPL. |

`Ctrl+C` once cancels the in-flight LLM request; press it twice to quit.

Startup flags:

| Flag | Effect |
|---|---|
| `--no-auto-queue` | Don't start the background worker (just show status; don't take the lock). |
| `--no-auto-watch` | Don't start the watcher (just display, no monitoring). |
| `--no-transcript` | Don't write the session's markdown transcript. |

Subcommands (scripted or manual) below.

---

## Synchronous ingest

```bash
# Single file (converter auto-picked by extension: .md/.txt/.pdf/.docx/.html/.eml)
pith-wiki ingest --collection tech --file ./paper.md
pith-wiki ingest --collection tech --file ./paper.pdf      # pdf-parse
pith-wiki ingest --collection tech --file ./report.docx    # mammoth

# Or from stdin (skips the converter, feeds straight to the hydrator)
cat paper.md | pith-wiki ingest --collection tech

# Batch: glob (fast-glob syntax)
pith-wiki ingest --collection tech --batch 'papers/**/*.md'

# Batch: recurse a directory (any registered extension is picked up)
pith-wiki ingest --collection tech --dir ./papers/
# Defaults: concurrency 3, automatic 429 backoff, skips already-ingested sources.
# Use --force to re-hydrate and overwrite.
pith-wiki ingest --collection tech --dir ./papers/ --force --concurrency 5

# Force a specific converter (bypass extension matching); --no-cache for debugging
pith-wiki ingest --collection tech --file ./readme.unknown --converter markdown-passthrough
pith-wiki ingest --collection tech --file ./paper.pdf --no-cache

# List all registered converters (including host extensions)
pith-wiki converters
```

---

## Persistent queue

Async ingest: interruptible, progress-queryable, retries with backoff. A file
lock ensures only one process consumes the queue at a time.

```bash
# Enqueue without processing immediately. deriveJobId is based on path+collection,
# so re-adding the same source is a no-op.
pith-wiki queue add --collection reading --file ./paper.md
pith-wiki queue add --collection reading --batch 'inbox/**/*.md'
pith-wiki queue add --collection reading --dir ~/notes/inbox      # needs --read-path
pith-wiki queue add --collection reading --dir ~/notes/inbox --force  # re-ingest

# Run a foreground worker (takes the lock; Ctrl+C exits cleanly and resumes later)
pith-wiki queue run
pith-wiki queue run --concurrency 4   # temporarily override queueConcurrency

# Check progress at any time (lock-free; coexists with the worker)
pith-wiki queue status                # human-readable: counts + running + last 10 events
pith-wiki queue status --json | jq '.counts'

# Failed jobs: each one retries up to maxAttempts (default 3, with 5s/30s/2min backoff);
# after that it's archived as `dead` for manual reset.
pith-wiki queue retry <jobId> ...     # reset specific job ids
pith-wiki queue retry --all-dead      # reset all dead

# Cleanup (does not delete log files)
pith-wiki queue clear                 # default: completed
pith-wiki queue clear --dead
pith-wiki queue clear --all           # includes pending! Use with care.
```

The REPL exposes the same operations as tools (`wiki_queue_add` /
`wiki_queue_status`) — just ask the LLM in plain English:

```
> Add everything under ~/notes/inbox/ to the `reading` collection's queue.
> What's still pending in the queue? Anything stuck?
```

For multi-worker coordination and crash recovery details, see
[docs/repl-workflow.md](repl-workflow.md#multi-terminal-coordination).

---

## Directory watcher

Don't want to `queue add` by hand every time? Configure `watchDirs` to have
chokidar monitor a folder of notes; add/change events auto-enqueue, the worker
hydrates them. In `~/.pith-wiki/config.json`:

```jsonc
{
  "watchDirs": [
    {
      "path": "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyVault",
      "collectionFromSubdir": true,
      "fallbackCollection": "inbox",
      "initialScan": true
    }
  ],
  "additionalReadPaths": [
    "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyVault"
  ]
}
```

(Running `pith-wiki init --watch-dir <path>` writes both `watchDirs[]` and
`additionalReadPaths` for you.)

Start `pith-wiki`; the REPL's dashboard shows `watch N`. Drop `work/notes.md`
into the vault and it lands at `<wikiRoot>/work/<id>.md`.

Key points:

- **Collection resolution**: `collectionFromSubdir: true` means the first-level
  subdir name is the collection. Chinese/English/mixed directory names all work
  (`工作/`, `tech/` both fine). Deeper subdirs all roll up to the first level.
  Files dropped directly into the watch root → `fallbackCollection`.
- **Renaming**: to map a Chinese directory to a URL-friendly English collection,
  use `subdirAlias`:
  ```jsonc
  { "subdirAlias": { "工作": "work", "读书": "reading" } }
  ```
- **Sandbox**: the watch path must fall within
  `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`, and **must not overlap
  `wikiRoot`** (otherwise wiki writes would trigger a self-loop; fail-fast at
  startup). If your vault is outside `$HOME`, add it to `PITH_WIKI_READ_PATHS`.
- **Auto-ignored**: `.obsidian/`, `.git/`, `.DS_Store`, `.icloud`, and any
  nested `wiki/` / `outputs/` / `node_modules/`. Plugin data inside an Obsidian
  vault won't pollute the queue.
- **`change` events**: if an already-ingested file is modified, the
  corresponding job is reset to `force=true` and the worker re-hydrates it,
  overwriting the original entry (same id, no `-2` suffix).
- **Disable**: `--no-auto-watch` on the command line, or
  `"watchAutoStart": false` in `~/.pith-wiki/config.json`.

CLI standalone:

```bash
# Quick ad-hoc watcher (not persisted to config)
pith-wiki watch --dir ~/notes/inbox --collection reading --initial-scan

# Using collectionFromSubdir
pith-wiki watch --dir ~/.../vault --collection-from-subdir --fallback-collection misc

# Read config.watchDirs (foreground; Ctrl-C to stop)
pith-wiki watch
```

The watcher **does not hold the queue lock** — it can run in parallel with the
REPL (auto worker) or `queue run`. It only `enqueue`s; it never hydrates.

---

## Retrieval

Local operations that don't need an LLM call:

```bash
# Look up a single entry
pith-wiki get llm-agent-design

# Assemble context (no LLM call; pure local keyword search)
pith-wiki query "how should agent retry logic be designed"

# List all entries / a collection
pith-wiki list --collection tech
```

---

## Doctor

After accumulating tens to hundreds of entries, run a health check to surface
"malformed structure, stale references, id collisions" — issues that
`LibraryService` doesn't silently skip but are real problems. Reports only; no
data mutated. No LLM call needed.

```bash
# Human-readable; exits 1 on any error (handy for CI pre-commit hooks)
pith-wiki doctor

# Machine-readable; pipe into jq or your monitoring system
pith-wiki doctor --json

# Run a subset of checks (default: all five, in this order:
# frontmatter / orphan-link / duplicate-id / illegal-source / dangling-concept)
pith-wiki doctor --check orphan-link,dangling-concept
```

The five checks:

| Check | Severity | Catches |
|---|---|---|
| `frontmatter` | error | YAML syntax broken / `EntrySchema` invalid (id not kebab-case, more than 6 tags, `updated` not ISO-8601, etc.). |
| `orphan-link` | warning | `links: [foo]` but the library has no `foo` entry. |
| `duplicate-id` | error | Same id appears in two or more collections — ambiguous on lookup. |
| `illegal-source` | warning | `source.type=file` but `source.value` is outside the sandbox (`workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`); `wiki_read_source` won't be able to read it. |
| `dangling-concept` | warning | Body contains `[[id]]` references but the target doesn't exist, or it exists but isn't registered in the `links:` field. |

Each problem carries a `suggestion` telling you exactly which file and field to
fix. JSON output schema in [src/wiki/doctor.ts](../src/wiki/doctor.ts), see the
`DoctorReport` type at the top.

> Planned `doctor --fix` (auto-repair) tracked in a separate issue — the current
> version is deliberately read-only.

---

## Switching providers

pith-wiki uses the OpenAI-compatible HTTP protocol — any service on that
protocol (DeepSeek / Qwen DashScope / OpenAI / Moonshot Kimi / Zhipu GLM /
OpenRouter / Groq / local Ollama …) can be plugged in. Declare multiple in
`~/.pith-wiki/config.json`:

```jsonc
{
  "providers": {
    "deepseek": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "qwen":     { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "apiKeyEnv": "DASHSCOPE_API_KEY" },
    "openai":   { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" },
    "kimi":     { "baseURL": "https://api.moonshot.cn/v1", "model": "moonshot-v1-32k", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "ollama":   { "baseURL": "http://localhost:11434/v1", "model": "llama3.1:70b", "apiKey": "ollama" }
  },
  "activeProvider": "deepseek"
}
```

Each entry's API key uses either `apiKey` (literal — not recommended in JSON)
or `apiKeyEnv` (the env var name).

Switching (priority high → low):

```bash
pith-wiki --provider qwen                  # current command only
PITH_WIKI_PROVIDER=qwen pith-wiki          # current shell session
# Or set "activeProvider": "qwen" in config.json — persistent default
```

Inside the REPL:

```
› /provider                # list all; * marks the active one
› /provider qwen           # switch; implicit /reset of conversation
                           # (different models shouldn't share history)
```

A provider must support **function calling + JSON mode** to fully work; without
the former the REPL agent loop hangs, without the latter `wiki_ingest` /
`/digest` fail.

---

## Global flags

| Flag | Effect |
|---|---|
| `--read-only` | Disable all writes (read_file / list_dir still allowed). |
| `--model <name>` | Override the active provider's model. |
| `--root <dir>` | Override `wikiRoot`. |
| `--read-path <dir>` | Add an extra readable directory (repeatable; see [docs/config.md#additional-read-paths](config.md#additional-read-paths)). |
| `--provider <name>` | Temporary provider switch (not persisted). |
