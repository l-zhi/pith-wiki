import OpenAI from 'openai';
import type { Config } from '../config.js';
import {
  ensureSecurityRulesFile,
  loadSecurityRules,
  Sanitizer,
  wrapClientWithSecurity,
  type SecurityNoticeKind,
} from '../security/index.js';

export interface CreateClientOptions {
  /**
   * 安全模块的人类可读提示（脱敏发生 / 占位符还原异常），带分级。
   * REPL 传回调接到 UI（常规 masked 默认不打扰用户）；不传时 wrap 层默认打 stderr。
   */
  onSecurityNotice?: (message: string, kind: SecurityNoticeKind) => void;
}

/**
 * 唯一的 client 工厂。securityEnabled 时在这里包上出站过滤/脱敏 + 入站还原 ——
 * Agent / Hydration / queue worker 全部经由本工厂拿 client，没有第二条出站路径。
 * Sanitizer（占位符映射表）随 client 同生命周期：同一会话内映射稳定可还原。
 */
export function createClient(config: Config, opts: CreateClientOptions = {}): OpenAI {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    // 显式设超时——OpenAI SDK 默认 10 分钟，对自建/兼容端点挂起时体验极差
    // （REPL 会转圈最长 10 分钟才报错）。可通过 config.requestTimeoutMs 调整。
    timeout: config.requestTimeoutMs,
  });
  if (!config.securityEnabled) return client;
  // 首次使用：任何一层规则文件都不存在时写入基础模板（apiKey/手机号/身份证/
  // 银行卡/邮箱，全 mask），让默认行为可发现、可编辑。已有文件绝不覆盖。
  const created = ensureSecurityRulesFile(config.securityRulesFiles);
  if (created) {
    opts.onSecurityNotice?.(`security: initialized default rules at ${created}`, 'info');
  }
  const rules = loadSecurityRules(config.securityRulesFiles, (msg) =>
    opts.onSecurityNotice?.(msg, 'warning'),
  );
  return wrapClientWithSecurity(client, new Sanitizer(rules), {
    onNotice: opts.onSecurityNotice,
  });
}
