/**
 * 文件 → 文本转换器的公共接口。
 *
 * 一个 Converter 把"文件路径 + 字节"变成"喂给 hydrator 的 markdown/纯文本"。
 * 例如：
 *   - markdown-passthrough：直接 utf8 解码
 *   - pdf-parse：调 pdf-parse 抽取文字
 *   - 自定义：宿主可以注册任意实现（OCR、网页清洗、模板展开 ……）
 *
 * 设计要点：
 *   - 80% 转换器只关心扩展名 → 用 `extensions: string[]` 声明即可；少数场景
 *     （按 MIME / 文件头 magic bytes 判断）可实现 `match(filePath, mime?)`
 *   - 同一扩展名可以注册多个，`priority` 决定优先级（高者胜）。内置默认 0，
 *     宿主注入默认 100，自然覆盖
 *   - `version` 是缓存 key 的一部分。升级转换器逻辑时递增让旧缓存失效
 *   - `convert` 必须是无状态的 —— 同一份 input 多次调用应得到同一份 output
 *     （否则缓存不可信）
 */

export interface Converter {
  /** 全局唯一名字，CLI --converter 与 collections.<x>.converter 都引用它。 */
  name: string;
  /** 内部版本号；升级实现时递增让旧缓存失效。默认 '1'。 */
  version?: string;
  /** 同扩展名多个匹配时高者胜。内置默认 0；宿主注入建议 100。 */
  priority?: number;
  /** 能处理的扩展名（小写、含点，如 '.pdf'）。与 match() 二选一/可叠加。 */
  extensions?: string[];
  /** 自定义匹配；返回 true 视为可处理。与 extensions 同时存在则任一命中即可。 */
  match?(filePath: string, mime?: string): boolean;
  convert(input: ConvertInput, ctx: ConvertContext): Promise<ConvertOutput>;
}

export interface ConvertInput {
  /** 绝对路径。某些转换器需要它来定位同目录资源（图片、附件）。 */
  filePath: string;
  /** 原始字节。某些转换器（pdf-parse / mammoth）直接吃 Buffer 更高效。 */
  bytes: Buffer;
}

export interface ConvertOutput {
  /** 喂给 hydrator 的 markdown / 纯文本。空字符串会被上游判为转换失败。 */
  content: string;
  /** 可选元数据：标题、页数、警告等。会被一起写进缓存，便于 UI 展示。 */
  meta?: ConvertMeta;
}

export interface ConvertMeta {
  title?: string;
  pages?: number;
  warnings?: string[];
  /** 给宿主转换器的逃生舱口，避免我们这里把 meta 形状钉死。 */
  [extra: string]: unknown;
}

export interface ConvertContext {
  /** 请求被取消（CLI Ctrl+C / Electron 关页）时触发；转换器要尽快退出。 */
  signal?: AbortSignal;
  /**
   * 长任务进度回调。processJob 把它桥接到 queue events，宿主 UI 可订阅。
   * 不强制调用——快速转换器（passthrough）忽略即可。
   */
  onProgress?(p: ConvertProgress): void;
  /**
   * 转换器临时工作目录（已 mkdir）。OCR / PDF 抽图 / 解压可能需要。
   * 调用方负责清理；转换器不要假设目录会持久化。
   */
  workDir?: string;
}

export interface ConvertProgress {
  /** 阶段标识，自由文本（'parsing'、'ocr-page'、'rendering' 等）。 */
  phase: string;
  cur?: number;
  total?: number;
}

/**
 * 上游统一抛出的 "转换器把垃圾喂上来"——空内容、纯空白等。
 * 队列 worker 把它当永久失败（status='dead'，不退避重试）：因为重试一定还是空。
 */
export class EmptyConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyConversionError';
  }
}

/** 用户用 --converter <name> 指定了一个不存在的转换器。 */
export class UnknownConverterError extends Error {
  constructor(name: string, registered: string[]) {
    super(
      `unknown converter "${name}". registered: ${registered.length ? registered.join(', ') : '(none)'}`,
    );
    this.name = 'UnknownConverterError';
  }
}

/** 没有任何转换器声明能处理这个文件。 */
export class NoConverterError extends Error {
  constructor(filePath: string, registeredExts: string[]) {
    super(
      `no converter matched ${filePath}. registered extensions: ${registeredExts.length ? registeredExts.join(', ') : '(none)'}`,
    );
    this.name = 'NoConverterError';
  }
}
