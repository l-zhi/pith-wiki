import fs from 'node:fs';
import path from 'node:path';

/**
 * 转换器 sidecar：把非 markdown 源（PDF / DOCX / HTML / TXT …）转换后的 .md
 * 落地到 `<wikiRoot>/<collection>/.cache/<rel>.md`，供 wiki_read_source 直接读取。
 *
 * 与 `cache.ts`（sha-keyed JSON cache，纯性能层）的关系：
 *   - sha cache：避免重跑 pdf-parse 之类昂贵转换
 *   - sidecar：给 LLM / 人类一份可读 markdown，并作为 entry.source.cachePath 的目标
 *
 * 命名规则：
 *   - 相对于 sourceRoot 推导子路径；缺省 sourceRoot 时退化为 basename（扁平落在 .cache/）
 *   - 替换扩展名为 .md
 *   - 路径段保留原文件名（中文/空格都允许，与 LibraryService entry 文件名同等宽松）
 *
 * 不写 sidecar 的场景：markdown-passthrough — 源文件已经是 .md，再 copy 一份是冗余的。
 * 调用方负责判断 converter.name 后决定是否调用本模块。
 */

const CACHE_DIR_NAME = '.cache';

export interface SidecarPathInput {
  wikiRoot: string;
  collection: string;
  /** 推导相对路径的根；缺省时退化为 path.dirname(absFile)，sidecar 扁平落在 .cache/ 下。 */
  sourceRoot?: string;
  /** 原始源文件绝对路径（PDF/DOCX/...）。 */
  absFile: string;
}

/**
 * 纯函数：给定参数返回 sidecar 应落地的绝对路径。
 * 不创建目录、不写文件。
 */
export function cacheSidecarPath(input: SidecarPathInput): string {
  const { wikiRoot, collection, absFile } = input;
  const sourceRoot = input.sourceRoot ?? path.dirname(absFile);

  // 相对 sourceRoot 计算子路径。如果 absFile 不在 sourceRoot 之下（rel 含 ..），
  // 退化为 basename：防止 sidecar 路径逃出 .cache/。
  let rel = path.relative(sourceRoot, absFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.basename(absFile);
  }

  // 替换扩展名为 .md。无扩展名时直接加 .md。
  const dir = path.dirname(rel);
  const ext = path.extname(rel);
  const stem = ext ? path.basename(rel, ext) : path.basename(rel);
  const fileName = `${stem}.md`;
  const relMd = dir === '.' ? fileName : path.join(dir, fileName);

  return path.join(wikiRoot, collection, CACHE_DIR_NAME, relMd);
}

export interface WriteSidecarInput extends SidecarPathInput {
  /** 转换器产出的 markdown / 文本内容。 */
  content: string;
}

/**
 * 原子写：`.tmp + rename`，与 LibraryService.put / queue/state.ts 同款。
 * 同一 sidecar 路径多并发写：tmp 名带 pid + 时间戳 + 随机数避碰，与 FileSystemConverterCache 同思路。
 * 返回写入的绝对路径。
 */
export function writeCacheSidecar(input: WriteSidecarInput): string {
  const target = cacheSidecarPath(input);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const unique = `${process.pid}.${Date.now().toString(36)}.${Math.floor(
    Math.random() * 1e9,
  ).toString(36)}`;
  const tmp = `${target}.${unique}.tmp`;
  fs.writeFileSync(tmp, input.content, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}
