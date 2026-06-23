import React from 'react';
import { CornerDownRight, ExternalLink, FileText, Link2, MessageCirclePlus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { Badge, Button, SegmentedControl, Tag } from '../ds';
import { GraphCanvas } from './GraphView';
import { useStore } from '../store';

/**
 * 右栏阅读器（设计稿 EntryReader.jsx）：Read / Raw / Links 三视图 + 标签 +
 * 链接条目 chips + 反向链接；工具栏带「Open in chat」（显式 @scope 桥，CONTEXT.md Scope）。
 * v1 只读：无编辑 / Re-hydrate。
 */
export function EntryReader() {
  const entry = useStore((s) => s.entry);
  const openEntry = useStore((s) => s.openEntry);
  const openInChat = useStore((s) => s.openInChat);
  const { t } = useTranslation();
  const [view, setView] = React.useState('read');

  if (!entry) return <Empty />;

  const srcLabel: Record<string, string> = {
    url: t('reader.srcUrl'),
    file: t('reader.srcFile'),
    inline: t('reader.srcInline'),
    unknown: t('reader.srcUnknown'),
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <SegmentedControl
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'read', label: t('reader.read') },
            { value: 'raw', label: t('reader.raw') },
            { value: 'graph', label: t('reader.links') },
          ]}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {entry.sourceValue && (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<ExternalLink size={15} />}
              onClick={() => void window.pith.openSource(entry.sourceValue!)}
            >
              {t('reader.source')}
            </Button>
          )}
          <Button size="sm" variant="primary" iconLeft={<MessageCirclePlus size={15} />} onClick={() => openInChat(entry)}>
            {t('reader.openInChat')}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <article style={{ maxWidth: 'var(--content-max)', margin: '0 auto', padding: '40px 48px 80px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <Badge tone="watch" dot>
              {entry.collection}
            </Badge>
            <Badge tone="neutral">{srcLabel[entry.sourceType] ?? srcLabel.unknown}</Badge>
            {typeof entry.compressionRatio === 'number' && (
              <Badge tone="brand">{t('reader.ratio', { r: entry.compressionRatio.toFixed(2) })}</Badge>
            )}
          </div>

          <h1
            style={{
              margin: '0 0 10px',
              fontSize: 'var(--text-title-1)',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
              lineHeight: 'var(--leading-tight)',
              color: 'var(--text-primary)',
            }}
          >
            {entry.title}
          </h1>
          {entry.summary && (
            <p style={{ margin: '0 0 18px', fontSize: 'var(--text-headline)', lineHeight: 'var(--leading-snug)', color: 'var(--text-secondary)' }}>
              {entry.summary}
            </p>
          )}

          <div style={{ display: 'flex', gap: 6, marginBottom: 28, flexWrap: 'wrap' }}>
            {entry.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>

          {view === 'raw' ? (
            <pre
              style={{
                margin: 0,
                padding: '18px 20px',
                borderRadius: 'var(--radius-card)',
                background: 'var(--surface-sunken)',
                boxShadow: 'var(--ring-card)',
                font: 'var(--font-code)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
              }}
            >
              {entry.raw}
            </pre>
          ) : view === 'graph' ? (
            <LinkGraph />
          ) : (
            <div className="pith-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
            </div>
          )}

          {view !== 'graph' && entry.links.length > 0 && (
            <LinkChips title={t('reader.linkedEntries')} ids={entry.links} onOpen={(id) => void openEntry(id)} icon={<Link2 size={14} />} />
          )}
          {view !== 'graph' && entry.backlinks.length > 0 && (
            <LinkChips
              title={t('reader.backlinks')}
              ids={entry.backlinks}
              onOpen={(id) => void openEntry(id)}
              icon={<CornerDownRight size={14} />}
            />
          )}
        </article>
      </div>
    </div>
  );
}

function LinkChips({
  title,
  ids,
  onOpen,
  icon,
}: {
  title: string;
  ids: string[];
  onOpen: (id: string) => void;
  icon: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 36 }}>
      <span className="pith-eyebrow">{title}</span>
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        {ids.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onOpen(l)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 13px',
              border: 'none',
              cursor: 'pointer',
              background: 'var(--surface-card)',
              boxShadow: 'var(--ring-control), var(--shadow-card)',
              borderRadius: 'var(--radius-control)',
              fontSize: 'var(--text-subhead)',
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          >
            <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>{icon}</span>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Links 视图：以当前条目为中心的局部力导向图（深度 1/2 可切，复用 GraphCanvas）。 */
function LinkGraph() {
  const { t } = useTranslation();
  const entry = useStore((s) => s.entry);
  const openEntry = useStore((s) => s.openEntry);
  const graph = useStore((s) => s.graph);
  const loadGraph = useStore((s) => s.loadGraph);
  const setNav = useStore((s) => s.setNav);
  const [depth, setDepth] = React.useState('1');

  React.useEffect(() => {
    if (!graph) void loadGraph();
  }, [graph, loadGraph]);

  const handleOpen = React.useCallback((id: string) => void openEntry(id), [openEntry]);

  if (!entry) return null;
  if (!graph) {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>…</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="pith-eyebrow">{t('graph.localTitle')}</span>
        <SegmentedControl
          size="sm"
          value={depth}
          onChange={setDepth}
          options={[
            { value: '1', label: `${t('graph.depth')} 1` },
            { value: '2', label: `${t('graph.depth')} 2` },
          ]}
          style={{ width: 170 }}
        />
        <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => setNav('graph')}>
          {t('graph.openGlobal')}
        </Button>
      </div>
      <div
        style={{
          height: 420,
          borderRadius: 'var(--radius-card)',
          background: 'var(--surface-card)',
          boxShadow: 'var(--ring-card), var(--shadow-card)',
          overflow: 'hidden',
        }}
      >
        <GraphCanvas data={graph} rootId={entry.id} depth={Number(depth)} onOpenEntry={handleOpen} />
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: 'var(--surface-window)',
        color: 'var(--text-tertiary)',
      }}
    >
      <FileText size={34} style={{ opacity: 0.4 }} />
      <span style={{ fontSize: 'var(--text-subhead)' }}>{i18n.t('reader.selectEntry')}</span>
    </div>
  );
}

