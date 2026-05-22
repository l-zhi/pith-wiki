# One-shot migration scripts

These are **not** day-to-day tools. They were written to fix specific data-format
transitions during 0.2.x internal development. **New installs (≥ 0.3.0) never need
to run any of them.**

Kept in-repo for: (a) auditing what the historical migrations did; (b) helping
anyone resurrecting a very old `wiki-data/` directory.

## Inventory

| Script | Commit | What it did |
|---|---|---|
| `migrate-entries-to-subpath.mjs` | f013ef4 | Mirrored flat `<wikiRoot>/<collection>/<id>.md` layout into the new `subpath`-aware tree, so watcher's `collectionFromSubdir` mode could preserve source directory structure. |
| `migrate-sidecar-colocate.mjs` | a707a34 | Relocated converter sidecar files (PDF/DOCX → markdown caches) from a global `<wikiRoot>/.cache/` to per-entry `.cache/` co-located next to the entry. |
| `migrate-sidecar-dedup.mjs` | dd29eb3 | Fixed a transient bug where a sidecar was double-written under two paths after the relocation above; deduped by deleting the old copy. |

## When to ignore

- You started using llm-wiki at 0.3.0 or later.
- Your `wiki-data/` was created by the current `LibraryService.put` / converter pipeline.

## When to run

Only if you have a backup of a `wiki-data/` from a pre-0.3.0 install and want to
bring it forward. Read each script's source comment block first — they were
written for specific moments in time and may need tweaks against your actual layout.

Always back up `wiki-data/` before running any migration.
