import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderDTO } from '../../../shared/protocol';
import { Input, Select } from '../ds';

export type ModelFields = Pick<ProviderDTO, 'model' | 'reasoningEffort' | 'verbosity'>;
type ModelProvider = ModelFields & Pick<ProviderDTO, 'kind' | 'modelOptions' | 'reasoningEfforts'>;

export function ProviderModelFields({
  provider: p,
  onChange,
  disabled,
}: {
  provider: ModelProvider;
  onChange: (fields: Partial<ModelFields>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = React.useState(false);
  const models = p.modelOptions ?? [];
  const cli = p.kind !== 'openai';
  const known = p.model === 'default' || models.some((m) => m.id === p.model);
  const customModel = custom || !known;
  const levels = models.find((m) => m.id === p.model)?.reasoningEfforts ?? p.reasoningEfforts ?? [];
  const onModel = (model: string) => {
    const supported = models.find((m) => m.id === model)?.reasoningEfforts;
    onChange({
      model,
      ...(p.reasoningEffort && supported && !supported.includes(p.reasoningEffort)
        ? { reasoningEffort: undefined }
        : {}),
    });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label={t('settings.model')}>
        {cli && (
          <Select
            aria-label={t('settings.model')}
            disabled={disabled}
            value={customModel ? '__custom__' : p.model}
            options={[
              { value: 'default', label: t('settings.cliDefault') },
              ...models.map((m) => ({ value: m.id, label: m.id })),
              { value: '__custom__', label: t('settings.customModel') },
            ]}
            onChange={(v) => {
              setCustom(v === '__custom__');
              if (v !== '__custom__') onModel(v);
            }}
          />
        )}
        {(!cli || customModel) && (
          <Input
            aria-label={t('settings.modelId')}
            disabled={disabled}
            value={p.model}
            placeholder={t('settings.modelId')}
            onChange={(e) => onModel(e.target.value)}
          />
        )}
      </Field>
      {cli && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14,
          }}
        >
          <Field label={t('settings.reasoningEffort')}>
            <Select
              aria-label={t('settings.reasoningEffort')}
              disabled={disabled}
              value={p.reasoningEffort ?? ''}
              options={[
                { value: '', label: t('settings.cliDefault') },
                ...Array.from(
                  new Set([...levels, ...(p.reasoningEffort ? [p.reasoningEffort] : [])]),
                ).map((v) => ({
                  value: v,
                  label: `${t(`settings.effort.${v}`, { defaultValue: v })} (${v})`,
                })),
              ]}
              onChange={(v) => onChange({ reasoningEffort: v || undefined })}
            />
          </Field>
          {p.kind === 'codex' && (
            <Field label={t('settings.verbosity')}>
              <Select
                aria-label={t('settings.verbosity')}
                disabled={disabled}
                value={p.verbosity ?? ''}
                options={[
                  { value: '', label: t('settings.cliDefault') },
                  ...(['low', 'medium', 'high'] as const).map((v) => ({
                    value: v,
                    label: t(`settings.verbosityOptions.${v}`),
                  })),
                ]}
                onChange={(v) => onChange({ verbosity: v || undefined })}
              />
            </Field>
          )}
        </div>
      )}
      <p
        style={{
          margin: 0,
          fontSize: 'var(--text-caption)',
          lineHeight: 1.6,
          color: 'var(--text-tertiary)',
        }}
      >
        {t(cli ? 'settings.cliModelHint' : 'settings.apiModelHint')}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span className="pith-eyebrow">{label}</span>
      {children}
    </div>
  );
}
