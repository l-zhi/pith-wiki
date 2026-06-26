import React from 'react';
import {
  AlertTriangle,
  ArrowUp,
  BookmarkPlus,
  Check,
  ChevronRight,
  Copy,
  FileText,
  MessageCircle,
  Plus,
  Quote,
  Sparkles,
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, Spinner, TokenMeter, ToolApprovalCard } from '../ds';
import { parseScopeFromText, useStore, type ChatItem } from '../store';
import type { EntryRefDTO } from '../../../shared/protocol';

/**
 * 右栏聊天（设计稿 ChatPane.jsx + Claude Code 会话语义）：
 * transcript（用户气泡 / assistant markdown / 工具过程行 / 内联审批卡）+
 * composer（⏎ 发送 · ⇧⏎ 换行 · /reset /digest · @scope）+ TokenMeter。
 */
export function ChatPane() {
  const activeSession = useStore((s) => s.activeSession);
  const chat = useStore((s) => (activeSession ? s.chat[activeSession] : undefined));
  const newSession = useStore((s) => s.newSession);
  const boot = useStore((s) => s.boot);

  const { t } = useTranslation();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const itemCount = chat?.items.length ?? 0;
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [itemCount, chat?.activity, activeSession]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-window)',
      }}
    >
      <div
        className="pith-toolbar titlebar-drag"
        style={{
          flex: 'none',
          height: 'var(--titlebar-h)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 18px',
        }}
      >
        <MessageCircle size={17} style={{ color: 'var(--status-brand)' }} />
        <span
          style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}
        >
          {t('chat.title')}
        </span>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
          {t('chat.subtitle')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <TokenMeter inTokens={chat?.usage.inTok ?? 0} outTokens={chat?.usage.outTok ?? 0} />
          <IconButton title={t('chat.newChat')} onClick={() => void newSession()}>
            <Plus size={17} />
          </IconButton>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            padding: '28px 32px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {!chat || chat.items.length === 0 ? (
            <EmptyHero />
          ) : (
            chat.items.map((it) => <Item key={it.id} item={it} />)
          )}
          {chat?.busy && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--text-tertiary)',
                fontSize: 'var(--text-subhead)',
              }}
            >
              <Spinner size={13} />
              <span>{chat.activity ?? t('chat.thinking')}</span>
            </div>
          )}
        </div>
      </div>

      <Composer />
      <span style={{ display: 'none' }}>{boot?.model}</span>
    </div>
  );
}

function EmptyHero() {
  const { t } = useTranslation();
  return (
    <div style={{ textAlign: 'center', padding: '80px 0 40px', color: 'var(--text-tertiary)' }}>
      <Sparkles size={30} style={{ opacity: 0.5 }} />
      <p
        style={{
          margin: '14px 0 4px',
          fontSize: 'var(--text-headline)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
        }}
      >
        {t('chat.heroTitle')}
      </p>
      <p style={{ margin: 0, fontSize: 'var(--text-subhead)' }}>{t('chat.heroSub')}</p>
    </div>
  );
}

/* ───────── transcript items ───────── */

function Item({ item }: { item: ChatItem }) {
  const answerApproval = useStore((s) => s.answerApproval);

  switch (item.kind) {
    case 'user':
      return (
        <div className="pith-fade-up" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            style={{
              maxWidth: '78%',
              padding: '10px 15px',
              background: 'var(--accent)',
              color: 'var(--text-on-accent)',
              borderRadius: 'var(--radius-card)',
              borderBottomRightRadius: 'var(--radius-xs)',
              fontSize: 'var(--text-body)',
              lineHeight: 'var(--leading-snug)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {item.text}
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="pith-fade-up" style={{ display: 'flex', gap: 12 }}>
          <div
            style={{
              width: 28,
              height: 28,
              flex: 'none',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--status-brand-soft)',
              color: 'var(--status-brand)',
            }}
          >
            <Sparkles size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
              <span
                style={{
                  fontSize: 'var(--text-subhead)',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                pith
              </span>
            </div>
            <div className="pith-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
            </div>
            <MessageActions text={item.text} />
            {item.refs && item.refs.length > 0 && <ReferencesBlock refs={item.refs} kind="cited" />}
            {item.browsed && item.browsed.length > 0 && (
              <ReferencesBlock refs={item.browsed} kind="browsed" />
            )}
          </div>
        </div>
      );

    case 'tool':
      return <ToolRow item={item} />;

    case 'approval':
      return (
        <div className="pith-fade-up" style={{ marginLeft: 40 }}>
          <ToolApprovalCard
            kind={item.approvalKind}
            path={item.path}
            preview={item.preview}
            decided={item.decided}
            onApprove={() => answerApproval(item.approvalId, 'yes')}
            onAlways={() => answerApproval(item.approvalId, 'always')}
            onDeny={() => answerApproval(item.approvalId, 'no')}
          />
        </div>
      );

    case 'error':
      return <ErrorItem text={item.text} />;

    case 'note':
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-tertiary)',
            fontSize: 'var(--text-subhead)',
          }}
        >
          <ChevronRight size={13} style={{ opacity: 0.6 }} />
          <span>{item.text}</span>
        </div>
      );
  }
}

