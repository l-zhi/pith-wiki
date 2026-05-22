# Contributing to pith-wiki

Thanks for poking around. This is a solo-maintained project with limited
bandwidth, but small contributions are welcome. Big ones — please open a
discussion issue first so we can scope-check before you sink hours into it.

## What kind of PR fits

**Fits well**:

- Bug fixes with a reproducing test
- Doc improvements (typos, unclear sections, missing examples)
- New `Likely next` items from [docs/roadmap.md](docs/roadmap.md) — leave a
  comment on the issue first so we don't both end up writing it
- Platform fixes (especially Windows — see [ADR-0003](docs/adr/0003-windows-best-effort.md))

**Open an issue first**:

- Architectural changes (new tool, new core service, schema migration)
- Anything touching `src/tools/` (read [docs/security-model.md](docs/security-model.md) first)
- New dependencies (we keep the dep tree small)

**Probably won't merge**:

- Features in `Won't do` of [docs/roadmap.md](docs/roadmap.md) (Notion
  replacement, enterprise KB, generic RAG framework, embedding-by-default)
- Refactors with no behavioral change and no test improvement — they
  churn git history without buying anything
- Style-only changes (run the formatter; don't PR for whitespace)

## Setup

```bash
# Requires Node ≥ 20 (check `engines` in package.json). Use nvm if needed:
nvm use   # reads .nvmrc

git clone https://github.com/l-zhi/pith-wiki.git
cd pith-wiki
npm install

# Provide an API key only if you're running ingest / REPL. List/query/doctor
# work without one.
mkdir -p ~/.pith-wiki && cp .env.example ~/.pith-wiki/.env && chmod 600 ~/.pith-wiki/.env
# edit ~/.pith-wiki/.env and fill DEEPSEEK_API_KEY (or your provider's key)

npm run build
```

## Commands

```bash
npm run dev         # tsx, runs the REPL straight from src/
npm run build       # tsc → dist/, chmods bin
npm start           # run built CLI from dist/
npm test            # vitest, one-shot
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit
```

Run a single test file:

```bash
npx vitest run tests/library.test.ts
npx vitest run tests/library.test.ts -t "round-trip"   # filter by test name
```

Pipe stdin to a subcommand during dev (note the `--` separator for `npm run`):

```bash
cat ./paper.md | npm run dev -- ingest --collection tech
```

## Tests

vitest is the only test framework. **Every behavioral change needs a test**:

- Bug fix → regression test that fails before the fix, passes after
- New feature → unit tests covering happy path + 1-2 edge cases
- Refactor with no behavioral change → no new tests needed, but existing
  suite must stay green

Tests live in [`tests/`](tests/) — flat, one file per concern. Use tmpdirs
(`fs.mkdtempSync(os.tmpdir() + 'pith-wiki-...-')`) for filesystem fixtures
and clean up in `afterEach`. **Never** read from `~/.pith-wiki/` in tests —
set `PITH_WIKI_CONFIG_PATH` to a sandbox path (see how `tests/config.test.ts`
does it).

## Commit Style

Conventional Commits:

- `feat:` new user-visible capability
- `fix:` bug fix
- `refactor:` internal change with no behavioral diff
- `chore:` build / tooling / deps
- `docs:` docs only
- `test:` test-only changes
- `ci:` CI config
- `perf:` performance improvement
- Scope optional but encouraged: `feat(doctor): ...`, `fix(queue): ...`

First line ≤ 70 chars. Body should explain **why**, not what (the diff
shows what). For nontrivial changes, list trade-offs considered and
rejected.

If your commit closes a GitHub issue, end the body with `Closes #N`. GitHub
auto-closes the issue when the commit lands on `main`.

## PR Flow

1. Branch off `main`. Branch name: `topic/short-description` (e.g.
   `topic/doctor-fix-mode`).
2. Make commits as you go. Don't squash before review — small commits make
   review easier; if I want to squash at merge time I'll say so.
3. Push and open a PR. The [PR template](.github/pull_request_template.md)
   asks for what / why / test plan / breaking changes — fill it out.
4. CI must pass: ubuntu + macos, Node 20 + 22, plus typecheck. Windows is
   best-effort and not in CI matrix.
5. One reviewer (the maintainer). I aim for a first response within a few
   days but make no promises — solo dev caveat applies.

## Code Style

- TypeScript with `NodeNext` modules — relative imports inside `src/` end in
  `.js` (not `.ts`). Tests import from `../src/foo.js`.
- Prettier handles formatting; ESLint handles common pitfalls. Run
  `npm run lint` (0 errors required) and `npm run format` (rewrites files
  in place) before pushing. Existing codebase has ~150 prettier warnings
  intentionally left as-is for now; new code should not add more.
- Function and variable comments — code is allowed to have personality.
  Long-form explanations of nontrivial decisions are encouraged in JSDoc
  above the symbol. Look at `src/wiki/hydration.ts` for the tone.
- No `console.log` in `src/wiki/` / `src/llm/` / `src/tools/` core
  paths — they should be silent libraries. CLI layer (`src/cli/`) and
  subcommands can print.

## Domain Vocabulary

When naming things in code or docs, check [CONTEXT.md](CONTEXT.md) first
(if it exists — created lazily by the `/grill-with-docs` skill as we
resolve domain terms). If your PR introduces a new domain concept, propose
a glossary entry in the PR body so we don't end up with synonyms drift.

For architectural decisions, browse [docs/adr/](docs/adr/) — if your PR
contradicts an existing ADR, surface that explicitly. We can reopen the
decision, but silent override leads to confused future readers.

## Security

If you find a security issue, **do not open a public PR or issue.** See
[SECURITY.md](SECURITY.md) for the GHSA reporting flow.

If you're refactoring `src/tools/` for any reason, read
[docs/security-model.md](docs/security-model.md) first — the sandbox /
approval / payload-truncation invariants there must be preserved.

## Questions

Stuck? Open a [question issue](.github/ISSUE_TEMPLATE/question.md). If
you'd like a design check before writing code, open a feature issue with
the `Willing to PR? — Yes, but I'd want a design check first` box checked.
