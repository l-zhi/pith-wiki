# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # run the REPL via tsx (no build needed)
npm run build       # tsc → dist/, also chmods bin
npm start           # run built CLI from dist/
npm test            # vitest run (one-shot)
npm run test:watch
npm run typecheck   # tsc --noEmit
```

Run a single test: `npx vitest run tests/library.test.ts` (or `-t "<name>"` to filter by test name).

Subcommands during development: prefix with `npm run dev --` instead of `llm-wiki`, e.g. `npm run dev -- list --collection tech`. Stdin piping works (`cat foo.md | npm run dev -- ingest --collection tech`).

`DEEPSEEK_API_KEY` (in `.env`) is required for `ingest` and the REPL; `get` / `list` / `query` work without it.

## Architecture

`bin/llm-wiki.ts` uses commander to dispatch either to subcommands (`src/cli/subcommands.ts`) or the default Ink REPL (`src/cli/App.tsx`). Both paths instantiate the same three services in `src/wiki/` — there is no parallel implementation for the LLM-tool route.

**Three core services** (`src/wiki/`):

- `LibraryService` — file CRUD over `<wikiRoot>/<collection>/<id>.md`. Forward links live in YAML frontmatter; backlinks are computed lazily into an in-memory `Map<id, {forward, backward}>` and invalidated on any `put`/`delete`. Atomic writes via `.tmp + rename`.
- `HydrationService` — calls DeepSeek in JSON mode (`response_format: json_object`). When `autoLink=true` it injects existing entries' `{id, title, summary}` into the prompt as link candidates. **Cannot be combined with tools** — JSON mode and `tools` are mutually exclusive on the OpenAI-compatible API.
- `ContextAssembler` — no embeddings. Tokenizes via `\W+`, scores entries (`2*title + 2*tags + summary + 0.5*content`), takes top 5 seeds, expands forward links BFS depth=1, and packs to a `maxTokens × 4 chars × 0.7` byte budget. The 0.7 leaves headroom for the rest of the conversation.

**REPL agent loop** (`src/llm/agent.ts`): trusts `tool_calls.length > 0` (not `finish_reason`) to decide whether to recurse; loop cap is 12 iterations. Tool calls run serially through a `p-queue(concurrency=1)`. The `AbortController` from the UI is forwarded into the OpenAI client so `Ctrl+C` kills the in-flight HTTP request *and* prevents further tool dispatch.

**Tool registry** (`src/tools/`): six tools — `read_file`, `write_file`, `list_dir`, `wiki_ingest`, `wiki_get`, `wiki_query`. Wiki tools are thin wrappers over the same services subcommands use. `src/tools/index.ts` ships a hand-rolled `zodToJsonSchema` that only understands `string|number|boolean|array|enum|optional|default|object` — if you add a tool whose params use other zod constructs (unions, records, refinements), extend the converter or the schema will silently degrade to `{}`.

**Sandbox** (`src/tools/safety.ts`): every path resolved through `read_file` / `write_file` / `list_dir` must land under `workspaceRoot` ∪ `wikiRoot`. Both are passed through `realpathSync` to neutralize symlinks (notably macOS `/var` → `/private/var`). Write targets in not-yet-existing directories use `realPathClimbing` — walks upward to the first existing ancestor, realpaths it, then re-attaches the missing tail. Symlinks pointing outside the sandbox are rejected post-realpath.

**Approval flow**: in REPL mode, every new write path triggers an approval prompt. Answers: `y` (this path only), `a` (whole session — added to `approvedWritePaths`), `n` (refuse). Subcommands bypass this (no UI).

**Config precedence** (`src/config.ts`): CLI flag > env (`DEEPSEEK_API_KEY`, `LLM_WIKI_*`) > `~/.llm-wiki/config.json` > built-in defaults. Parsed through zod — invalid config is fail-fast at startup.

## Conventions worth knowing

- Entry IDs are kebab-case slugs enforced by `EntrySchema` regex (`^[a-z0-9][a-z0-9-]*$`). Hydration prompt repeats this rule but the schema is the actual gate.
- TS config uses `NodeNext` modules, so all relative imports inside `src/` and `bin/` end in `.js` (not `.ts`). Tests in `tests/` are excluded from the build but vitest resolves them fine.
- `npm run build` writes only `bin/` and `src/` to `dist/`; `tests/` is excluded by `tsconfig.json`.
- `--url` on `ingest` only tags the entry's `source` — it does **not** fetch. Pipe content via `--file` or stdin.
- The wiki layer is `Promise`-light: `LibraryService` is sync (filesystem only); only `HydrationService` and the agent are async.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues at `l-zhi/llm-wiki`. Use the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

Default mattpocock/skills vocabulary (no custom mapping).
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `CONTEXT.md` at root + `docs/adr/`.
See `docs/agents/domain.md`.
