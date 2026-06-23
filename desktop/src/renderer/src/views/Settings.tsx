import React from 'react';
import { Check, FolderPlus, KeyRound, Plus, Settings2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Input, SegmentedControl, Switch } from '../ds';
import { useStore, type Theme } from '../store';
import type { SettingsDTO, SettingsSaveDTO, WatchDirDTO } from '../../../shared/protocol';

/**
 * Settings —— 设计稿 Settings.jsx 的三段结构：Provider / Library / Appearance。
 * 保存语义（grill 共识）：写 config.json + Engine 全量重建；busy 会话两步确认；
 * key 双形态展示（env 引用胶囊 / 字面值掩码），输入新值才覆盖。
 */

interface ProviderDraft {
  name: string;
  baseURL: string;
  model: string;
  supportsJsonMode: boolean;
  newApiKey: string;
  /** 来自 settings.get 的展示信息（新增的没有） */
  keySource?: 'literal' | 'env' | 'none';
  keyMasked?: string;
  keyEnvVar?: string;
  keyResolved?: boolean;
  isNew?: boolean;
}

interface Draft {
  activeProvider: string;
  providers: ProviderDraft[];
  watchDirs: WatchDirDTO[];
  readOnly: boolean;
}

function toDraft(s: SettingsDTO): Draft {
  return {
    activeProvider: s.activeProvider,
    providers: s.providers.map((p) => ({ ...p, newApiKey: '' })),
    watchDirs: s.watchDirs.map((w) => ({ ...w })),
    readOnly: s.readOnly,
  };
}

function toPayload(d: Draft): SettingsSaveDTO {
  return {
    activeProvider: d.activeProvider,
    providers: d.providers.map((p) => ({
      name: p.name.trim(),
      baseURL: p.baseURL.trim(),
      model: p.model.trim(),
      supportsJsonMode: p.supportsJsonMode,
      ...(p.newApiKey.trim() ? { newApiKey: p.newApiKey.trim() } : {}),
    })),
    watchDirs: d.watchDirs,
    readOnly: d.readOnly,
  };
}

