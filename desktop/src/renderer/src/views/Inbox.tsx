import React from 'react';
import { ChevronRight, Inbox as InboxIcon, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Spinner, StatusDot } from '../ds';
import { bridge } from '../bridge';
import { useStore } from '../store';
import type { QueueJobDTO } from '../../../shared/protocol';

/**
 * Inbox —— ingest 队列视图（CONTEXT.md：队列任务的家，不是 Entry 待审阅箱）。
 * pending/running/dead 计数 + dead 任务明细（重试 / 清除 / 点击展开完整错误日志）。
 */

/** dead 任务行：点击展开该 job 的完整日志（懒加载 queue/logs/<id>.log 尾部）。 */
function DeadRow({ job }: { job: QueueJobDTO }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [log, setLog] = React.useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && log === null) {
      bridge
        .request<{ log: string; path: string }>({ kind: 'queue.jobLog', id: job.id })
        .then((r) => setLog(`# ${r.path}\n\n${r.log}`))
        .catch((err: Error) => setLog(`(failed to load log: ${err.message})`));
    }
  };

  return (
    <div style={{ borderBottom: '0.5px solid var(--separator)' }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 22px',
          width: '100%',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronRight
          size={14}
          style={{
            color: 'var(--text-quaternary)',
            flex: 'none',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--dur-fast)',
          }}
        />
        <StatusDot tone="dead" size={8} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 'var(--text-callout)',
              fontWeight: 500,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.file.split('/').pop()}
          </span>
          <span style={{ display: 'block', fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            → {job.collection}
            {job.attempts != null ? ` · ${t('inbox.attempts', { n: job.attempts })}` : ''}
            {!open && job.error ? ` · ${job.error.slice(0, 100)}` : ''}
          </span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 22px 14px 48px' }}>
          {job.error && (
            <p style={{ margin: '0 0 8px', fontSize: 'var(--text-subhead)', color: 'var(--status-dead)', wordBreak: 'break-word' }}>
              {job.error}
            </p>
          )}
          <pre
            style={{
              margin: 0,
              padding: '12px 14px',
              font: 'var(--font-code)',
              fontSize: 'var(--text-footnote)',
              color: 'var(--text-secondary)',
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--ring-card)',
              maxHeight: 280,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {log ?? t('inbox.loadingLog')}
          </pre>
        </div>
      )}
    </div>
  );
}
export function Inbox() {
  const { t } = useTranslation();
  const queue = useStore((s) => s.queue);
  const refreshQueue = useStore((s) => s.refreshQueue);
  const retryDead = useStore((s) => s.retryDead);
  const clearDead = useStore((s) => s.clearDead);

  const counts = queue?.counts ?? { pending: 0, running: 0, completed: 0, dead: 0 };

  const stat = (label: string, value: number, tone?: string) => (
    <Card padding="16px 18px" style={{ flex: 1 }}>
      <div
        style={{
          fontSize: 'var(--text-caption)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-wide)',
          color: 'var(--text-tertiary)',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 'var(--text-title-1)',
          fontWeight: 700,
          letterSpacing: 'var(--tracking-tight)',
          color: tone ?? 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </Card>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <InboxIcon size={17} style={{ color: 'var(--status-watch)' }} />
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('inbox.title')}</span>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{t('inbox.subtitle')}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} onClick={() => void refreshQueue()}>
            {t('inbox.refresh')}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '32px 36px 64px', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
              {t('inbox.heading')}
            </h1>
            <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)' }}>
              {t('inbox.worker')}{' '}
              <Badge tone={queue?.workerMode === 'self' ? 'done' : queue?.workerMode === 'error' ? 'dead' : 'neutral'} dot>
                {queue?.workerMode ?? '…'}
              </Badge>
              {queue?.workerError && <span style={{ color: 'var(--status-dead)' }}>{queue.workerError}</span>}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-5)' }}>
            {stat(t('inbox.pending'), counts.pending)}
            {stat(t('inbox.running'), counts.running, 'var(--status-running)')}
            {stat(t('inbox.done'), counts.completed, 'var(--status-done)')}
            {stat(t('inbox.dead'), counts.dead, counts.dead > 0 ? 'var(--status-dead)' : undefined)}
          </div>

          <Card container padding="0" style={{ overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 22px',
                borderBottom: '0.5px solid var(--separator)',
              }}
            >
              <span className="pith-eyebrow">{t('inbox.deadLetters')}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <Button size="sm" variant="secondary" iconLeft={<RotateCcw size={14} />} onClick={() => void retryDead()} disabled={counts.dead === 0}>
                  {t('inbox.retryAll')}
                </Button>
                <Button size="sm" variant="ghost" iconLeft={<Trash2 size={14} />} onClick={() => void clearDead()} disabled={counts.dead === 0} style={{ color: 'var(--status-dead)' }}>
                  {t('inbox.clear')}
                </Button>
              </span>
            </div>
            {(queue?.dead ?? []).map((j) => (
              <DeadRow key={j.id} job={j} />
            ))}
            {counts.dead === 0 && (
              <div style={{ padding: '28px 22px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>
                {counts.running > 0 ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Spinner size={13} /> {t('inbox.hydrating')}
                  </span>
                ) : (
                  t('inbox.empty')
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
