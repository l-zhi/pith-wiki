import { Box, Text, useInput } from 'ink';

export interface ApprovalRequest {
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text color="yellow" bold>
        {`Run command "${request.path}"?`}
      </Text>
      <Text color="gray">--- command ---</Text>
      <Text>{request.preview}</Text>
      <Text color="gray">---------------</Text>
      <Text>
        <Text color="green">[y]</Text> yes  <Text color="green">[a]</Text> always (this binary, this session)
        {'  '}
        <Text color="red">[n]</Text> no
      </Text>
    </Box>
  );
}
