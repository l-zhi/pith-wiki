import type { ConverterRegistry } from '../wiki/converters/registry.js';

/**
 * 把 ConverterRegistry 列成给人看的多行字符串（一行一条）。
 *
 * 输出示例：
 *   Registered converters:
 *     pdf-parse        v1   p=0    .pdf
 *     markdown-passthrough v1 p=0  .md, .markdown
 *
 * REPL 的 /converters slash 和 CLI 的 `llm-wiki converters` 共用同一个格式化函数，
 * 避免两处实现长歪。
 */
export function formatConvertersTable(registry: ConverterRegistry): string {
  const rows = registry.list();
  if (rows.length === 0) return 'No converters registered.';
  const lines = ['Registered converters:'];
  // 计算名字列宽：最长 name + 1
  const nameWidth = Math.max(...rows.map((c) => c.name.length));
  // 按 priority 降序、然后名字升序，跟 resolve 顺序一致
  const sorted = [...rows].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    return a.name.localeCompare(b.name);
  });
  for (const c of sorted) {
    const name = c.name.padEnd(nameWidth);
    const ver = (c.version ?? '1').padEnd(3);
    const prio = `p=${c.priority ?? 0}`.padEnd(5);
    const exts = (c.extensions ?? []).join(', ') || '(no extensions)';
    lines.push(`  ${name}  ${ver}  ${prio}  ${exts}`);
  }
  return lines.join('\n');
}
