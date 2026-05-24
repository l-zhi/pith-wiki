# Configuration and on-disk layout

> 中文版 → [config.zh-CN.md](./config.zh-CN.md)

- [Configuration precedence](#configuration-precedence)
- [Field reference](#field-reference)
- [Additional read paths](#additional-read-paths)
- [On-disk layout](#on-disk-layout)

---

## Configuration precedence

```
CLI flag  >  environment variable  >  ~/.pith-wiki/config.json  >  built-in default
```

Want a complete `config.json` to copy from? See
[docs/config.example.json](config.example.json) — multi-provider + watchDirs +
queue + custom paths, every field. Pick the parts you need and paste them into
`~/.pith-wiki/config.json`.

---

## Field reference

| Field | Env var | Default |
| --- | --- | --- |
| `apiKey` | `DEEPSEEK_API_KEY` | _required_ (only for ingest / REPL; superseded by the active provider entry when `providers` is configured) |
| `baseURL` | `PITH_WIKI_BASE_URL` | `https://api.deepseek.com` |
| `model` | `PITH_WIKI_MODEL` | `deepseek-chat` |
| `providers` | _(no env, complex shape)_ | `{}` (see [usage.md#switching-providers](usage.md#switching-providers)) |
| `activeProvider` | `PITH_WIKI_PROVIDER` | _unset_ (CLI `--provider` takes priority) |
| `wikiRoot` | `PITH_WIKI_ROOT` | `~/.pith-wiki/wiki-data` |
| `workspaceRoot` | `PITH_WIKI_WORKSPACE` | `<cwd>` |
| `readOnly` | `PITH_WIKI_READ_ONLY` | `false` |
| `additionalReadPaths` | `PITH_WIKI_READ_PATHS` (JSON array or `:`-separated) | `[]` |
| `queueStatePath` | _(no env)_ | `~/.pith-wiki/queue/state.json` |
| `queueLogDir` | _(no env)_ | `~/.pith-wiki/queue/logs` |
| `queueConcurrency` | _(no env)_ | `2` |
| `queueMaxAttempts` | _(no env)_ | `3` |
| `queueAutoStart` | _(no env)_ | `true` (CLI `--no-auto-queue` disables) |
| `watchDirs` | _(no env)_ | `[]` (see [usage.md#directory-watcher](usage.md#directory-watcher)) |
| `watchAutoStart` | _(no env)_ | `true` (CLI `--no-auto-watch` disables) |
| `outputDir` | _(no env)_ | `<wikiRoot>/output/transcripts` |
| `transcriptEnabled` | _(no env)_ | `true` (CLI `--no-transcript` disables) |
| `digestCollection` | _(no env)_ | `output` (default collection for `/digest`) |
| `cacheConverted` | _(no env)_ | `true` (CLI `--no-cache` disables) |
| `soulFile` | `PITH_WIKI_SOUL` | _auto-discovered_ (see SOUL.md.example) |
| `maxToolPayloadBytes` | _(no env)_ | `100000` |
| `configPath` | `PITH_WIKI_CONFIG_PATH` | `~/.pith-wiki/config.json` |
| `PITH_WIKI_HOME` | `PITH_WIKI_HOME` | `~/.pith-wiki/` — overrides the entire home directory location (useful for dev/prod isolation) |

---

## Additional read paths

By default, the `read_file` / `list_dir` tools can only see files inside the
current workspace and `wikiRoot`. To let the LLM consult external reference
material (a notes vault, a papers folder…) **without giving it write access**,
configure additional read paths:

```bash
# CLI flag (repeatable)
pith-wiki --read-path ~/notes --read-path ~/research/papers

# Environment variable / .env — JSON array recommended, `~` auto-expands
PITH_WIKI_READ_PATHS=["~/notes", "~/research/papers"]

# Env var also supports a separator-joined string (POSIX `:` / Windows `;`)
PITH_WIKI_READ_PATHS=/Users/me/notes:/Users/me/research/papers

# ~/.pith-wiki/config.json
{ "additionalReadPaths": ["/Users/me/notes", "/Users/me/research/papers"] }
```

**Two effects**:

1. **Read expansion**: `read_file` / `list_dir` tools can reach these
   directories. `write_file` is still locked to `workspaceRoot ∪ wikiRoot`.
2. **Ingest gate**: `pith-wiki ingest --file <p>` and the `--batch` / `--dir`
   modes require source files to fall within
   `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`. Ingesting from a path
   outside the sandbox is rejected immediately. This blocks accidents like
   `pith-wiki ingest --file /etc/passwd`.

All paths go through `realpath` normalization; symlinks that escape the sandbox
are still rejected. Sandbox design details in
[docs/security-model.md](security-model.md).

---

## On-disk layout

All pith-wiki local data lives under `~/.pith-wiki/` — **never touches your
workspace**:

```
~/.pith-wiki/
├── .env                                 # default .env location (mode 600)
├── config.json                          # optional user config
├── history                              # REPL up-arrow command history (last N entries)
├── SOUL.md                              # optional; persona overlay (see SOUL.md.example)
├── wiki-data/                           # default wikiRoot — your whole wiki
│   ├── tech/                            # collection (indexed by LibraryService)
│   │   └── agent-loop.md                # entry: YAML frontmatter + Markdown body
│   ├── reading/                         # collection
│   └── output/                          # collection (default digestCollection)
│       ├── agent-retry-policy.md        # /digest output (indexed)
│       └── transcripts/                 # raw transcript subdir (not indexed)
│           └── 2026-04-30T08-15-32-100Z.md   # one per REPL session
├── queue/
│   ├── state.json                       # persistent queue state (jobs + ring-buffer events)
│   ├── state.json.lock                  # exists while a worker holds the lock; contains pid/ts
│   └── logs/
│       └── <jobId>.log                  # per-job append-only log
└── index.json                           # LibraryService persistent entry index (cold-start speedup)
```

> **Want the wiki bundled with your workspace?** Set
> `"wikiRoot": "/Users/me/code/myproject/wiki-data"` in
> `~/.pith-wiki/config.json`, or `export PITH_WIKI_ROOT=...`. Add `/wiki-data/`
> to `.gitignore` to avoid accidentally committing the data.
>
> **Want a separate dev sandbox alongside production?** Set
> `PITH_WIKI_HOME=~/.pith-wiki-dev` to point everything (config, queue, wiki
> data, transcripts) at a parallel directory. The `bin/pith-wiki-dev` shim in
> the repo does this for you.
