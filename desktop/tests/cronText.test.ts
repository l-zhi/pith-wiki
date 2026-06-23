import { describe, expect, it } from 'vitest';
import { buildCron, parseCron, describeCron, parseTime } from '../src/renderer/src/cronText.js';

describe('cronText build/parse round-trip', () => {
  it('daily', () => {
    expect(buildCron({ freq: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *');
    expect(parseCron('0 9 * * *')).toEqual({ freq: 'daily', hour: 9, minute: 0 });
  });

  it('weekly (single + multi day, sorted, deduped)', () => {
    expect(buildCron({ freq: 'weekly', hour: 9, minute: 30, days: [1] })).toBe('30 9 * * 1');
    expect(buildCron({ freq: 'weekly', hour: 8, minute: 0, days: [3, 1, 1, 5] })).toBe(
      '0 8 * * 1,3,5',
    );
    expect(parseCron('0 8 * * 1,3,5')).toEqual({
      freq: 'weekly',
      hour: 8,
      minute: 0,
      days: [1, 3, 5],
    });
  });

  it('weekly normalizes dow 7 → 0 (Sunday)', () => {
    expect(parseCron('0 9 * * 7')).toEqual({ freq: 'weekly', hour: 9, minute: 0, days: [0] });
  });

  it('monthly', () => {
    expect(buildCron({ freq: 'monthly', hour: 9, minute: 0, dom: 15 })).toBe('0 9 15 * *');
    expect(parseCron('0 9 15 * *')).toEqual({ freq: 'monthly', hour: 9, minute: 0, dom: 15 });
  });

  it('returns null for advanced expressions (falls back to custom)', () => {
    expect(parseCron('*/15 9 * * *')).toBeNull(); // step minute
    expect(parseCron('0 9-17 * * *')).toBeNull(); // hour range
    expect(parseCron('0 9 1 6 *')).toBeNull(); // month constrained
    expect(parseCron('0 9 * *')).toBeNull(); // 4 fields
  });

  it('describeCron (zh / en)', () => {
    expect(describeCron('0 9 * * *', 'zh-CN')).toBe('每天 09:00');
    expect(describeCron('0 9 * * *', 'en')).toBe('Daily at 09:00');
    expect(describeCron('0 9 15 * *', 'zh-CN')).toBe('每月 15 号 09:00');
    expect(describeCron('*/15 9 * * *', 'en')).toBe('*/15 9 * * *'); // unparseable → raw
    // weekly contains the time and is locale-shaped (weekday names are Intl-localized)
    expect(describeCron('30 8 * * 1', 'en')).toContain('08:30');
    expect(describeCron('30 8 * * 1', 'zh-CN')).toContain('每周');
  });

  it('parseTime', () => {
    expect(parseTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('garbage')).toEqual({ hour: 9, minute: 0 });
  });
});
