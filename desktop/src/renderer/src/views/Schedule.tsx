import React from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Input, SegmentedControl, Spinner, Switch } from '../ds';
import { useStore } from '../store';
import {
  buildCron,
  describeCron,
  parseCron,
  parseTime,
  timeString,
  weekdayShort,
} from '../cronText';
import type {
  ScheduledTaskDTO,
  ScheduleRunDTO,
  ScheduleSavePayload,
} from '../../../shared/protocol';
import { resolveDatePlaceholders, hasDatePlaceholder } from '../../../shared/placeholders';

/**
 * 定时任务视图（PRD-schedule）：日历（未来触发点 + 历史 run 叠加）+ 任务列表 +
 * 创建/编辑表单。触发宿主在 engine；本视图只做 CRUD / Run now / 打开 run 的 session。
 */

/* ───────── 日期工具（全本地时区） ───────── */

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const statusTone: Record<ScheduleRunDTO['status'], string> = {
  ok: 'var(--status-done)',
  failed: 'var(--status-dead)',
  skipped: 'var(--text-tertiary)',
  catchUp: 'var(--status-running)',
};

const FUTURE_TONE = 'var(--status-watch)';

const statusLabelKey = {
  ok: 'schedule.statusOk',
  failed: 'schedule.statusFailed',
  skipped: 'schedule.statusSkipped',
  catchUp: 'schedule.statusCatchUp',
} as const;

