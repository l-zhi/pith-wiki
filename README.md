# pith-wiki

> 中文版 → [README.zh-CN.md](./README.zh-CN.md)

A local-first LLM wiki, Karpathy-style: don't shove raw documents into a vector
DB and pray. Hydrate them into dense Markdown entries, retrieve by keyword + link
traversal. File-based, works with any OpenAI-compatible LLM endpoint — and runs
as a **native desktop app**.

![Obsidian vault + pith-wiki side by side](docs/screenshots/Obsidian-pithwiki.png)

*Drop a note into your Obsidian vault — pith-wiki auto-ingests it into entries the LLM can pull from mid-conversation.*

Current input formats: `.docx` `.eml` `.htm` `.html` `.markdown` `.md` `.pdf`
`.text` `.txt`.

> **Best practice**: point `watchDirs` at your Obsidian vault — every new
> document is automatically hydrated into an entry the LLM can pull from
> mid-conversation.

> **Design philosophy: data engineering > retrieval algorithms.** Don't dump raw
> docs into a store and hope embedding will pull them back. Use an LLM to
> _hydrate_ each source into a high-density Markdown entry, then retrieve by
> keyword + link traversal. Simple, file-based, human-readable.

**Platforms**: Linux and macOS, both covered by CI (Node 20 / 22). Windows is
theoretically usable but **not in CI** — `fs.rename` atomicity, chokidar
fs-events, `path.delimiter` all differ from POSIX. PRs welcome; not a launch
priority.

## Run the app

The desktop app (Electron) is the way to use pith — chat, inbox, dashboard, link
graph, skills, and a **scheduled-tasks** view with a calendar, all over the same
engine and on-disk library. No packaged installer yet, so run it from source:

```bash
git clone https://github.com/l-zhi/pith-wiki.git
cd pith-wiki/desktop
npm install
npm run dev      # electron-vite dev (HMR)
```

On first launch, onboarding walks you through setup — pick a provider, paste an
API key, and point it at a notes folder to watch. Everything lives under
`~/.pith-wiki/` (config + wiki data); set `PITH_WIKI_HOME` for an isolated
profile.

Dev scripts: `npm test` / `npm run typecheck` / `npm run build` (run inside
`desktop/`, or at the repo root for the engine/core). Contribution flow in
[CONTRIBUTING.md](CONTRIBUTING.md).

## What it does

**1. Hydrate** — compress raw documents (markdown / PDF / DOCX / HTML / email)
into Markdown entries roughly 30% of the original size. Strip filler, keep
signal. LLMs read these directly.

**2. Retrieve** — no embeddings, no vector DB. Weighted keyword search (title × 2,
tags × 2, summary × 1, content × 0.5) + BFS link traversal, plus exact
substring/regex search (`wiki_grep`) and date-range filters (when an entry was
added to the library, or the content's own date). Boring on purpose. Entries are
plain Markdown; Obsidian, VS Code, and Git all open them natively.

**3. Chat** — the agent talks to your library through file + wiki tools
(`wiki_query` fuzzy search, `wiki_grep` exact search, `wiki_get`,
`wiki_read_source`, `wiki_ingest`, `read_file` / `write_file` / `list_dir`, …).
Every turn writes a transcript; `/digest` distills the conversation back into a
wiki entry, closing the loop chat → store → retrieve.

**4. Auto-ingest** — point a watch folder (Obsidian vault, inbox, etc.) at pith
in Settings, and changes are auto-enqueued for a background worker to hydrate.
Built-in health checks flag orphan links, broken frontmatter, and ID collisions.

**5. Schedule** *(desktop)* — set tasks that run an agent prompt on a schedule
(once, or cron) — e.g. a daily digest of everything added yesterday. Each fire
opens a fresh session you can reopen; `${yyyy-mm-dd -1}`-style date placeholders
are resolved at run time so "yesterday" is always correct.

## Full documentation

| Document | When to read it |
|---|---|
| [docs/config.md](docs/config.md) | Configuration field reference, `additionalReadPaths`, on-disk layout |
| [docs/config.example.json](docs/config.example.json) | Full `~/.pith-wiki/config.json` example (multi-provider + watchDirs + queue) |
| [docs/entry-format.md](docs/entry-format.md) | YAML frontmatter spec for entries |
| [docs/architecture.md](docs/architecture.md) | Three core services + data-flow diagram |
| [docs/security-model.md](docs/security-model.md) | Sandbox invariants (required reading for contributors) |
| [docs/usage.md](docs/usage.md) | CLI reference (advanced / automation — the app is the primary way to run) |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution flow |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## License

[MIT](LICENSE) · Copyright (c) 2026 lizhi
