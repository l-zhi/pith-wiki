# Security Model (Internal)

> This doc is for **contributors touching `src/tools/`**. For users reporting
> vulnerabilities, see [SECURITY.md](../SECURITY.md) instead.

llm-wiki gives an LLM real filesystem access through the `read_file` /
`write_file` / `list_dir` tools. The promise to users is "the agent can't
escape the workspace + wiki sandbox, and can't write anywhere without
explicit approval." Every refactor under `src/tools/` has to preserve those
two invariants, even when the change looks unrelated to safety.

This file documents the invariants. If your PR breaks one, please flag it
in the PR body so the review knows what to verify.

## Sandbox Roots

Two operations, two root sets:

- **Read** (`read_file`, `list_dir`) — allowed under `workspaceRoot ∪ wikiRoot
  ∪ additionalReadPaths`. The third one lets users grant the agent read
  access to reference folders (their `~/notes/`, paper archives, etc.) without
  also letting it write there.
- **Write** (`write_file`) — allowed only under `workspaceRoot ∪ wikiRoot`.
  **`additionalReadPaths` is never writable**, no matter what config a user
  sets. The "extra read paths" are explicitly user-visible reference data;
  letting the LLM mutate them would violate the user's mental model.

Canonical implementation: `resolveSafePath(inputPath, kind, opts)` in
[src/tools/safety.ts](../src/tools/safety.ts).

## Realpath Normalization

Every input path goes through `realpathSync` (effectively) before the root
containment check. This is **not optional cosmetic cleanup** — it neutralizes
two attacks:

1. **Symlink escape**. A symlink inside the sandbox pointing at `/etc/passwd`.
   Without realpath, `path.relative` would say "inside sandbox" (the symlink
   itself is). After realpath, the resolved target is `/etc/passwd`, which is
   correctly outside.

2. **macOS `/var → /private/var`**. The OS-level symlink means a path resolved
   from a fresh `mkdtemp` may show as `/var/folders/...` even though the
   workspaceRoot was set via realpath at startup to `/private/var/folders/...`.
   Without normalizing both sides, the comparison fails and the legitimate
   path gets rejected.

For **write paths into not-yet-existing directories** (`fs.realpath` would
throw `ENOENT`), `realPathClimbing` walks up to the first ancestor that does
exist, realpaths that, then re-attaches the missing tail. The escape check
still applies to the resolved root — you can't bypass the sandbox by writing
into a sibling that doesn't exist yet.

## Approval Flow (REPL only)

When the REPL agent calls `write_file` with a path it hasn't seen this
session, the UI shows a `[y/N/a]` prompt:

- `y` — allow this write only
- `a` — allow this **path** for the rest of the session (added to
  `approvedWritePaths`)
- `n` (default) — refuse; tool returns an error to the agent

**The approval list is path-keyed, not directory-keyed.** `a` for
`./foo.md` doesn't allow `./bar.md`. This is deliberate: a prompt-injected
"approval cascade" against one file shouldn't extend to others.

Subcommands (`ingest`, `query`, etc.) **bypass the approval prompt** —
they're scripted entry points where the user has already decided what to
write by typing the command. Programmatic embedding contexts can pass a
custom `requestApproval` callback through `ToolContext`.

## Payload Truncation

`truncatePayload(content, max)` caps `read_file` output at
`config.maxToolPayloadBytes` bytes (default `100_000`) before returning to
the LLM. This is **byte-level, UTF-8 aware** — multi-byte chars at the cut
point are handled by `Buffer.byteLength`. The cap exists to prevent a
prompt-injection chain where the agent is tricked into reading a giant
file to fill the context window and then asked to do something malicious
with the residue.

## Threat Model — In Scope

These are real threats the sandbox + approval flow are designed to stop:

1. **Sandbox escape** via path-relative tricks (`../`), symlinks, or
   case-only differences on case-insensitive filesystems.
2. **Prompt-injection-driven file writes** — adversarial source content
   that tries to coerce the agent into `write_file` calls; the user-facing
   approval prompt is the last line of defense.
3. **Cross-collection write confusion** — `write_file` to a path that
   resolves into the wiki tree but in a different collection than the user
   thinks.
4. **API key leakage into transcripts / history / queue logs**. The
   redaction in `src/cli/transcript.ts` is best-effort, not exhaustive.
   Don't paste keys verbatim into the REPL chat box.

## Threat Model — Out of Scope

What the sandbox is **not** designed to stop (and refactors don't need to
fight against):

- The LLM giving wrong / hallucinated answers — that's a quality problem,
  not a security problem.
- DoS via legitimately huge inputs — users cap with
  `--max-tool-payload-bytes` or by not feeding huge files.
- Attacks requiring physical / root access to the user's machine.
- Vulnerabilities in `node_modules` deps that aren't reachable from
  llm-wiki code paths.

## Before Refactoring `src/tools/`

If your change touches any of these files, double-check the invariants:

- [src/tools/safety.ts](../src/tools/safety.ts) — `resolveSafePath`,
  `truncatePayload`, `realPathClimbing`. The hot loop of all safety checks.
- [src/tools/read_file.ts](../src/tools/read_file.ts),
  [src/tools/write_file.ts](../src/tools/write_file.ts),
  [src/tools/list_dir.ts](../src/tools/list_dir.ts) — they MUST call
  `resolveSafePath` before any fs operation.
- [src/wiki/library.ts](../src/wiki/library.ts) — `LibraryService.put`
  enforces atomic `.tmp + rename` writes and stays within wikiRoot.
- [src/cli/ToolApproval.tsx](../src/cli/ToolApproval.tsx) — the
  `[y/N/a]` prompt UI. Don't add an "approve all writes for this session"
  shortcut; that defeats the path-keyed safety.

Tests to keep green:

- [tests/safety.test.ts](../tests/safety.test.ts) — sandbox containment,
  symlink rejection, realpath climbing, payload truncation byte-level cuts.

If a refactor genuinely requires loosening an invariant (e.g. a new tool
category needs broader read scope), call it out in the PR and update this
doc. Don't silently degrade the model — future contributors will read
`safety.ts` and assume the current behavior is the design.
