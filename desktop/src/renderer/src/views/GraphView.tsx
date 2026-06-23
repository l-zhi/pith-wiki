import React from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';
import Sigma from 'sigma';
import { animateNodes } from 'sigma/utils';
import { ChevronDown, Layers, RefreshCw, Sparkles, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Switch } from '../ds';
import { useStore } from '../store';
import type { GraphDTO } from '../../../shared/protocol';

/**
 * 关系图谱（grill 共识）：sigma.js(WebGL) + graphology，ForceAtlas2 固定轮次布局。
 * GraphCanvas 为全局图与 Reader 局部图共用：hover 高亮邻居（其余淡出）、拖拽、
 * 点击跳 Reader、节点大小=度数、按集合着色；主题切换时重建（颜色读 CSS 变量）。
 */

/* ───────── 配色 ─────────
 * 按集合上色（两套主题专属调色板，同一索引 = 同一色相，换主题色相一致）：
 *   - 浅色模式：中深饱和（白底上清晰、互相可辨）。
 *   - 深色模式：鲜亮（暗底上跳出）。
 * 必须返回 #hex —— sigma v3 的 parseColor 只认 #hex / rgb() / 命名色，
 * 不解析 hsl()（遇到会回退成纯黑，这正是旧版节点全黑的原因）。
 */
/** 浅色模式的中性兜底色（用于淡出态等，不再用于普通节点）。 */
export function nodeColor(dark: boolean): string {
  return dark ? '#a1a1aa' : '#55555c';
}

/** 深色模式集合调色板：色相均匀、暗底上鲜亮可辨。 */
const PALETTE_DARK: readonly string[] = [
  '#ff8589', '#ff9d52', '#f3cb45', '#aede5f', '#69d97e', '#3ed3c2',
  '#4ec6f0', '#7aa0ff', '#9c8cff', '#c08cff', '#f084d8', '#ff85a8',
];

/** 浅色模式集合调色板：与深色版同色相顺序，但中深饱和，适配白底。 */
const PALETTE_LIGHT: readonly string[] = [
  '#e5484d', '#e7600a', '#b08600', '#5d9a13', '#2f9e44', '#0d9488',
  '#0892c8', '#2f6bd6', '#5b4ae0', '#8b3ce0', '#bb359f', '#d23d6a',
];

function palette(dark: boolean): readonly string[] {
  return dark ? PALETTE_DARK : PALETTE_LIGHT;
}

function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

/** 无状态按名取色（hash 选板内颜色）。局部图/兜底用。 */
export function collectionColor(name: string, dark: boolean): string {
  const p = palette(dark);
  return p[hashName(name) % p.length];
}

/**
 * 按集合顺序分配颜色：前 12 个集合颜色互不相同（之后循环复用）。
 * 返回 collection → #hex 取色函数；全局图与图例共用，确保同色。
 */
export function makeCollectionPalette(
  collections: readonly string[],
  dark: boolean,
): (collection: string) => string {
  const p = palette(dark);
  const map = new Map<string, string>();
  collections.forEach((name, i) => map.set(name, p[i % p.length]));
  return (collection) => map.get(collection) ?? collectionColor(collection, dark);
}

/** hover 时关联节点的浅红色（比强调红更淡，作“次级关联”提示）。 */
function neighborColor(dark: boolean): string {
  return dark ? '#ff9aa0' : '#ef9499';
}

/** 两个 #rrggbb 颜色按 t∈[0,1] 线性插值（展开动画里节点“点亮”用）。 */
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/* ───────── GraphCanvas ───────── */

interface CanvasProps {
  data: GraphDTO;
  /** local 模式：以 rootId 为中心 BFS depth 跳的子图 */
  rootId?: string;
  depth?: number;
  hiddenCollections?: Set<string>;
  showOrphans?: boolean;
  /** 集合 → #hex 取色；缺省按名 hash（局部图用）。全局图传入有序调色板以避免撞色。 */
  colorOf?: (collection: string) => string;
  /** 每次自增触发一次“炫酷展开”长动画（仅全局图用）。 */
  replayNonce?: number;
  onOpenEntry: (id: string) => void;
  style?: React.CSSProperties;
}

