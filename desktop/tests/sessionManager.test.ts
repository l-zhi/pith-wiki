import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineEvent } from '../src/shared/protocol.js';
import { SessionStore } from '../src/engine/sessionStore.js';
import {
  SessionManager,
  deriveDisplay,
  extractWikiRefs,
  type AgentFactory,
  type AgentLike,
  type ApprovalBridge,
} from '../src/engine/sessionManager.js';

/**
 * FakeAgent：可编程的 AgentLike。
 *   - send 时把 user+assistant 消息压进历史；
 *   - script 钩子允许测试在轮中触发审批 / 挂起 / 抛错 / 监听 abort。
 */
class FakeAgent implements AgentLike {
  history: unknown[] = [{ role: 'system', content: 'sys' }];
  approvals: ApprovalBridge | null = null;
  script: ((text: string, opts: Parameters<AgentLike['send']>[1]) => Promise<string>) | null = null;

  async send(text: string, opts: Parameters<AgentLike['send']>[1]): Promise<string> {
    this.history.push({ role: 'user', content: text });
    const reply = this.script ? await this.script(text, opts) : `echo:${text}`;
    this.history.push({ role: 'assistant', content: reply });
    opts.events?.onAssistantText?.({ text: reply, final: true });
    return reply;
  }
  exportHistory(): unknown[] {
    return structuredClone(this.history);
  }
  restoreHistory(messages: unknown[]): void {
    this.history = [
      { role: 'system', content: 'sys' },
      ...messages.filter((m) => (m as { role?: string }).role !== 'system'),
    ];
  }
}

let dir: string;
let store: SessionStore;
let events: EngineEvent[];
let agents: Map<string, FakeAgent>;
let mgr: SessionManager;

