# Quickstart — five minutes to first entry

> 中文版 → [quickstart.zh-CN.md](./quickstart.zh-CN.md)

Zero to your first hydrated entry. For the full picture see
[README.md](../README.md); this page sticks to the happy path.

## 1. Install

Not on npm yet (planned for `v0.3.0`). For now, install from a local build:

```bash
git clone https://github.com/l-zhi/pith-wiki.git
cd pith-wiki
npm install && npm run build
npm pack                          # produces pith-wiki-x.y.z.tgz
npm install -g ./pith-wiki-*.tgz
```

Requires **Node ≥ 20**.

> Want to hack on source? See the
> [README "Developers" section](../README.md#developers-build-from-source) for
> the `npm run dev` flow. The rest of this page assumes you have a working
> `pith-wiki` command on your PATH.

## 2. Get an API key

pith-wiki speaks OpenAI-compatible HTTP — any service on that protocol works.
Cheapest option is [DeepSeek](https://platform.deepseek.com/api_keys) (about
$0.27 / 1M input tokens for `deepseek-chat`). Sign up, grab a key.

Then run interactive `init` — it picks the provider, writes a minimal `.env`,
and (if you set a watch dir) a minimal `config.json`:

```bash
pith-wiki init
# Prompts:
#   Select an LLM provider:  [1] DeepSeek (default)  [2] OpenAI  …
#   Enter your DeepSeek API key:  sk-xxxxxxxxxxxxxxxx
#   Auto-watch directory (optional):  ~/Obsidian   (Enter to skip)
#   Scan existing files now? [Y/n]  Y
```

Press Enter on any step to skip / accept the default. Non-interactive one-liner
(for CI / scripted setup):

```bash
pith-wiki init --provider deepseek \
               --api-key sk-xxxxxxxxxxxxxxxx \
               --no-prompt
```

> Want a different provider (Qwen / OpenAI / OpenRouter / local Ollama …)?
> Pick it during interactive `init`, or see
> [docs/config.example.json](config.example.json) for a multi-provider config.

## 3. Ingest your first entry

Pick a markdown file worth "digesting" — a paper, a blog post, your own notes —
and pipe it into `ingest`:

```bash
cat ./some-article.md | pith-wiki ingest --collection reading
```

Or pass `--file ./some-article.md`. On success it prints the new entry's id;
the library lives at `~/.pith-wiki/wiki-data/` by default:

```bash
ls ~/.pith-wiki/wiki-data/reading/
# → my-article-title.md   (id derived by the LLM, kebab-case)
```

Take a look at the hydrated entry:

```bash
cat ~/.pith-wiki/wiki-data/reading/my-article-title.md
```

The frontmatter has a `compressionRatio` field — exactly how much the original
shrank.

## 4. Retrieve

```bash
# Local keyword search; no LLM call.
pith-wiki query "the core argument of that article you just ingested"

# Or list everything in a collection
pith-wiki list --collection reading

# Or interactive REPL (asks the LLM, which auto-calls wiki_query)
pith-wiki
```

In the REPL, just talk naturally. For example: "based on the notes in my
`reading` collection, compare topic A vs topic B" — the LLM will auto-invoke
`wiki_query` to pull relevant entries into context, then answer.

## 5. Where next

- **Auto-ingest a folder**? Add it to `watchDirs` (you may have already done
  this during `init`). See `README §watchDirs`.
- **Bulk ingest a whole directory**? `ingest --batch '<glob>'` or `--dir <folder>`.
- **Switch providers / configure several**? See `README §multi-provider` and
  [docs/config.example.json](config.example.json).
- **Library got messy**? `pith-wiki doctor` scans for malformed frontmatter,
  orphan links, duplicate ids.
- **Where the project is headed**? [docs/roadmap.md](roadmap.md).
- **Want to contribute**? [CONTRIBUTING.md](../CONTRIBUTING.md).

## Install succeeded but something errors out?

| Symptom | Usually means |
|---|---|
| `Error: API key required` | `~/.pith-wiki/.env` is missing or the key var name is wrong (DeepSeek uses `DEEPSEEK_API_KEY`). Rerun `pith-wiki init`. |
| `command not found: pith-wiki` | Not globally installed. Either `npm install -g ./pith-wiki-*.tgz`, or use `node dist/bin/pith-wiki.js` from the cloned repo, or `npm link`. |
| `tsc` complaints / weird ESM errors | Node version too old; need ≥ 20. Run `node --version`. |
| `Failed to parse ~/.pith-wiki/config.json` | Invalid JSON in your config. Delete the file to fall back to defaults, then rerun `init`. |
| `watch path outside read sandbox: /some/path` | The watch dir isn't in the read sandbox. `pith-wiki init --force --watch-dir /your/path` re-writes the config with the path also added to `additionalReadPaths`. |
| `ingest` hangs a long time | Usually normal — DeepSeek takes 5–15s to hydrate a 5 KB article. Check progress in another terminal: `pith-wiki status`. |

For anything not in this table, open a [GitHub issue](https://github.com/l-zhi/pith-wiki/issues).
