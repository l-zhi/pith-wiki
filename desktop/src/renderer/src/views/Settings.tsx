import React from 'react';
import { Check, FolderPlus, KeyRound, Plus, Settings2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Input, SegmentedControl, Switch } from '../ds';
import { DocEditor, type DocPreset } from './DocEditor';
import { useStore, type Theme } from '../store';
import type { SettingsDTO, SettingsSaveDTO, WatchDirDTO } from '../../../shared/protocol';

/**
 * Settings —— 设计稿 Settings.jsx 的三段结构：Provider / Library / Appearance。
 * 保存语义（grill 共识）：写 config.json + Engine 全量重建；busy 会话两步确认；
 * key 双形态展示（env 引用胶囊 / 字面值掩码），输入新值才覆盖。
 */

interface ProviderDraft {
  name: string;
  kind: 'openai' | 'claude-code' | 'codex';
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
  hydrationProvider: string;
  reviewProvider: string;
  providers: ProviderDraft[];
  watchDirs: WatchDirDTO[];
  readOnly: boolean;
}

function toDraft(s: SettingsDTO): Draft {
  return {
    activeProvider: s.activeProvider,
    hydrationProvider: s.hydrationProvider,
    reviewProvider: s.reviewProvider,
    providers: s.providers.map((p) => ({ ...p, newApiKey: '' })),
    watchDirs: s.watchDirs.map((w) => ({ ...w })),
    readOnly: s.readOnly,
  };
}

function toPayload(d: Draft): SettingsSaveDTO {
  return {
    activeProvider: d.activeProvider,
    hydrationProvider: d.hydrationProvider,
    providers: d.providers.map((p) => ({
      name: p.name.trim(),
      kind: p.kind,
      baseURL: p.baseURL.trim(),
      model: p.model.trim(),
      supportsJsonMode: p.supportsJsonMode,
      ...(p.newApiKey.trim() ? { newApiKey: p.newApiKey.trim() } : {}),
    })),
    watchDirs: d.watchDirs,
    readOnly: d.readOnly,
  };
}

/**
 * SOUL 风格预设：不知道填什么时一键套用（套进草稿后仍可编辑再保存）。
 * 内容按语言给两份——SOUL 本身带语气示范，随 UI 语言走更自然。
 */
const SOUL_PRESETS: DocPreset[] = [
  {
    key: 'concise',
    label: { zh: '简洁直接', en: 'Concise & direct' },
    body: {
      zh: [
        '- 用简体中文，语气直接，省去寒暄和客套',
        '- 先给结论，再给依据；能一句话说清就不展开',
        '- 涉及取舍时明确给出你的推荐，不要罗列所有选项让我自己挑',
        '- 不确定就说不确定，绝不编造',
      ].join('\n'),
      en: [
        '- Answer in a direct tone; skip greetings and filler',
        '- Lead with the conclusion, then the reasoning; if one line suffices, stop there',
        "- On trade-offs, state your recommendation — don't just list options for me to pick",
        "- If you're unsure, say so; never fabricate",
      ].join('\n'),
    },
  },
  {
    key: 'advisor',
    label: { zh: '深度顾问', en: 'Thorough advisor' },
    body: {
      zh: [
        '- 用简体中文，像资深顾问一样回答',
        '- 先给结论和推荐，再展开背景、权衡与风险',
        '- 主动补充我没问到但重要的点',
        '- 关键判断给出理由链，方便我复核',
      ].join('\n'),
      en: [
        '- Answer like a seasoned advisor',
        '- Give the conclusion and recommendation first, then background, trade-offs and risks',
        "- Proactively surface important points I didn't ask about",
        '- Show the reasoning chain for key judgments so I can double-check',
      ].join('\n'),
    },
  },
  {
    key: 'critic',
    label: { zh: '犀利批判', en: 'Critical & challenging' },
    body: {
      zh: [
        '- 用简体中文，语气犀利、不迁就',
        '- 我的想法有漏洞时直接指出，先反驳、找反例和风险，再补充',
        '- 默认对我的假设持怀疑态度，不要为了让我舒服而附和',
        '- 但结论要落地，别只批评不给方向',
      ].join('\n'),
      en: [
        "- Be sharp and don't coddle me",
        '- When my idea has holes, say so first — find counterexamples and risks before agreeing',
        "- Default to skepticism about my assumptions; don't agree just to please me",
        '- But land on something actionable — no critique without a direction',
      ].join('\n'),
    },
  },
  {
    key: 'editor',
    label: { zh: '知识整理', en: 'Knowledge editor' },
    body: {
      zh: [
        '- 用简体中文，以编辑/整理者的视角回答',
        '- 善于把零散信息归纳成结构化要点、清单、对照表',
        '- 措辞适合直接用作笔记 / 公众号素材',
        '- 标注信息来源，区分事实与推测',
      ].join('\n'),
      en: [
        '- Answer as an editor who organizes information',
        '- Turn scattered input into structured points, lists and comparison tables',
        '- Phrase things so they can be reused directly as notes or article material',
        '- Cite sources and separate fact from speculation',
      ].join('\n'),
    },
  },
];

