import { describe, expect, it } from 'vitest';
import {
  NOTICE_COLLAPSE_LIMIT,
  selectVisibleNotices,
  type Notice,
} from '../src/renderer/src/components/noticeModel';

const notices = (count: number): Notice[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `n${index + 1}`,
    level: 'info',
    text: `notice ${index + 1}`,
  }));

describe('NoticeCenter folding', () => {
  it('shows every notice while the total is within the limit', () => {
    expect(selectVisibleNotices(notices(NOTICE_COLLAPSE_LIMIT), false)).toHaveLength(3);
  });

  it('shows only the three newest notices when collapsed', () => {
    expect(selectVisibleNotices(notices(5), false).map((notice) => notice.id)).toEqual([
      'n3',
      'n4',
      'n5',
    ]);
  });

  it('shows every notice when expanded', () => {
    expect(selectVisibleNotices(notices(5), true)).toHaveLength(5);
  });
});
