import fs from 'node:fs';
import path from 'node:path';

/**
 * 每个 job 一个 append-only 文本日志，路径 `<queueLogDir>/<jobId>.log`。
 *
 * 用 `appendFileSync` 而不是异步流：
 *   - 行长度都很短（最多几百字节），同步开销可忽略；
 *   - 出错路径上必须保证日志真落盘（Ctrl-C 或异常退出时不能丢）；
 *   - 每个 job 写量 < 数十行，根本谈不上性能压力。
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface JobLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** 关闭句柄。当前实现是 no-op（每次写都是独立 syscall）。 */
  close(): void;
  /** 返回 log 文件的绝对路径，方便用户 `tail -f`。 */
  readonly path: string;
}

export function openJobLog(logDir: string, jobId: string): JobLogger {
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, `${jobId}.log`);

  function write(level: LogLevel, msg: string): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5, ' ')} ${msg}\n`;
    fs.appendFileSync(filePath, line, 'utf8');
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    close: () => {},
    path: filePath,
  };
}
