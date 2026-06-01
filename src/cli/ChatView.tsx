import React from 'react';
import { Box, Static, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface DisplayMessage {
  id: string;
  /**
   * `process` = 降权"过程痕迹"（think 标记 / tool round / verbose 叙述）：暗灰、
   * 无标题头、紧贴上一条，不抢正文注意力。其余 role 正常带标题头渲染。
   */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error' | 'process';
  text: string;
  meta?: string;
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
}

/**
 * 已完成的消息走 <Static>，只渲染一次然后写入终端 scrollback，
 * 之后任何 React state 变化（输入框打字、spinner 动画）都不会重绘它们。
 *
 * 只有 spinner 留在动态渲染区。这样 Ink 的 log-update 每次刷新的面积
 * 极小，不会触发整屏闪烁。
 *
 * 参考 Claude Code 的同款实现思路。
 */
export function ChatView({ messages, inFlight }: Props) {
  return (
    <>
      <Static items={messages}>
        {(m) =>
          m.role === 'process' ? (
            // 过程档：暗灰、紧贴上一条（marginTop=0）、无标题头。
            <Box key={m.id} flexDirection="column">
              <Text color="gray" dimColor>
                {m.text}
              </Text>
            </Box>
          ) : (
            <Box key={m.id} flexDirection="column" marginTop={1}>
              <Text color={colorFor(m.role)} bold>
                {labelFor(m.role)}
                {m.meta ? <Text color="gray"> {m.meta}</Text> : null}
              </Text>
              {m.node ? m.node : <Text>{m.text}</Text>}
            </Box>
          )
        }
      </Static>
      {inFlight ? (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> thinking…
          </Text>
        </Box>
      ) : null}
    </>
  );
}

function colorFor(role: DisplayMessage['role']): string {
  switch (role) {
    case 'user':
      return 'green';
    case 'assistant':
      return 'cyan';
    case 'tool':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
}

function labelFor(role: DisplayMessage['role']): string {
  switch (role) {
    case 'user':
      return 'you';
    case 'assistant':
      return 'pith-wiki';
    case 'tool':
      return 'tool';
    case 'error':
      return 'error';
    default:
      return role;
  }
}