export function Schedule() {
  const { t, i18n } = useTranslation();
  const schedule = useStore((s) => s.schedule);
  const loadSchedule = useStore((s) => s.loadSchedule);
  const createSchedule = useStore((s) => s.createSchedule);
  const updateSchedule = useStore((s) => s.updateSchedule);
  const deleteSchedule = useStore((s) => s.deleteSchedule);
  const runNow = useStore((s) => s.runScheduleNow);

  const [editing, setEditing] = React.useState<ScheduledTaskDTO | 'new' | null>(null);
  const [prefillAt, setPrefillAt] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  const openNew = (at?: string) => {
    setPrefillAt(at);
    setEditing('new');
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-window)',
      }}
    >
      <div
        className="pith-toolbar titlebar-drag"
        style={{
          flex: 'none',
          height: 'var(--titlebar-h)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 18px',
        }}
      >
        <CalendarClock size={17} style={{ color: 'var(--text-secondary)' }} />
        <span
          style={{ fontSize: 'var(--text-callout)', fontWeight: 600, color: 'var(--text-primary)' }}
        >
          {t('schedule.title')}
        </span>
        <div style={{ marginLeft: 'auto' }} className="titlebar-no-drag">
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus size={14} />}
            onClick={() => openNew()}
          >
            {t('schedule.newTask')}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div
          style={{
            maxWidth: 880,
            margin: '0 auto',
            padding: '28px 36px 64px',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 'var(--text-title-1)',
                fontWeight: 700,
                letterSpacing: 'var(--tracking-tight)',
                color: 'var(--text-primary)',
              }}
            >
              {t('schedule.title')}
            </h1>
            <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-tertiary)' }}>
              {t('schedule.subtitle')}
            </span>
          </div>

          <CalendarPanel tasks={schedule} locale={i18n.language} onPickDay={openNew} />

          {schedule.length === 0 ? (
            <div
              style={{
                padding: '40px 0',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--text-subhead)',
              }}
            >
              {t('schedule.noTasks')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {schedule.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  locale={i18n.language}
                  onEdit={() => setEditing(task)}
                  onDelete={() => {
                    if (window.confirm(t('schedule.confirmDelete', { name: task.title })))
                      void deleteSchedule(task.id);
                  }}
                  onRunNow={() => void runNow(task.id)}
                  onToggle={(enabled) => void updateSchedule(task.id, toPayload(task, { enabled }))}
                />
              ))}
            </div>
          )}

          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)', margin: 0 }}>
            {t('schedule.closedAppHint')}
          </p>
        </div>
      </div>

      {editing && (
        <TaskForm
          task={editing === 'new' ? null : editing}
          prefillAt={editing === 'new' ? prefillAt : undefined}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (editing === 'new') await createSchedule(payload);
            else await updateSchedule(editing.id, payload);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/* ───────── 月历 ───────── */

function CalendarPanel({
  tasks,
  locale,
  onPickDay,
}: {
  tasks: ScheduledTaskDTO[];
  locale: string;
  onPickDay: (atLocal: string) => void;
}) {
  const { t } = useTranslation();
  const selectSession = useStore((s) => s.selectSession);
  const setNav = useStore((s) => s.setNav);
  const [view, setView] = React.useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  // 收集每天的标记：未来触发（FUTURE_TONE）+ 历史 run（按状态色，带 sessionId）
  const marks = React.useMemo(() => {
    const map = new Map<string, { tone: string; sessionId?: string; label: string }[]>();
    const add = (iso: string, tone: string, label: string, sessionId?: string) => {
      const d = new Date(iso);
      const k = dayKey(d);
      const arr = map.get(k) ?? [];
      arr.push({ tone, sessionId, label });
      map.set(k, arr);
    };
    for (const task of tasks) {
      for (const f of task.upcomingFires)
        add(f, FUTURE_TONE, `${task.title} · ${fmtTime(f, locale)}`);
      for (const r of task.runs) {
        if (r.sessionId)
          add(r.firedAt, statusTone[r.status], `${task.title} · ${r.status}`, r.sessionId);
        else add(r.firedAt, statusTone[r.status], `${task.title} · ${r.status}`);
      }
    }
    return map;
  }, [tasks, locale]);

  const monthLabel = view.toLocaleDateString(locale, { year: 'numeric', month: 'long' });
  const cells = monthCells(view);
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(2024, 5, 2 + i))); // 2024-06-02 is Sunday
  const today = dayKey(new Date());

  return (
    <Card style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-callout)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            textTransform: 'capitalize',
          }}
        >
          {monthLabel}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          >
            <ChevronLeft size={15} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            {t('time.now')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {weekdays.map((w) => (
          <div
            key={w}
            style={{
              textAlign: 'center',
              fontSize: 'var(--text-caption)',
              color: 'var(--text-tertiary)',
              padding: '2px 0',
            }}
          >
            {w}
          </div>
        ))}
        {cells.map((cell) => {
          const k = dayKey(cell.date);
          const dayMarks = marks.get(k) ?? [];
          return (
            <button
              key={k}
              type="button"
              onClick={() =>
                onPickDay(
                  `${k.split('-')[0]}-${pad(cell.date.getMonth() + 1)}-${pad(cell.date.getDate())}T09:00`,
                )
              }
              title={dayMarks.map((m) => m.label).join('\n')}
              style={{
                minHeight: 56,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                padding: 6,
                borderRadius: 'var(--radius-sm)',
                background: k === today ? 'var(--surface-hover)' : 'transparent',
                opacity: cell.inMonth ? 1 : 0.35,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 'var(--text-caption)',
                  color: k === today ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: k === today ? 700 : 400,
                }}
              >
                {cell.date.getDate()}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {dayMarks.slice(0, 6).map((m, i) => (
                  <span
                    key={i}
                    onClick={(e) => {
                      if (!m.sessionId) return;
                      e.stopPropagation();
                      void selectSession(m.sessionId);
                      setNav('chat');
                    }}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: m.tone,
                      cursor: m.sessionId ? 'pointer' : 'default',
                    }}
                  />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
        <Legend tone={FUTURE_TONE} label={t('schedule.nextFire')} />
        <Legend tone={statusTone.ok} label={t('schedule.statusOk')} />
        <Legend tone={statusTone.failed} label={t('schedule.statusFailed')} />
        <Legend tone={statusTone.catchUp} label={t('schedule.statusCatchUp')} />
        <Legend tone={statusTone.skipped} label={t('schedule.statusSkipped')} />
      </div>
    </Card>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 'var(--text-caption)',
        color: 'var(--text-tertiary)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone }} />
      {label}
    </span>
  );
}

/* ───────── 任务行 ───────── */

function TaskRow({
  task,
  locale,
  onEdit,
  onDelete,
  onRunNow,
  onToggle,
}: {
  task: ScheduledTaskDTO;
  locale: string;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectSession = useStore((s) => s.selectSession);
  const setNav = useStore((s) => s.setNav);
  const [open, setOpen] = React.useState(false);

  return (
    <Card style={{ padding: 14, opacity: task.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 'var(--text-callout)',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {task.title}
            </span>
            <Badge tone={task.enabled ? 'done' : 'neutral'}>
              {task.enabled ? t('schedule.enabled') : t('schedule.paused')}
            </Badge>
          </div>
          <div
            style={{
              fontSize: 'var(--text-subhead)',
              color: 'var(--text-secondary)',
              marginTop: 2,
            }}
          >
            {task.schedule.kind === 'once'
              ? `${t('schedule.once')} · ${new Date(task.schedule.at).toLocaleString(locale)}`
              : `${describeCron(task.schedule.expr, locale)} · ${task.schedule.tz}`}
          </div>
          <div
            style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}
          >
            {t('schedule.nextFire')}:{' '}
            {task.nextFire ? fmtDateTime(task.nextFire, locale) : t('schedule.never')}
            {task.runCount > 0 && (
              <>
                {'  ·  '}
                <button type="button" onClick={() => setOpen((o) => !o)} style={linkBtn}>
                  {t('schedule.runHistory')} ({task.runCount})
                </button>
              </>
            )}
          </div>
        </div>
        <Switch checked={task.enabled} onChange={onToggle} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <Button variant="secondary" size="sm" iconLeft={<Play size={13} />} onClick={onRunNow}>
          {t('schedule.runNow')}
        </Button>
        <Button variant="ghost" size="sm" iconLeft={<Pencil size={13} />} onClick={onEdit}>
          {t('schedule.edit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Trash2 size={13} />}
          onClick={onDelete}
          style={{ color: 'var(--status-dead)' }}
        >
          {t('schedule.delete')}
        </Button>
      </div>

      {open && (
        <div
          style={{
            marginTop: 12,
            borderTop: '0.5px solid var(--separator)',
            paddingTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {task.runs.length === 0 && (
            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
              {t('schedule.noRuns')}
            </span>
          )}
          {task.runs.map((r) => (
            <div
              key={r.runId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 'var(--text-caption)',
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: statusTone[r.status],
                  flex: 'none',
                }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>
                {fmtDateTime(r.firedAt, locale)}
              </span>
              <span style={{ color: 'var(--text-tertiary)' }}>{t(statusLabelKey[r.status])}</span>
              {r.preview && (
                <span
                  style={{
                    color: 'var(--text-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  — {r.preview}
                </span>
              )}
              {r.error && (
                <span
                  style={{
                    color: 'var(--status-dead)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  — {r.error}
                </span>
              )}
              {r.sessionId && (
                <button
                  type="button"
                  onClick={() => {
                    void selectSession(r.sessionId);
                    setNav('chat');
                  }}
                  style={linkBtn}
                >
                  {t('schedule.openSession')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ───────── 创建/编辑表单 ───────── */

function TaskForm({
  task,
  prefillAt,
  onClose,
  onSave,
}: {
  task: ScheduledTaskDTO | null;
  prefillAt?: string;
  onClose: () => void;
  onSave: (payload: ScheduleSavePayload) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [input, setInput] = React.useState(task?.input ?? '');
  const [title, setTitle] = React.useState(task?.title ?? '');
  const [kind, setKind] = React.useState<'once' | 'cron'>(task?.schedule.kind ?? 'once');
  const [at, setAt] = React.useState(
    task?.schedule.kind === 'once' ? isoToLocalInput(task.schedule.at) : (prefillAt ?? ''),
  );
  const [cron, setCron] = React.useState(
    task?.schedule.kind === 'cron' ? task.schedule.expr : '0 9 * * *',
  );
  const [tz] = React.useState(task?.schedule.kind === 'cron' ? task.schedule.tz : systemTz());
  const [catchUp, setCatchUp] = React.useState(task?.catchUp ?? true);
  const [requireApproval, setRequireApproval] = React.useState(task?.requireApproval ?? false);
  const [review, setReview] = React.useState(task?.review ?? false);
  const [enabled, setEnabled] = React.useState(task?.enabled ?? true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const cronInvalid = kind === 'cron' && cron.trim().split(/\s+/).length !== 5;
  const canSave = input.trim().length > 0 && (kind === 'once' ? at.length > 0 : !cronInvalid);

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const schedule: ScheduleSavePayload['schedule'] =
        kind === 'once'
          ? { kind: 'once', at: new Date(at).toISOString() }
          : { kind: 'cron', expr: cron.trim(), tz };
      await onSave({
        input: input.trim(),
        title: title.trim() || undefined,
        schedule,
        enabled,
        catchUp,
        requireApproval,
        review,
      });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--scrim, rgba(0,0,0,0.35))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 540 }}>
        <Card
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            maxHeight: '82vh',
            overflowY: 'auto',
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-headline)',
              fontWeight: 700,
              color: 'var(--text-primary)',
            }}
          >
            {task ? t('schedule.edit') : t('schedule.newTask')}
          </span>

          <Field label={t('schedule.formInput')} hint={t('schedule.placeholderHint')}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('schedule.formInputPlaceholder')}
              rows={3}
              style={textareaStyle}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              <button
                type="button"
                style={chipStyle}
                onClick={() => setInput((v) => `${v}\${yyyy-mm-dd}`)}
              >
                {t('schedule.insertToday')}
              </button>
              <button
                type="button"
                style={chipStyle}
                onClick={() => setInput((v) => `${v}\${yyyy-mm-dd -1}`)}
              >
                {t('schedule.insertYesterday')}
              </button>
            </div>
            {hasDatePlaceholder(input) && (
              <div
                style={{
                  marginTop: 4,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--status-brand-soft, var(--surface-sunken))',
                  fontSize: 'var(--text-caption)',
                  color: 'var(--text-secondary)',
                }}
              >
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {t('schedule.previewToday')}：
                </span>
                {resolveDatePlaceholders(input, new Date())}
              </div>
            )}
          </Field>

          <Field label={t('schedule.formTitle')}>
            <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          </Field>

          <Field label={t('schedule.formKind')}>
            <SegmentedControl
              value={kind}
              onChange={(v) => setKind(v as 'once' | 'cron')}
              options={[
                { value: 'once', label: t('schedule.once') },
                { value: 'cron', label: t('schedule.cron') },
              ]}
            />
          </Field>

          {kind === 'once' ? (
            <Field label={t('schedule.at')}>
              <input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                style={textInputStyle}
              />
            </Field>
          ) : (
            <CronBuilder value={cron} onChange={setCron} tz={tz} invalid={cronInvalid} />
          )}

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-primary)' }}>
                {t('schedule.catchUp')}
              </span>
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
                {t('schedule.catchUpHint')}
              </span>
            </span>
            <Switch checked={catchUp} onChange={setCatchUp} />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-primary)' }}>
                {t('schedule.requireApproval')}
              </span>
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
                {t('schedule.requireApprovalHint')}
              </span>
            </span>
            <Switch checked={requireApproval} onChange={setRequireApproval} />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-primary)' }}>
                {t('schedule.review')}
              </span>
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
                {t('schedule.reviewHint')}
              </span>
            </span>
            <Switch checked={review} onChange={setReview} />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--text-primary)' }}>
              {t('schedule.enabled')}
            </span>
            <Switch checked={enabled} onChange={setEnabled} />
          </label>

          {err && (
            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--status-dead)' }}>
              {err}
            </span>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <Button variant="ghost" onClick={onClose}>
              {t('schedule.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave || busy} onClick={() => void submit()}>
              {busy ? <Spinner size={13} /> : t('schedule.save')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ───────── cron 友好编辑器 ───────── */

type Freq = 'daily' | 'weekly' | 'monthly' | 'custom';

function CronBuilder({
  value,
  onChange,
  tz,
  invalid,
}: {
  value: string;
  onChange: (cron: string) => void;
  tz: string;
  invalid: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const initial = React.useMemo(() => parseCron(value), [value]);

  const [freq, setFreq] = React.useState<Freq>(initial?.freq ?? 'custom');
  const [hour, setHour] = React.useState(initial ? initial.hour : 9);
  const [minute, setMinute] = React.useState(initial ? initial.minute : 0);
  const [days, setDays] = React.useState<number[]>(initial?.freq === 'weekly' ? initial.days : [1]);
  const [dom, setDom] = React.useState(initial?.freq === 'monthly' ? initial.dom : 1);
  const [raw, setRaw] = React.useState(value);

  const composed = (): string => {
    if (freq === 'daily') return buildCron({ freq: 'daily', hour, minute });
    if (freq === 'weekly')
      return buildCron({ freq: 'weekly', hour, minute, days: days.length ? days : [1] });
    if (freq === 'monthly') return buildCron({ freq: 'monthly', hour, minute, dom });
    return raw;
  };

  // 结构化档位：任何子项变化都重算 cron 上报；custom 由 raw 驱动。
  // （deps 仅列结构化输入；onChange 来自父组件 setState，引用稳定。）
  React.useEffect(() => {
    if (freq === 'custom') return;
    onChange(composed());
  }, [freq, hour, minute, days, dom]);

  const time = timeString(hour, minute);
  const onTime = (v: string) => {
    const p = parseTime(v);
    setHour(p.hour);
    setMinute(p.minute);
  };
  // 至少保留一个星期（避免空选导致语义漂移成「每天」）
  const toggleDay = (d: number) =>
    setDays((cur) =>
      cur.includes(d) ? (cur.length > 1 ? cur.filter((x) => x !== d) : cur) : [...cur, d],
    );

  const preview = describeCron(composed(), lang);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span
        style={{ fontSize: 'var(--text-subhead)', fontWeight: 600, color: 'var(--text-secondary)' }}
      >
        {t('schedule.formKind')}
      </span>
      <SegmentedControl
        value={freq}
        size="sm"
        onChange={(v) => {
          if (v === 'custom') setRaw(composed());
          setFreq(v as Freq);
        }}
        options={[
          { value: 'daily', label: t('schedule.freqDaily') },
          { value: 'weekly', label: t('schedule.freqWeekly') },
          { value: 'monthly', label: t('schedule.freqMonthly') },
          { value: 'custom', label: t('schedule.freqCustom') },
        ]}
      />

      {freq === 'weekly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('schedule.onWeekdays')}
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  style={{
                    minWidth: 38,
                    height: 30,
                    padding: '0 8px',
                    borderRadius: 'var(--radius-control)',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 'var(--text-subhead)',
                    fontWeight: on ? 600 : 400,
                    color: on ? '#fff' : 'var(--text-secondary)',
                    background: on ? 'var(--accent)' : 'var(--surface-sunken)',
                    boxShadow: on ? 'none' : 'var(--ring-control)',
                  }}
                >
                  {weekdayShort(d, lang)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {freq === 'monthly' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('schedule.dayOfMonth')}
          </span>
          <select value={dom} onChange={(e) => setDom(Number(e.target.value))} style={selectStyle}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
                {t('schedule.dayOfMonthUnit')}
              </option>
            ))}
          </select>
        </div>
      )}

      {freq === 'custom' ? (
        <Field label={t('schedule.cronExpr')} hint={t('schedule.cronHint')}>
          <Input
            value={raw}
            onChange={(e) => {
              setRaw(e.currentTarget.value);
              onChange(e.currentTarget.value);
            }}
            invalid={invalid}
          />
        </Field>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
            {t('schedule.atTime')}
          </span>
          <input
            type="time"
            value={time}
            onChange={(e) => onTime(e.target.value)}
            style={selectStyle}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 'var(--radius-control)',
          background: 'var(--status-brand-soft, var(--surface-sunken))',
          fontSize: 'var(--text-subhead)',
          color: 'var(--text-primary)',
        }}
      >
        <span style={{ fontWeight: 600 }}>{preview}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 'var(--text-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          {composed()} · {tz}
        </span>
      </div>
    </div>
  );
}

/* ───────── helpers ───────── */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span
        style={{ fontSize: 'var(--text-subhead)', fontWeight: 600, color: 'var(--text-secondary)' }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-tertiary)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  padding: '2px 10px',
  height: 24,
  borderRadius: 'var(--radius-control)',
  border: 'none',
  cursor: 'pointer',
  fontSize: 'var(--text-caption)',
  color: 'var(--text-secondary)',
  background: 'var(--surface-sunken)',
  boxShadow: 'var(--ring-control)',
};

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--accent, var(--status-watch))',
  fontSize: 'inherit',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  padding: '8px 12px',
  background: 'var(--surface-sunken)',
  border: 'none',
  borderRadius: 'var(--radius-control)',
  boxShadow: 'var(--ring-control)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-subhead)',
  fontFamily: 'inherit',
  outline: 'none',
};

const textInputStyle: React.CSSProperties = {
  height: 'var(--control-h-md)',
  padding: '0 12px',
  background: 'var(--surface-sunken)',
  border: 'none',
  borderRadius: 'var(--radius-control)',
  boxShadow: 'var(--ring-control)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-subhead)',
  fontFamily: 'inherit',
  outline: 'none',
};

const selectStyle: React.CSSProperties = {
  height: 'var(--control-h-md)',
  padding: '0 10px',
  background: 'var(--surface-sunken)',
  border: 'none',
  borderRadius: 'var(--radius-control)',
  boxShadow: 'var(--ring-control)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-subhead)',
  fontFamily: 'inherit',
  outline: 'none',
};

function monthCells(monthStart: Date): { date: Date; inMonth: boolean }[] {
  const firstWeekday = monthStart.getDay(); // 0=Sun
  const start = new Date(monthStart);
  start.setDate(1 - firstWeekday);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d, inMonth: d.getMonth() === monthStart.getMonth() };
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

function fmtDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function systemTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 把现有 task + 局部改动拼成完整 save payload（toggle 启停用）。 */
function toPayload(
  task: ScheduledTaskDTO,
  patch: Partial<ScheduleSavePayload>,
): ScheduleSavePayload {
  return {
    input: task.input,
    title: task.title,
    schedule: task.schedule,
    enabled: task.enabled,
    catchUp: task.catchUp,
    requireApproval: task.requireApproval,
    review: task.review,
    ...patch,
  };
}
