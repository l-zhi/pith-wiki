---
name: Bug report
about: Something broke. Help me reproduce it.
title: 'bug: '
labels: ['bug']
---

## What happened

<!-- One-line summary of the broken behavior. -->

## Steps to reproduce

<!-- Minimal commands that trigger the bug. Trim to what's necessary. -->

```bash
# e.g.
llm-wiki ingest --collection demo --file ./paper.pdf
```

## Expected vs actual

- **Expected**:
- **Actual**:

## Environment

- llm-wiki version: <!-- `node dist/bin/llm-wiki.js --version` or branch + commit -->
- Node version: <!-- `node --version` -->
- OS: <!-- macOS 14.x / Ubuntu 22.04 / etc. (Windows = best-effort, expect rough edges) -->
- LLM provider + model: <!-- e.g. DeepSeek deepseek-chat / OpenAI gpt-4o-mini / local Ollama -->

## Relevant logs / output

<!-- Paste stderr / job log / transcript. Wrap in ``` for readability.
     Redact API keys before pasting — the project does best-effort but not guaranteed redaction. -->

```
```

## Anything else

<!-- Network setup, custom converters, multi-provider config, anything weird in your env. -->
