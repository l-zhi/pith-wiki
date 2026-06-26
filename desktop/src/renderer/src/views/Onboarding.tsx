import React from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input, SegmentedControl } from '../ds';
import { LogoMark } from '../Logo';
import { useStore } from '../store';

const PRESETS: Record<string, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  // 任意 OpenAI 兼容端点（如火山引擎 Ark / 自建推理）——baseURL/model 留空给用户填。
  other: { baseURL: '', model: '' },
};

/**
 * 首启引导（PRD：检测不到可用 key 时弹出）：选 provider + 粘贴 key →
 * 写入 ~/.pith-wiki/config.json 的 providers map（与 CLI 同一事实源）。
 */
export function Onboarding() {
  const { t } = useTranslation();
  const saveOnboarding = useStore((s) => s.saveOnboarding);
  const [provider, setProvider] = React.useState('deepseek');
  const [model, setModel] = React.useState(PRESETS.deepseek.model);
  const [baseURL, setBaseURL] = React.useState(PRESETS.deepseek.baseURL);
  const [apiKey, setApiKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pick = (p: string) => {
    setProvider(p);
    setModel(PRESETS[p].model);
    setBaseURL(PRESETS[p].baseURL);
  };

  const save = async () => {
    if (!apiKey.trim()) {
      setError(t('onboarding.apiKeyRequired'));
      return;
    }
    if (!baseURL.trim()) {
      setError(t('onboarding.baseURLRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveOnboarding({ provider, baseURL, model, apiKey: apiKey.trim() });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--surface-window) 72%, transparent)',
        WebkitBackdropFilter: 'var(--blur-thick)',
        backdropFilter: 'var(--blur-thick)',
      }}
    >
      <Card container padding="0" style={{ width: 480, overflow: 'hidden' }}>
        <div style={{ padding: '32px 36px 0', textAlign: 'center' }}>
          <LogoMark
            size={56}
            variant="full"
            bg="#0e0e10"
            ink="rgba(255,255,255,0.26)"
            mk="#ff5247"
            title="pith"
            style={{ display: 'inline-block' }}
          />
          <h1 style={{ margin: '16px 0 6px', fontSize: 'var(--text-title-2)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
            {t('onboarding.welcome')}
          </h1>
          <p style={{ margin: 0, fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)', lineHeight: 'var(--leading-normal)' }}>
            {t('onboarding.desc', { path: '~/.pith-wiki/config.json' })}
          </p>
        </div>

        <div style={{ padding: '24px 36px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SegmentedControl
            value={provider}
            onChange={pick}
            options={[
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'qwen', label: 'Qwen' },
              { value: 'openai', label: 'OpenAI' },
              { value: 'other', label: t('onboarding.other') },
            ]}
          />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="pith-eyebrow">{t('onboarding.apiKey')}</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              iconLeft={<KeyRound size={15} />}
              invalid={Boolean(error)}
              autoFocus
            />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="pith-eyebrow">{t('onboarding.model')}</span>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                size="sm"
                placeholder="doubao-seed-2.0-pro"
              />
            </label>
            <label style={{ flex: 1.4, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="pith-eyebrow">{t('onboarding.baseURL')}</span>
              <Input
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                size="sm"
                placeholder="https://ark.cn-beijing.volces.com/api/coding/v3"
              />
            </label>
          </div>
          {error && <p style={{ margin: 0, fontSize: 'var(--text-subhead)', color: 'var(--status-dead)' }}>{error}</p>}
          <Button variant="primary" size="lg" fullWidth onClick={() => void save()} disabled={saving}>
            {saving ? t('onboarding.connecting') : t('onboarding.start')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
