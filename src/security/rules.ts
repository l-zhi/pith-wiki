import fs from 'node:fs';
import path from 'node:path';
import { compilePresets } from './presets.js';
import {
  PRESET_NAMES,
  SecurityRulesFileSchema,
  type CompiledRule,
  type PresetName,
  type PresetState,
  type SecurityRulesFile,
} from './types.js';

/**
 * 双层规则文件加载（用户级 + 项目级，与 soulFile/skillDirs 同构的 layering）。
 *
 * 合并语义是 union 而非覆盖 —— 安全规则做加法：
 *   - 自定义 rules：所有文件的规则全部生效（按文件顺序拼接）
 *   - presets：多层都显式声明同一项时取**更严格**的（block > mask > off），
 *     一层都没声明 → 默认 mask
 *
 * 失败策略与 config 一致：文件不存在是常态（跳过）；JSON 坏 / schema 不符 /
 * 正则编译失败 → 抛错 fail-fast，用户写错规则要在启动时立刻知道，
 * 而不是带着漏网的敏感数据继续跑。
 */

const STRICTNESS: Record<PresetState, number> = { off: 0, mask: 1, block: 2 };

/**
 * 首次初始化的基础规则模板。presets 与内置默认完全一致（全 mask）——写出来
 * 是为了可发现、可编辑：用户打开文件就知道有哪些检测器（apiKey/手机号/身份证/
 * 银行卡/邮箱）、怎么逐项调级，rules 数组就是加自定义关键词的地方。
 */
const STARTER_RULES: SecurityRulesFile = {
  presets: {
    apiKey: 'mask',
    phone: 'mask',
    idCard: 'mask',
    bankCard: 'mask',
    email: 'mask',
  },
  rules: [],
};

/**
 * 任何一层规则文件都不存在时，把基础模板写到第一条路径（user-global
 * `~/.pith-wiki/security.json`）。返回创建的路径；已有文件 → null（绝不覆盖）。
 */
export function ensureSecurityRulesFile(paths: string[]): string | null {
  if (paths.length === 0) return null;
  if (paths.some((p) => fs.existsSync(p))) return null;
  const target = paths[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(STARTER_RULES, null, 2)}\n`, 'utf8');
  return target;
}

/** 正则元字符转义：关键词字面量 → 等价正则源码。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function loadSecurityRules(paths: string[], onWarn?: (msg: string) => void): CompiledRule[] {
  const presetStates = new Map<PresetName, PresetState>();
  const customRules: CompiledRule[] = [];

  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse security rules ${file}: ${(err as Error).message}`);
    }
    const parsed = SecurityRulesFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid security rules ${file}: ${parsed.error.message}`);
    }

    for (const name of PRESET_NAMES) {
      const state = parsed.data.presets?.[name];
      if (!state) continue;
      const prev = presetStates.get(name);
      if (!prev || STRICTNESS[state] > STRICTNESS[prev]) presetStates.set(name, state);
    }

    parsed.data.rules.forEach((rule, idx) => {
      const sourceText = rule.regex ? rule.pattern : escapeRegExp(rule.pattern);
      let pattern: RegExp;
      try {
        pattern = new RegExp(sourceText, 'g');
      } catch (err) {
        throw new Error(
          `Invalid regex in security rules ${file} (rule #${idx}): ${(err as Error).message}`,
        );
      }
      customRules.push({
        label: rule.label ?? 'KEYWORD',
        action: rule.action,
        pattern,
        source: `file:${file}#${idx}`,
      });
    });
  }

  if (paths.length > 0 && customRules.length === 0 && presetStates.size === 0) {
    onWarn?.('security: no rules files found — running with built-in PII presets only (all mask)');
  }

  // 未显式声明的 preset 默认 mask（安全开启即全量 PII 脱敏，关闭需显式 off）
  const mergedStates = Object.fromEntries(
    PRESET_NAMES.map((n) => [n, presetStates.get(n) ?? 'mask']),
  ) as Record<PresetName, PresetState>;

  // 自定义规则在前：用户对具体业务词的意图（含跨越 PII 边界的长关键词）优先于通用预设
  return [...customRules, ...compilePresets(mergedStates)];
}
