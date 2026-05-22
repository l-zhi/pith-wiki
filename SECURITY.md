# Security Policy

pith-wiki is a solo-maintained open source project. The threat model is real
(file-system sandbox, prompt-injection-driven writes, third-party file
parsers), but maintainer bandwidth is limited. This policy is honest about
both.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security bugs.** Public
disclosure before a fix is shipped puts every user at risk.

Two channels, in order of preference:

1. **GitHub Security Advisory** (preferred) — go to
   <https://github.com/l-zhi/pith-wiki/security/advisories/new>. This gives
   us a private threaded conversation, optional CVE assignment, and a
   coordinated-disclosure timer.
2. **Email backup** — `lizhi.fan+pith-wiki.security@gmail.com`. Use this only
   if GHSA is unavailable or you don't have a GitHub account. Plain text is
   fine; PGP not required.

**Response expectations**: best-effort, **no SLA**. I'll typically
acknowledge within a few days but cannot promise a fix timeline. If a
vulnerability is critical and you haven't heard back in a week, please
nudge — sometimes notifications fall through the cracks.

## Scope

### In scope

Bugs that let a malicious input subvert the safety guarantees the project
claims:

- **Sandbox escape** — `read_file` / `write_file` / `list_dir` tools
  accessing paths outside `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`
  (realpath / symlink bypasses, race-window escapes, etc.).
- **Prompt-injection-driven file writes that bypass the approval prompt** —
  e.g. an ingested document that tricks the agent into a `write_file` call
  the user never sees the approval dialog for.
- **API key / secret leakage** — keys ending up in `output/<sessionTs>.md`
  transcripts, `~/.pith-wiki/history`, `<wikiRoot>/.queue/logs/*.log`, or
  any other persisted artifact.
- **DoS or RCE via malicious source files** fed to the converter pipeline
  (PDF via `pdf-parse`, DOCX via `mammoth`, HTML via `turndown`, EML via
  `mailparser`).

### Out of scope

Issues that are real bugs but **not security bugs** under our threat
model:

- LLM produces wrong / low-quality hydration output. That's a quality
  issue — open a regular GitHub issue.
- The LLM is jail-broken by a clever prompt. That's an LLM problem, not
  ours.
- DoS via legitimately huge input files. Use `--max-tool-payload-bytes`
  to cap; we don't promise unlimited file sizes.
- Bugs that require physical access to the user's machine, or root /
  Administrator privileges they already have.
- CVEs in `node_modules` dependencies that are **not reachable** from
  pith-wiki code. (Reachable ones — yes, please report.)
- Anything in Windows-specific code paths — per [ADR-0003](docs/adr/0003-windows-best-effort.md),
  Windows is best-effort and not in CI. Bug reports welcome, but they
  get warning severity, not security severity.

## Disclosure Policy

I follow **coordinated disclosure**. After you report:

1. I acknowledge receipt and start investigating.
2. We discuss the fix privately (in the GHSA thread or via email).
3. A fix lands in `main` and ships in the next release.
4. After the fix is in the wild for a reasonable window (usually 1-2
   weeks), the GHSA is published with credit to the reporter (unless you
   ask to stay anonymous).
5. If a CVE applies, GHSA handles assignment automatically.

If I'm unresponsive for **more than 30 days** after your initial report and
the issue is serious, you're free to disclose publicly — but please give
me a 14-day heads-up first so I can at least scramble a partial mitigation.

## Hardening Notes

Before reporting, it's worth knowing what's already considered:

- All `read_file` / `write_file` / `list_dir` paths go through
  `resolveSafePath` in [src/tools/safety.ts](src/tools/safety.ts), which
  applies `realpathSync` + post-resolve sandbox-root containment check.
  Symlink-based escape attempts are rejected after realpath, not before.
- The REPL has a path-level write approval prompt (`y` / `a` / `n`) for
  every new write target. Subcommands bypass this — by design, for
  scripting.
- API keys are loaded from `~/.pith-wiki/.env` (recommended) or the
  workspace `.env`. The transcript writer (`src/cli/transcript.ts`)
  attempts to redact common secret patterns but is not exhaustive — never
  paste keys verbatim into the REPL chat box.

If you spot a gap in any of the above, that's almost certainly in scope.
