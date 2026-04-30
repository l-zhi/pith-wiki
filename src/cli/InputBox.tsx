import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { completeOnTab, filterCommands, SLASH_COMMANDS } from './slashCommands.js';

interface Props {
  disabled: boolean;
  onSubmit: (value: string) => void;
  /** 历史记录数组，按时间升序：最旧在前、最新在后。 */
  history: string[];
}

/**
 * 输入框 + 历史浏览 + Slash 命令实时提示 / Tab 补全。
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
 *   Tab  在 / 开头时按命令前缀做补全（1 个匹配 → 完整补全；多个 → 最长公共前缀）
 *
 * 已知坑修复：ink-text-input v6 的内部光标偏移是 useState 维护的，外部 setValue
 * 不会重置；用 key={historyIndex|tabBump} 强制 React 在切换历史项 / Tab 补全后
 * 整体 remount，新的 TextInput 初始化时把 cursorOffset 设为 value.length，
 * 光标自然落在末尾。
 */
export function InputBox({ disabled, onSubmit, history }: Props) {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  // 进入历史前的草稿，按 ↓ 回到 -1 时复原。
  const draftRef = useRef('');
  // 每次 Tab 补全 +1，与 historyIndex 一起组成 TextInput 的 key，让光标重置到末尾。
  const [tabBump, setTabBump] = useState(0);

  // / 开头时实时过滤命令；其他情况返回空数组（不渲染提示框）。
  const suggestions = useMemo(() => {
    if (!value.startsWith('/')) return [];
    // 已经在打参数（含空格）时不再过滤——参数自由输入，命令头已固定
    if (value.includes(' ')) return [];
    return filterCommands(value);
  }, [value]);

  useInput((_input, key) => {
    if (disabled) return;

    if (key.tab) {
      if (suggestions.length === 0) return;
      const next = completeOnTab(value, suggestions);
      if (next !== value) {
        setValue(next);
        setTabBump((n) => n + 1); // 强制 TextInput remount → 光标回末尾
      }
      return;
    }

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
    <Box flexDirection="column">
      {suggestions.length > 0 ? <SuggestionList items={suggestions} /> : null}
      <Box>
        <Text color="green">› </Text>
        {/*
          key={historyIndex}-{tabBump} 触发 remount，让光标在切换历史项 / Tab 补全
          后回到末尾。正常打字时两个值都不变，TextInput 不 remount，输入流畅。
        */}
        <TextInput
          key={`${historyIndex}-${tabBump}`}
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
        />
      </Box>
    </Box>
  );
}

/**
 * 命令提示列表。简单的纯展示组件——不接收键盘焦点、不维护选中态；
 * 用户通过继续打字过滤、按 Tab 补全。等价于 fish/zsh 的 menu-complete 风格。
 */
function SuggestionList({ items }: { items: typeof SLASH_COMMANDS }) {
  // 命令名右侧对齐到等宽列，便于眼扫
  const nameWidth = Math.max(...items.map((c) => c.name.length));
  return (
    <Box flexDirection="column" marginBottom={0}>
      {items.map((c) => (
        <Box key={c.name}>
          <Text color="cyan">{c.name.padEnd(nameWidth)}</Text>
          <Text color="gray">  {c.description}</Text>
          {c.aliases && c.aliases.length > 0 ? (
            <Text color="gray"> (alias: {c.aliases.join(', ')})</Text>
          ) : null}
        </Box>
      ))}
      <Text color="gray">  Tab to complete · Enter to submit</Text>
    </Box>
  );
}