const factory: AgentFactory = (sessionId, approvals) => {
  const agent = new FakeAgent();
  agent.approvals = approvals;
  agents.set(sessionId, agent);
  return { agent, model: 'fake-model', provider: 'fake' };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-mgr-'));
  store = new SessionStore(dir);
  events = [];
  agents = new Map();
  mgr = new SessionManager(store, factory, (e) => events.push(e));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const evKinds = (sessionId?: string) =>
  events
    .filter((e) => !sessionId || ('sessionId' in e && e.sessionId === sessionId))
    .map((e) => e.kind);

describe('SessionManager', () => {
  it('create → send → 历史落盘；首条消息定标题', async () => {
    const meta = mgr.create();
    await mgr.send(meta.id, '把上周的 RAG 剪藏整理成大纲');
    const stored = store.load(meta.id)!;
    expect(stored.meta.title).toBe('把上周的 RAG 剪藏整理成大纲');
    // 只持久化对话本体：system prompt 由 Agent 配置自持，恢复时重建，不落盘
    expect(stored.messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant']);
    expect(evKinds(meta.id)).toEqual([
      'session.busy',
      'session.assistantText',
      'session.busy',
      'session.turnDone',
    ]);
  });

  it('恢复：restoreHistory 注入 + display 回放（含 tool 卡片）', async () => {
    const meta = mgr.create();
    const agent = agents.get(meta.id)!;
    agent.script = async () => {
      agent.history.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'wiki_query', arguments: '{"q":"x"}' } },
        ],
      });
      agent.history.push({ role: 'tool', tool_call_id: 'c1', content: '{"hits":1}' });
      return '查到了';
    };
    await mgr.send(meta.id, '查一下');

    // 模拟重启：新 manager / 新 store 实例
    const mgr2 = new SessionManager(new SessionStore(dir), factory, (e) => events.push(e));
    const { meta: m2, display } = mgr2.resume(meta.id);
    expect(m2.title).toBe('查一下');
    const roles = display.map((d) => d.role);
    expect(roles).toContain('user');
    expect(roles).toContain('tool');
    expect(roles).toContain('assistant');
    const tool = display.find((d) => d.role === 'tool') as { name: string };
    expect(tool.name).toBe('wiki_query');
    // 恢复后的 agent 拿到了完整历史
    const restored = agents.get(meta.id)!;
    expect(restored.history.length).toBeGreaterThan(3);
  });

  it('两个会话并行 send 互不阻塞；同会话并发被拒', async () => {
    const a = mgr.create();
    const b = mgr.create();
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    agents.get(a.id)!.script = async () => {
      await gateA;
      return 'A done';
    };

    const pa = mgr.send(a.id, 'slow');
    // A 还挂着，B 能完整跑完
    await mgr.send(b.id, 'fast');
    expect(evKinds(b.id)).toContain('session.turnDone');
    // 同会话并发：拒绝
    await expect(mgr.send(a.id, 'again')).rejects.toThrow(/busy/);
    releaseA();
    await pa;
    expect(evKinds(a.id)).toContain('session.turnDone');
  });

  it('审批路由：approvalRequest 事件 → answerApproval 按 id 回执到正确会话', async () => {
    const a = mgr.create();
    const agent = agents.get(a.id)!;
    let answer: string | null = null;
    agent.script = async () => {
      answer = await agent.approvals!.request('write', 'wiki-data/tech/x.md', '+ new entry');
      return `approval=${answer}`;
    };
    const p = mgr.send(a.id, '写入');
    // 等审批事件冒出来
    await new Promise((r) => setTimeout(r, 0));
    const req = events.find((e) => e.kind === 'session.approvalRequest') as Extract<
      EngineEvent,
      { kind: 'session.approvalRequest' }
    >;
    expect(req.sessionId).toBe(a.id);
    expect(req.approvalKind).toBe('write');
    mgr.answerApproval(req.approvalId, 'always');
    await p;
    expect(answer).toBe('always');
    expect(events.some((e) => e.kind === 'session.approvalSettled')).toBe(true);
    // 未知 id 抛错
    expect(() => mgr.answerApproval('nope', 'yes')).toThrow(/no pending approval/);
  });

  it('abort 只杀目标会话；轮内未决审批被默认拒绝', async () => {
    const a = mgr.create();
    const agent = agents.get(a.id)!;
    let sawAbort = false;
    let approvalAnswer: string | null = null;
    agent.script = (_text, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => {
          sawAbort = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          // FakeAgent.send 的 catch 不存在——直接 reject 模拟真 agent 行为
          resolveWith(err);
        });
        // 轮中发起审批但永远没人答
        void agent.approvals!.request('exec', 'weread', 'weread sync').then((ans) => {
          approvalAnswer = ans;
        });
        const resolveWith = (err: Error) => resolve(Promise.reject(err) as never);
      });
    const p = mgr.send(a.id, 'long');
    await new Promise((r) => setTimeout(r, 0));
    mgr.abort(a.id);
    await p; // send 内部吞掉 AbortError → turnDone(error='cancelled')
    expect(sawAbort).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(approvalAnswer).toBe('no');
    const done = events.find((e) => e.kind === 'session.turnDone') as Extract<
      EngineEvent,
      { kind: 'session.turnDone' }
    >;
    expect(done.error).toBe('cancelled');
  });

  it('list 合并落盘会话与 live 状态（busy / pendingApproval 角标）', async () => {
    const a = mgr.create();
    const agent = agents.get(a.id)!;
    agent.script = async () => {
      void agent.approvals!.request('write', 'x', 'y');
      await new Promise(() => {}); // 永挂，保持 busy
      return '';
    };
    void mgr.send(a.id, 'hang');
    await new Promise((r) => setTimeout(r, 0));
    const item = mgr.list().find((s) => s.id === a.id)!;
    expect(item.busy).toBe(true);
    expect(item.pendingApprovalId).toBeTruthy();
  });

  it('rename 同步 live meta 与落盘 meta；空标题拒绝', async () => {
    const a = mgr.create();
    await mgr.send(a.id, 'hello');
    mgr.rename(a.id, '  我的 RAG 研究  ');
    expect(mgr.list().find((s) => s.id === a.id)!.title).toBe('我的 RAG 研究');
    expect(store.load(a.id)!.meta.title).toBe('我的 RAG 研究');
    expect(() => mgr.rename(a.id, '   ')).toThrow(/empty/);
  });

  it('deriveDisplay 跳过 system，tool 结果按 call id 归位', () => {
    const display = deriveDisplay([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c9', type: 'function', function: { name: 'wiki_get', arguments: '{"id":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c9', content: 'entry body' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(display).toEqual([
      { role: 'user', text: 'q' },
      { role: 'tool', name: 'wiki_get', argsPreview: '{"id":"a"}', resultPreview: 'entry body' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('extractWikiRefs：get/query 计入引用；list/grep 批量候选归浏览', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'g1', type: 'function', function: { name: 'wiki_get', arguments: '{}' } },
          { id: 'q1', type: 'function', function: { name: 'wiki_query', arguments: '{}' } },
          { id: 'l1', type: 'function', function: { name: 'wiki_list', arguments: '{}' } },
          { id: 'gr1', type: 'function', function: { name: 'wiki_grep', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'g1',
        content: JSON.stringify({ ok: true, entry: { id: 'got', title: 'Got' } }),
      },
      {
        role: 'tool',
        tool_call_id: 'q1',
        content: JSON.stringify({ ok: true, references: [{ id: 'queried', title: 'Q' }] }),
      },
      {
        role: 'tool',
        tool_call_id: 'l1',
        content: JSON.stringify({
          ok: true,
          items: Array.from({ length: 50 }, (_, i) => ({ id: `listed-${i}`, title: `L${i}` })),
        }),
      },
      {
        role: 'tool',
        tool_call_id: 'gr1',
        // grep 命中也是批量候选，不该撑大「引用」
        content: JSON.stringify({
          ok: true,
          items: Array.from({ length: 30 }, (_, i) => ({ id: `grepped-${i}`, title: `G${i}` })),
        }),
      },
    ];
    const { cited, browsed } = extractWikiRefs(messages);
    expect(cited.map((r) => r.id).sort()).toEqual(['got', 'queried']); // 仅定向取用
    expect(browsed).toHaveLength(80); // 50 list + 30 grep
    expect(browsed.every((b) => b.id.startsWith('listed-') || b.id.startsWith('grepped-'))).toBe(
      true,
    );
  });
});
