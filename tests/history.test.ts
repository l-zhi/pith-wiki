/**
 * REPL 历史命令磁盘持久化的单元测试。
 *
 * 关注外部行为：
 * - loadHistory：返回顺序、limit 截尾、空文件、不存在文件、IO 失败容错
 * - appendHistory：换行追加、错误静默
 *
 * 不测的（属于 Ink 集成层）：
 * - 上下键交互（InputBox.tsx 内部状态机，需要 Ink testing 库）
 * - 草稿保护行为
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHistory, loadHistory } from '../src/cli/history.js';

let tmpFile: string;

beforeEach(() => {
  // 每个用例用独立的临时文件路径，互不干扰。
  tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-hist-')),
    'history',
  );
});

afterEach(() => {
  // 清理整个临时目录（包括尚未创建的历史文件）。
  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
});

describe('loadHistory', () => {
  it('文件不存在时返回空数组（不抛）', () => {
    expect(loadHistory(tmpFile, 20)).toEqual([]);
  });

  it('空文件返回空数组', () => {
    fs.writeFileSync(tmpFile, '');
    expect(loadHistory(tmpFile, 20)).toEqual([]);
  });

  it('单行文件返回单元素数组', () => {
    fs.writeFileSync(tmpFile, 'hello world\n');
    expect(loadHistory(tmpFile, 20)).toEqual(['hello world']);
  });

  it('多行返回值按时间升序：最旧在前，最新在后', () => {
    fs.writeFileSync(tmpFile, 'first\nsecond\nthird\n');
    expect(loadHistory(tmpFile, 20)).toEqual(['first', 'second', 'third']);
  });

  it('行数超过 limit 时只返回最后 limit 条', () => {
    // 写入 30 条，limit 设为 20，应当返回最后 20 条（索引 10..29）。
    const lines = Array.from({ length: 30 }, (_, i) => `cmd-${i}`);
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');

    const loaded = loadHistory(tmpFile, 20);
    expect(loaded).toHaveLength(20);
    expect(loaded[0]).toBe('cmd-10'); // 第一条是第 11 条历史
    expect(loaded[19]).toBe('cmd-29'); // 最后一条是最新
  });

  it('limit 远大于文件行数时返回所有行', () => {
    fs.writeFileSync(tmpFile, 'a\nb\nc\n');
    expect(loadHistory(tmpFile, 100)).toEqual(['a', 'b', 'c']);
  });

  it('过滤空行（包括只有空格 / tab 的行）', () => {
    fs.writeFileSync(tmpFile, 'cmd1\n\n  \nt\nrelevant\n\t\n');
    expect(loadHistory(tmpFile, 20)).toEqual(['cmd1', 't', 'relevant']);
  });

  it('支持 UTF-8 中文命令', () => {
    fs.writeFileSync(tmpFile, '查询 agent\n列出 wiki\n中英 mixed query\n', 'utf8');
    expect(loadHistory(tmpFile, 20)).toEqual([
      '查询 agent',
      '列出 wiki',
      '中英 mixed query',
    ]);
  });

  it('limit=0 时返回空数组（即使文件有内容）', () => {
    fs.writeFileSync(tmpFile, 'a\nb\n');
    expect(loadHistory(tmpFile, 0)).toEqual([]);
  });

  it('IO 错误（路径是目录而非文件）时静默返回空数组', () => {
    // 把 tmpFile 路径建成目录，让 readFileSync 抛 EISDIR。
    fs.mkdirSync(tmpFile);
    expect(loadHistory(tmpFile, 20)).toEqual([]);
  });
});

describe('appendHistory', () => {
  it('追加单行并自动加换行', () => {
    appendHistory(tmpFile, 'first command');
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('first command\n');
  });

  it('多次追加保持顺序', () => {
    appendHistory(tmpFile, 'a');
    appendHistory(tmpFile, 'b');
    appendHistory(tmpFile, 'c');
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('a\nb\nc\n');
  });

  it('追加中文命令保持 UTF-8 编码', () => {
    appendHistory(tmpFile, '中文查询');
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('中文查询\n');
  });

  it('write → load round-trip 一致', () => {
    appendHistory(tmpFile, 'one');
    appendHistory(tmpFile, 'two');
    appendHistory(tmpFile, 'three');
    expect(loadHistory(tmpFile, 20)).toEqual(['one', 'two', 'three']);
  });

  it('父目录不存在时静默失败（不抛异常）', () => {
    // 如果父目录已经被清理，appendHistory 应该不影响后续逻辑。
    const nonexistent = path.join('/tmp', 'definitely', 'not', 'there', 'history');
    expect(() => appendHistory(nonexistent, 'cmd')).not.toThrow();
  });
});

describe('集成：模拟 REPL 启动 → 提交 → 重启', () => {
  it('上次会话的命令在新会话启动时按时间序加载回来', () => {
    // 第一次会话：连续提交 5 条命令。
    appendHistory(tmpFile, 'session1-cmd1');
    appendHistory(tmpFile, 'session1-cmd2');
    appendHistory(tmpFile, 'session1-cmd3');
    appendHistory(tmpFile, 'session1-cmd4');
    appendHistory(tmpFile, 'session1-cmd5');

    // 新一轮会话启动加载历史。
    const loaded = loadHistory(tmpFile, 20);
    expect(loaded).toEqual([
      'session1-cmd1',
      'session1-cmd2',
      'session1-cmd3',
      'session1-cmd4',
      'session1-cmd5',
    ]);

    // 新会话又提交一条，再次加载应能看到全部 6 条。
    appendHistory(tmpFile, 'session2-cmd1');
    expect(loadHistory(tmpFile, 20)).toHaveLength(6);
    expect(loadHistory(tmpFile, 20)[5]).toBe('session2-cmd1');
  });

  it('磁盘累计超过 20 条但 limit=20 时只回放尾部', () => {
    // 模拟用户跑了几百次，磁盘文件不断增长。
    for (let i = 0; i < 50; i++) appendHistory(tmpFile, `cmd-${i}`);

    const loaded = loadHistory(tmpFile, 20);
    expect(loaded).toHaveLength(20);
    // 最新一条应该是 cmd-49，最早回放的是 cmd-30。
    expect(loaded[0]).toBe('cmd-30');
    expect(loaded[19]).toBe('cmd-49');
  });
});
