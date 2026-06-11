import type { CompiledRule, PresetName, PresetState, RuleAction } from './types.js';

/**
 * 内置 PII 检测器（中国场景为主）。
 *
 * 全部用 digit-boundary lookaround（而非 \b —— \b 对 CJK 相邻数字不可靠）防止
 * 命中更长数字串的内部片段：身份证里不会被抠出一个"手机号"，订单号里不会
 * 误标银行卡。
 *
 * 应用顺序即数组顺序：更长/更特异的在前（idCard → bankCard → phone），
 * 先命中的先被替换成占位符，后面的检测器看不到已替换的片段。
 */

/** Luhn 校验：银行卡号的二次过滤，把"恰好 13-19 位的随机数字"误报率压到 ~10%。 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface PresetDef {
  name: PresetName;
  label: string;
  pattern: () => RegExp;
  validate?: (match: string) => boolean;
}

const PRESET_DEFS: PresetDef[] = [
  {
    name: 'idCard',
    label: 'ID_CARD',
    // 18 位：6 区划 + 19/20 世纪出生日期 + 3 顺序码 + 校验位（数字或 X）
    pattern: () =>
      /(?<![0-9Xx])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9Xx])/g,
  },
  {
    name: 'bankCard',
    label: 'BANK_CARD',
    pattern: () => /(?<!\d)\d{13,19}(?!\d)/g,
    validate: luhnValid,
  },
  {
    name: 'phone',
    label: 'PHONE',
    pattern: () => /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    name: 'email',
    label: 'EMAIL',
    pattern: () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    name: 'apiKey',
    label: 'API_KEY',
    // 常见 key 形态：OpenAI/DeepSeek sk-、GitHub ghp_/gho_/PAT、Slack xox、AWS AKIA、腾讯云 AKID
    pattern: () =>
      /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AKID[A-Za-z0-9]{13,40})/g,
  },
];

/** 按合并后的 preset 状态编译出运行时规则（off 的剔除）。顺序固定为 PRESET_DEFS 声明序。 */
export function compilePresets(states: Record<PresetName, PresetState>): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const def of PRESET_DEFS) {
    const state = states[def.name];
    if (state === 'off') continue;
    out.push({
      label: def.label,
      action: state as RuleAction,
      pattern: def.pattern(),
      validate: def.validate,
      source: `preset:${def.name}`,
    });
  }
  return out;
}
