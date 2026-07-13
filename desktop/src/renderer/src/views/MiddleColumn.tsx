import React from 'react';
import {
  ChevronRight,
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
import type { EntrySummary } from '../../../shared/protocol';
import { folderView } from '../libraryTree';
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
  const path = useStore((s) => s.libraryPath);
  const entryId = useStore((s) => s.entryId);
  const openEntry = useStore((s) => s.openEntry);
  const enterFolder = useStore((s) => s.enterFolder);
  const goToPath = useStore((s) => s.goToPath);
  const { t } = useTranslation();
  const [q, setQ] = React.useState('');

  const searching = q.trim() !== '';
  // 搜索态：跨整个集合平铺过滤（忽略层级，方便全局找）。
  const searchResults = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) =>
      (e.title + ' ' + e.summary + ' ' + e.tags.join(' ')).toLowerCase().includes(needle),
    );
  }, [entries, q]);

  // 浏览态：当前 path 层的直接子目录（含子树计数）+ 直属条目。
  const { folders, atLevel } = React.useMemo(() => folderView(entries, path), [entries, path]);

  const renderEntry = (e: EntrySummary) => (
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
  );

  return (
    <ColumnShell>
      <ColumnHeader
        icon={<Folder size={18} />}
        title={collection ?? t('entryList.library')}
        subtitle={t('entryList.subtitle', { n: entries.length })}
      />
      {/* 面包屑：集合 › 子目录 ›…，点任一段跳回；只在钻入子目录后出现。 */}
      {!searching && path.length > 0 && (
        <div
          style={{
            flex: 'none',
            padding: '0 16px 10px',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 3,
            fontSize: 'var(--text-caption)',
          }}
        >
          <Crumb label={collection ?? ''} onClick={() => goToPath(0)} />
          {path.map((seg, i) => (
            <React.Fragment key={i}>
              <ChevronRight size={12} style={{ color: 'var(--text-quaternary)', flex: 'none' }} />
              {i === path.length - 1 ? (
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{seg}</span>
              ) : (
                <Crumb label={seg} onClick={() => goToPath(i + 1)} />
              )}
            </React.Fragment>
          ))}
        </div>
      )}
      <div style={{ flex: 'none', padding: '0 16px 12px' }}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={path.length > 0 ? t('entryList.filterHere') : t('entryList.filter')}
          iconLeft={<Search size={15} />}
          size="sm"
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {searching ? (
          <>
            {searchResults.map(renderEntry)}
            {searchResults.length === 0 && <EmptyNote text={t('entryList.noMatch')} />}
          </>
        ) : (
          <>
            {folders.length > 0 && <GroupLabel text={t('entryList.subfolders')} />}
            {folders.map((f) => (
              <FolderRow
                key={f.name}
                name={f.name}
                countLabel={t('entryList.folderCount', { count: f.count })}
                onClick={() => enterFolder(f.name)}
              />
            ))}
            {folders.length > 0 && atLevel.length > 0 && <GroupLabel text={t('entryList.entriesGroup')} />}
            {atLevel.map(renderEntry)}
            {folders.length === 0 && atLevel.length === 0 && (
              <EmptyNote text={t('entryList.emptyFolder')} />
            )}
          </>
        )}
      </div>
    </ColumnShell>
  );
}

/** 面包屑里可点的一段。 */
function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <span
      role="button"
      onClick={onClick}
      style={{ color: 'var(--text-secondary)', cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
    >
      {label}
    </span>
  );
}

function GroupLabel({ text }: { text: string }) {
  return (
    <div style={{ padding: '8px 10px 2px', fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)' }}>
      {text}
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <p style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>
      {text}
    </p>
  );
}

/** 中栏子目录行：文件夹图标 + 名字 + 条数 + ›，点进下钻。 */
function FolderRow({
  name,
  countLabel,
  onClick,
}: {
  name: string;
  countLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '9px 10px',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--text-primary)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-sunken)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Folder size={16} style={{ flex: 'none', color: 'var(--status-watch)' }} />
      <span style={{ fontSize: 'var(--text-subhead)', fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
      <span style={{ flex: 'none', fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)' }}>
        {countLabel}
      </span>
      <ChevronRight size={15} style={{ flex: 'none', color: 'var(--text-quaternary)' }} />
    </button>
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
