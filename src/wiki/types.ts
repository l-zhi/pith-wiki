import { z } from 'zod';

/**
 * 合法的 entry id 正则。允许两种命名风格混用：
 *   - ASCII kebab-case：`a-z 0-9 -`（沿用旧规则；英文条目走这条）
 *   - CJK：汉字 / 假名 / 谚文，可与 ASCII 段用连字符拼接（中文条目走这条）
 *
 * 用 Unicode property escape（`\p{Script=Han}` 等）需要 `u` flag。覆盖：
 *   - Han: 中日韩通用汉字 + 扩展
 *   - Hiragana / Katakana: 日文假名
 *   - Hangul: 韩文谚文
 *
 * 拒绝：
 *   - 大写 ASCII（保留 kebab-case 的视觉一致性）
 *   - 空格 / 点 / 路径分隔符（避免破坏 `<id>.md` 的文件名安全）
 *   - 引导连字符（避免 `-foo` 这种隐藏文件式 id）
 *
 * 文件系统兼容：macOS / Linux / Windows 都接 UTF-8 文件名；这里产出的 id 直接
 * 作为 `<wikiRoot>/<collection>/<id>.md` 的文件名落地，不再做二次转义。
 *
 * 兼容旧条目：旧的纯 ASCII kebab-case ids 仍属于新正则的子集，迁移零成本。
 */
export const ID_RE = /^[a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}-]*$/u;

export const SourceSchema = z.object({
  type: z.enum(['url', 'file', 'inline', 'unknown']),
  value: z.string().optional(),
  /**
   * 转换器名（来自 ConverterRegistry）。
   * 当 source.type='file' 且文件经历过 converter pipeline 时填入；
   * 老 entry 没这字段照样 parse。
   */
  convertedBy: z.string().optional(),
  /**
   * 转换器产出的 markdown sidecar 绝对路径。
   * 仅当 converter 是非 passthrough（pdf / docx / html / text 等）时填入；
   * markdown-passthrough 不写 sidecar，该字段留空。
   * wiki_read_source 优先读这个文件（拿到的是 LLM 可读的 markdown 而不是二进制 PDF/DOCX）。
   * value 仍指向原始路径，作为溯源；老 entry 没这字段照样 parse。
   */
  cachePath: z.string().optional(),
});

/**
 * 子路径校验：entry 在 collection 内的相对目录。
 *
 * 设计原则：
 *   - POSIX 风格的 `/` 分隔（即使在 Windows 上落盘前再 path.join，schema 内统一 POSIX）
 *   - 缺省 / 空串 = collection 根（旧行为）
 *   - 拒绝绝对路径 / `..` 段：防止逃出 collection 目录
 *   - 拒绝以 `.` 开头的段：与 LibraryService 跳过 dotdir 的策略对齐，避免与 `.cache/` 撞车
 *   - 拒绝段内 `/` 重复、首尾 `/`、空段：保持唯一规范形态
 *   - 不限制段内字符（中文、空格、标点都允许），只挡危险字符 `\0` 和路径分隔符变体
 */
export function isValidSubpath(s: string): boolean {
  if (s === '') return true;
  if (s.startsWith('/') || s.endsWith('/')) return false;
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg) return false; // 空段（连续 //）
    if (seg === '.' || seg === '..') return false;
    if (seg.startsWith('.')) return false; // dotdir 段
    if (seg.includes('\0') || seg.includes('\\')) return false;
  }
  return true;
}

export const SubpathSchema = z
  .string()
  .refine(isValidSubpath, {
    message:
      'subpath must be POSIX-style relative path (no leading/trailing slash, no .. or dot segments, no \\ or NUL)',
  });

export const EntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      ID_RE,
      'id must be kebab-case (a-z, 0-9, -) or CJK characters (Han / Kana / Hangul); no spaces, dots, uppercase, or leading hyphen',
    ),
  collection: z.string().min(1),
  /**
   * Entry 在 collection 目录内的相对子路径（POSIX 形式，`/` 分隔）。
   * 缺省 / 空串 = collection 根（旧 flat 行为）。
   * watcher collectionFromSubdir 模式下，segs[0] 用作 collection，segs[1..-1] 拼成 subpath。
   * 落盘路径：`<wikiRoot>/<collection>/<subpath>/<id>.md`。
   */
  subpath: SubpathSchema.optional(),
  title: z.string().min(1),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  content: z.string(),
  source: SourceSchema.default({ type: 'unknown' }),
  updated: z.string(),
  compressionRatio: z.number().min(0).max(1).optional(),
});

export type Entry = z.infer<typeof EntrySchema>;
export type Source = z.infer<typeof SourceSchema>;

export const HydrationOutputSchema = z.object({
  id: z.string().min(1).regex(ID_RE),
  title: z.string().min(1),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  content: z.string().min(1),
});
export type HydrationOutput = z.infer<typeof HydrationOutputSchema>;
