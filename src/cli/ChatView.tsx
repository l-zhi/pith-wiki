import React from 'react';
import { Box, Static, Text } from 'ink';
import Spinner from 'ink-spinner';
import { C } from './theme.js';

export interface DisplayMessage {
  id: string;
  /**
   * `process` = 降权"过程痕迹"（think 标记 / verbose 叙述）：暗灰、
   * 无标题头、紧贴上一条，不抢正文注意力。
   * `tool` = 工具调用卡片（design 稿的 inset tool block）：左侧暗 rule 竖条 +
   * `●/✗ name(args)` + `↳ result`，verbose 模式下由 App 构造 node 传入。
   * 其余 role 按 role-bar 消息渲染（左侧彩色竖条 + 角色名 + 时间）。
   */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error' | 'process';
  text: string;
  meta?: string;
  /** 消息产生时刻（HH:MM）。append() 统一盖戳；缺省不渲染时间。 */
  ts?: string;
  /**
   * 富内容：如果给了，正文区渲染这个 React 节点替代 `text`。
   * 用于需要列对齐 / 表格 / 自定义颜色块的场景（dashboard、转换器表等）。
   * `text` 仍要传——做日志 / transcript fallback 用。
   */
  node?: React.ReactNode;
}

interface Props {
  messages: DisplayMessage[];
  inFlight: boolean;
  /**
   * 进行中的"当前活动"单行状态（tool 调用 / 中间叙述）。新动作替换旧的，轮结束清空。
   * 默认模式下显示在 spinner 旁，替代通用的 "thinking…"；null 时回落到 "thinking…"。
   * 完整过程在 transcript，这里只截断成一行说明"在干嘛"。
   */
  activity?: string | null;
}

/** 动态区活动行的单行宽度上限，超出截断，避免换行把布局顶乱。 */
const ACTIVITY_MAX = 100;

function oneLine(text: string, max = ACTIVITY_MAX): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * 已完成的消息走 <Static>，只渲染一次然后写入终端 scrollback，
 * 之后任何 React state 变化（输入框打字、spinner 动画）都不会重绘它们。
 *
 * 只有 spinner 留在动态渲染区。这样 Ink 的 log-update 每次刷新的面积
 * 极小，不会触发整屏闪烁。
 *
 * 视觉对齐 design 稿 ChatHero（role-bar messages）：
 *   - 每条消息左侧一根角色色竖条（you=purple · wiki=cyan · sys=dim · error=pink）
 *   - 标题头 = 角色名（粗体着色）+ 时间（dim）
 *   - tool 卡片内嵌：暗 rule 竖条，不带标题头
 */
export function ChatView({ messages, inFlight, activity }: Props) {
  // 进行中计时器：每秒 +1，inFlight 落下即归零。给用户"在跑还是挂了"的判断依据
  // ——尤其配合带超时的请求（最长可达 config.requestTimeoutMs）。
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!inFlight) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [inFlight]);

  return (
    <>
      <Static items={messages}>{(m) => <Message key={m.id} m={m} />}</Static>
      {inFlight ? (
        <Box marginTop={1}>
          <Text color={C.amber}>
            <Spinner type="dots" />{' '}
          </Text>
          {activity ? (
            <Text color={C.dim}>{oneLine(activity)}</Text>
          ) : (
            <Text color={C.dim}>thinking…</Text>
          )}
          {elapsed > 0 ? (
            <Text color={C.dim2}>
              {' '}
              ({elapsed}s{elapsed >= 10 ? ' · ctrl-c 取消' : ''})
            </Text>
          ) : null}
        </Box>
      ) : null}
    </>
  );
}

function Message({ m }: { m: DisplayMessage }) {
  if (m.role === 'process') {
    // 过程档：暗灰、紧贴上一条（marginTop=0）、无标题头、无竖条。
    return (
      <Box flexDirection="column">
        <Text color={C.dim2}>{m.text}</Text>
      </Box>
    );
  }

  if (m.role === 'tool') {
    // 工具卡片：暗 rule 竖条内嵌块，紧贴上一条。node 由 App 构造
    //（●/✗ + name + args + ↳ preview）；纯 text 时降级为 dim 整段。
    return (
      <Stripe color={C.dim3} marginTop={0}>
        {m.node ? m.node : <Text color={C.dim}>{m.text}</Text>}
      </Stripe>
    );
  }

  if (m.role === 'system') {
    // sys 消息：design 稿里无角色头，内容整体 dim，竖条用更暗的 dim2。
    return (
      <Stripe color={C.dim2} marginTop={1}>
        {m.node ? m.node : <Text color={C.dim}>{m.text}</Text>}
      </Stripe>
    );
  }

  return (
    <Stripe color={stripeFor(m.role)} marginTop={1}>
      <Box>
        <Text color={stripeFor(m.role)} bold>
          {labelFor(m.role)}
        </Text>
        {m.ts ? <Text color={C.dim2}>  {m.ts}</Text> : null}
        {m.meta ? <Text color={C.dim2}> {m.meta}</Text> : null}
      </Box>
      {m.node ? m.node : <Text color={C.fg2}>{m.text}</Text>}
    </Stripe>
  );
}

/** 左侧角色竖条容器：ink 单边 border 画 `│`，跨消息的全部行高。 */
function Stripe({
  color,
  marginTop,
  children,
}: {
  color: string;
  marginTop: number;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      marginTop={marginTop}
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeftColor={color}
      paddingLeft={1}
    >
      {children}
    </Box>
  );
}

function stripeFor(role: DisplayMessage['role']): string {
  switch (role) {
    case 'user':
      return C.purple;
    case 'assistant':
      return C.cyan;
    case 'error':
      return C.pink;
    default:
      return C.dim2;
  }
}

function labelFor(role: DisplayMessage['role']): string {
  switch (role) {
    case 'user':
      return 'you';
    case 'assistant':
      return 'wiki';
    case 'error':
      return 'error';
    default:
      return role;
  }
}
