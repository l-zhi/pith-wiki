#!/usr/bin/env node
/**
 * pith-mcp — a stdio MCP server exposing pith's READ-ONLY retrieval tools.
 *
 * Purpose: let an external agent host (notably Claude Code, via `claude -p
 * --mcp-config … --allowedTools "mcp__pith__*"`) query a pith library through
 * the same wiki tools the built-in agent uses — wiki_query / wiki_grep /
 * wiki_get / wiki_list / wiki_read_source. No write/ingest/schedule tools are
 * exposed, so the worst this server can do is read inside the sandbox.
 *
 * The library it serves is whatever `loadConfigFromEnv()` resolves — set
 * `PITH_WIKI_HOME` in the MCP server's `env` to point at the right profile
 * (e.g. ~/.pith-wiki-dev in dev).
 *
 * This server NEVER calls an LLM; the OpenAI client below is a dummy that only
 * satisfies buildContext's signature (its hydrator is never invoked).
 */
import { z } from 'zod';
import OpenAI from 'openai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv } from '../src/config.js';
import { LibraryService } from '../src/wiki/library.js';
import { buildContext, type AnyToolDef } from '../src/tools/index.js';
import { wikiQueryTool } from '../src/tools/wiki_query.js';
import { wikiGrepTool } from '../src/tools/wiki_grep.js';
import { wikiGetTool } from '../src/tools/wiki_get.js';
import { wikiListTool } from '../src/tools/wiki_list.js';
import { wikiReadSourceTool } from '../src/tools/wiki_read_source.js';

const RETRIEVAL_TOOLS: AnyToolDef[] = [
  wikiQueryTool,
  wikiGrepTool,
  wikiGetTool,
  wikiListTool,
  wikiReadSourceTool,
];

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const library = new LibraryService(config.wikiRoot, { ignoredDirs: [config.outputDir] });
  // dummy client: retrieval tools never touch the hydrator, so this is never called.
  const dummyClient = new OpenAI({ apiKey: 'unused-mcp-readonly', baseURL: 'http://127.0.0.1:1' });
  const ctx = buildContext(config, dummyClient, async () => 'no', library, {});

  const server = new McpServer({ name: 'pith', version: '0.2.0' });
  for (const tool of RETRIEVAL_TOOLS) {
    const shape = (tool.parameters as z.ZodObject<z.ZodRawShape>).shape;
    server.tool(tool.name, tool.description, shape, async (args: Record<string, unknown>) => {
      try {
        const parsed = tool.parameters.parse(args);
        const result = await tool.handler(parsed, ctx);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `pith ${tool.name} failed: ${(err as Error).message}` }],
        };
      }
    });
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err: Error) => {
  // stderr only — stdout is the MCP JSON-RPC channel and must stay clean.
  console.error('[pith-mcp] fatal:', err.message);
  process.exit(1);
});
