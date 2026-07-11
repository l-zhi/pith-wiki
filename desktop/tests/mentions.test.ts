/**
 * `@`-mention 引用选择器纯逻辑单测（src/renderer/src/mentions.ts）。
 *
 * 关注：光标感知的 mention 检测、按层列举、下钻 / 确认改写。用一棵手搭的
 * MentionTreeDTO（= engine 下发形态）喂数据，不碰 React / bridge。
 */
import { describe, expect, it } from 'vitest';
import {
  confirmEntryValue,
  confirmSelfValue,
  descendValue,
  listLevel,
  parseMentionInput,
} from '../src/renderer/src/mentions';
import type { MentionTreeDTO } from '../src/shared/protocol.js';

// 技术相关/ 有一个直属条目 + 子目录 会议/；生活/ 有一个条目。
const tree: MentionTreeDTO = {
  root: {
    count: 3,
    entries: [],
    dirs: {
      技术相关: {
        count: 2,
        entries: [{ id: 'ts-config', title: 'TS 配置备忘', collection: '技术相关' }],
        dirs: {
          会议: {
            count: 1,
            entries: [{ id: '260609-wla', title: '对齐会议纪要', collection: '技术相关' }],
            dirs: {},
          },
        },
      },
      生活: {
        count: 1,
        entries: [{ id: 'recipe-1', title: '番茄炒蛋', collection: '生活' }],
        dirs: {},
      },
    },
  },
};

describe('parseMentionInput（光标感知）', () => {
  it('末尾 @ → 根层空 partial', () => {
    expect(parseMentionInput('问题 @', 4)).toEqual({ pathSegs: [], partial: '' });
  });

  it('光标在 @ 串中间时按光标前截断', () => {
    // 'a @tech b'，光标在 'te' 后（index 5）→ partial 'te'
    expect(parseMentionInput('a @tech b', 5)).toEqual({ pathSegs: [], partial: 'te' });
  });

  it('斜杠切分出已完成目录段 + partial', () => {
    expect(parseMentionInput('@技术相关/会', 7)).toEqual({ pathSegs: ['技术相关'], partial: '会' });
  });

  it('遇空白 / 第二个 @ 判定不在 mention 态', () => {
    expect(parseMentionInput('@tech done', 10)).toBeNull();
    expect(parseMentionInput('@a @b', 2)).not.toBeNull(); // 光标在第一个 token 内仍算
  });

  it('/ 开头（slash 命令）不触发', () => {
    expect(parseMentionInput('/digest @x', 10)).toBeNull();
  });
});

describe('listLevel（按目录层列举 + 过滤）', () => {
  it('根层列出集合目录，带子树 count', () => {
    const items = listLevel(tree, [], '');
    expect(items.map((i) => `${i.kind}:${i.segment}`)).toEqual(['dir:技术相关', 'dir:生活']);
    expect(items[0].count).toBe(2);
  });

  it('钻入集合列出直属条目 + 子目录', () => {
    const items = listLevel(tree, ['技术相关'], '');
    // 目录在前、条目在后
    expect(items.map((i) => `${i.kind}:${i.segment}`)).toEqual(['dir:会议', 'entry:ts-config']);
  });

  it('partial 大小写无关子串过滤 title / id / collection', () => {
    expect(listLevel(tree, ['技术相关'], 'config').map((i) => i.segment)).toEqual(['ts-config']);
    expect(listLevel(tree, [], '生活').map((i) => i.segment)).toEqual(['生活']);
  });
});

describe('改写函数（返回 { value, cursor }）', () => {
  it('descendValue 下钻目录：无尾空格，光标落在末尾', () => {
    const edit = descendValue('@', 1, [], '技术相关');
    expect(edit).toEqual({ value: '@技术相关/', cursor: 6 });
  });

  it('confirmEntryValue 丢弃路径前缀、插入裸 @id + 尾空格', () => {
    const edit = confirmEntryValue('@技术相关/会议/', 9, '260609-wla');
    expect(edit).toEqual({ value: '@260609-wla ', cursor: 12 });
  });

  it('保留光标后的既有文本', () => {
    // '@ 尾巴'，光标在 @ 后（index 1）→ 替换只动光标前
    const edit = descendValue('@ 尾巴', 1, [], '生活');
    expect(edit.value).toBe('@生活/ 尾巴');
    expect(edit.cursor).toBe(4);
  });

  it('confirmSelfValue 在 root 层 = 删掉 @（整库，无范围）', () => {
    expect(confirmSelfValue('问题 @', 4, [])).toEqual({ value: '问题 ', cursor: 3 });
  });

  it('confirmSelfValue 在集合/子目录层 = 钉住当前文件夹整体', () => {
    expect(confirmSelfValue('@技术相关/', 6, ['技术相关'])).toEqual({
      value: '@技术相关/ ',
      cursor: 7,
    });
    expect(confirmSelfValue('@工作/2024/', 9, ['工作', '2024'])).toEqual({
      value: '@工作/2024/ ',
      cursor: 10,
    });
  });
});
