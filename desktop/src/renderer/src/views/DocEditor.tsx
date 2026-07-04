import React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../ds';

/** 一键套用的预设(SOUL 风格 / REVIEW 标准);内容按 UI 语言给两份。 */
export interface DocPreset {
  key: string;
  label: { zh: string; en: string };
  body: { zh: string; en: string };
}

export interface DocEditorProps {
  title: string;
  desc: string;
  presetHint: string;
  presets: DocPreset[];
  placeholder: string;
  saveLabel: string;
  savingLabel: string;
  savedLabel: string;
  /** 读当前内容 + 落盘路径(store action,引用稳定)。 */
  load: () => Promise<{ content: string; path: string }>;
  /** 保存(会触发 Engine 重建)。 */
  save: (content: string) => Promise<void>;
}

/**
 * 可编辑 markdown 文档区块——SOUL.md / REVIEW.md 共用。
 * 载入即读盘;预设 chip 一键套入草稿;dirty 才可保存;保存后显示已保存;底部显示落盘路径。
 */
export function DocEditor(props: DocEditorProps) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [saved, setSaved] = React.useState<string | null>(null); // 已保存基线(dirty 比对)
  const [draft, setDraft] = React.useState('');
  const [docPath, setDocPath] = React.useState('');
  const [loading, setLoading] = React.useState(true); // 首次读盘中——此时禁用编辑,避免打字被 load 覆盖
  const [saving, setSaving] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = props.load;
  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!alive) return;
        setSaved(d.content);
        setDraft(d.content);
        setDocPath(d.path);
      })
      .catch((err: unknown) => {
        // 读盘失败:不留在"永远空白且不可编辑"的死态,允许从空稿开始编辑并提示原因。
        if (!alive) return;
        setSaved('');
        setError(t('settings.docLoadFailed', { error: (err as Error).message }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load, t]);

  const dirty = saved !== null && draft.trim() !== saved.trim();
  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await props.save(draft);
      setSaved(draft.trim());
      setDone(true);
    } catch (err) {
      // 保存失败必须冒泡:否则按钮静默重新可用,用户以为存进去了其实没有。
      setError(t('settings.docSaveFailed', { error: (err as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="pith-eyebrow">{props.title}</span>
      <Card padding="0" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{props.desc}</div>
          {props.presets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-quaternary)' }}>
                {props.presetHint}
              </span>
              {props.presets.map((p) => {
                const body = zh ? p.body.zh : p.body.en;
                const active = draft.trim() === body.trim();
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      setDraft(body);
                      setDone(false);
                      setError(null);
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: 'var(--text-caption)',
                      fontWeight: 'var(--weight-semibold)',
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-pill)',
                      border: `0.5px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
                      background: active ? 'var(--accent-soft)' : 'var(--surface-card)',
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    }}
                  >
                    {zh ? p.label.zh : p.label.en}
                  </button>
                );
              })}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDone(false);
              setError(null);
            }}
            placeholder={loading ? t('settings.loading') : props.placeholder}
            spellCheck={false}
            disabled={loading}
            rows={10}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 160,
              padding: '12px 14px',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-body)',
              lineHeight: 'var(--leading-normal)',
              color: 'var(--text-primary)',
              background: 'var(--surface-sunken)',
              border: '0.5px solid var(--border-control)',
              borderRadius: 'var(--radius-control)',
              outline: 'none',
              opacity: loading ? 0.5 : 1,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              title={docPath}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 'var(--text-caption)',
                color: 'var(--text-quaternary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {docPath}
            </span>
            {error && (
              <span
                style={{ fontSize: 'var(--text-caption)', color: 'var(--status-dead)' }}
              >
                {error}
              </span>
            )}
            {done && !dirty && !error && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-caption)', color: 'var(--status-done)' }}>
                <Check size={13} /> {props.savedLabel}
              </span>
            )}
            <Button size="sm" variant="primary" disabled={!dirty || saving || loading} onClick={() => void doSave()}>
              {saving ? props.savingLabel : props.saveLabel}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
