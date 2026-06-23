import {
  Blocks,
  CalendarClock,
  Folder,
  Inbox as InboxIcon,
  LayoutDashboard,
  MessageCircle,
  Settings2,
  Waypoints,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SidebarItem, StatusDot } from '../ds';
import { LogoLockup } from '../Logo';
import { useStore } from '../store';

/**
 * 玻璃侧边栏（设计稿 Sidebar.jsx）：红绿灯留白 + 品牌、Chat/Inbox/Dashboard 导航、
 * Collections 列表（watch 点 + 计数）、底部 provider 信息 + 主题切换。
 */
export function Sidebar() {
  const nav = useStore((s) => s.nav);
  const setNav = useStore((s) => s.setNav);
  const collections = useStore((s) => s.collections);
  const collection = useStore((s) => s.collection);
  const openCollection = useStore((s) => s.openCollection);
  const queue = useStore((s) => s.queue);
  const boot = useStore((s) => s.boot);
  const { t } = useTranslation();

  const inboxCount = queue ? queue.counts.pending + queue.counts.dead : 0;

  return (
    <aside
      style={{
        width: 'var(--sidebar-w)',
        flex: 'none',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--material-glass-thick)',
        WebkitBackdropFilter: 'var(--blur-glass)',
        backdropFilter: 'var(--blur-glass)',
        borderRight: '0.5px solid var(--separator)',
      }}
    >
      {/* 红绿灯区域（hiddenInset 时由系统绘制）+ 品牌 */}
      <div
        className="titlebar-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px 0 84px',
          height: 'var(--titlebar-h)',
          flex: 'none',
        }}
      >
        <LogoLockup size={22} variant="simple" fontSize={17} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <StatusDot tone={boot?.ready ? 'ready' : 'dead'} pulse={boot?.ready} size={7} />
        </span>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <SidebarItem icon={<MessageCircle size={16} />} selected={nav === 'chat'} onClick={() => setNav('chat')}>
          {t('nav.chat')}
        </SidebarItem>
        <SidebarItem
          icon={<InboxIcon size={16} />}
          count={inboxCount > 0 ? inboxCount : null}
          selected={nav === 'inbox'}
          onClick={() => setNav('inbox')}
        >
          {t('nav.inbox')}
        </SidebarItem>
        <SidebarItem
          icon={<LayoutDashboard size={16} />}
          selected={nav === 'dashboard'}
          onClick={() => setNav('dashboard')}
        >
          {t('nav.dashboard')}
        </SidebarItem>
        <SidebarItem icon={<Waypoints size={16} />} selected={nav === 'graph'} onClick={() => setNav('graph')}>
          {t('nav.graph')}
        </SidebarItem>
        <SidebarItem icon={<Blocks size={16} />} selected={nav === 'skills'} onClick={() => setNav('skills')}>
          {t('nav.skills')}
        </SidebarItem>
        <SidebarItem icon={<CalendarClock size={16} />} selected={nav === 'schedule'} onClick={() => setNav('schedule')}>
          {t('nav.schedule')}
        </SidebarItem>

        <div style={{ padding: '14px 8px 5px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="pith-eyebrow">{t('nav.collections')}</span>
        </div>
        {collections.map((c) => (
          <SidebarItem
            key={c.id}
            icon={<Folder size={16} />}
            count={c.count}
            dotTone={c.watch ? 'watch' : undefined}
            selected={nav === 'library' && collection === c.id}
            onClick={() => void openCollection(c.id)}
          >
            {c.id}
          </SidebarItem>
        ))}
        {collections.length === 0 && (
          <p style={{ padding: '8px 10px', fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('nav.noCollections')}
          </p>
        )}
      </div>

      {/* footer: provider 胶囊 → Settings（设计稿语义；主题控件已迁入设置） */}
      <div style={{ flex: 'none', padding: 10, borderTop: '0.5px solid var(--separator)' }}>
        <button
          type="button"
          onClick={() => setNav('settings')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            border: 'none',
            background: nav === 'settings' ? 'var(--surface-hover)' : 'transparent',
            cursor: 'pointer',
            padding: '7px 8px',
            borderRadius: 'var(--radius-sm)',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              width: 26,
              height: 26,
              borderRadius: '50%',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--status-done-soft)',
              color: 'var(--status-done)',
              flex: 'none',
            }}
          >
            <Zap size={14} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--text-subhead)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {boot?.provider ?? '…'}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 'var(--text-caption)',
                color: 'var(--text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {boot?.model ?? t('nav.loading')}
            </span>
          </span>
          <Settings2 size={15} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
        </button>
      </div>
    </aside>
  );
}
