import { Folder, LayoutDashboard, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, ProgressBar, StatusDot } from '../ds';
import { useStore } from '../store';

/** Dashboard —— 库健康（设计稿 Dashboard.jsx）：stat 卡 + 按 Collection 聚合状态表 + 队列行。 */
export function Dashboard() {
  const { t } = useTranslation();
  const dash = useStore((s) => s.dash);
  const queue = useStore((s) => s.queue);
  const refreshDashboard = useStore((s) => s.refreshDashboard);
  const openCollection = useStore((s) => s.openCollection);

  const cols = dash?.collections ?? [];
  const totalFiles = cols.reduce((a, c) => a + c.files, 0);
  const totals = cols.reduce(
    (a, c) => ({ pending: a.pending + c.pending, running: a.running + c.running, done: a.done + c.done, dead: a.dead + c.dead }),
    { pending: 0, running: 0, done: 0, dead: 0 },
  );
  const watching = cols.filter((c) => c.watch).length;

  const num = (n: number, color: string) =>
    n > 0 ? (
      <span style={{ color, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{n}</span>
    ) : (
      <span style={{ color: 'var(--text-quaternary)' }}>·</span>
    );

  const stat = (label: string, value: number | string, tone?: string) => (
    <Card padding="16px 18px" style={{ flex: 1 }}>
      <div style={{ fontSize: 'var(--text-caption)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', color: 'var(--text-tertiary)', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ marginTop: 6, fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: tone ?? 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </Card>
  );

  const grid = '1.6fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <LayoutDashboard size={17} style={{ color: 'var(--status-watch)' }} />
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('dashboard.title')}</span>
        <div style={{ marginLeft: 'auto' }}>
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} onClick={() => void refreshDashboard()}>
            {t('dashboard.refresh')}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '32px 36px 64px', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
              {t('dashboard.heading')}
            </h1>
            <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)' }}>
              <StatusDot tone="watch" size={8} /> {dash?.wikiRoot ?? '…'}
              {dash?.watchDirs.length ? ` · ${t('dashboard.watchDirs', { n: dash.watchDirs.length })}` : ` · ${t('dashboard.noWatchDirs')}`}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-5)' }}>
            {stat(t('dashboard.entries'), totalFiles)}
            {stat(t('dashboard.done'), totals.done, 'var(--status-done)')}
            {stat(t('dashboard.running'), totals.running, 'var(--status-running)')}
            {stat(t('dashboard.dead'), totals.dead, totals.dead > 0 ? 'var(--status-dead)' : undefined)}
          </div>

          <Card container padding="0" style={{ overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: grid, padding: '14px 22px', borderBottom: '0.5px solid var(--separator)' }}>
              {[t('dashboard.colCollection'), t('dashboard.colFiles'), t('dashboard.colPending'), t('dashboard.colRunning'), t('dashboard.colDone'), t('dashboard.colDead'), t('dashboard.colWatch')].map((h, i) => (
                <span
                  key={h}
                  style={{
                    fontSize: 'var(--text-caption)',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--tracking-wide)',
                    color: 'var(--text-tertiary)',
                    fontWeight: 600,
                    textAlign: i === 0 ? 'left' : 'right',
                  }}
                >
                  {h}
                </span>
              ))}
            </div>
            {cols.map((c) => (
              <div
                key={c.name}
                onClick={() => void openCollection(c.name)}
                style={{ display: 'grid', gridTemplateColumns: grid, padding: '12px 22px', alignItems: 'center', borderBottom: '0.5px solid var(--separator)', cursor: 'pointer' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 'var(--text-callout)', fontWeight: 500, color: c.danger ? 'var(--status-dead)' : 'var(--text-primary)' }}>
                  <Folder size={15} style={{ color: 'var(--text-tertiary)' }} />
                  {c.name}
                </span>
                <span style={{ textAlign: 'right' }}>{num(c.files, 'var(--text-primary)')}</span>
                <span style={{ textAlign: 'right' }}>{num(c.pending, 'var(--text-secondary)')}</span>
                <span style={{ textAlign: 'right' }}>
                  {c.running > 0 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--status-running)', fontWeight: 600 }}>
                      <StatusDot tone="running" pulse size={6} />
                      {c.running}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-quaternary)' }}>·</span>
                  )}
                </span>
                <span style={{ textAlign: 'right' }}>{num(c.done, 'var(--status-done)')}</span>
                <span style={{ textAlign: 'right' }}>{num(c.dead, 'var(--status-dead)')}</span>
                <span style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
                  {c.watch ? <StatusDot tone="watch" size={8} /> : <StatusDot tone="off" hollow size={8} />}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 22px', background: 'var(--surface-sunken)' }}>
              <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)' }}>
                {t('dashboard.queue')} <b style={{ color: 'var(--text-primary)' }}>{queue?.workerMode ?? '…'}</b>
              </span>
              <Badge tone="done" dot>
                {t('dashboard.doneBadge', { n: totals.done })}
              </Badge>
              {totals.running > 0 && (
                <Badge tone="running" dot>
                  {t('dashboard.runningBadge', { n: totals.running })}
                </Badge>
              )}
              <Badge tone="neutral">{t('dashboard.pendingCount', { n: totals.pending })}</Badge>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, width: 220 }}>
                <ProgressBar value={totalFiles ? totals.done / totalFiles : 0} tone="done" />
                <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {t('dashboard.watchRatio', { w: watching, n: cols.length })}
                </span>
              </span>
            </div>
          </Card>

          {dash?.extensions.length ? (
            <p style={{ margin: 0, fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
              {t('dashboard.ingestable', { exts: dash.extensions.join(' ') })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
