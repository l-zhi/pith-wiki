import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ApprovalRequest {
  /** 'write' = 文件写入路径；'exec' = 命令执行（path 存二进制名，preview 存完整 argv）。 */
  kind?: 'write' | 'exec';
  path: string;
  preview: string;
  resolve: (answer: 'yes' | 'no' | 'always') => void;
}

interface Props {
  request: ApprovalRequest;
}

export function ToolApproval({ request }: Props) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y') request.resolve('yes');
    else if (ch === 'a') request.resolve('always');
    else if (ch === 'n' || key.escape || key.return) request.resolve('no');
  });

  useEffect(() => () => {
    /* nothing to cleanup */
  }, []);

  const isExec = request.kind === 'exec';
  const title = isExec ? `Run command "${request.path}"?` : `Approve write to ${request.path}?`;
  const previewLabel = isExec ? '--- command ---' : '--- preview ---';
  const alwaysLabel = isExec ? 'always (this binary, this session)' : 'always (this session)';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text color="yellow" bold>
        {title}
      </Text>
      <Text color="gray">{previewLabel}</Text>
      <Text>{request.preview}</Text>
      <Text color="gray">---------------</Text>
      <Text>
        <Text color="green">[y]</Text> yes  <Text color="green">[a]</Text> {alwaysLabel}
        {'  '}
        <Text color="red">[n]</Text> no
      </Text>
    </Box>
  );
}
