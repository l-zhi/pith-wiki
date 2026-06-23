/**
 * pith Design System 组件 —— 从 design/pith-design-system/project/components 逐一移植。
 * 视觉规则保持原样（token CSS 变量 + inline style）；唯一改动：
 *   - <i data-lucide> → lucide-react 组件（icon prop 收 ReactNode）
 *   - JSX → TSX，补类型
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

/* ───────── StatusDot ───────── */

const DOT_COLORS: Record<string, string> = {
  ready: 'var(--status-ready)',
  done: 'var(--status-done)',
  watch: 'var(--status-watch)',
  running: 'var(--status-running)',
  pending: 'var(--status-pending)',
  dead: 'var(--status-dead)',
  error: 'var(--status-error)',
  brand: 'var(--status-brand)',
  accent: 'var(--accent)',
  off: 'var(--text-quaternary)',
};

export function StatusDot({
  tone = 'ready',
  size = 9,
  pulse = false,
  hollow = false,
  style = {},
}: {
  tone?: string;
  size?: number;
  pulse?: boolean;
  hollow?: boolean;
  style?: React.CSSProperties;
}) {
  const color = DOT_COLORS[tone] ?? DOT_COLORS.ready;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flex: 'none', ...style }}>
      {pulse && !hollow && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background: color,
            animation: 'pith-pulse 2s var(--ease-out) infinite',
          }}
        />
      )}
      <span
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          background: hollow ? 'transparent' : color,
          boxShadow: hollow ? `inset 0 0 0 1.5px ${color}` : 'none',
        }}
      />
    </span>
  );
}

/* ───────── Badge ───────── */

const BADGE_TONES: Record<string, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--text-secondary)', bg: 'var(--surface-sunken)' },
  accent: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  done: { fg: 'var(--status-done)', bg: 'var(--status-done-soft)' },
  watch: { fg: 'var(--status-watch)', bg: 'var(--status-watch-soft)' },
  running: { fg: 'var(--status-running)', bg: 'var(--status-running-soft)' },
  dead: { fg: 'var(--status-dead)', bg: 'var(--status-dead-soft)' },
  brand: { fg: 'var(--status-brand)', bg: 'var(--status-brand-soft)' },
};

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  style = {},
}: {
  children: React.ReactNode;
  tone?: string;
  dot?: boolean;
  style?: React.CSSProperties;
}) {
  const t = BADGE_TONES[tone] ?? BADGE_TONES.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-caption)',
        fontWeight: 600,
        lineHeight: 1.4,
        color: t.fg,
        background: t.bg,
        borderRadius: 'var(--radius-pill)',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flex: 'none' }} />}
      {children}
    </span>
  );
}

/* ───────── Tag ───────── */

export function Tag({ children, hash = true }: { children: React.ReactNode; hash?: boolean }) {
  const [hover, setHover] = React.useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-footnote)',
        fontWeight: 500,
        color: hover ? 'var(--accent)' : 'var(--text-secondary)',
        background: hover ? 'var(--accent-soft)' : 'var(--surface-sunken)',
        borderRadius: 'var(--radius-sm)',
        transition: 'all var(--dur-fast) var(--ease-standard)',
        whiteSpace: 'nowrap',
      }}
    >
      {hash && <span style={{ opacity: 0.5 }}>#</span>}
      {children}
    </span>
  );
}

/* ───────── Card ───────── */

