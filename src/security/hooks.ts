import type { Config } from '../config.js';
import { ensureSecurityRulesFile, loadSecurityRules } from './rules.js';
import { Sanitizer } from './sanitizer.js';
import { createStreamRestorer } from './streamRestore.js';
import type { SecurityNoticeKind } from './wrap.js';

/**
 * 非 `chat.completions` 链路的安全钩子。
 *
 * 背景：`createClient` 的 monkey-patch 只覆盖走 `chat.completions.create` 的传输
 * （openai SDK / pi-ai 适配器）。pi-agent-core 的 agent loop **不经过那个方法**——它自己
 * 持有 provider 流，所以脱敏/还原必须由宿主在 `streamFn` 与事件回放两处显式接上。
 * 这里把「造一份与 client 层同源的规则 + Sanitizer」封成一个工厂，避免两条链路的
 * 规则加载逻辑各写一遍（规则文件、preset 合并、首次写模板全都一致）。
 *
 * 一个 hooks 实例 = 一个 Sanitizer = 一份占位符映射表，生命周期应与会话一致
 * （同一会话内 re-mask 才是确定的、还原才查得到）。
 */
export interface SecurityHooks {
  /** 出站：把一段文本脱敏成占位符形式。 */
  maskText(text: string): string;
  /** 入站（整段）：把占位符还原成原文。 */
  restoreText(text: string): string;
  /** 入站（流式）：造一个跨 chunk 的还原器（占位符可能被切在两个 delta 之间）。 */
  createRestorer(): { push(chunk: string): string; flush(): string };
}

/**
 * 按 config 造一份安全钩子。`securityEnabled=false` 或规则为空 → 返回 undefined
 * （调用方据此完全跳过脱敏，零开销）。
 */
export function createSecurityHooks(
  config: Config,
  onNotice?: (message: string, kind: SecurityNoticeKind) => void,
): SecurityHooks | undefined {
  if (!config.securityEnabled) return undefined;
  const created = ensureSecurityRulesFile(config.securityRulesFiles);
  if (created) onNotice?.(`security: initialized default rules at ${created}`, 'info');
  const rules = loadSecurityRules(config.securityRulesFiles, (msg) => onNotice?.(msg, 'warning'));
  const sanitizer = new Sanitizer(rules);
  if (!sanitizer.hasRules) return undefined;
  return {
    maskText: (text) => {
      const r = sanitizer.sanitize(text);
      if (r.newLabels.length > 0) {
        onNotice?.(`已脱敏 ${r.newLabels.length} 处: ${r.newLabels.join(', ')}`, 'masked');
      }
      return r.text;
    },
    restoreText: (text) => sanitizer.restore(text).text,
    createRestorer: () => createStreamRestorer(sanitizer),
  };
}