/** 把 LLM/网络层的技术报错粗分类，映射到一句人话提示；无法识别返回 null（显示原文）。 */
function classifyChatError(raw: string): 'Auth' | 'Network' | 'Timeout' | 'Rate' | null {
  const s = raw.toLowerCase();
  if (/401|unauthor|invalid.*key|authentication|forbidden|\bapi[ _-]?key\b/.test(s)) return 'Auth';
  if (/enotfound|econnrefused|fetch failed|network|getaddrinfo|socket hang|\bdns\b/.test(s))
    return 'Network';
  if (/timeout|etimedout|timed out|\baborted\b/.test(s)) return 'Timeout';
  if (/429|rate[ _-]?limit|quota|insufficient|too many/.test(s)) return 'Rate';
  return null;
}

/** 会话出错气泡：识别得出的错误显示人话 + 「打开设置」入口，原始报错收进可展开详情。 */
function ErrorItem({ text }: { text: string }) {
  const { t } = useTranslation();
  const setNav = useStore((s) => s.setNav);
  const cls = classifyChatError(text);
  const friendly = cls ? t(`error.chat${cls}`) : null;
  const showSettings = cls === 'Auth' || cls === 'Network';
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div
        style={{
          width: 28,
          height: 28,
          flex: 'none',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--status-dead-soft)',
          color: 'var(--status-dead)',
        }}
      >
        <AlertTriangle size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--text-body)',
            color: 'var(--status-dead)',
            lineHeight: 'var(--leading-relaxed)',
            wordBreak: 'break-word',
          }}
        >
          {friendly ?? text}
        </div>
        {showSettings && (
          <button
            type="button"
            onClick={() => setNav('settings')}
            style={{
              marginTop: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
              fontSize: 'var(--text-subhead)',
              fontWeight: 600,
              color: 'var(--accent)',
            }}
          >
            {t('error.openSettings')} →
          </button>
        )}
        {friendly && (
          <details style={{ marginTop: 6 }}>
            <summary
              style={{ cursor: 'pointer', fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}
            >
              {t('error.detail')}
            </summary>
            <pre
              style={{
                margin: '6px 0 0',
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-sunken)',
                font: 'var(--font-code)',
                fontSize: 'var(--text-caption)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                overflow: 'auto',
                maxHeight: 140,
              }}
            >
              {text}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * assistant 消息底部操作行：复制原始 markdown / 总结入库。
 * 「总结」= 把当前对话快照水合成新 Entry 落进 output 集合（/digest 同链路），
 * 进度与结果以 note 形式出现在消息流末尾。
 */
/**
 * 助手回答末尾的可收起区：列出本回合的来源条目，点击打开 Reader。
 * kind='cited'：真正取用的引用；kind='browsed'：仅 wiki_list 翻菜单浏览过的候选（默认折叠、更弱）。
 */
function ReferencesBlock({ refs, kind }: { refs: EntryRefDTO[]; kind: 'cited' | 'browsed' }) {
  const { t } = useTranslation();
  const openEntry = useStore((s) => s.openEntry);
  const label =
    kind === 'cited'
      ? t('chat.cited', { count: refs.length })
      : t('chat.browsed', { count: refs.length });
  // 默认收起：只显示 eyebrow 标签 + 数量 + 折叠箭头；点击展开为一排 .pith-cite chips。
  // browsed（仅浏览过的候选）可能很多（截图里 47 个），收起避免占满半屏；cited 同样收起保持一致。
  const [open, setOpen] = React.useState(false);
  const accent = kind === 'cited';
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          fontSize: 'var(--text-caption)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-wide)',
          textTransform: 'uppercase',
          color: 'var(--text-quaternary)',
        }}
      >
        <Quote size={12} />
        {label}
        <ChevronRight
          size={12}
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease-standard)',
          }}
        />
      </button>
      {open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {refs.map((r) => (
            <button
              key={r.id}
              type="button"
              className="pith-cite"
              onClick={() => void openEntry(r.id, r.collection)}
              title={r.collection ? `${r.collection} / ${r.title}` : r.title}
              style={accent ? undefined : { color: 'var(--text-tertiary)', fontWeight: 500 }}
            >
              <FileText
                size={12}
                style={{ color: accent ? 'var(--accent)' : 'var(--text-quaternary)', flex: 'none' }}
              />
              <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageActions({ text }: { text: string }) {
  const { t } = useTranslation();
  const digestSession = useStore((s) => s.digestSession);
  const busy = useStore((s) =>
    s.activeSession ? (s.chat[s.activeSession]?.busy ?? false) : false,
  );
  const [copied, setCopied] = React.useState(false);

  const copy = () => {
    window.pith.copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const btn: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 9px',
    border: 'none',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    transition: 'background var(--dur-fast), color var(--dur-fast)',
  };

  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 8, marginLeft: -9 }}>
      <button
        type="button"
        style={copied ? { ...btn, color: 'var(--status-done)' } : btn}
        onClick={copy}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? t('chat.copied') : t('chat.copy')}
      </button>
      <button
        type="button"
        style={btn}
        title={t('chat.digestTooltip')}
        disabled={busy}
        onClick={() => void digestSession()}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <BookmarkPlus size={13} />
        {t('chat.digestButton')}
      </button>
    </div>
  );
}