export function Card({
  children,
  container = false,
  padding = 'var(--space-6)',
  style = {},
}: {
  children: React.ReactNode;
  container?: boolean;
  padding?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        borderRadius: container ? 'var(--radius-container)' : 'var(--radius-card)',
        boxShadow: 'var(--ring-card), var(--shadow-card)',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ───────── Button ───────── */

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  iconLeft = null,
  iconRight = null,
  disabled = false,
  fullWidth = false,
  onClick,
  style = {},
}: {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' | 'accentSoft';
  size?: 'sm' | 'md' | 'lg';
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const heights = { sm: 'var(--control-h-sm)', md: 'var(--control-h-md)', lg: 'var(--control-h-lg)' };
  const pads = { sm: '0 12px', md: '0 16px', lg: '0 22px' };
  const fonts = { sm: 'var(--text-subhead)', md: 'var(--text-callout)', lg: 'var(--text-body)' };
  const variants: Record<string, React.CSSProperties> = {
    primary: {
      background: active ? 'var(--accent-active)' : hover ? 'var(--accent-hover)' : 'var(--accent)',
      color: 'var(--text-on-accent)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
    },
    secondary: {
      background: hover ? 'var(--surface-hover)' : 'var(--surface-card)',
      color: 'var(--text-primary)',
      boxShadow: 'var(--ring-control), var(--shadow-card)',
    },
    ghost: {
      background: active ? 'var(--surface-active)' : hover ? 'var(--surface-hover)' : 'transparent',
      color: 'var(--text-primary)',
    },
    destructive: {
      background: hover ? 'color-mix(in srgb, var(--apple-red) 88%, #000)' : 'var(--apple-red)',
      color: '#fff',
      boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
    },
    accentSoft: {
      background: hover ? 'color-mix(in srgb, var(--accent-soft) 70%, var(--accent))' : 'var(--accent-soft)',
      color: 'var(--accent)',
    },
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        height: heights[size],
        padding: pads[size],
        width: fullWidth ? '100%' : 'auto',
        fontFamily: 'var(--font-sans)',
        fontSize: fonts[size],
        fontWeight: 600,
        letterSpacing: 'var(--tracking-snug)',
        borderRadius: 'var(--radius-control)',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition:
          'background var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard)',
        transform: active && !disabled ? 'scale(0.97)' : 'scale(1)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        ...variants[variant],
        ...style,
      }}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}

/* ───────── IconButton ───────── */

export function IconButton({
  children,
  title,
  onClick,
  style = {},
}: {
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        border: 'none',
        cursor: 'pointer',
        borderRadius: 'var(--radius-sm)',
        background: hover ? 'var(--surface-hover)' : 'transparent',
        color: 'var(--text-secondary)',
        transition: 'background var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ───────── Input ───────── */

export function Input({
  iconLeft = null,
  trailing = null,
  size = 'md',
  invalid = false,
  wrapStyle = {},
  ...rest
}: {
  iconLeft?: React.ReactNode;
  trailing?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
  wrapStyle?: React.CSSProperties;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  const [focus, setFocus] = React.useState(false);
  const heights = { sm: 'var(--control-h-sm)', md: 'var(--control-h-md)', lg: 'var(--control-h-lg)' };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: heights[size],
        padding: '0 12px',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-control)',
        boxShadow: invalid
          ? 'inset 0 0 0 1px var(--apple-red)'
          : focus
            ? 'var(--ring-control), var(--ring-focus)'
            : 'var(--ring-control)',
        transition: 'box-shadow var(--dur-fast) var(--ease-standard)',
        ...wrapStyle,
      }}
    >
      {iconLeft && <span style={{ display: 'inline-flex', color: 'var(--text-tertiary)', flex: 'none' }}>{iconLeft}</span>}
      <input
        {...rest}
        onFocus={(e) => {
          setFocus(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocus(false);
          rest.onBlur?.(e);
        }}
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-callout)',
          ...rest.style,
        }}
      />
      {trailing && <span style={{ display: 'inline-flex', flex: 'none' }}>{trailing}</span>}
    </div>
  );
}

/* ───────── SegmentedControl ───────── */

