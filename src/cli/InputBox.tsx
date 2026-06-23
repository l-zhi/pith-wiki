import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { completeOnTab, filterCommands, type SlashCommand } from './slashCommands.js';
import { C } from './theme.js';
import {
  ascendValue,
  confirmDirValue,
  confirmEntryValue,
  descendValue,
  listLevel,
  parseMentionInput,
  type MentionLevelItem,
  type MentionTree,
} from './mentions.js';

interface Props {
  disabled: boolean;
  onSubmit: (value: string) => void;
  /** 历史记录数组，按时间升序：最旧在前、最新在后。 */
  history: string[];
  /**
   * `@`-mention 目录树（wiki 的 collection + subpath 层级）。由 App 按 library memo 后传入。
   * 缺省 → 不弹 mention 提示（嵌入 / 测试场景）。
   */
  mentionTree?: MentionTree;
  /**
   * 运行时动态 slash 命令（每个 skill → `/<name>`）。并入命令提示 / 补全；
   * 与内置同名者由 filterCommands 丢弃（内置优先）。
   */
  extraCommands?: SlashCommand[];
}

/**
 * 输入框 + 历史浏览 + Slash 命令 / @-mention 实时提示。
 *
 * Picker 打开时（输入 `/` 命令头 或 `@` mention）支持键盘导航：
 *   ↑ / ↓   移动高亮选择
 *   Enter    确认高亮项 → 补全进输入框（不提交本条消息）；已是完整形态时再 Enter 才提交
 *   Tab      钻取 / 补全（@目录 → 进入该目录；@条目 / 命令 → 补全）
 *   ← / →    （仅 @-mention）→ 进入高亮目录 / ← 退回上层目录
 * Picker 关闭时：
 *   ↑ / ↓   浏览输入历史
 *   Enter    提交消息
 *
 * 历史索引语义：-1 = 草稿；0 = 最近一条；越旧越大。
 *
 * 光标坑：ink-text-input v6 的光标偏移是内部 useState，外部 setValue 不重置；
 * 用 key={historyIndex|tabBump} 在切历史 / 导航补全后强制 remount，让光标回末尾。
 */
