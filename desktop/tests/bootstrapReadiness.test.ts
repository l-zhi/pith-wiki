import { describe, expect, it } from 'vitest';
import { bootstrapReadiness } from '../src/engine/bootstrapReadiness.js';

const delegates = ['claude-code', 'codex', 'pi'] as const;

describe('bootstrapReadiness', () => {
  it('委托型 provider 没有 apiKey 时仍 ready，且不弹引导', () => {
    for (const providerKind of delegates) {
      expect(bootstrapReadiness({ apiKey: '', providerKind })).toEqual({
        ready: true,
        needsOnboarding: false,
      });
    }
  });

  it('openai 没有 apiKey 时未就绪，需要引导', () => {
    expect(bootstrapReadiness({ apiKey: '', providerKind: 'openai' })).toEqual({
      ready: false,
      needsOnboarding: true,
    });
  });

  it('有 apiKey 时就绪，不管 provider 种类', () => {
    for (const providerKind of ['openai', ...delegates]) {
      expect(bootstrapReadiness({ apiKey: 'sk-test', providerKind })).toEqual({
        ready: true,
        needsOnboarding: false,
      });
    }
  });

  it('ready 与 needsOnboarding 始终互为反面', () => {
    for (const providerKind of ['openai', ...delegates]) {
      for (const apiKey of ['', 'sk-test']) {
        const status = bootstrapReadiness({ apiKey, providerKind });
        expect(status.ready).toBe(!status.needsOnboarding);
      }
    }
  });
});