export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  style = {},
}: {
  options: (string | { value: string; label: string })[];
  value: string;
  onChange?: (v: string) => void;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const idx = Math.max(
    0,
    opts.findIndex((o) => o.value === value),
  );
  const h = size === 'sm' ? 28 : 34;
  const pad = 3;
  return (
    <div
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `repeat(${opts.length}, 1fr)`,
        height: h,
        padding: pad,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-control)',
        boxShadow: 'var(--ring-control)',
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: pad,
          left: pad,
          height: h - pad * 2,
          width: `calc((100% - ${pad * 2}px) / ${opts.length})`,
          transform: `translateX(${idx * 100}%)`,
          background: 'var(--surface-card)',
          borderRadius: 'calc(var(--radius-control) - 2px)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12), var(--ring-card)',
          transition: 'transform var(--dur-base) var(--ease-out)',
        }}
      />
      {opts.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange?.(o.value)}
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              fontSize: size === 'sm' ? 'var(--text-subhead)' : 'var(--text-callout)',
              fontWeight: selected ? 600 : 500,
              color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
              padding: '0 12px',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ───────── Switch ───────── */

export function Switch({
  checked,
  onChange,
  tone = 'done',
  disabled = false,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  tone?: 'done' | 'accent';
  disabled?: boolean;
}) {
  const on = tone === 'accent' ? 'var(--accent)' : 'var(--apple-green, #34c759)';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={{
        position: 'relative',
        width: 40,
        height: 24,
        borderRadius: 'var(--radius-pill)',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: checked ? on : 'var(--gray-300)',
        transition: 'background var(--dur-base) var(--ease-standard)',
        flex: 'none',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          transition: 'left var(--dur-base) var(--ease-out)',
        }}
      />
    </button>
  );
}

/* ───────── SidebarItem ───────── */