/** 工具过程行（设计稿 ChatBubble role=process），点击展开结果预览。 */
function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ marginLeft: 40 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '2px 0',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-subhead)',
        }}
      >
        <ChevronRight
          size={13}
          style={{
            opacity: 0.6,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--dur-fast)',
          }}
        />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-footnote)' }}>
          <span style={{ color: item.ok === false ? 'var(--status-dead)' : 'var(--status-done)' }}>
            {item.ok === false ? '✗' : '●'}
          </span>{' '}
          {item.name}
          <span style={{ opacity: 0.7 }}>({item.argsPreview})</span>
        </span>
      </button>
      {open && (
        <pre
          style={{
            margin: '6px 0 0 21px',
            padding: '10px 12px',
            font: 'var(--font-code)',
            color: 'var(--text-secondary)',
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--ring-card)',
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {item.preview || t('chat.emptyResult')}
        </pre>
      )}
    </div>
  );
}

/* ───────── composer ───────── */

const SLASH_CMDS = ['/digest', '/reset'] as const;

function Composer() {
  const { t } = useTranslation();
  const send = useStore((s) => s.send);
  const abort = useStore((s) => s.abort);
  const resetSession = useStore((s) => s.resetSession);
  const digestSession = useStore((s) => s.digestSession);
  const collections = useStore((s) => s.collections);
  const activeSession = useStore((s) => s.activeSession);
  const chat = useStore((s) => (activeSession ? s.chat[activeSession] : undefined));
  const boot = useStore((s) => s.boot);
  const switchProvider = useStore((s) => s.switchProvider);
  const composerDraft = useStore((s) => s.composerDraft);

  const [text, setText] = React.useState('');
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Reader「在聊天中打开」的预填
  React.useEffect(() => {
    if (composerDraft !== null) {
      setText(composerDraft);
      useStore.setState({ composerDraft: null });
      taRef.current?.focus();
    }
  }, [composerDraft]);

  const busy = chat?.busy ?? false;
  const showSlash = text.startsWith('/') && !text.includes(' ') && text.length > 1;
  const slashHints = [
    { cmd: '/digest', desc: t('chat.slashDigest') },
    { cmd: '/reset', desc: t('chat.slashReset') },
  ];
  const slashMatches = slashHints.filter((s) => s.cmd.startsWith(text));

  const submit = () => {
    const t = text.trim();
    if (!t || !activeSession) return;
    setText('');
    if (t === '/reset') {
      void resetSession();
      return;
    }
    if (t === '/digest' || t.startsWith('/digest ')) {
      const col = t.split(/\s+/)[1];
      void digestSession(col);
      return;
    }
    void send(t, parseScopeFromText(t, collections));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法的确认键也是 Enter：composition 进行中（isComposing / keyCode 229）
    // 绝不能提交，否则消息带着未上屏的拼音发出去、上屏文本残留在输入框里。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) submit();
    }
  };

  return (
    <div style={{ flex: 'none', padding: '0 32px 22px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', position: 'relative' }}>
        {showSlash && slashMatches.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              marginBottom: 8,
              background: 'var(--surface-raised)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-popover), var(--ring-card)',
              padding: 6,
              zIndex: 5,
            }}
          >
            {slashMatches.map((s) => (
              <button
                key={s.cmd}
                type="button"
                onClick={() => {
                  setText(s.cmd + (s.cmd === '/digest' ? ' ' : ''));
                  taRef.current?.focus();
                }}
                style={{
                  display: 'flex',
                  gap: 10,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <code style={{ font: 'var(--font-code)', color: 'var(--accent)', fontWeight: 600 }}>
                  {s.cmd}
                </code>
                <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)' }}>
                  {s.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        <div
          className="pith-card"
          style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <textarea
            ref={taRef}
            rows={2}
            className="pith-composer"
            placeholder={
              boot?.needsOnboarding
                ? t('chat.composerNeedsProvider')
                : t('chat.composerPlaceholder')
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={boot?.needsOnboarding ?? false}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)' }}>
              {t('chat.sendHint')}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 'var(--text-caption)',
                  color: 'var(--text-quaternary)',
                }}
              >
                <Sparkles size={12} />
                {(boot?.providers?.length ?? 0) > 0 ? (
                  <select
                    value={boot?.provider ?? ''}
                    onChange={(e) => void switchProvider(e.target.value)}
                    title={t('chat.switchProvider')}
                    style={{
                      fontSize: 'var(--text-caption)',
                      color: 'var(--text-quaternary)',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      padding: 0,
                    }}
                  >
                    {boot?.providers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.model || p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  (boot?.model ?? '')
                )}
              </span>
              {busy ? (
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Square size={13} />}
                  onClick={() => abort()}
                >
                  {t('chat.stop')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  iconRight={<ArrowUp size={15} />}
                  onClick={submit}
                  disabled={!text.trim()}
                >
                  {t('chat.send')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
