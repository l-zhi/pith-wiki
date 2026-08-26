export interface Notice {
  id: string;
  level: string;
  text: string;
}

export const NOTICE_COLLAPSE_LIMIT = 3;

/** 折叠时只保留最新的通知；展开时按原顺序显示全部。 */
export function selectVisibleNotices(notices: Notice[], expanded: boolean): Notice[] {
  if (expanded || notices.length <= NOTICE_COLLAPSE_LIMIT) return notices;
  return notices.slice(-NOTICE_COLLAPSE_LIMIT);
}