export function Settings() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const chat = useStore((s) => s.chat);

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [confirmBusy, setConfirmBusy] = React.useState(false);

  // settings 到位/刷新时重置草稿
  React.useEffect(() => {
    if (settings) setDraft(toDraft(settings));
  }, [settings]);

  if (!settings || !draft) return <Shell><p style={{ color: 'var(--text-tertiary)' }}>{t('settings.loading')}</p></Shell>;

  const dirty = JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(toDraft(settings)));
  const anyBusy = Object.values(chat).some((c) => c.busy);

  const patch = (fn: (d: Draft) => Draft) => {
    setDraft((d) => (d ? fn(d) : d));
    setSaved(false);
    setConfirmBusy(false);
  };

  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings(toPayload(draft));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      setConfirmBusy(false);
    }
  };

  const onSaveClick = () => {
    if (anyBusy && !confirmBusy) {
      setConfirmBusy(true); // 两步确认：保存会中断进行中的会话
      return;
    }
    void doSave();
  };

  const addProvider = () =>
    patch((d) => ({
      ...d,
      providers: [
        ...d.providers,
        { name: '', baseURL: 'https://', model: '', supportsJsonMode: true, newApiKey: '', isNew: true },
      ],
    }));

  const addWatchDir = async () => {
    const dir = await window.pith.pickFolder();
    if (!dir) return;
    patch((d) =>
      d.watchDirs.some((w) => w.path === dir)
        ? d
        : { ...d, watchDirs: [...d.watchDirs, { path: dir, collectionFromSubdir: true, initialScan: true }] },
    );
  };

  return (
    <Shell>
      <h1 style={{ margin: 0, fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
        {t('settings.title')}
      </h1>

      {/* ───── Provider ───── */}
      <Section title={t('settings.provider')}>
        {draft.providers.map((p, i) => (
          <div key={p.isNew ? `new-${i}` : p.name} style={{ padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              {p.isNew ? (
                <Input
                  size="sm"
                  placeholder={t('settings.providerNamePlaceholder')}
                  value={p.name}
                  onChange={(e) => patch((d) => updateP(d, i, { name: e.target.value }))}
                  wrapStyle={{ width: 160 }}
                />
              ) : (
                <span style={{ fontSize: 'var(--text-callout)', fontWeight: 700, color: 'var(--text-primary)' }}>{p.name}</span>
              )}
              {draft.activeProvider === p.name && !p.isNew ? (
                <Badge tone="brand" dot>{t('settings.active')}</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => patch((d) => ({ ...d, activeProvider: p.name }))} disabled={!p.name}>
                  {t('settings.setActive')}
                </Button>
              )}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{t('settings.jsonMode')}</span>
                <Switch checked={p.supportsJsonMode} onChange={(v) => patch((d) => updateP(d, i, { supportsJsonMode: v }))} />
                <button
                  type="button"
                  title={draft.activeProvider === p.name ? t('settings.deleteActiveHint') : t('settings.deleteProvider')}
                  disabled={draft.activeProvider === p.name}
                  onClick={() => patch((d) => ({ ...d, providers: d.providers.filter((_, j) => j !== i) }))}
                  style={{
                    display: 'inline-flex',
                    border: 'none',
                    background: 'transparent',
                    cursor: draft.activeProvider === p.name ? 'default' : 'pointer',
                    color: draft.activeProvider === p.name ? 'var(--text-quaternary)' : 'var(--status-dead)',
                    opacity: draft.activeProvider === p.name ? 0.5 : 1,
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <Field label={t('settings.baseURL')} flex={1.5}>
                <Input size="sm" value={p.baseURL} onChange={(e) => patch((d) => updateP(d, i, { baseURL: e.target.value }))} />
              </Field>
              <Field label={t('settings.model')} flex={1}>
                <Input size="sm" value={p.model} onChange={(e) => patch((d) => updateP(d, i, { model: e.target.value }))} />
              </Field>
            </div>
            <Field label={t('settings.apiKey')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Input
                  size="sm"
                  type="password"
                  placeholder={
                    p.keySource === 'literal'
                      ? t('settings.keyLiteralPlaceholder', { masked: p.keyMasked })
                      : p.keySource === 'env'
                        ? t('settings.keyEnvPlaceholder')
                        : t('settings.keyEmptyPlaceholder')
                  }
                  value={p.newApiKey}
                  onChange={(e) => patch((d) => updateP(d, i, { newApiKey: e.target.value }))}
                  iconLeft={<KeyRound size={14} />}
                  wrapStyle={{ flex: 1 }}
                />
                {p.keySource === 'env' && (
                  <Badge tone={p.keyResolved ? 'done' : 'dead'} dot>
                    ${p.keyEnvVar}
                  </Badge>
                )}
                {p.keySource === 'literal' && <Badge tone={p.keyResolved ? 'done' : 'dead'} dot>literal</Badge>}
              </div>
            </Field>
          </div>
        ))}
        <div style={{ padding: '12px 20px' }}>
          <Button size="sm" variant="ghost" iconLeft={<Plus size={14} />} onClick={addProvider}>
            {t('settings.addProvider')}
          </Button>
        </div>
      </Section>

      {/* ───── Library ───── */}
      <Section title={t('settings.library')}>
        {draft.watchDirs.map((w, i) => (
          <Row
            key={w.path}
            title={w.path.split('/').slice(-2).join('/')}
            desc={w.path}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
              <Labeled label={t('settings.subdirAsCollection')} hint={t('settings.subdirAsCollectionHint')}>
                <Switch checked={w.collectionFromSubdir} onChange={(v) => patch((d) => updateW(d, i, { collectionFromSubdir: v }))} />
              </Labeled>
              <Labeled label={t('settings.initialScan')}>
                <Switch checked={w.initialScan} onChange={(v) => patch((d) => updateW(d, i, { initialScan: v }))} />
              </Labeled>
              <button
                type="button"
                title={t('settings.removeWatchDir')}
                onClick={() => patch((d) => ({ ...d, watchDirs: d.watchDirs.filter((_, j) => j !== i) }))}
                style={{ display: 'inline-flex', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--status-dead)' }}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </Row>
        ))}
        <Row title={t('settings.addWatchDir')} desc={t('settings.addWatchDirDesc')}>
          <Button size="sm" variant="secondary" iconLeft={<FolderPlus size={14} />} onClick={() => void addWatchDir()}>
            {t('settings.pickFolder')}
          </Button>
        </Row>
        <Row title={t('settings.readOnly')} desc={t('settings.readOnlyDesc')}>
          <Switch checked={draft.readOnly} onChange={(v) => patch((d) => ({ ...d, readOnly: v }))} tone="accent" />
        </Row>
      </Section>

      {/* ───── Appearance（即时生效，不参与保存） ───── */}
      <Section title={t('settings.appearance')}>
        <Row title={t('settings.theme')} desc={t('settings.themeDesc')}>
          <SegmentedControl
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
            size="sm"
            options={[
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
              { value: 'auto', label: t('settings.themeAuto') },
            ]}
          />
        </Row>
        <Row title={t('settings.language')} desc={t('settings.languageDesc')}>
          <SegmentedControl
            value={lang}
            onChange={(v) => setLang(v as 'zh' | 'en' | 'auto')}
            size="sm"
            options={[
              { value: 'zh', label: t('settings.langZh') },
              { value: 'en', label: t('settings.langEn') },
              { value: 'auto', label: t('settings.langAuto') },
            ]}
          />
        </Row>
      </Section>

      {/* ───── Save bar ───── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          variant={confirmBusy ? 'destructive' : 'primary'}
          disabled={!dirty || saving}
          onClick={onSaveClick}
          iconLeft={saved && !dirty ? <Check size={15} /> : undefined}
        >
          {saving
            ? t('settings.saving')
            : confirmBusy
              ? t('settings.confirmBusySave')
              : saved && !dirty
                ? t('settings.saved')
                : t('settings.save')}
        </Button>
        {dirty && (
          <Button variant="ghost" disabled={saving} onClick={() => patch(() => toDraft(settings))}>
            {t('settings.reset')}
          </Button>
        )}
        {anyBusy && dirty && !confirmBusy && (
          <span style={{ fontSize: 'var(--text-caption)', color: 'var(--status-running)' }}>
            {t('settings.busyWarning')}
          </span>
        )}
        {error && <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--status-dead)' }}>{error}</span>}
      </div>

      <p style={{ margin: 0, fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)' }}>
        {t('settings.configPathNote', { path: settings.configPath })}
      </p>
    </Shell>
  );
}

/* ───────── 布局原子 ───────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <Settings2 size={17} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>Settings</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 36px 64px', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="pith-eyebrow">{title}</span>
      <Card padding="0" style={{ overflow: 'hidden' }}>
        {children}
      </Card>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '14px 20px', borderBottom: '0.5px solid var(--separator)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {desc && (
          <div
            title={typeof desc === 'string' ? desc : undefined}
            style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {desc}
          </div>
        )}
      </div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

function Field({ label, flex, children }: { label: string; flex?: number; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: flex ?? 'none', minWidth: 0 }}>
      <span className="pith-eyebrow">{label}</span>
      {children}
    </label>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span title={hint} style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)', cursor: hint ? 'help' : undefined }}>
        {label}
      </span>
      {children}
    </span>
  );
}

function updateP(d: Draft, i: number, patch: Partial<ProviderDraft>): Draft {
  const providers = d.providers.map((p, j) => (j === i ? { ...p, ...patch } : p));
  // 重命名新建 provider 时，若它恰好是 activeProvider 引用对象则同步
  return { ...d, providers };
}

function updateW(d: Draft, i: number, patch: Partial<WatchDirDTO>): Draft {
  return { ...d, watchDirs: d.watchDirs.map((w, j) => (j === i ? { ...w, ...patch } : w)) };
}
