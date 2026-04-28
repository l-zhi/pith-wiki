import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  disabled: boolean;
  onSubmit: (value: string) => void;
  /** 历史记录数组，按时间升序：最旧在前、最新在后。 */
  history: string[];
}

/**
 * 输入框 + 历史浏览。
 *
 * 历史索引语义：
 *   -1                 = 用户当前正在编辑的草稿
 *   0                  = 最近一条历史
 *   ...                = 越旧越大
 *   history.length - 1 = 最旧的一条
 *
 * 操作：
 *   ↑ 进入更老的历史（在 -1 时先把当前草稿存进 draftRef，下次 ↓ 回到 -1 时还原）
 *   ↓ 朝当前方向走；走到 -1 时恢复草稿
 *   Enter 提交；提交后索引重置为 -1、草稿清空
 *
 * 已知坑修复：ink-text-input v6 的内部光标偏移是 useState 维护的，外部 setValue
 * 不会重置；用 key={historyIndex} 强制 React 在切换索引时整体 remount，新的
 * TextInput 初始化时把 cursorOffset 设为 value.length，光标自然落在末尾。
 */
export function InputBox({ disabled, onSubmit, history }: Props) {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  // 进入历史前的草稿，按 ↓ 回到 -1 时复原。
  const draftRef = useRef('');

  useInput((_input, key) => {
    if (disabled) return;

    if (key.upArrow) {
      if (history.length === 0) return;
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      if (newIndex === historyIndex) return; // 已到最旧
      // 第一次离开草稿时把当前正在编辑的内容存起来。
      if (historyIndex === -1) draftRef.current = value;
      setHistoryIndex(newIndex);
      // history 的最后一项是最近一条，对应索引 0。
      setValue(history[history.length - 1 - newIndex]);
      return;
    }

    if (key.downArrow) {
      if (historyIndex === -1) return; // 已经在草稿
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setValue(newIndex === -1 ? draftRef.current : history[history.length - 1 - newIndex]);
      return;
    }
  });

  const handleSubmit = (v: string) => {
    if (!v.trim()) return;
    onSubmit(v);
    setValue('');
    setHistoryIndex(-1);
    draftRef.current = '';
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
      {/*
        key={historyIndex} 触发 remount，让光标在切换历史项时回到末尾。
        正常打字时（historyIndex 维持 -1）key 不变，不会 remount，输入流畅。
      */}
      <TextInput key={historyIndex} value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
