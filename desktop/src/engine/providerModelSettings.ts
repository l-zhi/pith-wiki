import fs from 'node:fs';
import path from 'node:path';
import { ProviderSchema } from '@core/config.js';
import { reasoningEffortsFor } from '@core/llm/modelSettings.js';
import type { ModelOptionDTO, SettingsSaveDTO } from '../shared/protocol.js';

/** Read only the cached catalog: opening Settings never makes an LLM request. */
export function readCodexModelOptions(codexHome: string): ModelOptionDTO[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    if (!Array.isArray(raw.models)) return [];
    return raw.models.flatMap((m: Record<string, unknown>) => {
      if (!m || typeof m.slug !== 'string' || m.visibility === 'hide') return [];
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.flatMap((r) =>
            r && typeof r.effort === 'string' && reasoningEffortsFor('codex').includes(r.effort)
              ? [r.effort]
              : [],
          )
        : [];
      return [{ id: m.slug, ...(levels.length ? { reasoningEfforts: levels } : {}) }];
    });
  } catch {
    return [];
  }
}

/** Preserve unedited fields, explicitly clear defaults, and validate before writing. */
export function applyProviderModelSettings(
  existing: Record<string, unknown>,
  update: Pick<
    SettingsSaveDTO['providers'][number],
    'kind' | 'model' | 'reasoningEffort' | 'verbosity'
  >,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    kind: update.kind,
    model: update.model.trim(),
  };
  for (const key of ['reasoningEffort', 'verbosity'] as const) {
    if (update[key] === null) delete next[key];
    else if (update[key] !== undefined) next[key] = update[key];
  }
  ProviderSchema.parse(next);
  return next;
}
