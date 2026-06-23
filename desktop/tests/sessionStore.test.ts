import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type StoredMeta } from '../src/engine/sessionStore.js';

let dir: string;
let store: SessionStore;

const meta = (id: string): StoredMeta => ({
  id,
  title: 'New chat',
  createdAt: '2026-06-12T00:00:00.000Z',
  model: 'deepseek-chat',
  provider: 'deepseek',
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-sessions-'));
  store = new SessionStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('create → load 往返：meta 与消息逐字节等价', () => {
    store.create(meta('s1'));
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好，整理一下 RAG 笔记' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'wiki_query', arguments: '{"q":"RAG"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"hits":3}' },
      { role: 'assistant', content: '找到 3 条。' },
    ];
    store.appendMessages('s1', msgs);
    const loaded = store.load('s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.meta).toEqual(meta('s1'));
    expect(loaded!.messages).toEqual(msgs);
    expect(loaded!.corruptLines).toBe(0);
  });

  it('分批 append 等价于一次性 append', () => {
    store.create(meta('s2'));
    store.appendMessages('s2', [{ role: 'user', content: 'a' }]);
    store.appendMessages('s2', [
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(store.load('s2')!.messages).toHaveLength(3);
  });

  it('损坏行被跳过并计数；其余消息完好', () => {
    store.create(meta('s3'));
    store.appendMessages('s3', [{ role: 'user', content: 'ok' }]);
    fs.appendFileSync(path.join(dir, 's3.jsonl'), '{broken json…\n', 'utf8');
    store.appendMessages('s3', [{ role: 'assistant', content: 'still ok' }]);
    const loaded = store.load('s3')!;
    expect(loaded.messages).toEqual([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'still ok' },
    ]);
    expect(loaded.corruptLines).toBe(1);
  });

  it('首行 meta 损坏 → load 返回 null，list 跳过该会话', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'not json at all\n', 'utf8');
    expect(store.load('bad')).toBeNull();
    expect(store.list().map((s) => s.id)).not.toContain('bad');
  });

  it('list 返回 msgCount 并按更新时间倒序', () => {
    store.create(meta('old'));
    store.appendMessages('old', [{ role: 'user', content: 'x' }]);
    // 让 mtime 拉开差距
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'old.jsonl'), past, past);
    store.create(meta('new'));
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(['new', 'old']);
    expect(list.find((s) => s.id === 'old')!.msgCount).toBe(1);
  });

  it('updateMeta 重写标题且保留消息', () => {
    store.create(meta('s4'));
    store.appendMessages('s4', [{ role: 'user', content: 'keep me' }]);
    store.updateMeta('s4', { title: '整理 RAG 笔记' });
    const loaded = store.load('s4')!;
    expect(loaded.meta.title).toBe('整理 RAG 笔记');
    expect(loaded.messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('delete 幂等；非法 id 拒绝（路径逃逸防御）', () => {
    store.create(meta('s5'));
    expect(store.delete('s5')).toBe(true);
    expect(store.delete('s5')).toBe(false);
    expect(() => store.load('../etc/passwd')).toThrow(/invalid session id/);
  });
});
