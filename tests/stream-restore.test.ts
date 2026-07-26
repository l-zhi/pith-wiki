/**
 * 流式占位符还原（迁移路线 A 的前置件）。
 *
 * 核心不变量：**任意切片方式**下，逐 chunk push + flush 的拼接结果，必须等于把整段
 * 文本一次性 restore 的结果。调研报告把「流式下的 mask 还原」列为 A 的最大隐性成本，
 * 这里用穷举切点 + 随机切片把它钉死。
 */
import { describe, expect, it } from 'vitest';
import { compilePresets, Sanitizer } from '../src/security/index.js';
import { createStreamRestorer } from '../src/security/streamRestore.js';

const PHONE = '13800138000';
const PHONE2 = '13911112222';

function maskingSanitizer(): Sanitizer {
  return new Sanitizer(
    compilePresets({ phone: 'mask', idCard: 'off', bankCard: 'off', email: 'off', apiKey: 'off' }),
  );
}

/** 先脱敏一段文本，拿到「模型会回给我们的」占位符文本 + 同一个 sanitizer（映射表在里面）。 */
function maskedText(text: string): { sanitizer: Sanitizer; masked: string } {
  const sanitizer = maskingSanitizer();
  const masked = sanitizer.sanitize(text).text;
  return { sanitizer, masked };
}

function pushAll(sanitizer: Sanitizer, chunks: string[]): string {
  const r = createStreamRestorer(sanitizer);
  let out = '';
  for (const c of chunks) out += r.push(c);
  out += r.flush();
  return out;
}

describe('createStreamRestorer', () => {
  it('占位符被切在两个 chunk 之间也能还原（逐字符喂）', () => {
    const { sanitizer, masked } = maskedText(`我的号码是 ${PHONE}，记好了`);
    expect(masked).toContain('[PHONE_1]');
    const out = pushAll(sanitizer, [...masked]); // 一个字符一个 chunk：最坏情况
    expect(out).toBe(`我的号码是 ${PHONE}，记好了`);
  });

  it('穷举所有切点：任何一刀切下去结果都与整段 restore 一致', () => {
    const { sanitizer, masked } = maskedText(`前面 ${PHONE} 中间 ${PHONE2} 后面`);
    const expected = sanitizer.restore(masked).text;
    for (let i = 0; i <= masked.length; i++) {
      const out = pushAll(sanitizer, [masked.slice(0, i), masked.slice(i)]);
      expect(out, `切点 ${i}`).toBe(expected);
    }
  });

  it('随机多刀切片（3 段）同样一致', () => {
    const { sanitizer, masked } = maskedText(`A ${PHONE} B ${PHONE2} C`);
    const expected = sanitizer.restore(masked).text;
    for (let i = 0; i < masked.length; i++) {
      for (const j of [i, Math.min(i + 3, masked.length), masked.length]) {
        const out = pushAll(sanitizer, [masked.slice(0, i), masked.slice(i, j), masked.slice(j)]);
        expect(out, `切点 ${i}/${j}`).toBe(expected);
      }
    }
  });

  it('未闭合的方括号正文不会被永久扣住（flush 原样吐出）', () => {
    const sanitizer = maskingSanitizer();
    const r = createStreamRestorer(sanitizer);
    let out = r.push('见附录 [TODO');
    out += r.flush();
    expect(out).toBe('见附录 [TODO');
  });

  it('尾巴超过上限就不再扣留（避免一段全大写正文卡住输出）', () => {
    const sanitizer = maskingSanitizer();
    const r = createStreamRestorer(sanitizer);
    const long = `[${'A'.repeat(80)}`;
    // 长尾巴不可能是占位符 → 立刻放行，不等 flush
    expect(r.push(long)).toBe(long);
  });

  it('映射表里查不到的占位符计入 leftover 并原样保留', () => {
    const sanitizer = maskingSanitizer();
    const r = createStreamRestorer(sanitizer);
    let out = r.push('未知 [PHO');
    out += r.push('NE_9] 结束');
    out += r.flush();
    expect(out).toBe('未知 [PHONE_9] 结束');
    expect(r.leftover).toBe(1);
  });

  it('同一占位符多次出现（跨 chunk 重复）都被还原', () => {
    const { sanitizer, masked } = maskedText(`${PHONE} 和 ${PHONE} 是同一个`);
    const out = pushAll(sanitizer, [...masked]);
    expect(out).toBe(`${PHONE} 和 ${PHONE} 是同一个`);
  });

  it('jsonEscape 语义与一次性 restore 对齐（tool_calls 参数流用）', () => {
    const sanitizer = maskingSanitizer();
    const withQuote = `他说"${PHONE}"`;
    const masked = sanitizer.sanitize(withQuote).text;
    const expected = sanitizer.restore(masked, { jsonEscape: true }).text;
    const r = createStreamRestorer(sanitizer, { jsonEscape: true });
    let out = '';
    for (const c of masked) out += r.push(c);
    out += r.flush();
    expect(out).toBe(expected);
  });
});