/** REVIEW.md 审核标准预设(审稿模式下 reviewer 对着它打分)。 */
const REVIEW_PRESETS: DocPreset[] = [
  {
    key: 'general',
    label: { zh: '通用严格', en: 'General & strict' },
    body: {
      zh: [
        '- 结论明确:先给结论/推荐,不含糊、不骑墙',
        '- 契合任务:确实回答了诉求,没跑题、没遗漏关键点',
        '- 有据可依:关键论断有依据,不编造事实、不虚构来源',
        '- 结构清晰:该分点/分段处分点,便于阅读',
        '- 无冗余、重复、自相矛盾',
      ].join('\n'),
      en: [
        '- Clear conclusion: lead with the takeaway/recommendation, no hedging',
        '- On-task: actually answers the ask, no drift, no missing key points',
        '- Grounded: key claims are backed; no fabricated facts or sources',
        '- Well-structured: break into points/sections where it helps reading',
        '- No redundancy, repetition, or self-contradiction',
      ].join('\n'),
    },
  },
  {
    key: 'factual',
    label: { zh: '重事实核查', en: 'Fact-check heavy' },
    body: {
      zh: [
        '- 每个事实性论断都必须能追溯到知识库条目或明确来源,否则打回',
        '- 数字、日期、人名、专有名词必须与来源一致,不许含糊近似',
        '- 推测与事实必须显式区分(用"据推测/可能"等措辞)',
        '- 宁可少说,不许编造;拿不准的点要标注存疑',
      ].join('\n'),
      en: [
        '- Every factual claim must trace to a wiki entry or explicit source, else bounce',
        '- Numbers, dates, names, proper nouns must match sources exactly — no fuzzy approximations',
        '- Speculation must be explicitly marked as such (e.g. "likely / presumably")',
        '- Prefer saying less over fabricating; flag anything uncertain',
      ].join('\n'),
    },
  },
  {
    key: 'publish',
    label: { zh: '公众号发布', en: 'Ready to publish' },
    body: {
      zh: [
        '- 有抓人的标题/开头,不是平铺直叙的流水账',
        '- 观点鲜明,有信息增量,不是常识堆砌',
        '- 语言通顺、节奏好,适合直接作为公众号/笔记发布',
        '- 结尾有落点(行动建议/总结/引子),不烂尾',
        '- 无明显 AI 腔、空话套话',
      ].join('\n'),
      en: [
        '- Has a hooky title/opening, not a flat play-by-play',
        '- A clear point of view with real information gain, not common-sense filler',
        '- Fluent, well-paced prose ready to publish as an article/note',
        '- Ends with a payoff (takeaway/summary/hook), no abrupt stop',
        '- No obvious AI-speak or empty boilerplate',
      ].join('\n'),
    },
  },
];

