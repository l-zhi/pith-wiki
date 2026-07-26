import OpenAI from 'openai';
import type { Config } from '../config.js';
import {
  ensureSecurityRulesFile,
  loadSecurityRules,
  Sanitizer,
  wrapClientWithSecurity,
  type SecurityNoticeKind,
} from '../security/index.js';
import type { ChatClient, TransportPurpose } from './transport.js';

export interface CreateClientOptions {
  /**
   * 安全模块的人类可读提示（脱敏发生 / 占位符还原异常），带分级。
   * REPL 传回调接到 UI（常规 masked 默认不打扰用户）；不传时 wrap 层默认打 stderr。
   */
  onSecurityNotice?: (message: string, kind: SecurityNoticeKind) => void;
  /**
   * 该 client 的用途。决定是否允许走 `pi-ai` 传输：
   *   - 'chat'（默认）：按 config.transport 选实现
   *   - 'hydration'：**强制** openai SDK —— 水合依赖 `response_format: json_object`，
   *     pi-ai 没有对等能力（见 docs/research-pi-harness-migration.md §3 L7）
   */
  purpose?: TransportPurpose;
}

/**
 * 唯一的 client 工厂。两件事在这里发生，别处不许有第二条出站路径：
 *   1. **选传输实现**：config.transport = 'openai'（OpenAI SDK 直连）或 'pi-ai'
 *      （经 @earendil-works/pi-ai 的 provider 生态）。水合用途永远回落到 openai。
 *   2. **挂安全过滤**：securityEnabled 时包上出站过滤/脱敏 + 入站还原。过滤层按
 *      `chat.completions.create` 的形状工作，因此两种传输都被同一层覆盖 ——
 *      这正是 ChatClient 故意与 OpenAI SDK 同形的原因（见 transport.ts）。
 * Sanitizer（占位符映射表）随 client 同生命周期：同一会话内映射稳定可还原。
 */
export function createClient(config: Config, opts: CreateClientOptions = {}): ChatClient {
  const purpose: TransportPurpose = opts.purpose ?? 'chat';
  const client = makeTransport(config, purpose);
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

/** 按 transport + purpose 造未包裹安全层的裸传输。 */
function makeTransport(config: Config, purpose: TransportPurpose): ChatClient {
  if (config.transport === 'pi-ai' && purpose === 'chat') {
    return lazyPiAiClient(config);
  }
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    // 显式设超时——OpenAI SDK 默认 10 分钟，对自建/兼容端点挂起时体验极差
    // （REPL 会转圈最长 10 分钟才报错）。可通过 config.requestTimeoutMs 调整。
    timeout: config.requestTimeoutMs,
  });
}

/**
 * pi-ai 传输的**延迟加载**包装。
 *
 * 为什么不直接 `import { createPiAiChatClient }`：实测 import `@earendil-works/pi-ai`
 * 本身要 ~130ms（加 pi-agent-core 共 ~160ms），静态 import 会让**所有**用户在启动时
 * 付这笔钱——包括 transport='openai'（默认）从不碰 pi-ai 的用户。这里把 import 推到
 * 第一次真正发请求时，默认路径的启动成本回到零。
 *
 * 首个 create() 调用会 await 一次动态 import（之后缓存）；对一次 LLM 请求的整体耗时
 * 而言 130ms 可忽略。
 */
function lazyPiAiClient(config: Config): ChatClient {
  let impl: Promise<ChatClient> | null = null;
  const load = (): Promise<ChatClient> => {
    impl ??= import('./piAiTransport.js').then((m) => m.createPiAiChatClient(config));
    return impl;
  };
  return {
    chat: {
      completions: {
        create: async (body, options) => (await load()).chat.completions.create(body, options),
      },
    },
  };
}
