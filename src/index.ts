/**
 * llm-wiki 公共库入口。
 *
 * 嵌入用法：
 *   import { LibraryService, Agent, defineConfig, createClient, buildContext } from 'llm-wiki';
 *
 * 也可走 subpath 按需导入：
 *   import { LibraryService } from 'llm-wiki/wiki';
 *   import { Agent } from 'llm-wiki/agent';
 *   import { buildContext } from 'llm-wiki/tools';
 *   import { defineConfig } from 'llm-wiki/config';
 *
 * 此文件只 re-export framework-agnostic 的能力——不包含任何 CLI / Ink / React 代码。
 */

export * from './wiki/index.js';
export * from './llm/index.js';
export {
  buildContext,
  ALL_TOOLS,
  TOOL_REGISTRY,
  toolsForOpenAI,
  type ToolContext,
  type ToolDef,
  type AnyToolDef,
  type ApprovalAnswer,
} from './tools/index.js';
export { defineConfig, type DefineConfigInput, type Config } from './config.js';
