import fs from 'node:fs';
import path from 'node:path';

/**
 * 转换器 sidecar：把非 markdown 源（PDF / DOCX / HTML / TXT …）转换后的 .md
 * 落地到 entry 所在目录下的 `.cache/` 子目录，供 wiki_read_source 直接读取。
 *
 * 布局规则（贴着 entry 走）：
 *   - entry 在 `<wikiRoot>/<collection>/<id>.md`        → sidecar `<wikiRoot>/<collection>/.cache/<basename>.md`
 *   - entry 在 `<wikiRoot>/<collection>/<sub>/<id>.md`  → sidecar `<wikiRoot>/<collection>/<sub>/.cache/<basename>.md`
 *
 * 设计意图：sidecar 永远就在 entry 旁边，浏览文件夹时一眼看出来源；
 * `.cache/` 内部不再嵌套子目录，扁平存放当前层级 entry 的所有原文转写。
 *
 * 与 `cache.ts`（sha-keyed JSON cache，纯性能层）的关系：
 *   - sha cache：避免重跑 pdf-parse 之类昂贵转换（按字节内容键控，单库一份）
 *   - sidecar：给 LLM / 人类一份可读 markdown，并作为 entry.source.cachePath 的目标
 *
 * 命名规则：
 *   - 文件名 = 源文件 basename 去掉扩展名后加 `.md`（无扩展名直接补 .md）
 *   - 中文 / 空格 / 标点都允许，与 LibraryService 同等宽松
 *
 * 不写 sidecar 的场景：markdown-passthrough / text-passthrough —— 源已是可读文本，
 * 再 copy 一份冗余。调用方判断 converter.name 后决定是否调用本模块。
 */

const CACHE_DIR_NAME = '.cache';

export interface SidecarPathInput {
  wikiRoot: string;
  collection: string;
  /** Entry 在 collection 内的相对子路径（POSIX 形式）。空 / 缺省 = collection 根。 */
  subpath?: string;
  /** 原始源文件绝对路径（PDF / DOCX / …），仅用其 basename + 扩展名。 */
  absFile: string;
}

/**
 * 纯函数：给定参数返回 sidecar 应落地的绝对路径。不创建目录、不写文件。
 */
export function cacheSidecarPath(input: SidecarPathInput): string {
  const ext = path.extname(input.absFile);
  const stem = ext ? path.basename(input.absFile, ext) : path.basename(input.absFile);
  const fileName = `${stem}.md`;
  const segs = input.subpath ? input.subpath.split('/').filter(Boolean) : [];
  const dir = path.join(input.wikiRoot, input.collection, ...segs, CACHE_DIR_NAME);
  return path.join(dir, fileName);
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
