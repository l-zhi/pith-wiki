# Roadmap

pith-wiki is a solo-dev open-source tool. **No committed timeline.**

Priorities are set by reaction counts and discussion quality on the
[issue tracker](https://github.com/l-zhi/pith-wiki/issues). This file is
organized into three sections: **Likely next** (might land in the next minor
version), **Maybe someday** (longer-term, contingent on real signal), and
**Won't do** (kept here to prevent scope creep).

> Decision mechanism in detail: [ADR-0002](adr/0002-issue-driven-roadmap.md).

---

## Likely next

Directions that might make it into the next minor version. To push for any of
these, +1 the corresponding issue or open one with your specific use-case —
concrete demand gets prioritized.

| Topic | One-liner | Tracking issue |
|---|---|---|
| URL fetching | `--url` actually issues HTTP, runs readability to extract main text (currently it only tags the source field) | _none — open one to push_ |
| `pith-wiki update <id>` | Re-hydrate from new raw text, overwrite the entry, preserve backlinks | _none_ |
| `pith-wiki rename <old> <new>` | When renaming an id, also fix every `links:` reference across the wiki | _none_ |
| Auto-fill `[[concept-id]]` links | Scan body for `[[xxx]]` markers, reconcile with the `links:` field, auto-add missing ones (today `doctor` only reports, doesn't fix) | _none_ |
| `/save <name>` / `/load <name>` | Persist + resume REPL conversations | _none_ |
| `doctor --fix` | Today's `doctor` is read-only; add an interactive fix mode (per-problem approval, same `[y/N/a]` UX as `write_file`) | _none_ |

> These are what the maintainer considers most likely to be the next step,
> but **no timeline is committed.** Wait for issue discussion / +1s / user PRs
> before any priority is locked in.

---

## Maybe someday

Long-term directions. Generally not actively pursued unless a real use-case
drives them — explanations for the conservatism follow each item.

### HTTP REST interface

Letting pith-wiki be called by remote services (VS Code plugin, web frontend,
clients in other languages). Not hard to design (wrap with Fastify / Hono),
but **it changes the project positioning**: from "personal CLI" to "deployable
service" doubles engineering scope (auth, TLS, concurrency, logging, monitoring).

**Trigger**: someone clearly says "I want to call pith-wiki remotely in use-case
X" and the requirements are nailed down in an issue.

### BM25 scoring

Today's retrieval is `2*title + 2*tags + summary + 0.5*content` keyword
weighting + BFS link expansion. BM25 is more precise on large libraries (5000+
entries).

**Trigger**: someone with a 1k+ entry library reports a retrieval-precision
issue, and the issue gives a concrete counter-example of "BM25 would fix this
specific query".

### Synonym dictionary

`<wikiRoot>/.synonyms.yml` to group "agent / 智能体 / agent loop" together.
Substitution happens at tokenize time.

**Trigger**: BM25 hasn't solved a remaining precision problem, or someone reports
mixed Chinese/English retrieval issues.

### Embedding hybrid retrieval (deliberate restraint)

Vector retrieval + keyword + link traversal, merged three ways. But the project
philosophy (PRD §1.2) is explicitly "after hydration to Markdown, keywords are
enough" — adding embeddings contradicts that.

**Trigger**: someone shows on a real library (not a toy demo) that "no keyword
tweak finds this entry" but embedding does. Not a "theoretically better" argument.

### Web UI (does not replace the CLI)

A read-only entry browser + graph view, served on a local HTTP endpoint.
**Not** for editing (Obsidian / VS Code stay the editors), **not** for chat
(REPL stays the chat).

**Trigger**: graph view is a real request raised ≥ 3 times.

### Team collaboration

Multi-user RBAC, Git backend, collection namespacing. Would deform the entire
architecture (v0 is a single-machine single-user filesystem model).

**Trigger**: a concrete team use-case with a maintainer willing to own the
ongoing burden.

---

## Won't do

PRs in these directions won't be accepted, to avoid wasting contributors' time:

- ❌ **Replace Notion / Obsidian** — they have full GUIs + plugin ecosystems
  that can't be matched and shouldn't be. pith-wiki is **complementary** to
  Obsidian (Obsidian for editing, pith-wiki for hydration + retrieval).
- ❌ **AI-driven writing platform** — pith-wiki is a knowledge base, not a
  content generator.
- ❌ **Enterprise knowledge base** — compliance / SSO / audit requirements
  would deform the architecture.
- ❌ **Generic RAG framework** — the project philosophy runs opposite to
  "general RAG". For general RAG use LangChain / LlamaIndex.
- ❌ **GUI client** — Electron / Tauri clients. Cross-platform maintenance
  cost too high for the benefit.
- ❌ **Multi-language SDKs** — Python / Go / Rust clients. The CLI + the
  persistent file format already work as a cross-language protocol; fork
  for language bindings.

---

## Want to push a direction?

[Open an issue](https://github.com/l-zhi/pith-wiki/issues/new?template=feature.md) with:

- Your specific use-case (not "the feature would be more complete")
- Your current workaround and its pain points
- A proposed CLI / API shape

Or comment on an existing issue with +1 and your specific scenario — real
signals get prioritized.

[Bug reports](https://github.com/l-zhi/pith-wiki/issues/new?template=bug.md)
always get fast-tracked.
