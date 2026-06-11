/**
 * 数据安全模块单元测试：presets 命中/边界、Sanitizer 脱敏-还原 round-trip、
 * 映射稳定性、JSON 转义还原、block 报错、规则文件加载（union 合并 / fail-fast）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compilePresets,
  ensureSecurityRulesFile,
  loadSecurityRules,
  luhnValid,
  Sanitizer,
  type PresetName,
  type PresetState,
} from '../src/security/index.js';

function allMask(over: Partial<Record<PresetName, PresetState>> = {}) {
  return compilePresets({
    phone: 'mask',
    idCard: 'mask',
    bankCard: 'mask',
    email: 'mask',
    apiKey: 'mask',
    ...over,
  });
}

describe('presets — PII 检测器', () => {
  it('手机号被脱敏，长数字串内部的 11 位片段不误报', () => {
    const s = new Sanitizer(allMask());
    const r = s.sanitize('联系张三 13800138000，订单号 991380013800019');
    expect(r.text).toContain('[PHONE_1]');
    expect(r.text).not.toContain('13800138000，'); // 真手机号被换掉
    expect(r.text).toContain('991380013800019'); // 订单号原样保留（digit boundary）
  });

  it('身份证号被脱敏（含 X 校验位）', () => {
    const s = new Sanitizer(allMask());
    const r = s.sanitize('证件号 11010119900307123X 已核验');
    expect(r.text).toContain('[ID_CARD_1]');
    expect(r.text).not.toContain('11010119900307123X');
  });

  it('银行卡：Luhn 通过的 16 位被脱敏，Luhn 不通过的不动', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    const s = new Sanitizer(allMask());
    const r = s.sanitize('卡号 4111111111111111 与流水号 4111111111111112');
    expect(r.text).toContain('[BANK_CARD_1]');
    expect(r.text).toContain('4111111111111112');
  });

  it('邮箱与 API key 被脱敏', () => {
    const s = new Sanitizer(allMask());
    const r = s.sanitize('发到 alan@example.com，key 是 sk-abcdefghij1234567890abcd');
    expect(r.text).toContain('[EMAIL_1]');
    expect(r.text).toContain('[API_KEY_1]');
    expect(r.text).not.toContain('alan@example.com');
    expect(r.text).not.toContain('sk-abcdefghij1234567890abcd');
  });

  it('off 的 preset 不参与', () => {
    const s = new Sanitizer(allMask({ phone: 'off' }));
    const r = s.sanitize('打 13800138000');
    expect(r.text).toContain('13800138000');
  });
});

describe('Sanitizer — 可还原脱敏', () => {
  it('mask → restore round-trip 还原原文', () => {
    const s = new Sanitizer(allMask());
    const original = '手机 13800138000 邮箱 a@b.com';
    const masked = s.sanitize(original);
    expect(masked.text).not.toContain('13800138000');
    const restored = s.restore(masked.text);
    expect(restored.text).toBe(original);
    expect(restored.leftover).toBe(0);
  });

  it('同一会话内映射稳定：同值多次 sanitize 得到同一占位符', () => {
    const s = new Sanitizer(allMask());
    const a = s.sanitize('号码 13800138000');
    const b = s.sanitize('再发一遍 13800138000，另一个 13911112222');
    expect(a.text).toContain('[PHONE_1]');
    expect(b.text).toContain('[PHONE_1]');
    expect(b.text).toContain('[PHONE_2]');
    // newLabels 只报首次见到的值：第二次的 13800138000 不再报
    expect(a.newLabels).toEqual(['PHONE']);
    expect(b.newLabels).toEqual(['PHONE']);
    expect(b.maskedLabels).toEqual(['PHONE', 'PHONE']);
  });

  it('jsonEscape 还原：原文含引号/换行时不破坏外层 JSON', () => {
    const rules = loadRulesFromObj({
      rules: [{ pattern: '机密"项目\nX', action: 'mask', label: 'SECRET' }],
    });
    const s = new Sanitizer(rules);
    const masked = s.sanitize('内容：机密"项目\nX 完');
    expect(masked.text).toContain('[SECRET_1]');
    const json = JSON.stringify({ summary: 'about [SECRET_1] here' });
    const restored = s.restore(json, { jsonEscape: true });
    const parsed = JSON.parse(restored.text) as { summary: string };
    expect(parsed.summary).toBe('about 机密"项目\nX here');
  });

  it('block 规则返回 blocked（不替换），sample 截断', () => {
    const rules = loadRulesFromObj({
      rules: [{ pattern: '绝密代号阿尔法贝塔伽马德尔塔艾普西龙泽塔伊塔西塔卡帕拉姆达', action: 'block' }],
    });
    const s = new Sanitizer(rules);
    const r = s.sanitize('文档提到 绝密代号阿尔法贝塔伽马德尔塔艾普西龙泽塔伊塔西塔卡帕拉姆达 字样');
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0].label).toBe('KEYWORD');
    expect(r.blocked[0].sample.endsWith('…')).toBe(true);
    expect(r.text).toContain('绝密代号'); // block 不做替换
  });

  it('restore 遇到映射表没有的占位符：原样保留并计数', () => {
    const s = new Sanitizer(allMask());
    const r = s.restore('模型编造了 [PHONE_9] 这个占位符');
    expect(r.text).toContain('[PHONE_9]');
    expect(r.leftover).toBe(1);
  });
});

// ---- 规则文件加载 ----

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-sec-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeRules(name: string, obj: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

/** 测试辅助：经由真实文件加载（覆盖 schema 校验 + 编译路径）。 */
function loadRulesFromObj(obj: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-sec-obj-'));
  const p = path.join(dir, 'security.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  try {
    return loadSecurityRules([p]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadSecurityRules — 双层加载与合并', () => {
  it('文件全部缺失：内置 presets 全 mask，无自定义规则', () => {
    const rules = loadSecurityRules([path.join(tmpDir, 'nope.json')]);
    expect(rules).toHaveLength(5); // 5 个内置 preset
    expect(rules.every((r) => r.action === 'mask')).toBe(true);
  });

  it('自定义关键词 + preset 关闭', () => {
    const p = writeRules('a.json', {
      presets: { email: 'off' },
      rules: [{ pattern: '内部项目雷神', action: 'mask', label: 'PROJECT' }],
    });
    const rules = loadSecurityRules([p]);
    expect(rules.find((r) => r.label === 'PROJECT')).toBeTruthy();
    expect(rules.find((r) => r.source === 'preset:email')).toBeUndefined();
    // 自定义规则排在 presets 前
    expect(rules[0].label).toBe('PROJECT');
  });

  it('union 合并：自定义规则全收，preset 冲突取更严格（block > mask > off）', () => {
    const a = writeRules('user.json', {
      presets: { phone: 'off', email: 'block' },
      rules: [{ pattern: 'kw-a', action: 'mask' }],
    });
    const b = writeRules('project.json', {
      presets: { phone: 'mask', email: 'mask' },
      rules: [{ pattern: 'kw-b', action: 'block' }],
    });
    const rules = loadSecurityRules([a, b]);
    expect(rules.filter((r) => r.label === 'KEYWORD')).toHaveLength(2);
    expect(rules.find((r) => r.source === 'preset:phone')?.action).toBe('mask');
    expect(rules.find((r) => r.source === 'preset:email')?.action).toBe('block');
  });

  it('无效正则 fail-fast', () => {
    const p = writeRules('bad-re.json', {
      rules: [{ pattern: '([unclosed', action: 'mask', regex: true }],
    });
    expect(() => loadSecurityRules([p])).toThrow(/Invalid regex/);
  });

  it('JSON 坏 / 未知键 fail-fast', () => {
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(bad, '{not json', 'utf8');
    expect(() => loadSecurityRules([bad])).toThrow(/Failed to parse/);

    const unknown = writeRules('unknown.json', { presets: {}, blocklist: [] });
    expect(() => loadSecurityRules([unknown])).toThrow(/Invalid security rules/);
  });

  it('regex=false 的 pattern 按字面量处理（元字符被转义）', () => {
    const p = writeRules('lit.json', {
      rules: [{ pattern: 'a.b(c)', action: 'mask', label: 'LIT' }],
    });
    const s = new Sanitizer(loadSecurityRules([p]));
    expect(s.sanitize('axb(c)').text).toBe('axb(c)'); // `.` 不是通配
    expect(s.sanitize('a.b(c)').text).toContain('[LIT_1]');
  });
});

describe('ensureSecurityRulesFile — 首次初始化', () => {
  it('所有层都缺失时写基础模板到第一条路径（含 apiKey 等全部 preset），且可被正常加载', () => {
    const user = path.join(tmpDir, 'home', 'security.json');
    const project = path.join(tmpDir, 'proj', 'security.json');
    const created = ensureSecurityRulesFile([user, project]);
    expect(created).toBe(user);
    const parsed = JSON.parse(fs.readFileSync(user, 'utf8')) as {
      presets: Record<string, string>;
      rules: unknown[];
    };
    expect(parsed.presets.apiKey).toBe('mask');
    expect(parsed.rules).toEqual([]);
    // 模板本身过 schema + 编译（写出来的文件必须永远是合法输入）
    const rules = loadSecurityRules([user, project]);
    expect(rules).toHaveLength(5);
  });

  it('任何一层已存在 → no-op，绝不覆盖', () => {
    const user = path.join(tmpDir, 'security.json');
    const project = writeRules('proj-security.json', { rules: [] });
    expect(ensureSecurityRulesFile([user, project])).toBeNull();
    expect(fs.existsSync(user)).toBe(false);

    fs.writeFileSync(user, '{"rules":[{"pattern":"x","action":"mask"}]}', 'utf8');
    expect(ensureSecurityRulesFile([user])).toBeNull();
    expect(fs.readFileSync(user, 'utf8')).toContain('"x"'); // 用户内容原封不动
  });
});
