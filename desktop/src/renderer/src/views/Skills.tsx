import React from 'react';
import { Blocks, Check, Copy, FlaskConical, KeyRound, Terminal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Input, Spinner } from '../ds';
import { useStore } from '../store';
import type {
  SkillCardDTO,
  SkillEnvDTO,
  SkillReqDTO,
  SkillTestResultDTO,
} from '../../../shared/protocol';

/**
 * 技能管理页（PRD-desktop-skill-manager）：策展的 bundled 建议清单 + 安装状态。
 * 点安装 = 复制 bundled → skillDirs[0] 并全量重建（重置当前会话）；已装且声明
 * auth_env 的 skill 在卡片内联配置 appkey（写 config.json secrets + process.env，即时生效，不重建）。
 */
export function Skills() {
  const { t } = useTranslation();
  const skills = useStore((s) => s.skills);
  const skillsBusy = useStore((s) => s.skillsBusy);
  const installSkill = useStore((s) => s.installSkill);
  const removeSkill = useStore((s) => s.removeSkill);

  const onUninstall = (name: string) => {
    if (window.confirm(t('skills.confirmUninstall', { name }))) void removeSkill(name);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-window)' }}>
      <div
        className="pith-toolbar titlebar-drag"
        style={{ flex: 'none', height: 'var(--titlebar-h)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        <Blocks size={17} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('skills.title')}</span>
        {skillsBusy && <Spinner size={13} />}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 36px 64px', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1 style={{ margin: 0, fontSize: 'var(--text-title-1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text-primary)' }}>
              {t('skills.title')}
            </h1>
            <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-tertiary)' }}>{t('skills.subtitle')}</span>
          </div>

          {skills.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-subhead)' }}>
              {t('skills.empty')}
            </div>
          ) : (
            skills.map((sk) => <SkillCard key={sk.name} skill={sk} busy={skillsBusy} onInstall={() => void installSkill(sk.name)} onUninstall={() => onUninstall(sk.name)} />)
          )}
        </div>
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  busy,
  onInstall,
  onUninstall,
}: {
  skill: SkillCardDTO;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  const needsKey = skill.installed && skill.requiredEnv.some((e) => !e.set);
  const needsBin = skill.requires.some((r) => !r.present);

  return (
    <Card padding="0">
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}>{skill.name}</span>
            <Badge tone={skill.installed ? 'done' : 'neutral'} dot>
              {skill.installed ? t('skills.installed') : t('skills.available')}
            </Badge>
            {needsKey && <Badge tone="running">{t('skills.needsKey')}</Badge>}
            {needsBin && <Badge tone="running">{t('skills.needsBin')}</Badge>}
          </div>
          <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{skill.description}</span>
        </div>
        <div style={{ flex: 'none' }}>
          {skill.installed ? (
            <Button size="sm" variant="ghost" iconLeft={<Trash2 size={13} />} disabled={busy} onClick={onUninstall}>
              {busy ? t('skills.uninstalling') : t('skills.uninstall')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={busy} onClick={onInstall}>
              {busy ? t('skills.installing') : t('skills.install')}
            </Button>
          )}
        </div>
      </div>

      {/* 声明了 requires（CLI 集成型）→ 显示依赖二进制状态 + 安装/认证提示 */}
      {skill.requires.length > 0 && (
        <div style={{ borderTop: '0.5px solid var(--separator)', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {skill.requires.map((req) => (
            <ReqField key={req.bin} req={req} />
          ))}
          {needsBin && <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>{t('skills.cliAuthHint')}</span>}
        </div>
      )}

      {/* 已安装且声明了 auth_env → 内联配置 appkey */}
      {skill.installed && skill.requiredEnv.length > 0 && (
        <div style={{ borderTop: '0.5px solid var(--separator)', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {skill.requiredEnv.map((env) => (
            <EnvField key={env.name} env={env} />
          ))}
        </div>
      )}

      {/* 已安装且声明了自测探针 → 就地「测试」按钮（闭环验证是否可用） */}
      {skill.installed && skill.testable && <TestSection name={skill.name} />}
    </Card>
  );
}

/** 技能自测：点一下跑 skill 声明的探针，就地显示可用 / 不可用 + 原因。 */
function TestSection({ name }: { name: string }) {
  const { t } = useTranslation();
  const testSkill = useStore((s) => s.testSkill);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<SkillTestResultDTO | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await testSkill(name));
    } catch (e) {
      setResult({ ok: false, detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '0.5px solid var(--separator)', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Button
        size="sm"
        variant="secondary"
        iconLeft={busy ? <Spinner size={12} /> : <FlaskConical size={13} />}
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? t('skills.testing') : t('skills.test')}
      </Button>
      {result && (
        <>
          <Badge tone={result.ok ? 'done' : 'dead'} dot>
            {result.ok ? t('skills.testPass') : t('skills.testFail')}
          </Badge>
          {result.detail && (
            <code
              style={{
                fontSize: 'var(--text-caption)',
                color: 'var(--text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
              title={result.detail}
            >
              {result.detail}
            </code>
          )}
        </>
      )}
    </div>
  );
}

function ReqField({ req }: { req: SkillReqDTO }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    if (!req.install) return;
    window.pith.copyText(req.install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Terminal size={14} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
      <code style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', flex: 'none' }}>{req.bin}</code>
      <Badge tone={req.present ? 'done' : 'running'} dot>
        {req.present ? t('skills.binPresent') : t('skills.binMissing')}
      </Badge>
      {!req.present && req.install && (
        <button
          type="button"
          onClick={copy}
          title={t('skills.copyInstall')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            cursor: 'pointer',
            padding: '3px 8px',
            borderRadius: 'var(--radius-xs)',
            background: 'var(--surface-sunken)',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 'var(--text-caption)',
            maxWidth: '100%',
            minWidth: 0,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req.install}</span>
          {copied ? <Check size={12} style={{ flex: 'none' }} /> : <Copy size={12} style={{ flex: 'none', opacity: 0.6 }} />}
        </button>
      )}
    </div>
  );
}

function EnvField({ env }: { env: SkillEnvDTO }) {
  const { t } = useTranslation();
  const setSkillEnv = useStore((s) => s.setSkillEnv);
  const [val, setVal] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (clear: boolean) => {
    setBusy(true);
    try {
      await setSkillEnv(env.name, clear ? '' : val);
      setVal('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <KeyRound size={14} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
      <code style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', flex: 'none', minWidth: 130 }}>{env.name}</code>
      <Badge tone={env.set ? 'done' : 'running'} dot>
        {env.set ? t('skills.keyConfigured') : t('skills.keyNotConfigured')}
      </Badge>
      <Input
        size="sm"
        type="password"
        autoComplete="off"
        placeholder={t('skills.keyPlaceholder', { name: env.name })}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && val.trim() && !busy) void submit(false);
        }}
        invalid={!env.set && !val}
        wrapStyle={{ flex: 1 }}
      />
      <Button size="sm" variant="secondary" iconLeft={<Check size={13} />} disabled={busy || !val.trim()} onClick={() => void submit(false)}>
        {t('skills.save')}
      </Button>
      {env.set && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit(true)}>
          {t('skills.clear')}
        </Button>
      )}
    </div>
  );
}