export function Settings() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const switchProvider = useStore((s) => s.switchProvider);
  const setHydrationProvider = useStore((s) => s.setHydrationProvider);
  const setReviewProvider = useStore((s) => s.setReviewProvider);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const chat = useStore((s) => s.chat);
  const getSoul = useStore((s) => s.getSoul);
  const saveSoul = useStore((s) => s.saveSoul);
  const getReview = useStore((s) => s.getReview);
  const saveReview = useStore((s) => s.saveReview);

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

  // activeProvider / hydrationProvider 是「选了即生效」的即时选择器，不归 Save 管——
  // 从 dirty 比对里剔除，避免切换它们时 Save 按钮在重建期间闪一下"可保存"。
  const stripInstant = (p: SettingsSaveDTO) => ({ ...p, activeProvider: '', hydrationProvider: '' });
  const dirty =
    JSON.stringify(stripInstant(toPayload(draft))) !==
    JSON.stringify(stripInstant(toPayload(toDraft(settings))));
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
        { name: '', kind: 'openai', baseURL: 'https://', model: '', supportsJsonMode: true, newApiKey: '', isNew: true },
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

  // ── 三段所需的派生数据 ──
  // 区域 1（Provider）只展示 openai 类（= API key 配置）；claude-code 不是 API 卡片。
  const openaiProviders = draft.providers.filter((p) => p.kind === 'openai' && p.name.trim());
  // 区域 3（对话模型）选项 = openai providers + 本机检测到的 CLI。
  // 既没检测到、也没配置过的 CLI 选了也用不了 → 直接不列入。
  const cliOptions = (settings.availableClis ?? [])
    .map((cli) => ({ cli, entry: draft.providers.find((p) => p.kind === cli.id) }))
    .filter(({ cli, entry }) => cli.present || entry)
    .map(({ cli, entry }) => ({
      value: entry?.name ?? cli.id,
      label: `${cli.label}${cli.present ? '' : ` · ${t('settings.cliAbsent')}`}`,
    }));
  const chatOptions = [...openaiProviders.map((p) => ({ value: p.name, label: p.name })), ...cliOptions];
  // 两个选择器都是「选了即刻生效」（不走 Save）——乐观更新草稿 + 即时持久化 + 重建。
  // 未配置的 CLI（如本机检测到但没建 entry）由 engine 端在 setActiveProvider 里合成。
  const onChatChange = (value: string) => {
    patch((d) => ({ ...d, activeProvider: value }));
    void switchProvider(value);
  };
  const onReviewProviderChange = (value: string) => {
    patch((d) => ({ ...d, reviewProvider: value }));
    void setReviewProvider(value);
  };
  const onHydrationChange = (value: string) => {
    patch((d) => ({ ...d, hydrationProvider: value }));
    void setHydrationProvider(value);
  };

  return (
    <Shell>
      <h1 style={{ margin: 0, fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
        {t('settings.title')}
      </h1>

      {/* ───── 区域 1：Provider（配置 API key） ───── */}
      <Section title={t('settings.provider')}>
        <div style={{ padding: '12px 20px 4px', fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
          {t('settings.providerHint')}
        </div>
        {draft.providers.map((p, i) =>
          p.kind !== 'openai' ? null : (
            <div key={p.isNew ? `new-${i}` : p.name} style={{ padding: '16px 20px', borderTop: '0.5px solid var(--separator)' }}>
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
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{t('settings.jsonMode')}</span>
                  <Switch checked={p.supportsJsonMode} onChange={(v) => patch((d) => updateP(d, i, { supportsJsonMode: v }))} />
                  {(() => {
                    const used = draft.activeProvider === p.name || draft.hydrationProvider === p.name;
                    return (
                      <button
                        type="button"
                        title={used ? t('settings.deleteActiveHint') : t('settings.deleteProvider')}
                        disabled={used}
                        onClick={() => patch((d) => ({ ...d, providers: d.providers.filter((_, j) => j !== i) }))}
                        style={{
                          display: 'inline-flex',
                          border: 'none',
                          background: 'transparent',
                          cursor: used ? 'default' : 'pointer',
                          color: used ? 'var(--text-quaternary)' : 'var(--status-dead)',
                          opacity: used ? 0.5 : 1,
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    );
                  })()}
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
          ),
        )}
        <div style={{ padding: '12px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <Button size="sm" variant="ghost" iconLeft={<Plus size={14} />} onClick={addProvider}>
            {t('settings.addProvider')}
          </Button>
        </div>
      </Section>

      {/* ───── 区域 2：知识库水合模型（选择器） ───── */}
      <Section title={t('settings.hydrationTitle')}>
        <Row title={t('settings.hydrationProvider')} desc={t('settings.hydrationHint')}>
          <SegmentedControl
            size="sm"
            value={draft.hydrationProvider}
            onChange={onHydrationChange}
            options={[
              { value: '', label: t('settings.hydrationAuto') },
              ...openaiProviders.map((p) => ({ value: p.name, label: p.name })),
            ]}
          />
        </Row>
      </Section>

      {/* ───── 区域 3：默认对话模型（选择器，含本机 CLI） ───── */}
      <Section title={t('settings.chatTitle')}>
        <Row title={t('nav.chat')} desc={t('settings.chatHint')}>
          <SegmentedControl size="sm" value={draft.activeProvider} onChange={onChatChange} options={chatOptions} />
        </Row>
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

      {/* ───── Soul（人设 / 语气；保存 = Engine 重建） ───── */}
      <DocEditor
        title={t('settings.soulTitle')}
        desc={t('settings.soulDesc')}
        presetHint={t('settings.soulPresetHint')}
        presets={SOUL_PRESETS}
        placeholder={t('settings.soulPlaceholder')}
        saveLabel={t('settings.soulSave')}
        savingLabel={t('settings.soulSaving')}
        savedLabel={t('settings.soulSaved')}
        load={getSoul}
        save={saveSoul}
      />

      {/* ───── Review（审稿标准；保存 = Engine 重建） ───── */}
      <DocEditor
        title={t('settings.reviewTitle')}
        desc={t('settings.reviewDesc')}
        presetHint={t('settings.reviewPresetHint')}
        presets={REVIEW_PRESETS}
        placeholder={t('settings.reviewPlaceholder')}
        saveLabel={t('settings.soulSave')}
        savingLabel={t('settings.soulSaving')}
        savedLabel={t('settings.soulSaved')}
        load={getReview}
        save={saveReview}
      />

      {/* ───── 审稿模型（选择器，选了即生效） ───── */}
      <Section title={t('settings.reviewProviderTitle')}>
        <Row title={t('settings.reviewProvider')} desc={t('settings.reviewProviderHint')}>
          <SegmentedControl
            size="sm"
            value={draft.reviewProvider}
            onChange={onReviewProviderChange}
            options={[
              { value: '', label: t('settings.reviewProviderSame') },
              ...openaiProviders.map((p) => ({ value: p.name, label: p.name })),
              ...cliOptions,
            ]}
          />
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
