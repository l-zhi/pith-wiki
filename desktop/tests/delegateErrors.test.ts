/**
 * 委托型 CLI 的报错加工。实机诱因：界面上只显示了
 * 「Failed to authenticate: OAuth session expired and could not be refreshed」，
 * 修复动作却在 pith 之外（去终端重新登录），用户无从下手。
 */
import { describe, expect, it } from 'vitest';
import { explainDelegateError } from '../src/engine/delegateErrors.js';

describe('explainDelegateError', () => {
  it('Codex 模型版本错误显示升级提示、实际路径和原始错误', () => {
    const raw = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
      },
    });
    const out = explainDelegateError('codex', raw, { binary: '/old/bin/codex' });
    expect(out).toMatch(/^当前 Codex CLI 版本过旧/);
    expect(out).toContain('/old/bin/codex');
    expect(out).toContain(raw);
    expect(out).not.toContain('codex login');
  });

  it('其他 400 错误不会被误判为 CLI 版本问题', () => {
    const raw = '{"status":400,"message":"Unsupported value: model_verbosity"}';
    expect(explainDelegateError('codex', raw)).toBe(raw);
  });

  it('claude 的 OAuth 过期 → 指向 /login 与 setup-token', () => {
    const out = explainDelegateError(
      'claude-code',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    expect(out).toContain('OAuth session expired'); // 原文保留，便于排查
    expect(out).toContain('/login');
    expect(out).toContain('setup-token');
  });

  it('各 CLI 指向各自的登录方式', () => {
    expect(explainDelegateError('codex', 'not logged in')).toContain('codex login');
    expect(explainDelegateError('pi', 'unauthorized')).toContain('~/.pi/agent/auth.json');
  });

  it('额度/限流不往「重新登录」上引（那是另一回事）', () => {
    const out = explainDelegateError('claude-code', 'rate limit exceeded, try again later');
    expect(out).toMatch(/额度|速率/);
    expect(out).not.toContain('/login');
  });

  it('认不出来的错误原样透传（瞎猜比不猜更糟）', () => {
    expect(explainDelegateError('pi', 'ENOENT: spawn pi')).toBe('ENOENT: spawn pi');
  });

  it('空错误也给个能看的兜底', () => {
    expect(explainDelegateError('codex', '   ')).toContain('codex 未返回任何内容');
  });
});
