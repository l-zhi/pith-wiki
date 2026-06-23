import React from 'react';

/**
 * pith 品牌标识 —— 「脉络 / 橘络」(the pith net)。
 *
 * 1:1 复刻 design/pith-wiki-logo（LogoMark.dc.html + Logo System.dc.html）：
 * 柑橘白色纤维网从致密核心放射到果皮 —— 同时是 pith（瓤）与 link graph。
 * 六重 60° 径向对称、单一品牌红、系统字体。
 *
 *   - variant 'full'（设计稿 v6）：6 条分叉纤维 + 12 节点 + 核心 + 果皮环。主标，≥48px。
 *   - variant 'simple'（设计稿 v7）：6 条单纤维 + 6 节点 + 核心。小尺寸 / favicon。
 *
 * 颜色契约（与 design 一致）：
 *   bg  = 圆角方块底（tile）；transparent 时不出底，直接贴在玻璃/卡片上。
 *   ink = 果皮环（rind），仅 full 用。
 *   mk  = 纤维 / 节点 / 核心（品牌红）。on-black 用 #ff5247，on-white 用 #e11d2a。
 *
 * viewBox 固定 120×120；几何照搬设计稿，任意 size 等比缩放。
 */

const FIBRE_ANGLES = [0, 60, 120, 180, 240, 300];

// v7 简化版的 6 个节点坐标（设计稿写死，= 半径 36 的六边形顶点，从正上方起每 60°）
const SIMPLE_NODES: [number, number][] = [
  [60, 24],
  [91.2, 42],
  [91.2, 78],
  [60, 96],
  [28.8, 78],
  [28.8, 42],
];

export interface LogoMarkProps {
  /** 渲染像素尺寸（正方形）。默认 24。 */
  size?: number;
  /** 'full' = 分叉网（主标）；'simple' = 单纤维（小尺寸）。默认按 size 自动：<28 → simple。 */
  variant?: 'full' | 'simple';
  /** 圆角方块底色；transparent（默认）= 不出底，直接贴在背景上。 */
  bg?: string;
  /** 果皮环颜色（仅 full）。默认 on-white 的淡墨。 */
  ink?: string;
  /** 纤维/节点/核心颜色（品牌红）。默认 var(--status-brand)。 */
  mk?: string;
  /** tile 圆角（120 网格下的 rx，默认 27，等比缩放）。仅 bg 非透明时可见。 */
  radius?: number;
  title?: string;
  style?: React.CSSProperties;
}

export function LogoMark({
  size = 24,
  variant,
  bg = 'transparent',
  ink = 'rgba(0,0,0,0.18)',
  mk = 'var(--status-brand)',
  radius = 27,
  title,
  style,
}: LogoMarkProps) {
  const v = variant ?? (size < 28 ? 'simple' : 'full');
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      style={{ display: 'block', flex: 'none', ...style }}
      role="img"
      aria-label={title ?? 'pith'}
    >
      {title ? <title>{title}</title> : null}
      <rect x="0" y="0" width="120" height="120" rx={radius} ry={radius} fill={bg} />

      {v === 'full' ? (
        <>
          <circle cx="60" cy="60" r="40" fill="none" stroke={ink} strokeWidth="1.5" />
          <g fill="none" stroke={mk} strokeLinecap="round">
            {FIBRE_ANGLES.map((a) => (
              <g key={a} transform={`rotate(${a} 60 60)`}>
                <path d="M60 55 Q60 44 60 33" strokeWidth="2.4" />
                <path d="M60 35 Q55 29 49 24" strokeWidth="1.6" />
                <path d="M60 35 Q65 29 71 24" strokeWidth="1.6" />
                <circle cx="49" cy="24" r="1.9" fill={mk} stroke="none" />
                <circle cx="71" cy="24" r="1.9" fill={mk} stroke="none" />
              </g>
            ))}
          </g>
          <circle cx="60" cy="60" r="6.5" fill={mk} />
        </>
      ) : (
        <>
          <g fill="none" stroke={mk} strokeLinecap="round" strokeWidth="3">
            {FIBRE_ANGLES.map((a) => (
              <g key={a} transform={`rotate(${a} 60 60)`}>
                <line x1="60" y1="49" x2="60" y2="27" />
              </g>
            ))}
          </g>
          {SIMPLE_NODES.map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" fill={mk} />
          ))}
          <circle cx="60" cy="60" r="11" fill={mk} />
        </>
      )}
    </svg>
  );
}

export interface LogoLockupProps {
  /** mark 像素尺寸。默认 22。 */
  size?: number;
  variant?: 'full' | 'simple';
  /** 字标主色（"pith"）。默认 var(--text-primary)。 */
  wordColor?: string;
  /** 可选的 accent 后缀（如 "wiki"），用 mk 色显示；省略则只显示 "pith"。 */
  subword?: string;
  /** mark 与字标的品牌红（也用于 subword）。默认 var(--status-brand)。 */
  mk?: string;
  ink?: string;
  /** 字号（px）。默认按 size 推算。 */
  fontSize?: number;
  gap?: number;
  style?: React.CSSProperties;
}

/** mark + 字标横向锁版（设计稿 Lockups）。侧边栏品牌位、菜单栏等用。 */
export function LogoLockup({
  size = 22,
  variant,
  wordColor = 'var(--text-primary)',
  subword,
  mk = 'var(--status-brand)',
  ink,
  fontSize,
  gap = 8,
  style,
}: LogoLockupProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap, ...style }}>
      <LogoMark size={size} variant={variant} mk={mk} ink={ink ?? 'rgba(0,0,0,0.18)'} />
      <span
        style={{
          fontSize: fontSize ?? Math.round(size * 0.78),
          fontWeight: 700,
          letterSpacing: 'var(--tracking-tight, -0.022em)',
          lineHeight: 1,
          color: wordColor,
        }}
      >
        pith
        {subword ? <span style={{ color: mk }}>{subword}</span> : null}
      </span>
    </span>
  );
}
