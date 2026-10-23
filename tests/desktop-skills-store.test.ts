import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../desktop/src/renderer/src/bridge', () => ({ bridge: { request } }));
vi.mock('../desktop/src/renderer/src/i18n', () => ({
  default: { changeLanguage: vi.fn() }, storedLangPref: () => 'en', resolveLang: () => 'en',
}));

beforeAll(() => vi.stubGlobal('localStorage', { getItem: () => null }));
afterAll(() => vi.unstubAllGlobals());

describe('skill connection refresh', () => {
  it.each([true, false])('refreshes dependency badges after probe ok=%s, without replacing the chat', async (ok) => {
    const { useStore } = await import('../desktop/src/renderer/src/store');
    const chat = useStore.getState().chat;
    const card = { name: 'lark', installed: true, requires: [{ bin: 'lark-cli', present: true }] };
    const result = { ok, detail: ok ? 'connected' : 'Please log in' };
    request.mockReset().mockResolvedValueOnce(result).mockResolvedValueOnce({ skills: [card] });
    expect(await useStore.getState().testSkill('lark')).toEqual(result);
    expect(request.mock.calls.map(([req]) => req.kind)).toEqual(['skills.test', 'skills.list']);
    expect(useStore.getState().skills).toEqual([card]);
    expect(useStore.getState().chat).toBe(chat);
  });
});
