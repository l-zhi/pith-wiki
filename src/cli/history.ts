import fs from 'node:fs';

/**
 * REPL 历史命令的磁盘持久化与加载。
 *
 * 文件格式：每行一条命令，UTF-8。提交时 append 一行；启动时读尾部 N 行。
 * 文件本身不做大小限制（让用户的 grep / 编辑器可以自由检索全部历史），
 * 仅加载时按 limit 截取尾部。
 */

/** 从历史文件加载最后 limit 行；按时间升序（最旧在前、最新在后）。 */
export function loadHistory(file: string, limit: number): string[] {
  // 提前短路：limit ≤ 0 直接空数组。
  // （注意：JS 里 arr.slice(-0) 等价于 arr.slice(0) 会返回整个数组，必须在这里挡住。）
  if (limit <= 0) return [];
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    return lines.slice(-limit);
  } catch {
    // 历史功能是"锦上添花"，IO 失败时返回空数组而不是让 REPL 起不来。
    return [];
  }
}

/** 把单条命令追加到历史文件末尾，自动加换行。失败静默吞掉。 */
export function appendHistory(file: string, line: string): void {
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Non-fatal.
  }
}