export function InputBox({ disabled, onSubmit, history, mentionTree, extraCommands }: Props) {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef('');
  const [tabBump, setTabBump] = useState(0);
  // picker 内高亮项索引。任何会改变候选列表的操作（打字 / 导航）都把它复位到 0。
  const [selectedIndex, setSelectedIndex] = useState(0);

  // / 开头时实时过滤命令；含空格（进入参数区）则收起。
  const slashItems = useMemo<SlashCommand[]>(() => {
    if (!value.startsWith('/')) return [];
    if (value.includes(' ')) return [];
    return filterCommands(value, extraCommands ?? []);
  }, [value, extraCommands]);

  // 非 / 开头时检测正在输入的 @-mention，按当前目录层级列举候选。
  const mentionInput = useMemo(() => parseMentionInput(value), [value]);
  const mentionItems = useMemo<MentionLevelItem[]>(() => {
    if (!mentionInput || !mentionTree) return [];
    return listLevel(mentionTree, mentionInput.pathSegs, mentionInput.partial);
  }, [mentionInput, mentionTree]);

  const pickerKind: 'slash' | 'mention' | null =
    slashItems.length > 0 ? 'slash' : mentionItems.length > 0 ? 'mention' : null;
  const itemCount = pickerKind === 'slash' ? slashItems.length : mentionItems.length;
  const sel = itemCount > 0 ? Math.min(selectedIndex, itemCount - 1) : 0;

  // setValue + 复位选择 + 强制 remount（光标回末尾）。用于导航 / 补全这类整体改写。
  const applyValue = (v: string) => {
    setValue(v);
    setSelectedIndex(0);
    setTabBump((n) => n + 1);
  };

  // 给定高亮项算出"确认补全"后的完整 value（Enter 用）。
  const completionFor = (): string | null => {
    if (pickerKind === 'slash') {
      const c = slashItems[sel];
      return c ? `${c.name}${c.takesArg ? ' ' : ''}` : null;
    }
    if (pickerKind === 'mention' && mentionInput) {
      const it = mentionItems[sel];
      if (!it) return null;
      return it.kind === 'dir'
        ? confirmDirValue(value, mentionInput.pathSegs, it.segment)
        : confirmEntryValue(value, it.segment);
    }
    return null;
  };

  // Tab：钻取 / 补全。@目录 → 进入；@条目 → 确认；命令 → 补全选中项。
  const drillOrComplete = () => {
    if (pickerKind === 'mention' && mentionInput) {
      const it = mentionItems[sel];
      if (!it) return;
      applyValue(
        it.kind === 'dir'
          ? descendValue(value, mentionInput.pathSegs, it.segment)
          : confirmEntryValue(value, it.segment),
      );
      return;
    }
    if (pickerKind === 'slash') {
      const next = completeOnTab(value, slashItems);
      if (next !== value) applyValue(next);
    }
  };

  useInput((_input, key) => {
    if (disabled) return;

    if (pickerKind) {
      if (key.upArrow) {
        setSelectedIndex(Math.max(0, sel - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(Math.min(itemCount - 1, sel + 1));
        return;
      }
      if (key.tab) {
        drillOrComplete();
        return;
      }
      if (pickerKind === 'mention' && mentionInput) {
        if (key.rightArrow) {
          const it = mentionItems[sel];
          if (it && it.kind === 'dir') applyValue(descendValue(value, mentionInput.pathSegs, it.segment));
          return;
        }
        if (key.leftArrow) {
          if (mentionInput.pathSegs.length > 0) applyValue(ascendValue(value, mentionInput.pathSegs));
          return;
        }
      }
      // 其余按键（打字等）不拦截，交给 TextInput。
      return;
    }

    // picker 关闭：↑↓ 浏览历史。
    if (key.upArrow) {
      if (history.length === 0) return;
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      if (newIndex === historyIndex) return;
      if (historyIndex === -1) draftRef.current = value;
      setHistoryIndex(newIndex);
      setValue(history[history.length - 1 - newIndex]);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setValue(newIndex === -1 ? draftRef.current : history[history.length - 1 - newIndex]);
      return;
    }
  });

  const handleSubmit = (v: string) => {
    if (!v.trim()) return;
    // picker 开着：Enter 先确认高亮项进文本框；已是完整形态（补全 == 当前值）才真正提交。
    if (pickerKind && itemCount > 0) {
      const completion = completionFor();
      if (completion !== null && completion !== value) {
        applyValue(completion);
        return;
      }
    }
    onSubmit(v);
    setValue('');
    setHistoryIndex(-1);
    draftRef.current = '';
    setSelectedIndex(0);
  };

  if (disabled) {
    return (
      <Box>
        <Text color={C.dim2}>… (Ctrl+C to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {pickerKind === 'slash' ? (
        <SlashSuggestionList items={slashItems} selected={sel} extraCommands={extraCommands} />
      ) : null}
      {pickerKind === 'mention' ? (
        <MentionSuggestionList items={mentionItems} selected={sel} atRoot={mentionInput?.pathSegs.length === 0} />
      ) : null}
      <Box>
        <Text color={C.purple}>› </Text>
        <Box flexGrow={1}>
          <TextInput
            key={`${historyIndex}-${tabBump}`}
            value={value}
            onChange={(v) => {
              setValue(v);
              setSelectedIndex(0);
            }}
            onSubmit={handleSubmit}
          />
        </Box>
        {/* design 稿 .prompt .hint：输入行右缘的快捷键提示。仅在草稿为空时显示，
            打字后让位给长输入，避免和内容挤一行。 */}
        {value === '' ? <Text color={C.dim2}>↵ send · / commands</Text> : null}
      </Box>
    </Box>
  );
}

/**
 * Slash 命令提示（design 稿 SlashMenu）：高亮项前缀紫色 `❯`，命令名选中加粗，
 * 描述 dim；尾行 `N of M commands · type more to filter`。
 */
function SlashSuggestionList({
  items,
  selected,
  extraCommands,
}: {
  items: SlashCommand[];
  selected: number;
  extraCommands?: SlashCommand[];
}) {
  const nameWidth = Math.max(...items.map((c) => c.name.length));
  const total = filterCommands('/', extraCommands ?? []).length;
  return (
    <Box flexDirection="column" marginBottom={0}>
      {items.map((c, i) => {
        const active = i === selected;
        return (
          <Box key={c.name}>
            <Text color={C.purple}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? C.fg : C.fg2} bold={active}>
              {c.name.padEnd(nameWidth)}
            </Text>
            <Text color={C.dim}>  {c.description}</Text>
            {c.aliases && c.aliases.length > 0 ? (
              <Text color={C.dim2}> (alias: {c.aliases.join(', ')})</Text>
            ) : null}
          </Box>
        );
      })}
      <Text color={C.dim2}>
        {'  '}
        {items.length} of {total} commands · ↑↓ navigate · ↵ run · Tab completes
      </Text>
    </Box>
  );
}

/**
 * `@`-mention 提示。目录用 `▸ name/` 显示（→ 进入 / ← 退回），条目显示 title + 集合。
 * 高亮项前缀 `›` + 反色。
 */
function MentionSuggestionList({
  items,
  selected,
  atRoot,
}: {
  items: MentionLevelItem[];
  selected: number;
  atRoot: boolean;
}) {
  const nameWidth = Math.min(
    28,
    Math.max(...items.map((it) => (it.kind === 'dir' ? `${it.segment}/` : `@${it.segment}`).length)),
  );
  return (
    <Box flexDirection="column" marginBottom={0}>
      {items.map((it, i) => {
        const active = i === selected;
        const token = it.kind === 'dir' ? `${it.segment}/` : `@${it.segment}`;
        return (
          <Box key={`${it.kind}:${it.segment}`}>
            <Text color={active ? 'cyan' : undefined}>{active ? '› ' : '  '}</Text>
            <Text color={it.kind === 'dir' ? 'yellow' : 'cyan'} inverse={active}>
              {(it.kind === 'dir' ? `▸ ${token}` : token).padEnd(nameWidth + 2)}
            </Text>
            {it.kind === 'dir' ? (
              <Text color="gray">  {it.count} entries</Text>
            ) : (
              <Text color="gray">  {it.label}  ({it.collection})</Text>
            )}
          </Box>
        );
      })}
      <Text color="gray">
        {`  ↑↓ select · → enter dir${atRoot ? '' : ' · ← back'} · Enter confirm · Tab drill`}
      </Text>
    </Box>
  );
}
