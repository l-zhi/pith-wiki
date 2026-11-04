import type React from 'react';

/** 统一交给系统打开：http(s) → 浏览器，本地路径 / file:// → 默认应用。会把 file:// 转成文件系统路径并解码。 */
export function openTarget(raw: string) {
  let target = raw.trim();
  if (target.startsWith('file://')) target = target.replace(/^file:\/\//, '');
  if (!/^https?:\/\//i.test(target)) {
    try {
      target = decodeURIComponent(target);
    } catch {
      /* 非法转义序列则用原值 */
    }
  }
  void window.pith.openSource(target);
}

/** Markdown 链接统一交给系统打开（聊天 + 阅读器），绝不让窗口内跳走。 */
export function LocalLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href ?? '#'}
      onClick={(e) => {
        e.preventDefault();
        if (href) openTarget(href);
      }}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </a>
  );
}
