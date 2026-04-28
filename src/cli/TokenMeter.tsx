import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  inputTokens: number;
  outputTokens: number;
}

export function TokenMeter({ inputTokens, outputTokens }: Props) {
  if (inputTokens === 0 && outputTokens === 0) return null;
  return (
    <Box>
      <Text color="gray" dimColor>
        ↳ {inputTokens.toLocaleString()} in / {outputTokens.toLocaleString()} out
      </Text>
    </Box>
  );
}
