/**
 * 从源文件名派生 entry id。
 *
 * 引入原因：LLM 自选 id 在中文场景下不稳定——观察到把
 *   "成本1500，估值1000万？'死了么'APP凭什么火了.md"
 * 压成短钩子词 "死了么" 或 "死了么-凭什么火"，丢失了成本/估值/复盘等关键角度。
 *
 * 工程化解：filename 已经携带了源作者精心选择的"特异性信息"，直接拿来当 id 比
 * 让 LLM 二次发挥更可靠。本函数只做**确定性清洗**：
 *
 *   1. 去常见文档扩展名（.md / .markdown / .txt / .pdf / .docx / .html ...）
 *   2. ASCII 字母小写化（CJK 不区分大小写）
 *   3. 所有非 id 合法字符（含全角标点、引号、空格、中文标点）→ 单个 ASCII 连字符
 *   4. 折叠连续 `-`，去掉首尾 `-`
 *   5. 截长（超出 maxChars 时去尾，再清理可能的尾部 `-`）
 *
 * 输出落入 ID_RE 允许的字符集（a-z 0-9 + Han / Kana / Hangul + `-`），可直接用作
 * `<wikiRoot>/<collection>/<id>.md` 的文件名而无需再次转义。
 *
 * 不做的事：
 *   - 不去重——同名不同源的文件由调用方负责处理（hydration 暂不解决，文档已注明）
 *   - 不补 fallback——清洗后空字符串就返空字符串，让调用方自行决定回退到 LLM id
 *   - 不音译——拼音/罗马音不在职责范围内（拼音算法体积大、效果差）
 */

/**
 * 允许出现在 id 里的合法字符集，与 ID_RE 一致。
 * 任何不在这里的字符都会被替换为 `-`。
 *
 * 包含：
 *   - ASCII：小写字母、数字（大写在前一步先小写化处理）
 *   - Han：CJK 统一汉字 + 扩展 A + 兼容汉字（用 \p{Script=Han} 全覆盖）
 *   - Hiragana / Katakana：日文假名
 *   - Hangul：韩文谚文
 */
const ALLOWED_CHAR_RE =
  /[^a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * 常见文档扩展名（不区分大小写）。
 * 列得完是为了让 `note.PDF` 这种也能正确去尾，而不是把扩展名 `pdf` 当成 id 一部分。
 */
const EXT_RE = /\.(?:md|markdown|mdx|txt|pdf|docx?|html?|rst|org)$/i;

/**
 * 把 filename 转成合法的 id 字符串。
 *
 * @param filename 源文件名（可带或不带扩展名，可含路径分隔——会被替换成 `-`）
 * @param maxChars 截长上限。默认 60，按经验：6-14 汉字 ≈ 18-42 字节 UTF-8，
 *                 60 字符已经能容纳"中英混合 + 标点拆出来的多个段"且不至于太丑。
 * @returns 清洗后的 id；若全是非法字符（如 "___.md"）则返空字符串
 */
export function deriveIdFromFilename(filename: string, maxChars = 60): string {
  if (!filename) return '';

  // 1. 去扩展名
  let s = filename.replace(EXT_RE, '');

  // 2. ASCII 小写化（toLowerCase 对 CJK 是 no-op，对全角拉丁也按预期工作）
  s = s.toLowerCase();

  // 3. 非合法字符 → 单个 `-`。`+` 让连续的非法字符（如 "，"+空格）只产生一个 `-`
  s = s.replace(ALLOWED_CHAR_RE, '-');

  // 4. 折叠 + trim。先 trim 再折叠也行，顺序无关；这里先折叠语义更清晰
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  // 5. 截长。如果截断恰好停在 `-` 上，再 trim 一次防止尾随 `-`
  if (s.length > maxChars) {
    s = s.slice(0, maxChars).replace(/-+$/, '');
  }

  return s;
}
