/**
 * TranscriptLogger 单元测试。
 *
 * 关注：
 *   - 文件名派生稳定（确定时间戳 → 同一路径）
 *   - 写入顺序保留：header → user → tool → assistant → endTurn
 *   - markdown 转义不让 ``` 提前关闭代码块
 *   - 写失败时不抛（吞掉）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptLogger, deriveTranscriptPath } from '../src/cli/transcript.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-transcript-'));
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('deriveTranscriptPath', () => {
  it('文件名是 ISO 时间戳冒号/小数点替成 -', () => {
    const p = deriveTranscriptPath(tmpDir, new Date('2026-04-29T15:30:42.123Z'));
    expect(p).toBe(path.join(tmpDir, '2026-04-29T15-30-42-123Z.md'));
  });

  it('同一时间戳重复调用得相同路径', () => {
    const d = new Date('2026-04-29T15:30:42.123Z');
    expect(deriveTranscriptPath(tmpDir, d)).toBe(deriveTranscriptPath(tmpDir, d));
  });
});

describe('TranscriptLogger — 顺序写入', () => {
  it('一个完整回合的内容按调用顺序 append', () => {
    const filePath = path.join(tmpDir, 'test.md');
    const logger = new TranscriptLogger(filePath);
    logger.writeHeader({
      model: 'deepseek-chat',
      workspaceRoot: '/ws',
      wikiRoot: '/ws/wiki',
      startedAt: '2026-04-29T15:30:00.000Z',
    });
    logger.recordUser('帮我加文件');
    logger.recordToolCall('list_dir', { path: '~/notes' });
    logger.recordToolResult('list_dir', true, '12 files');
    logger.recordAssistant('已经加进队列了');
    logger.endTurn();

    const content = fs.readFileSync(filePath, 'utf8');
    // 头部
    expect(content).toContain('# Chat Session 2026-04-29T15:30:00.000Z');
    expect(content).toContain('model: `deepseek-chat`');
    // 用户回合
    expect(content).toContain('## 🧑 User');
    expect(content).toContain('帮我加文件');
    // 工具调用
    expect(content).toContain('### → tool: list_dir');
    expect(content).toContain('"path": "~/notes"');
    // 工具结果
    expect(content).toContain('### ✓ tool result: list_dir');
    expect(content).toContain('12 files');
    // 助手回合
    expect(content).toContain('## 🤖 Assistant');
    expect(content).toContain('已经加进队列了');
    // 顺序断言：user 出现在 assistant 之前
    expect(content.indexOf('帮我加文件')).toBeLessThan(content.indexOf('已经加进队列了'));
  });

  it('recordError 写错误段', () => {
    const filePath = path.join(tmpDir, 'err.md');
    const logger = new TranscriptLogger(filePath);
    logger.recordError('boom');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('## ⚠ Error');
    expect(content).toContain('boom');
  });

  it('failed 工具结果用 ✗ 标记', () => {
    const filePath = path.join(tmpDir, 'fail.md');
    const logger = new TranscriptLogger(filePath);
    logger.recordToolResult('write_file', false, 'denied');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('### ✗ tool result: write_file');
  });
});

describe('TranscriptLogger — markdown 转义', () => {
  it('user 内容里的 ``` 被转义，不会提前关闭代码块', () => {
    const filePath = path.join(tmpDir, 'esc.md');
    const logger = new TranscriptLogger(filePath);
    logger.recordUser('看下这段：\n```\nfoo\n```');
    const content = fs.readFileSync(filePath, 'utf8');
    // 转义后的标记，不是裸的 ```
    expect(content).toContain('\\`\\`\\`');
    expect(content).not.toMatch(/\n```\nfoo\n```\n/);
  });
});

describe('TranscriptLogger — 错误吞掉', () => {
  it('写入路径无效时不抛，后续调用静默', () => {
    // 用一个父目录不存在的路径，writeFileSync 会抛 ENOENT
    const filePath = path.join(tmpDir, 'no-such-subdir', 'x.md');
    const logger = new TranscriptLogger(filePath);
    expect(() => logger.recordUser('hi')).not.toThrow();
    expect(() => logger.recordAssistant('there')).not.toThrow();
  });
});
