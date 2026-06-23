import { describe, expect, it } from 'vitest';
import { resolveDatePlaceholders, hasDatePlaceholder } from '../src/shared/placeholders.js';

// 固定基准日：2026-06-17（周三，本地时区）
const base = new Date(2026, 5, 17, 10, 30, 0);

describe('resolveDatePlaceholders', () => {
  it('today, common formats', () => {
    expect(resolveDatePlaceholders('${yyyy-mm-dd}', base)).toBe('2026-06-17');
    expect(resolveDatePlaceholders('${yyyy/mm/dd}', base)).toBe('2026/06/17');
    expect(resolveDatePlaceholders('${yyyy年mm月dd日}', base)).toBe('2026年06月17日');
    expect(resolveDatePlaceholders('${yy-m-d}', base)).toBe('26-6-17');
    expect(resolveDatePlaceholders('${yyyy-mm}', base)).toBe('2026-06');
  });

  it('day offsets', () => {
    expect(resolveDatePlaceholders('${yyyy-mm-dd -1}', base)).toBe('2026-06-16'); // 昨天
    expect(resolveDatePlaceholders('${yyyy-mm-dd +1}', base)).toBe('2026-06-18'); // 明天
    expect(resolveDatePlaceholders('${yyyy-mm-dd -7}', base)).toBe('2026-06-10');
  });

  it('week / month / year offsets', () => {
    expect(resolveDatePlaceholders('${yyyy-mm-dd -1w}', base)).toBe('2026-06-10');
    expect(resolveDatePlaceholders('${yyyy-mm -1m}', base)).toBe('2026-05');
    expect(resolveDatePlaceholders('${yyyy -1y}', base)).toBe('2025');
  });

  it('crosses month/year boundaries', () => {
    const jun1 = new Date(2026, 5, 1, 9, 0, 0);
    expect(resolveDatePlaceholders('${yyyy-mm-dd -1}', jun1)).toBe('2026-05-31');
    const jan1 = new Date(2026, 0, 1, 9, 0, 0);
    expect(resolveDatePlaceholders('${yyyy-mm-dd -1}', jan1)).toBe('2025-12-31');
  });

  it('multiple placeholders in one string', () => {
    expect(
      resolveDatePlaceholders(
        '整理 ${yyyy-mm-dd -1} 的内容，命名为 ${yyyy-mm-dd -1}-每日新知',
        base,
      ),
    ).toBe('整理 2026-06-16 的内容，命名为 2026-06-16-每日新知');
  });

  it('leaves non-date ${...} untouched (no year token)', () => {
    expect(resolveDatePlaceholders('${FOO} and ${random} and ${HH:mm}', base)).toBe(
      '${FOO} and ${random} and ${HH:mm}',
    );
  });

  it('hasDatePlaceholder', () => {
    expect(hasDatePlaceholder('整理 ${yyyy-mm-dd -1}')).toBe(true);
    expect(hasDatePlaceholder('plain text')).toBe(false);
    expect(hasDatePlaceholder('${FOO}')).toBe(false);
  });
});
