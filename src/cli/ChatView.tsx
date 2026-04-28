import React from 'react';
import { Box, Text } from 'ink';
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

export function ChatView({ messages, inFlight }: Props) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column" marginTop={1}>
          <Text color={colorFor(m.role)} bold>
            {labelFor(m.role)}
            {m.meta ? <Text color="gray"> {m.meta}</Text> : null}
          </Text>
          <Text>{m.text}</Text>
        </Box>
      ))}
      {inFlight ? (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> thinking…
          </Text>
        </Box>
      ) : null}
    </Box>
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