export function GraphCanvas({
  data,
  rootId,
  depth = 1,
  hiddenCollections,
  showOrphans = true,
  colorOf,
  replayNonce = 0,
  onOpenEntry,
  style,
}: CanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const theme = useStore((s) => s.theme); // 触发亮暗重建
  const [themeTick, setThemeTick] = React.useState(0);
  const prevNonce = React.useRef(replayNonce); // 区分“点击展开”与主题/数据变化导致的重建

  // auto 模式下系统切换主题不经过 store：观察 data-theme 属性变化
  React.useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dark = isDarkTheme();
    const colorFor = colorOf ?? ((c: string) => collectionColor(c, dark));
    const accentRaw = cssVar('--accent');
    const hiNode = accentRaw.startsWith('#') ? accentRaw : '#e11d2a'; // hover/点亮强调红（保证 #hex 供插值）
    const nbNode = neighborColor(dark); // 关联节点浅红
    const labelColor = cssVar('--text-secondary') || (dark ? '#aeaeb2' : '#6e6e73');
    const fadeNode = dark ? 'rgba(150,150,158,0.14)' : 'rgba(60,60,67,0.10)';
    const edgeColor = dark ? 'rgba(120,120,132,0.55)' : 'rgba(60,60,67,0.32)';
    const edgeHi = hiNode; // hover 节点的边：红色

    /* —— 建图（含 local BFS / 过滤） —— */
    const adj = new Map<string, string[]>();
    for (const e of data.edges) {
      (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
      (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
    }

    let keep: Set<string> | null = null;
    if (rootId) {
      keep = new Set([rootId]);
      let frontier = [rootId];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const nb of adj.get(id) ?? []) {
            if (!keep.has(nb)) {
              keep.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
    }

    const graph = new Graph();
    for (const n of data.nodes) {
      if (keep && !keep.has(n.id)) continue;
      if (hiddenCollections?.has(n.collection)) continue;
      if (!showOrphans && !rootId && n.degree === 0) continue;
      graph.addNode(n.id, {
        label: n.title,
        collection: n.collection,
        size: rootId && n.id === rootId ? 10 : 2.5 + Math.sqrt(n.degree) * 1.4,
        color: colorFor(n.collection),
      });
    }
    for (const e of data.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { size: dark ? 0.3 : 1.4 });
      } catch {
        /* 平行边忽略 */
      }
    }
    if (graph.order === 0) return;

    /* —— BFS 层级 + 连通分量：每个分量从最高度节点起算 BFS 距离=层；孤点自成 0 层、单独分量。
     *    常规入场按“层”逐步揭开；展开动画按“分量(小→大) + 层”依次点亮（一个个、一层层）。 —— */
    const layer = new Map<string, number>();
    const comp = new Map<string, number>();
    const compSize = new Map<number, number>();
    {
      const remaining = new Set(graph.nodes());
      const order = rootId
        ? [rootId, ...graph.nodes().filter((id) => id !== rootId)]
        : graph.nodes().sort((a, b) => graph.degree(b) - graph.degree(a));
      let cid = 0;
      for (const seed of order) {
        if (!remaining.has(seed)) continue;
        layer.set(seed, 0);
        comp.set(seed, cid);
        remaining.delete(seed);
        let frontier = [seed];
        let d = 0;
        let size = 1;
        while (frontier.length) {
          const next: string[] = [];
          for (const id of frontier)
            for (const nb of graph.neighbors(id))
              if (remaining.has(nb)) {
                remaining.delete(nb);
                layer.set(nb, d + 1);
                comp.set(nb, cid);
                size++;
                next.push(nb);
              }
          frontier = next;
          d++;
        }
        compSize.set(cid, size);
        cid++;
      }
    }
    let maxLayer = 0;
    for (const v of layer.values()) maxLayer = Math.max(maxLayer, v);

    /* —— 揭示进度度量（0..1），动画推进 eased 到该值时点亮节点 —— */
    const isReplay = replayNonce !== prevNonce.current;
    prevNonce.current = replayNonce;
    const revealMetric = new Map<string, number>();
    if (isReplay) {
      // 分量按大小降序：先点亮居中的大簇（相机此时正放大对准中心），再随相机拉远显现小簇/孤点；同分量内由内向外（层）
      const compsBySize = [...compSize.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const slotOf = new Map<number, number>();
      compsBySize.forEach((id, i) => slotOf.set(id, i));
      const nComp = Math.max(1, compsBySize.length);
      graph.forEachNode((id) => {
        const slot = slotOf.get(comp.get(id) ?? 0) ?? 0;
        const inner = Math.min(0.9, (layer.get(id) ?? 0) / (maxLayer + 1));
        revealMetric.set(id, (slot + inner) / nComp);
      });
    } else {
      const denom = Math.max(1, maxLayer);
      graph.forEachNode((id) => revealMetric.set(id, (layer.get(id) ?? 0) / denom));
    }
    const sortedNodes = graph.nodes().sort((a, b) => (revealMetric.get(a) ?? 0) - (revealMetric.get(b) ?? 0));

    /* —— 布局：环形种子；FA2 不再一次性同步跑（会卡死主线程），改为分帧逐块计算。
     *    强排斥 + 低重力 + 出度归一（hub 居中、叶子向外）→ 簇间留白、每簇放射状，
     *    避免挤成一团（对照 Obsidian 的舒展观感）。 —— */
    circular.assign(graph);
    const fa2Settings = {
      ...forceAtlas2.inferSettings(graph),
      scalingRatio: rootId ? 10 : 18, // 排斥力：越大簇间越松、留白越多
      gravity: rootId ? 1 : 0.4, // 重力：越小各连通分量越分散
      outboundAttractionDistribution: true, // hub 向心、叶子外扩，形成放射圆形
    };

    /* —— 渲染 —— */
    let hovered: string | null = null;
    let neighbors = new Set<string>();
    let dragged: string | null = null;
    let dragMoved = false;
    const revealAt = new Map<string, number>(); // 节点被点亮的时间戳（未点亮=隐藏）
    let nowTs = 0; // 当前帧时间戳，供 reducer 算点亮进度
    const POP_MS = 460; // 节点“点亮”弹入时长（展开动画用）
    const sigma = new Sigma(graph, container, {
      labelColor: { color: labelColor },
      labelFont: 'system-ui, sans-serif',
      labelSize: 11,
      labelRenderedSizeThreshold: rootId ? 0 : 7,
      defaultEdgeColor: edgeColor,
      // 边的屏幕最小像素厚度（默认 1.7 会把细 size 顶起来）：深色调细
      minEdgeThickness: dark ? 0.8 : 1.2,
      allowInvalidContainer: true,
      // 自带交互的缓动手感：缩放/双击/平移惯性都给足时长。
      zoomDuration: 260,
      doubleClickZoomingDuration: 320,
      inertiaDuration: 240,
      inertiaRatio: 3,
      nodeReducer(node, attrs) {
        const at = revealAt.get(node);
        if (at === undefined) return { ...attrs, hidden: true }; // 尚未点亮
        if (isReplay) {
          const e = Math.min(1, (nowTs - at) / POP_MS);
          if (e < 1) {
            const k = 1 - Math.pow(1 - e, 2); // easeOut：由小变大、红→本色
            return { ...attrs, size: (attrs.size as number) * (0.15 + 0.85 * k), color: lerpHex(hiNode, attrs.color as string, k), zIndex: 5 };
          }
        }
        if (node === dragged) return { ...attrs, size: (attrs.size as number) * 1.45, color: hiNode, highlighted: true, zIndex: 3 };
        if (!hovered) return attrs;
        if (node === hovered) return { ...attrs, color: hiNode, zIndex: 2, highlighted: true };
        if (neighbors.has(node)) return { ...attrs, color: nbNode, zIndex: 1 };
        return { ...attrs, color: fadeNode, label: '', zIndex: 0 };
      },
      edgeReducer(edge, attrs) {
        const [s, t] = graph.extremities(edge);
        if (!revealAt.has(s) || !revealAt.has(t)) return { ...attrs, hidden: true }; // 两端都点亮才连线
        if (!hovered) return attrs;
        if (s === hovered || t === hovered) return { ...attrs, color: edgeHi, size: 2.6 };
        return { ...attrs, hidden: true };
      },
    });

    /* —— 动画驱动：常规入场 3s（cubic ease-out），点击“展开动画”10s（smoothstep + 逐节点点亮）。
     *    按缓动进度沿 sortedNodes 依次点亮，FA2 同步 settle；rAF 时间戳保证墙钟时长准确。 —— */
    const CHUNK = rootId ? 4 : 5; // 每帧 FA2 迭代轮数
    const DURATION = isReplay ? 10000 : rootId ? 1200 : 3000;
    const ZOOM_FROM = 0.32; // 展开动画起始相机比例（放大）→ 1（贴合全图）
    const ZOOM_SMOOTH = 0.1; // 缩放缓动系数（指数平滑：越小越柔、跟随越慢）
    let startTs = 0;
    let rafId = 0;
    let ptr = 0;
    let camRatio = ZOOM_FROM;
    if (isReplay) sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: ZOOM_FROM });

    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      nowTs = ts;
      const p = Math.min(1, (ts - startTs) / DURATION);
      const eased = isReplay ? p * p * (3 - 2 * p) : 1 - Math.pow(1 - p, 3); // 展开:smoothstep；常规:cubic-out
      while (ptr < sortedNodes.length && (revealMetric.get(sortedNodes[ptr]) ?? 0) <= eased) {
        revealAt.set(sortedNodes[ptr], ts);
        ptr++;
      }
      if (isReplay) {
        // 缩放与“画面中点的个数”联动：目标比例由已点亮占比决定，再指数平滑缓动跟随
        const frac = sortedNodes.length ? ptr / sortedNodes.length : 1;
        const targetRatio = ZOOM_FROM + (1 - ZOOM_FROM) * frac;
        camRatio += (targetRatio - camRatio) * ZOOM_SMOOTH;
        sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: camRatio });
      }
      forceAtlas2.assign(graph, { iterations: CHUNK, settings: fa2Settings });
      sigma.refresh();
      // 展开动画要多跑 POP_MS，让最后点亮的节点把弹入动画走完
      const done = p >= 1 && (!isReplay || ts - startTs >= DURATION + POP_MS);
      if (!done) rafId = requestAnimationFrame(tick);
      else {
        rafId = 0;
        if (isReplay) sigma.getCamera().animatedReset({ duration: 300 }); // 收尾精确贴合全图
      }
    };
    rafId = requestAnimationFrame(tick);

    sigma.on('enterNode', ({ node }) => {
      hovered = node;
      neighbors = new Set(graph.neighbors(node));
      container.style.cursor = 'pointer';
      sigma.refresh();
    });
    sigma.on('leaveNode', () => {
      hovered = null;
      neighbors = new Set();
      container.style.cursor = 'default';
      sigma.refresh();
    });
    // 点击：先缓动把节点送到视野中心并轻微放大，再打开条目。
    sigma.on('clickNode', ({ node }) => {
      if (dragMoved) {
        dragMoved = false;
        return; // 这是一次拖拽的收尾，不当作点击
      }
      const dd = sigma.getNodeDisplayData(node);
      const camera = sigma.getCamera();
      if (dd) {
        camera.animate(
          { x: dd.x, y: dd.y, ratio: Math.max(camera.ratio * 0.65, camera.minRatio ?? 0.05) },
          { duration: 240, easing: 'cubicInOut' },
          () => onOpenEntry(node),
        );
      } else {
        onOpenEntry(node);
      }
    });

    // 双击空白处：缓动复位到整体视图。
    sigma.on('doubleClickStage', (e) => {
      e.preventSigmaDefault();
      sigma.getCamera().animatedReset({ duration: 420 });
    });

    // 拖拽：临时拉出某点查看，松手后缓动弹回原位（不改变整体布局）。
    let downX = 0; // 按下时的视口坐标，用于判定是否真的在拖
    let downY = 0;
    let origX = 0; // 被拖节点的原始图坐标（松手回弹目标）
    let origY = 0;
    let cancelRestore: (() => void) | undefined;
    sigma.on('downNode', (e) => {
      dragged = e.node;
      dragMoved = false;
      downX = e.event.x;
      downY = e.event.y;
      origX = graph.getNodeAttribute(e.node, 'x') as number;
      origY = graph.getNodeAttribute(e.node, 'y') as number;
      cancelRestore?.(); // 打断上一次未完成的回弹
      cancelRestore = undefined;
      if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
    });
    sigma.getMouseCaptor().on('mousemovebody', (e) => {
      if (!dragged) return;
      if (!dragMoved && Math.hypot(e.x - downX, e.y - downY) < 4) return; // 阈值内当作点击
      dragMoved = true;
      const pos = sigma.viewportToGraph(e);
      graph.setNodeAttribute(dragged, 'x', pos.x); // 仅移动该点，其余保持不动
      graph.setNodeAttribute(dragged, 'y', pos.y);
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    });
    sigma.getMouseCaptor().on('mouseup', () => {
      const node = dragged;
      dragged = null;
      if (node && dragMoved) {
        // 缓动弹回原位
        cancelRestore = animateNodes(
          graph,
          { [node]: { x: origX, y: origY } },
          { duration: 450, easing: 'cubicOut' },
          () => {
            cancelRestore = undefined;
          },
        );
      }
      sigma.refresh();
    });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      cancelRestore?.();
      sigma.kill();
    };
  }, [data, rootId, depth, hiddenCollections, showOrphans, colorOf, replayNonce, onOpenEntry, theme, themeTick]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', ...style }} />;
}

