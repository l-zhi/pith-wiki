/**
 * 委托型 CLI（claude-code / codex / pi）的失败信息加工。
 *
 * 为什么需要：委托模式下 pith 只是个转发者，CLI 的原始报错会直接丢到界面上。
 * 实机踩到的例子是 `Failed to authenticate: OAuth session expired and could not be
 * refreshed` —— 对用户来说这句话不含任何「我该干什么」的信息，而修复动作恰恰在
 * pith 之外（去终端重新登录那个 CLI）。这是委托模式固有的失败模式：**出问题的地方
 * 不在 pith 里，但用户是在 pith 里撞见的**，所以 pith 有义务把话说完整。
 *
 * 只加工「用户能自己修」的那类错误（鉴权/额度），其余原样透传——瞎猜比不猜更糟。
 */

export type DelegateKind = 'claude-code' | 'codex' | 'pi';

/** 各 CLI 的重新登录方式。委托的代价之一：修复动作在 pith 之外。 */
const LOGIN_HINTS: Record<DelegateKind, string> = {
  'claude-code':
    '在终端跑 `claude` 后用 /login 重新登录；' +
    '或跑 `claude setup-token` 生成长期 token，填到该 provider 的密钥里' +
    '（这样就不依赖 CLI 自己那个会过期的会话了）。',
  codex: '在终端跑 `codex login` 重新登录（凭据写在 ~/.codex/auth.json）。',
  pi: '在终端跑 `pi` 后用 /login 重新登录（凭据写在 ~/.pi/agent/auth.json）。',
};

/** 鉴权/会话过期类错误的特征词（各 CLI 文案不同，取交集里最稳的几个）。 */
const AUTH_PATTERNS = [
  /failed to authenticate/i,
  /oauth session expired/i,
  /not (?:logged in|authenticated)/i,
  /unauthorized/i,
  /invalid api key/i,
  /authentication_error/i,
  /401/,
];

/** 额度/限流类错误：不是登录问题，别把用户往重新登录上引。 */
const QUOTA_PATTERNS = [/rate limit/i, /quota/i, /usage limit/i, /429/, /insufficient/i];

/**
 * 给 CLI 的原始错误补上可操作的下一步。返回值总是包含原文（便于排查），
 * 只在能确定类别时追加提示。
 */
export function explainDelegateError(kind: DelegateKind, raw: string): string {
  const text = raw.trim() || `${kind} 未返回任何内容`;
  if (QUOTA_PATTERNS.some((re) => re.test(text))) {
    return `${text}\n\n（${kind} 的额度或速率受限——不是登录问题。等一会儿再试，或在设置里换一个 provider。）`;
  }
  if (AUTH_PATTERNS.some((re) => re.test(text))) {
    return `${text}\n\n（${kind} 的登录状态失效了。${LOGIN_HINTS[kind]}）`;
  }
  return text;
}