export function SidebarItem({
  icon,
  children,
  count,
  selected = false,
  dotTone,
  onClick,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  count?: number | null;
  selected?: boolean;
  dotTone?: string;
  onClick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        height: 32,
        padding: '0 8px',
        borderRadius: 'var(--radius-sm)',
        background: selected ? 'var(--accent)' : hover ? 'var(--surface-hover)' : 'transparent',
        color: selected ? 'var(--text-on-accent)' : 'var(--text-primary)',
        transition: 'background var(--dur-fast) var(--ease-standard)',
      }}
    >
      {icon && (
        <span
          style={{
            display: 'inline-flex',
            flex: 'none',
            color: selected ? 'var(--text-on-accent)' : 'var(--text-secondary)',
          }}
        >
          {icon}
        </span>
      )}
      {dotTone && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flex: 'none',
            background: DOT_COLORS[dotTone] ?? 'var(--status-ready)',
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 'var(--text-callout)',
          fontWeight: selected ? 600 : 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      {count != null && (
        <span
          style={{
            flex: 'none',
            fontSize: 'var(--text-caption)',
            fontVariantNumeric: 'tabular-nums',
            color: selected ? 'var(--text-on-accent)' : 'var(--text-tertiary)',
            opacity: selected ? 0.85 : 1,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ───────── EntryListItem ───────── */

export function EntryListItem({
  icon,
  title,
  summary,
  tags = [],
  updated,
  selected = false,
  trailing,
  onClick,
}: {
  icon?: React.ReactNode;
  title: string;
  summary?: string;
  tags?: string[];
  updated?: string;
  selected?: boolean;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        padding: '12px 14px',
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--surface-selected)' : hover ? 'var(--surface-hover)' : 'transparent',
        transition: 'background var(--dur-fast) var(--ease-standard)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        {icon && (
          <span style={{ display: 'inline-flex', flex: 'none', color: selected ? 'var(--accent)' : 'var(--text-tertiary)' }}>
            {icon}
          </span>
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--text-callout)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: 'var(--tracking-snug)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        {trailing}
        {updated && <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)', flex: 'none' }}>{updated}</span>}
      </div>
      {summary && (
        <p
          style={{
            margin: '0 0 8px 22px',
            fontSize: 'var(--text-subhead)',
            lineHeight: 'var(--leading-snug)',
            color: 'var(--text-secondary)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {summary}
        </p>
      )}
      {tags.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginLeft: 22, flexWrap: 'wrap' }}>
          {tags.slice(0, 3).map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      )}
    </button>
  );
}

/* ───────── ProgressBar ───────── */

export function ProgressBar({
  value = 0,
  tone = 'accent',
  height = 6,
  style = {},
}: {
  value?: number;
  tone?: 'done' | 'accent' | 'running' | 'brand';
  height?: number;
  style?: React.CSSProperties;
}) {
  const colors = {
    done: 'var(--status-done)',
    accent: 'var(--accent)',
    running: 'var(--status-running)',
    brand: 'var(--status-brand)',
  };
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      style={{
        position: 'relative',
        width: '100%',
        height,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-pill)',
        overflow: 'hidden',
        boxShadow: 'var(--ring-card)',
        ...style,
      }}
    >
      <div
        style={{
          height: '100%',
          width: pct + '%',
          borderRadius: 'var(--radius-pill)',
          background: colors[tone],
          transition: 'width var(--dur-slow) var(--ease-out)',
        }}
      />
    </div>
  );
}

/* ───────── Spinner ───────── */

export function Spinner({ size = 14, tone = 'var(--status-running)' }: { size?: number; tone?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid color-mix(in srgb, ${tone} 25%, transparent)`,
        borderTopColor: tone,
        animation: 'pith-spin 0.8s linear infinite',
        flex: 'none',
      }}
    />
  );
}

/* ───────── TokenMeter ───────── */

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

export function TokenMeter({ inTokens = 0, outTokens = 0 }: { inTokens?: number; outTokens?: number }) {
  if (inTokens === 0 && outTokens === 0) return null;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 12px',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--surface-sunken)',
        boxShadow: 'var(--ring-card)',
        font: 'var(--font-code)',
        fontSize: 'var(--text-footnote)',
        color: 'var(--text-tertiary)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        ↑ {fmtTokens(inTokens)}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
        ↓ {fmtTokens(outTokens)}
      </span>
    </div>
  );
}

/* ───────── ToolApprovalCard ───────── */

export function ToolApprovalCard({
  kind = 'write',
  path = '',
  preview = '',
  decided = null,
  onApprove,
  onAlways,
  onDeny,
}: {
  kind?: 'write' | 'exec';
  path?: string;
  preview?: string;
  decided?: 'yes' | 'no' | 'always' | null;
  onApprove?: () => void;
  onAlways?: () => void;
  onDeny?: () => void;
}) {
  const { t } = useTranslation();
  const isExec = kind === 'exec';
  const accent = isExec ? 'var(--status-running)' : 'var(--apple-yellow)';
  const title = isExec ? t('approval.execTitle') : t('approval.writeTitle');
  return (
    <div
      style={{
        borderRadius: 'var(--radius-card)',
        background: 'var(--surface-card)',
        boxShadow: 'var(--ring-card), var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: '0.5px solid var(--separator)',
          background: `color-mix(in srgb, ${accent} 8%, transparent)`,
        }}
      >
        <span style={{ display: 'inline-flex', color: accent, fontSize: 15 }}>{isExec ? '⌘' : '✎'}</span>
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <code
          style={{
            marginLeft: 'auto',
            font: 'var(--font-code)',
            color: 'var(--text-tertiary)',
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {path}
        </code>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '14px 16px',
          font: 'var(--font-code)',
          color: 'var(--text-secondary)',
          background: 'var(--surface-sunken)',
          maxHeight: 160,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {preview}
      </pre>
      {decided ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            fontSize: 'var(--text-subhead)',
            color: decided === 'no' ? 'var(--status-dead)' : 'var(--status-done)',
          }}
        >
          {decided === 'no' ? t('approval.denied') : decided === 'always' ? t('approval.approvedAlways') : t('approval.approved')}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px' }}>
          <Button variant="primary" size="sm" onClick={onApprove}>
            {t('approval.approve')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onAlways}>
            {t('approval.always')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDeny} style={{ marginLeft: 'auto', color: 'var(--status-dead)' }}>
            {t('approval.deny')}
          </Button>
        </div>
      )}
    </div>
  );
}