/* ───────── 全局图谱页 ───────── */

export function GraphView() {
  const { t } = useTranslation();
  const graph = useStore((s) => s.graph);
  const loadGraph = useStore((s) => s.loadGraph);
  const openEntry = useStore((s) => s.openEntry);
  const theme = useStore((s) => s.theme);

  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [showOrphans, setShowOrphans] = React.useState(true);
  const [replayNonce, setReplayNonce] = React.useState(0); // 右上角“展开动画”按钮：每次点击 +1 触发炫酷重放
  const [legendOpen, setLegendOpen] = React.useState(true); // 左下角图例收起/展开

  const dark = isDarkTheme();
  const collections = React.useMemo(() => {
    const set = new Map<string, number>();
    for (const n of graph?.nodes ?? []) set.set(n.collection, (set.get(n.collection) ?? 0) + 1);
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  // 按集合（数量降序）分配颜色：深色模式彩色、浅色模式灰；节点与图例同色。
  const colorOf = React.useMemo(
    () => makeCollectionPalette(collections.map(([name]) => name), dark),
    [collections, dark],
  );

  const handleOpen = React.useCallback(
    (id: string) => void openEntry(id),
    [openEntry],
  );

  const toggle = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <Waypoints size={17} style={{ color: 'var(--status-watch)' }} />
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('graph.title')}</span>
        {graph && (
          <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('graph.stats', { nodes: graph.nodes.length, edges: graph.edges.length })}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('graph.showOrphans')}
            <Switch checked={showOrphans} onChange={setShowOrphans} />
          </span>
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<Sparkles size={14} />}
            onClick={() => setReplayNonce((n) => n + 1)}
            disabled={!graph || graph.edges.length === 0}
          >
            {t('graph.replay')}
          </Button>
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} onClick={() => void loadGraph(true)}>
            {t('graph.refresh')}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {!graph || graph.edges.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)', padding: 40, textAlign: 'center' }}>
            {graph ? t('graph.empty') : '…'}
          </div>
        ) : (
          <GraphCanvas data={graph} hiddenCollections={hidden} showOrphans={showOrphans} colorOf={colorOf} replayNonce={replayNonce} onOpenEntry={handleOpen} />
        )}

        {/* 图例：集合色点，点击切显隐；左下角可收起/展开 */}
        {collections.length > 0 &&
          (legendOpen ? (
            <div
              style={{
                position: 'absolute',
                left: 14,
                bottom: 14,
                maxWidth: 260,
                maxHeight: '45%',
                display: 'flex',
                flexDirection: 'column',
                padding: 8,
                borderRadius: 'var(--radius-md)',
                background: 'var(--material-glass)',
                WebkitBackdropFilter: 'var(--blur-thin)',
                backdropFilter: 'var(--blur-thin)',
                boxShadow: 'var(--ring-card), var(--shadow-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 6px' }}>
                <span style={{ flex: 1, fontSize: 'var(--text-caption)', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('nav.collections')}</span>
                <button
                  type="button"
                  onClick={() => setLegendOpen(false)}
                  title={t('graph.collapse')}
                  style={{ display: 'inline-flex', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, borderRadius: 'var(--radius-xs)' }}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', minHeight: 0 }}>
                {collections.map(([name, count]) => {
                  const off = hidden.has(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggle(name)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '3px 8px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        borderRadius: 'var(--radius-xs)',
                        opacity: off ? 0.35 : 1,
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: off ? 'transparent' : colorOf(name), border: off ? `1.5px solid ${colorOf(name)}` : 'none', boxSizing: 'border-box' }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-caption)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: off ? 'line-through' : 'none' }}>
                        {name}
                      </span>
                      <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLegendOpen(true)}
              title={t('nav.collections')}
              style={{
                position: 'absolute',
                left: 14,
                bottom: 14,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-md)',
                background: 'var(--material-glass)',
                WebkitBackdropFilter: 'var(--blur-thin)',
                backdropFilter: 'var(--blur-thin)',
                boxShadow: 'var(--ring-card), var(--shadow-card)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--text-caption)',
              }}
            >
              <Layers size={14} />
              <span>{t('nav.collections')}</span>
            </button>
          ))}
      </div>
      <span style={{ display: 'none' }}>{theme}</span>
    </div>
  );
}
