import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ApprovalRequest {
  /**
   * 'write' = 文件写入路径；'exec' = 命令执行（path 存二进制名，preview 存完整 argv）；
   * 'net' = 网络访问（path 存 host，preview 存 METHOD url）。
   */
  kind?: 'write' | 'exec' | 'net';
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

  const kind = request.kind ?? 'write';
  const title =
    kind === 'exec'
      ? `Run command "${request.path}"?`
      : kind === 'net'
        ? `Allow network request to ${request.path}?`
        : `Approve write to ${request.path}?`;
  const previewLabel =
    kind === 'exec' ? '--- command ---' : kind === 'net' ? '--- request ---' : '--- preview ---';
  const alwaysLabel =
    kind === 'exec'
      ? 'always (this binary, this session)'
      : kind === 'net'
        ? 'always (this host, this session)'
        : 'always (this session)';

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
