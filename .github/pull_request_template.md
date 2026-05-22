<!-- Thanks for the PR. Keep this template minimal — most of the context belongs in commit messages. -->

## What changed

<!-- One paragraph: what does this PR do? -->

## Why

<!-- One paragraph: why is this needed? Link to the issue if there is one. -->

Closes #<!-- issue number -->

## Test plan

<!-- How did you verify this works? Adapt to the change:
     - bug fix → "added regression test in X; reproduced before, green after"
     - feature → "new tests in Y cover N cases; manual smoke documented below"
     - docs / chore → "n/a" or what proofreading you did
-->

- [ ] `npm run typecheck` clean
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Manual smoke (if applicable) — describe:

## Breaking changes

- [ ] **No** breaking changes
- [ ] **Yes** — describe the migration path:

<!-- For breaking changes, update CHANGELOG.md under [Unreleased] with a
     "BREAKING:" prefix on the bullet. -->
