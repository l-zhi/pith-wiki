/**
 * 数据安全模块集成测试：wrapClientWithSecurity 的出站脱敏 / 入站还原、
 * block 拒发、hydration 端到端（脱敏出站 → 占位符响应 → 还原落 entry）、
 * Agent 在 SecurityBlockError 时的历史回滚。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  compilePresets,
  Sanitizer,
  SecurityBlockError,
  wrapClientWithSecurity,
} from '../src/security/index.js';
import { loadSecurityRules } from '../src/security/index.js';
import { HydrationService } from '../src/wiki/hydration.js';
import { LibraryService } from '../src/wiki/library.js';
import { Agent } from '../src/llm/agent.js';

const PHONE = '13800138000';

function maskAllSanitizer(extraRulesFile?: string) {
  const rules = extraRulesFile
    ? loadSecurityRules([extraRulesFile])
    : compilePresets({ phone: 'mask', idCard: 'mask', bankCard: 'mask', email: 'mask', apiKey: 'mask' });
  return new Sanitizer(rules);
}

interface SeenParams {
  messages: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** 队列式 mock client：按顺序吐响应，记录入参。 */
function makeMockClient(responses: unknown[]) {
  const seen: SeenParams[] = [];
  let i = 0;
  const create = vi.fn(async (params: SeenParams) => {
    seen.push(params);
    return responses[i++] ?? responses[responses.length - 1];
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, seen, create };
}

function finalResp(content: string, extra: Record<string, unknown> = {}) {
  return { choices: [{ message: { role: 'assistant', content, ...extra } }] };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-sec-int-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('wrapClientWithSecurity — 出站脱敏 / 入站还原', () => {
  it('出站 messages 被脱敏并注入占位符保留指令；响应 content 被还原', async () => {
    const { client, seen } = makeMockClient([finalResp('记下了，号码是 [PHONE_1]')]);
    const notices: string[] = [];
    wrapClientWithSecurity(client, maskAllSanitizer(), {
      onNotice: (m, kind) => notices.push(`${kind}: ${m}`),
    });

    const completion = (await client.chat.completions.create({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: `请记住手机号 ${PHONE}` },
      ],
      stream: false,
    } as never)) as { choices: Array<{ message: { content: string } }> };

    // 出站：真实值不出现，占位符在场，system 带保留指令
    const sentUser = seen[0].messages[1].content as string;
    expect(sentUser).not.toContain(PHONE);
    expect(sentUser).toContain('[PHONE_1]');
    expect(seen[0].messages[0].content as string).toContain('Privacy note');
    // 入站：占位符还原
    expect(completion.choices[0].message.content).toBe(`记下了，号码是 ${PHONE}`);
    // 提示：首次脱敏报数，分级为 masked（REPL 默认不展示这一级）
    expect(notices.some((n) => n.startsWith('masked:') && n.includes('PHONE'))).toBe(true);
  });

  it('响应里 tool_calls.arguments 的占位符按 JSON 转义还原', async () => {
    const { client } = makeMockClient([
      finalResp('', {
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'wiki_grep', arguments: '{"patterns":["[PHONE_1]"]}' },
          },
        ],
      }),
    ]);
    wrapClientWithSecurity(client, maskAllSanitizer(), { onNotice: () => {} });

    const completion = (await client.chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: `查 ${PHONE}` }],
    } as never)) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
    };

    const args = completion.choices[0].message.tool_calls[0].function.arguments;
    expect(JSON.parse(args)).toEqual({ patterns: [PHONE] });
  });

  it('block 规则命中：抛 SecurityBlockError，请求不发出', async () => {
    const rulesFile = path.join(tmpDir, 'security.json');
    fs.writeFileSync(
      rulesFile,
      JSON.stringify({ rules: [{ pattern: '绝密项目', action: 'block', label: 'TOP_SECRET' }] }),
      'utf8',
    );
    const { client, create } = makeMockClient([finalResp('should not happen')]);
    wrapClientWithSecurity(client, maskAllSanitizer(rulesFile), { onNotice: () => {} });

    await expect(
      client.chat.completions.create({
        model: 'm',
        messages: [{ role: 'user', content: '介绍一下绝密项目的进展' }],
      } as never),
    ).rejects.toThrow(SecurityBlockError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('hydration 端到端 — 脱敏出站、还原落 entry', () => {
  it('ingest 含手机号的内容：LLM 只见占位符，落盘 entry 是原文', async () => {
    const digest = JSON.stringify({
      id: 'contact-note',
      title: 'Contact note',
      summary: 'phone [PHONE_1]',
      tags: ['contact'],
      links: [],
      content: `# Note\n- call [PHONE_1]`,
    });
    const { client, seen } = makeMockClient([finalResp(digest)]);
    wrapClientWithSecurity(client, maskAllSanitizer(), { onNotice: () => {} });

    const lib = new LibraryService(tmpDir);
    const hydrator = new HydrationService(client, 'test-model', lib);
    const entry = await hydrator.hydrate({
      rawContent: `联系人手机号 ${PHONE}`,
      source: { type: 'inline' },
      collectionId: 'tech',
    });

    // 出站 user message 不含真实手机号
    const sentUser = seen[0].messages.find((m) => m.role === 'user')?.content as string;
    expect(sentUser).not.toContain(PHONE);
    expect(sentUser).toContain('[PHONE_1]');
    // hydrate 返回的 entry 已还原
    expect(entry.summary).toContain(PHONE);
    expect(entry.content).toContain(PHONE);
  });
});

describe('Agent — SecurityBlockError 历史回滚', () => {
  it('block 命中时本轮 user 消息被弹出，会话可继续', async () => {
    const rulesFile = path.join(tmpDir, 'security.json');
    fs.writeFileSync(
      rulesFile,
      JSON.stringify({ rules: [{ pattern: '违禁词', action: 'block' }] }),
      'utf8',
    );
    const { client } = makeMockClient([finalResp('ok')]);
    wrapClientWithSecurity(client, maskAllSanitizer(rulesFile), { onNotice: () => {} });

    const ctx = {
      config: {} as never,
      library: {} as never,
      assembler: {} as never,
      hydrator: {} as never,
      approvedWritePaths: new Set<string>(),
      requestApproval: async () => 'no' as const,
      converterRegistry: {} as never,
      converterCache: {} as never,
    };
    const agent = new Agent(client as never, 'test-model', ctx as never);
    const internal = agent as unknown as { messages: ChatCompletionMessageParam[] };
    const baseLen = internal.messages.length; // 仅 system prompt

    await expect(agent.send('这句话包含违禁词')).rejects.toThrow(SecurityBlockError);
    expect(internal.messages).toHaveLength(baseLen);

    // 回滚后正常提问可以继续
    const reply = await agent.send('正常提问');
    expect(reply).toBe('ok');
  });
});
