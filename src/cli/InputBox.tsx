import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  disabled: boolean;
  onSubmit: (value: string) => void;
}

export function InputBox({ disabled, onSubmit }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = (v: string) => {
    if (!v.trim()) return;
    onSubmit(v);
    setValue('');
  };

  if (disabled) {
    return (
      <Box>
        <Text color="gray">… (Ctrl+C to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="green">› </Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
