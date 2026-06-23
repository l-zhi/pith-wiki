import React from 'react';
import {
  Clipboard,
  FileText,
  Folder,
  Link as LinkIcon,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { EntryListItem, IconButton, Input, Spinner, StatusDot } from '../ds';
import { useStore } from '../store';

const SOURCE_ICON: Record<string, React.ReactNode> = {
  url: <LinkIcon size={14} />,
  file: <FileText size={14} />,
  inline: <Clipboard size={14} />,
  unknown: <FileText size={14} />,
};

/**
 * 中栏：nav=library/inbox → 条目列表（设计稿 EntryList.jsx）；
 *      nav=chat          → 会话列表（Claude Code 桌面端布局）。
 * dashboard 不渲染中栏。
 */
export function MiddleColumn() {
  const nav = useStore((s) => s.nav);
  if (nav === 'dashboard' || nav === 'inbox' || nav === 'settings' || nav === 'graph') return null;
  return nav === 'chat' ? <SessionList /> : <EntryColumn />;
}

function ColumnShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      style={{
        width: 'var(--list-col-w)',
        flex: 'none',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-window)',
        borderRight: '0.5px solid var(--separator)',
      }}
    >
      {children}
    </section>
  );
}

function ColumnHeader({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="titlebar-drag" style={{ flex: 'none', padding: '16px 16px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ display: 'inline-flex', color: 'var(--status-watch)' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--text-title-3)',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
              color: 'var(--text-primary)',
            }}
          >
            {title}
          </h2>
          {subtitle && <p style={{ margin: 0, fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{subtitle}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

/* ───────── entries（library） ───────── */

function EntryColumn() {
  const collection = useStore((s) => s.collection);
  const entries = useStore((s) => s.entries);
  const entryId = useStore((s) => s.entryId);
  const openEntry = useStore((s) => s.openEntry);
  const { t } = useTranslation();
  const [q, setQ] = React.useState('');

  const shown = entries.filter(
    (e) => !q || (e.title + ' ' + e.summary + ' ' + e.tags.join(' ')).toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <ColumnShell>
      <ColumnHeader
        icon={<Folder size={18} />}
        title={collection ?? t('entryList.library')}
        subtitle={t('entryList.subtitle', { n: entries.length })}
      />
      <div style={{ flex: 'none', padding: '0 16px 12px' }}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('entryList.filter')}
          iconLeft={<Search size={15} />}
          size="sm"
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((e) => (
          <EntryListItem
            key={e.id}
            icon={SOURCE_ICON[e.sourceType] ?? SOURCE_ICON.unknown}
            title={e.title}
            summary={e.summary}
            tags={e.tags}
            updated={e.updated}
            selected={entryId === e.id}
            onClick={() => void openEntry(e.id, e.collection)}
          />
        ))}
        {shown.length === 0 && (
          <p style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>
            {t('entryList.noMatch')}
          </p>
        )}
      </div>
    </ColumnShell>
  );
}

/* ───────── sessions（chat） ───────── */

function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.activeSession);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const renameSession = useStore((s) => s.renameSession);
  const newSession = useStore((s) => s.newSession);
  const chat = useStore((s) => s.chat);
  const { t } = useTranslation();

  // 双击标题进入行内重命名；删除是两步确认（再点一次红色 ✓，3s 超时还原）。
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!confirmId) return;
    const t = setTimeout(() => setConfirmId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmId]);

  const commitRename = () => {
    if (editingId && draft.trim()) void renameSession(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <ColumnShell>
      <ColumnHeader
        icon={<Sparkles size={18} />}
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle', { n: sessions.length })}
        action={
          <IconButton title={t('sessions.newChat')} onClick={() => void newSession()}>
            <Plus size={17} />
          </IconButton>
        }
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sessions.map((s) => {
          const live = chat[s.id];
          const busy = live?.busy ?? s.busy;
          const pendingApproval = (live?.items.some((i) => i.kind === 'approval' && i.decided === null) ?? false) || Boolean(s.pendingApprovalId);

          if (editingId === s.id) {
            return (
              <div key={s.id} style={{ padding: '8px 10px' }}>
                <Input
                  size="sm"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={commitRename}
                />
              </div>
            );
          }

          const confirming = confirmId === s.id;
          return (
            <div
              key={s.id}
              onDoubleClick={() => {
                setEditingId(s.id);
                setDraft(s.title);
              }}
            >
              <EntryListItem
                icon={<MessageCircle size={14} />}
                title={s.title}
                summary={t('sessions.meta', { n: s.msgCount, model: s.model })}
                updated={relDay(s.updatedAt)}
                selected={active === s.id}
                trailing={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {pendingApproval && <StatusDot tone="running" pulse size={7} />}
                    {busy && <Spinner size={12} />}
                    <span
                      role="button"
                      title={t('sessions.rename')}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                      style={{ display: 'inline-flex', color: 'var(--text-quaternary)', cursor: 'pointer' }}
                    >
                      <Pencil size={13} />
                    </span>
                    <span
                      role="button"
                      title={confirming ? t('sessions.deleteConfirm') : t('sessions.delete')}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (confirming) {
                          setConfirmId(null);
                          void deleteSession(s.id);
                        } else {
                          setConfirmId(s.id);
                        }
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        cursor: 'pointer',
                        color: confirming ? 'var(--status-dead)' : 'var(--text-quaternary)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 600,
                      }}
                    >
                      <Trash2 size={13} />
                      {confirming && t('sessions.confirmBadge')}
                    </span>
                  </span>
                }
                onClick={() => void selectSession(s.id)}
              />
            </div>
          );
        })}
        {sessions.length === 0 && (
          <p style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>
            {t('sessions.empty')}
          </p>
        )}
      </div>
    </ColumnShell>
  );
}

function relDay(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return i18n.t('time.now');
  if (m < 60) return i18n.t('time.minutes', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return i18n.t('time.hours', { n: h });
  return i18n.t('time.days', { n: Math.floor(h / 24) });
}
