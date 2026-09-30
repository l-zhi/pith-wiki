/** CLI reasoning levels; individual models may support a narrower subset. */
export const REASONING_EFFORTS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ModelVerbosity = 'low' | 'medium' | 'high';

export function reasoningEffortsFor(kind: string): readonly ReasoningEffort[] {
  if (kind === 'codex') return REASONING_EFFORTS.filter((v) => v !== 'off');
  if (kind === 'claude-code') return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (kind === 'pi') return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return [];
}
