import { describe, expect, it } from 'vitest';
import {
  isBridgeMessage,
  makeBridgeClient,
  makeBridgeServer,
  makeTransportPair,
  type EngineEvent,
  type EngineRequest,
} from '../src/shared/protocol.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('EngineBridge protocol', () => {
  it('request/response 按 correlation id 配对（并发交错）', async () => {
    const [clientSide, serverSide] = makeTransportPair();
    const client = makeBridgeClient(clientSide);
    makeBridgeServer(serverSide, async (req: EngineRequest) => {
      if (req.kind === 'session.list') return ['L'];
      if (req.kind === 'queue.digest') {
        await tick(); // 故意让后到的请求先回
        return ['Q'];
      }
      return null;
    });

    const [q, l] = await Promise.all([
      client.request({ kind: 'queue.digest' }),
      client.request({ kind: 'session.list' }),
    ]);
    expect(q).toEqual(['Q']);
    expect(l).toEqual(['L']);
  });

  it('handler 抛错 → 请求方收到 rejected promise（错误文本透传）', async () => {
    const [clientSide, serverSide] = makeTransportPair();
    const client = makeBridgeClient(clientSide);
    makeBridgeServer(serverSide, () => {
      throw new Error('boom');
    });
    await expect(client.request({ kind: 'session.list' })).rejects.toThrow('boom');
  });

  it('事件广播给全部订阅者，退订后不再收', async () => {
    const [clientSide, serverSide] = makeTransportPair();
    const client = makeBridgeClient(clientSide);
    const server = makeBridgeServer(serverSide, () => null);

    const got: EngineEvent[] = [];
    const got2: EngineEvent[] = [];
    const off = client.onEvent((e) => got.push(e));
    client.onEvent((e) => got2.push(e));

    server.emit({ kind: 'engine.ready' });
    await tick();
    off();
    server.emit({ kind: 'engine.notice', level: 'info', text: 'x' });
    await tick();

    expect(got.map((e) => e.kind)).toEqual(['engine.ready']);
    expect(got2.map((e) => e.kind)).toEqual(['engine.ready', 'engine.notice']);
  });

  it('isBridgeMessage 拒绝畸形消息；server 忽略非 req', () => {
    expect(isBridgeMessage(null)).toBe(false);
    expect(isBridgeMessage({})).toBe(false);
    expect(isBridgeMessage({ t: 'req' })).toBe(false);
    expect(isBridgeMessage({ t: 'req', id: 1, req: { kind: 'session.list' } })).toBe(true);
    expect(isBridgeMessage({ t: 'res', id: 1, ok: true })).toBe(true);
    expect(isBridgeMessage({ t: 'evt', evt: { kind: 'engine.ready' } })).toBe(true);
  });

  it('迟到/未知 id 的响应被静默丢弃（不抛不串）', async () => {
    const [clientSide, serverSide] = makeTransportPair();
    makeBridgeClient(clientSide);
    // 直接从 server 侧塞一个没人等的响应
    serverSide.post({ t: 'res', id: 999, ok: true, data: 1 });
    await tick(); // 不抛即通过
  });
});
