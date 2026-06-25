# pith

> 中文版 → [README.zh-CN.md](./README.zh-CN.md)

**A local-first LLM knowledge base.** Drop in your notes, PDFs, and emails — pith
hydrates each into a dense Markdown entry an LLM can read, then lets you chat with
your whole library, retrieved by keyword + link traversal. **No embeddings, no
vector DB.** Everything stays in plain files on your disk.

![Obsidian vault + pith side by side](docs/screenshots/Obsidian-pithwiki.png)

*Drop a note into your Obsidian vault — pith auto-ingests it into an entry the LLM
can pull from mid-conversation.*

- 🗂️ **Plain files, not a black box** — every entry is Markdown + YAML frontmatter; Obsidian, VS Code, and Git open them natively.
- 🔍 **Retrieval you can reason about** — weighted keyword search + link-graph traversal + exact grep. No embedding drift, no vendor lock-in.
- 💬 **Chat that writes back** — the agent reads your library through file/wiki tools; `/digest` distills a conversation into a new entry.
- 🤖 **Auto-ingest + schedule** — watch a folder for new files; run agent tasks on a cron (e.g. a daily digest of yesterday's additions).
- 🔒 **Local-first** — all data under `~/.pith-wiki/`; outbound PII filtering on by default. No cloud, no lock-in.

> **Design philosophy: data engineering > retrieval algorithms.** Don't dump raw
> docs into a store and hope embeddings pull them back. Use an LLM to _hydrate_
> each source into a high-density Markdown entry, then retrieve by keyword + link
> traversal. Simple, file-based, human-readable.

Input formats: `.docx` `.eml` `.htm` `.html` `.md` `.pdf` `.txt`. The product is
**pith**; the npm package and repo are historically named `pith-wiki`.

## Install

**Desktop app (recommended)** — the full experience: chat, inbox, dashboard, link
graph, skills, and a scheduled-tasks calendar, all over the same engine and
on-disk library. No packaged installer yet, so run it from source:

```bash
git clone https://github.com/l-zhi/pith-wiki.git
cd pith-wiki/desktop
npm install
npm run dev      # electron-vite dev (HMR)
```

**CLI** *(optional — for automation / headless use)*:

```bash
npm install -g pith-wiki
pith-wiki        # launch the REPL
```

On first launch, onboarding walks you through setup — pick a provider, paste an
API key, and point it at a notes folder to watch. Everything lives under
`~/.pith-wiki/` (config + wiki data); set `PITH_WIKI_HOME` for an isolated
profile.

**Platforms**: macOS + Linux are CI-tested (Node 20 / 22); Windows is usable but
not yet CI-covered. Dev scripts: `npm test` / `npm run typecheck` / `npm run build`
(inside `desktop/`, or repo root for engine/core). See [CONTRIBUTING.md](CONTRIBUTING.md).

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

[Apache 2.0](LICENSE) · Copyright (c) 2026 lizhi
