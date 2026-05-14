/**
 * scoring.ts 单元测试。
 *
 * 测试目标：
 *   - tokenize 在中英混合 / 纯 CJK / 纯 ASCII 三类输入下的行为符合预期
 *   - topNByQuery 的截断 + 同分稳定排序 + 空查询/空集兜底
 *
 * 不依赖 LibraryService、不读盘——纯函数测试，毫秒级。
 */
import { describe, expect, it } from 'vitest';
import { tokenize, topNByQuery, scoreEntry } from '../src/wiki/scoring.js';
import type { Entry } from '../src/wiki/types.js';

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    title: o.title ?? '',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? '',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

describe('tokenize', () => {
  it('ASCII 词：长度 > 1 才保留，全部小写', () => {
    expect(tokenize('Hello World a I')).toEqual(['hello', 'world']);
  });

  it('CJK 输入产生 bigram', () => {
    expect(tokenize('成长和低谷期')).toEqual(['成长', '长和', '和低', '低谷', '谷期']);
  });

  it('中英混合：两条管线并行产出', () => {
    const tokens = tokenize('OpenAI 工具');
    expect(tokens).toContain('openai');
    expect(tokens).toContain('工具');
  });

  it('空字符串返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('单字 CJK 不产生 token（bigram 需要至少 2 字）', () => {
    expect(tokenize('好')).toEqual([]);
  });

  it('标点切割 CJK 段，不跨段做 bigram', () => {
    // "成长，低谷" 应该切成 ["成长"] + ["低谷"]，"长，" 之类不会出现
    const tokens = tokenize('成长，低谷');
    expect(tokens).toEqual(['成长', '低谷']);
  });
});

describe('scoreEntry — 权重公式', () => {
  it('title 命中权重为 2', () => {
    const e = entry({ title: 'rust' });
    const q = new Set(tokenize('rust'));
    expect(scoreEntry(e, q)).toBe(2);
  });

  it('tags 命中权重也为 2', () => {
    const e = entry({ tags: ['rust'] });
    const q = new Set(tokenize('rust'));
    expect(scoreEntry(e, q)).toBe(2);
  });

  it('summary 命中权重 1', () => {
    const e = entry({ summary: 'about rust' });
    const q = new Set(tokenize('rust'));
    expect(scoreEntry(e, q)).toBe(1);
  });

  it('content 命中权重 0.5', () => {
    const e = entry({ content: 'rust rust' }); // 2 次命中 × 0.5
    const q = new Set(tokenize('rust'));
    expect(scoreEntry(e, q)).toBe(1);
  });

  it('完全不命中 → 0', () => {
    const e = entry({ title: 'python' });
    const q = new Set(tokenize('rust'));
    expect(scoreEntry(e, q)).toBe(0);
  });
});

describe('topNByQuery', () => {
  it('按分数降序返回，限 N 条', () => {
    const entries = [
      entry({ id: 'a', title: 'rust' }), // 2
      entry({ id: 'b', title: 'rust language', tags: ['rust'] }), // 2 + 2 = 4
      entry({ id: 'c', content: 'rust' }), // 0.5
    ];
    const result = topNByQuery('rust', entries, 2);
    expect(result.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('同分时按输入顺序稳定（更新时间近的在前——调用方约定）', () => {
    const entries = [
      entry({ id: 'a', title: 'rust' }),
      entry({ id: 'b', title: 'rust' }),
      entry({ id: 'c', title: 'rust' }),
    ];
    const result = topNByQuery('rust', entries, 3);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('score=0 的 entry 不返', () => {
    const entries = [
      entry({ id: 'a', title: 'rust' }),
      entry({ id: 'b', title: 'python' }),
    ];
    const result = topNByQuery('rust', entries, 10);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('空查询 → 空结果', () => {
    expect(topNByQuery('', [entry({ id: 'a', title: 'rust' })], 5)).toEqual([]);
  });

  it('空 entries → 空结果', () => {
    expect(topNByQuery('rust', [], 5)).toEqual([]);
  });

  it('topN=0 → 空结果', () => {
    expect(topNByQuery('rust', [entry({ id: 'a', title: 'rust' })], 0)).toEqual([]);
  });

  it('topN 大于命中数 → 返回所有命中', () => {
    const entries = [
      entry({ id: 'a', title: 'rust' }),
      entry({ id: 'b', title: 'rust' }),
    ];
    const result = topNByQuery('rust', entries, 100);
    expect(result.length).toBe(2);
  });

  it('CJK：bigram 命中也算', () => {
    const entries = [
      entry({ id: 'a', title: '成长经历' }), // bigram "成长" 命中
      entry({ id: 'b', title: 'python' }),
    ];
    const result = topNByQuery('成长和低谷期', entries, 5);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });
});
