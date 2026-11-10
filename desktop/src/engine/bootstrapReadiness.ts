import type { BootstrapDTO } from '../shared/protocol.js';

/**
 * 引导页和侧栏状态点共用的「能不能聊天」。
 * 委托型 CLI（claude-code/codex/pi）没有 apiKey（走订阅），不该被当成未就绪。
 */
export function bootstrapReadiness(config: {
  apiKey: string;
  providerKind: string;
}): Pick<BootstrapDTO, 'ready' | 'needsOnboarding'> {
  const needsOnboarding = config.apiKey.length === 0 && config.providerKind === 'openai';
  return { ready: !needsOnboarding, needsOnboarding };
}
