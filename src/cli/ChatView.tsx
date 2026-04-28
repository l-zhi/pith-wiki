import React from 'react';
import { Box, Static, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  text: string;
  meta?: string;
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
        {(m) => (
          <Box key={m.id} flexDirection="column" marginTop={1}>
            <Text color={colorFor(m.role)} bold>
              {labelFor(m.role)}
              {m.meta ? <Text color="gray"> {m.meta}</Text> : null}
            </Text>
            <Text>{m.text}</Text>
          </Box>
        )}
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
      return 'llm-wiki';
    case 'tool':
      return 'tool';
    case 'error':
      return 'error';
    default:
      return role;
  }
}
