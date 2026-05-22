# One-shot migration scripts

These are **not** day-to-day tools. They were written to fix specific data-format
transitions during 0.2.x internal development. **New installs (≥ 0.3.0) never need
to run any of them.**

Kept in-repo for: (a) auditing what the historical migrations did; (b) helping
anyone resurrecting a very old `wiki-data/` directory.

## Inventory

| Script | What it does |
|---|---|
| `migrate-from-llm-wiki.mjs` | **v0.3.0 rename**. Moves `~/.llm-wiki/` → `~/.pith-wiki/` and rewrites `LLM_WIKI_*` env-var names inside `.env` to `PITH_WIKI_*`. Dry-run by default; `--apply` to commit. Run once after upgrading from `llm-wiki` to `pith-wiki`. |
| `migrate-entries-to-subpath.mjs` | Mirrored flat `<wikiRoot>/<collection>/<id>.md` layout into the new `subpath`-aware tree, so watcher's `collectionFromSubdir` mode could preserve source directory structure. _0.2.x internal._ |
| `migrate-sidecar-colocate.mjs` | Relocated converter sidecar files (PDF/DOCX → markdown caches) from a global `<wikiRoot>/.cache/` to per-entry `.cache/` co-located next to the entry. _0.2.x internal._ |
| `migrate-sidecar-dedup.mjs` | Fixed a transient bug where a sidecar was double-written under two paths after the relocation above; deduped by deleting the old copy. _0.2.x internal._ |

## When to run

| Situation | Script |
|---|---|
| You used to run `llm-wiki` and now installed `pith-wiki` | `migrate-from-llm-wiki.mjs` (one time) |
| You're carrying a `wiki-data/` from before 0.3.0 with old sidecar layouts | The three `migrate-*` scripts above (read their source first; tweak for your layout) |
| Fresh install of pith-wiki ≥ 0.3.0 | None — ignore this folder |

**Always back up `~/.pith-wiki/` (or `wiki-data/`) before running any migration.** All scripts here are idempotent enough to not lose data, but a backup is cheap insurance.
