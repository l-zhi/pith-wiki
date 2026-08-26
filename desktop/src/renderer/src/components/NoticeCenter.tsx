import React from 'react';
import { useTranslation } from 'react-i18next';
import { NOTICE_COLLAPSE_LIMIT, selectVisibleNotices, type Notice } from './noticeModel';

interface NoticeCenterProps {
  notices: Notice[];
  onDismiss(id: string): void;
  onDismissAll(): void;
}

export function NoticeCenter({ notices, onDismiss, onDismissAll }: NoticeCenterProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const canCollapse = notices.length > NOTICE_COLLAPSE_LIMIT;

  React.useEffect(() => {
    if (!canCollapse) setExpanded(false);
  }, [canCollapse]);

  if (notices.length === 0) return null;

  const visibleNotices = selectVisibleNotices(notices, expanded);

  return (
    <aside className="pith-notice-center" aria-label={t('notification.region')}>
      {notices.length > 1 && (
        <div className="pith-notice-toolbar pith-fade-up">
          {canCollapse ? (
            <button
              type="button"
              className="pith-notice-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span>{t('notification.summary', { n: notices.length })}</span>
              <span className="pith-notice-action">
                {expanded ? t('notification.collapse') : t('notification.expand')}
              </span>
            </button>
          ) : (
            <span className="pith-notice-summary">
              {t('notification.summary', { n: notices.length })}
            </span>
          )}
          <button
            type="button"
            className="pith-notice-dismiss-all"
            onClick={() => {
              setExpanded(false);
              onDismissAll();
            }}
          >
            {t('notification.dismissAll')}
          </button>
        </div>
      )}

      <div className="pith-notice-list">
        {visibleNotices.map((notice) => (
          <button
            key={notice.id}
            type="button"
            onClick={() => onDismiss(notice.id)}
            className="pith-notice-toast pith-fade-up"
            title={t('notification.dismissOne')}
          >
            <span
              className="pith-notice-level"
              style={{
                background:
                  notice.level === 'error'
                    ? 'var(--status-dead)'
                    : notice.level === 'warning'
                      ? 'var(--status-running)'
                      : 'var(--status-watch)',
              }}
            />
            <span className="pith-notice-text">{notice.text}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
