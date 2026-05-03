import path from 'node:path';
import {
  type Converter,
  NoConverterError,
  UnknownConverterError,
} from './types.js';

/**
 * 转换器注册表。
 *
 * 解析顺序（resolve）：
 *   1) 若调用方给了 `force` 名字，按名查；找不到 → UnknownConverterError
 *   2) 否则按"扩展名命中 + match() 命中"过滤候选
 *   3) 候选按 priority 降序，第一个胜出
 *   4) 都不匹配 → NoConverterError
 *
 * 选择"最后注册不取代先注册"而是按 priority：宿主注入 priority=100 自然覆盖
 * 内置 priority=0；多次注册同名转换器视为更新（按 name 去重，新值覆盖旧值），
 * 这样模块热重载和测试不会越积越多。
 */
export class ConverterRegistry {
  private readonly byName = new Map<string, Converter>();

  register(converter: Converter): void {
    this.byName.set(converter.name, converter);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** 已注册转换器的全部 name（按注册顺序），主要给错误消息和 `/converters` 用。 */
  names(): string[] {
    return Array.from(this.byName.keys());
  }

  /** 全部已声明的扩展名（去重，小写，含点），watcher 用来生成 chokidar glob。 */
  extensions(): string[] {
    const set = new Set<string>();
    for (const c of this.byName.values()) {
      for (const e of c.extensions ?? []) set.add(e.toLowerCase());
    }
    return Array.from(set).sort();
  }

  list(): Converter[] {
    return Array.from(this.byName.values());
  }

  resolve(filePath: string, opts?: { force?: string }): Converter {
    if (opts?.force) {
      const c = this.byName.get(opts.force);
      if (!c) throw new UnknownConverterError(opts.force, this.names());
      return c;
    }
    const ext = path.extname(filePath).toLowerCase();
    const candidates: Converter[] = [];
    for (const c of this.byName.values()) {
      const extHit = ext && (c.extensions ?? []).map((e) => e.toLowerCase()).includes(ext);
      const fnHit = typeof c.match === 'function' ? !!c.match(filePath) : false;
      if (extHit || fnHit) candidates.push(c);
    }
    if (candidates.length === 0) {
      throw new NoConverterError(filePath, this.extensions());
    }
    // 高 priority 优先；并列时按 name 字典序保证稳定
    candidates.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.name.localeCompare(b.name);
    });
    return candidates[0];
  }
}
