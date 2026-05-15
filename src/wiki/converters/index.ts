/**
 * 文件 → 文本转换器子系统的公共出口。
 *
 * 嵌入用法：
 *   import {
 *     ConverterRegistry,
 *     defaultConverters,
 *     FileSystemConverterCache,
 *     type Converter,
 *   } from 'llm-wiki/wiki';
 *
 *   const registry = new ConverterRegistry();
 *   for (const c of defaultConverters()) registry.register(c);
 *   registry.register(myCustomConverter);  // priority=100 自然覆盖内置
 */

export {
  type Converter,
  type ConvertInput,
  type ConvertOutput,
  type ConvertContext,
  type ConvertProgress,
  type ConvertMeta,
  EmptyConversionError,
  UnknownConverterError,
  NoConverterError,
} from './types.js';

export { ConverterRegistry } from './registry.js';
export {
  type ConverterCache,
  type CacheKey,
  type CacheEntry,
  FileSystemConverterCache,
  NullConverterCache,
  sha256,
  cacheKey,
  cacheKeyString,
} from './cache.js';
export { cacheSidecarPath, writeCacheSidecar } from './sidecar.js';

import type { Converter } from './types.js';
import { markdownPassthrough } from './builtin/markdown.js';
import { textPassthrough } from './builtin/text.js';
import { pdfParseConverter } from './builtin/pdf.js';
import { docxMammothConverter } from './builtin/docx.js';
import { htmlTurndownConverter } from './builtin/html.js';
import { emlMailparserConverter } from './builtin/eml.js';

/**
 * 内置转换器集合。
 *
 * 调用方式：
 *   const registry = new ConverterRegistry();
 *   for (const c of defaultConverters()) registry.register(c);
 *
 * 顺序无关（registry 按 name 去重 + priority 排序）。
 * 每次调用返回新数组，确保宿主修改它不影响下次。
 */
export function defaultConverters(): Converter[] {
  return [
    markdownPassthrough,
    textPassthrough,
    pdfParseConverter,
    docxMammothConverter,
    htmlTurndownConverter,
    emlMailparserConverter,
  ];
}

export {
  markdownPassthrough,
  textPassthrough,
  pdfParseConverter,
  docxMammothConverter,
  htmlTurndownConverter,
  emlMailparserConverter,
};

import path from 'node:path';
import { ConverterRegistry } from './registry.js';
import {
  type ConverterCache,
  FileSystemConverterCache,
  NullConverterCache,
} from './cache.js';

/**
 * 给定 wikiRoot + 是否启用缓存 + 宿主额外的 converter 列表，一把建出 registry 和 cache。
 *
 * - 内置先注册（priority=0）
 * - 宿主转换器：默认 priority=100（如果没显式给）；同名后注册的覆盖前注册的
 * - cache=null 时返回 NullConverterCache（CLI --no-cache 用）
 *
 * 这个函数同时被 buildContext（库 / REPL）和 CLI 子命令复用，是配置 → 运行时
 * 中介的唯一职责模块。
 */
export function buildConverterPipeline(opts: {
  wikiRoot: string;
  cacheConverted: boolean;
  extras?: Converter[];
}): { registry: ConverterRegistry; cache: ConverterCache } {
  const registry = new ConverterRegistry();
  for (const c of defaultConverters()) registry.register(c);
  for (const c of opts.extras ?? []) {
    registry.register({
      ...c,
      priority: c.priority ?? 100,
    });
  }
  const cache: ConverterCache = opts.cacheConverted
    ? new FileSystemConverterCache(path.join(opts.wikiRoot, '.cache', 'converters'))
    : new NullConverterCache();
  return { registry, cache };
}
