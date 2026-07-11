import { create } from 'zustand';
import type {
  BootstrapDTO,
  CollectionInfo,
  DashboardDTO,
  DisplayItem,
  EngineEvent,
  EntryDetail,
  EntryRefDTO,
  EntrySummary,
  GraphDTO,
  MentionTreeDTO,
  QueueDigestDTO,
  ScheduledTaskDTO,
  ScheduleSavePayload,
  ScopeDTO,
  SessionMeta,
  SettingsDTO,
  SettingsSaveDTO,
  SoulDTO,
  SkillCardDTO,
  SkillsDTO,
} from '../../shared/protocol';
import { bridge } from './bridge';
import i18n, { resolveLang, storedLangPref, type LangPref } from './i18n';

/* ───────── chat item model ───────── */

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; refs?: EntryRefDTO[]; browsed?: EntryRefDTO[] }
  | {
      id: string;
      kind: 'tool';
      name: string;
      argsPreview: string;
      ok: boolean | null;
      preview: string;
    }
  | {
      id: string;
      kind: 'approval';
      approvalId: string;
      approvalKind: 'write' | 'exec';
      path: string;
      preview: string;
      decided: 'yes' | 'no' | 'always' | null;
    }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'note'; text: string }
  | { id: string; kind: 'artifact'; path: string; name: string };

export interface SessionChat {
  items: ChatItem[];
  busy: boolean;
  activity: string | null;
  usage: { inTok: number; outTok: number };
  loaded: boolean;
}

export type Nav =
  | 'chat'
  | 'inbox'
  | 'dashboard'
  | 'library'
  | 'settings'
  | 'graph'
  | 'skills'
  | 'schedule';
export type Theme = 'light' | 'dark' | 'auto';

let seq = 0;
const nid = () => `i${++seq}`;

let bootstrapInFlight: Promise<void> | null = null;
let graphLoadedAt = 0;

const emptyChat = (): SessionChat => ({
  items: [],
  busy: false,
  activity: null,
  usage: { inTok: 0, outTok: 0 },
  loaded: false,
});

interface PithStore {
  boot: BootstrapDTO | null;
  engineReady: boolean;
  nav: Nav;
  theme: Theme;
  lang: LangPref;

  collections: CollectionInfo[];
  collection: string | null;
  entries: EntrySummary[];
  entryId: string | null;
  entry: EntryDetail | null;
  /** `@`-mention 引用选择器的目录树（engine 下发）。null = 未加载 → 不弹选择器。 */
  mentionTree: MentionTreeDTO | null;

  sessions: SessionMeta[];
  activeSession: string | null;
  chat: Record<string, SessionChat>;
  /** Reader「在聊天中打开」预填的 composer 草稿。 */
  composerDraft: string | null;

  queue: QueueDigestDTO | null;
  dash: DashboardDTO | null;
  settings: SettingsDTO | null;
  graph: GraphDTO | null;
  skills: SkillCardDTO[];
  skillsBusy: boolean;
  schedule: ScheduledTaskDTO[];
  notices: { id: string; level: string; text: string }[];

  /* actions */
  setTheme(t: Theme): void;
  setLang(l: LangPref): void;
  setNav(nav: Nav): void;
  bootstrap(): Promise<void>;
  refreshCollections(): Promise<void>;
  refreshMentionTree(): Promise<void>;
  openCollection(id: string): Promise<void>;
  openEntry(id: string, collection?: string): Promise<void>;
  refreshSessions(): Promise<void>;
  newSession(): Promise<void>;
  selectSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setSessionReviewMode(id: string, on: boolean): Promise<void>;
  send(text: string, scope?: ScopeDTO): Promise<void>;
  abort(): void;
  answerApproval(approvalId: string, answer: 'yes' | 'no' | 'always'): void;
  resetSession(): Promise<void>;
  digestSession(collection?: string): Promise<void>;
  refreshQueue(): Promise<void>;
  retryDead(): Promise<void>;
  clearDead(): Promise<void>;
  refreshDashboard(): Promise<void>;
  loadSettings(): Promise<void>;
  loadGraph(force?: boolean): Promise<void>;
  saveSettings(payload: SettingsSaveDTO): Promise<void>;
  getSoul(): Promise<SoulDTO>;
  saveSoul(content: string): Promise<void>;
  getReview(): Promise<SoulDTO>;
  saveReview(content: string): Promise<void>;
  switchProvider(name: string): Promise<void>;
  setHydrationProvider(name: string): Promise<void>;
  setReviewProvider(name: string): Promise<void>;
  loadSkills(): Promise<void>;
  installSkill(name: string): Promise<void>;
  removeSkill(name: string): Promise<void>;
  setSkillEnv(key: string, value: string): Promise<void>;
  loadSchedule(): Promise<void>;
  createSchedule(payload: ScheduleSavePayload): Promise<void>;
  updateSchedule(id: string, payload: ScheduleSavePayload): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  runScheduleNow(id: string): Promise<void>;
  saveOnboarding(p: {
    provider: string;
    baseURL: string;
    model: string;
    apiKey: string;
  }): Promise<void>;
  openInChat(entry: EntryDetail): void;
  dismissNotice(id: string): void;
  handleEvent(evt: EngineEvent): void;
}

export const useStore = create<PithStore>((set, get) => {
  /** 不可变地更新某个会话的 chat 切片。 */
  const patchChat = (sessionId: string, fn: (c: SessionChat) => SessionChat) =>
    set((s) => ({ chat: { ...s.chat, [sessionId]: fn(s.chat[sessionId] ?? emptyChat()) } }));

  const pushItem = (sessionId: string, item: ChatItem) =>
    patchChat(sessionId, (c) => ({ ...c, items: [...c.items, item] }));

  return {
    boot: null,
    engineReady: false,
    nav: 'chat',
    theme: (localStorage.getItem('pith-theme') as Theme) || 'auto',
    lang: storedLangPref(),

    collections: [],
    collection: null,
    entries: [],
    entryId: null,
    entry: null,
    mentionTree: null,

    sessions: [],
    activeSession: null,
    chat: {},
    composerDraft: null,

    queue: null,
    dash: null,
    settings: null,
    graph: null,
    skills: [],
    skillsBusy: false,
    schedule: [],
    notices: [],

    setTheme(t) {
      localStorage.setItem('pith-theme', t);
      set({ theme: t });
    },

    setLang(l) {
      localStorage.setItem('pith-lang', l);
      set({ lang: l });
      void i18n.changeLanguage(resolveLang(l));
    },

    setNav(nav) {
      set({ nav });
      if (nav === 'inbox') void get().refreshQueue();
      if (nav === 'dashboard') void get().refreshDashboard();
      if (nav === 'settings') void get().loadSettings();
      if (nav === 'graph') void get().loadGraph();
      if (nav === 'skills') void get().loadSkills();
      if (nav === 'schedule') void get().loadSchedule();
    },

    async bootstrap() {
      // 闩锁：main.tsx 的主动调用与 engine.ready 事件可能并发触发，两次
      // bootstrap 会各建一个空会话。复用同一个 in-flight promise。
      if (bootstrapInFlight) return bootstrapInFlight;
      bootstrapInFlight = (async () => {
        try {
          const boot = await bridge.request<BootstrapDTO>({ kind: 'app.bootstrap' });
          set({ boot, engineReady: true });
          await Promise.all([
            get().refreshCollections(),
            get().refreshSessions(),
            get().refreshQueue(),
          ]);
          // 默认进入聊天：没有会话则建一个
          if (get().sessions.length === 0 && !boot.needsOnboarding) {
            await get().newSession();
          } else if (get().sessions.length > 0 && !get().activeSession) {
            await get().selectSession(get().sessions[0].id);
          }
        } finally {
          bootstrapInFlight = null;
        }
      })();
      return bootstrapInFlight;
    },

    async refreshCollections() {
      const collections = await bridge.request<CollectionInfo[]>({ kind: 'library.collections' });
      set({ collections });
      // 引用选择器的目录树随库刷新（fire-and-forget，别拖慢集合加载）。
      void get().refreshMentionTree();
    },

    async refreshMentionTree() {
      try {
        const mentionTree = await bridge.request<MentionTreeDTO>({ kind: 'library.mentionTree' });
        set({ mentionTree });
      } catch {
        /* 非致命：拉不到树时选择器不弹，@ 仍可手打并在提交时解析 scope */
      }
    },

    async openCollection(id) {
      set({ collection: id, nav: 'library' });
      const entries = await bridge.request<EntrySummary[]>({
        kind: 'library.entries',
        collection: id,
      });
      set({ entries });
      if (entries.length > 0) await get().openEntry(entries[0].id, id);
      else set({ entry: null, entryId: null });
    },

    async openEntry(id, collection) {
      // 切到 Reader 视图并跳到该条目（聊天/图谱里点引用都能直达内容）
      set({ entryId: id, nav: 'library' });
      try {
        const entry = await bridge.request<EntryDetail>({ kind: 'library.entry', id, collection });
        set({ entry, entryId: entry.id });
        // 跨集合跳链接时同步中栏
        if (entry.collection !== get().collection) {
          set({ collection: entry.collection });
          const entries = await bridge.request<EntrySummary[]>({
            kind: 'library.entries',
            collection: entry.collection,
          });
          set({ entries });
        }
      } catch (err) {
        set((s) => ({
          notices: [...s.notices, { id: nid(), level: 'warning', text: (err as Error).message }],
        }));
      }
    },

    async refreshSessions() {
      const sessions = await bridge.request<SessionMeta[]>({ kind: 'session.list' });
      set({ sessions });
    },

    async newSession() {
      const meta = await bridge.request<SessionMeta>({ kind: 'session.create' });
      set((s) => ({
        sessions: [meta, ...s.sessions],
        activeSession: meta.id,
        nav: 'chat',
        chat: { ...s.chat, [meta.id]: { ...emptyChat(), loaded: true } },
      }));
    },

    async selectSession(id) {
      set({ activeSession: id, nav: 'chat' });
      if (get().chat[id]?.loaded) return;
      const { display } = await bridge.request<{ meta: SessionMeta; display: DisplayItem[] }>({
        kind: 'session.resume',
        sessionId: id,
      });
      const items: ChatItem[] = display.map((d) =>
        d.role === 'user'
          ? { id: nid(), kind: 'user', text: d.text }
          : d.role === 'assistant'
            ? { id: nid(), kind: 'assistant', text: d.text, refs: d.refs, browsed: d.browsed }
            : {
                id: nid(),
                kind: 'tool',
                name: d.name,
                argsPreview: d.argsPreview,
                ok: null,
                preview: d.resultPreview,
              },
      );
      patchChat(id, (c) => ({ ...c, items, loaded: true }));
    },

    async renameSession(id, title) {
      await bridge.request({ kind: 'session.rename', sessionId: id, title });
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
      }));
    },

    async setSessionReviewMode(id, on) {
      // 切换审稿模式：engine 重建该会话 agent（保留对话历史），回写 meta。
      // 失败要显式冒泡成通知——否则请求 reject 后开关静默不动，看起来"点不动"。
      try {
        const meta = await bridge.request<SessionMeta>({
          kind: 'session.setReviewMode',
          sessionId: id,
          reviewMode: on,
        });
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, reviewMode: meta.reviewMode } : x,
          ),
        }));
      } catch (err) {
        set((s) => ({
          notices: [
            ...s.notices,
            {
              id: nid(),
              level: 'error',
              text: i18n.t('chat.reviewToggleFailed', { error: (err as Error).message }),
            },
          ],
        }));
      }
    },

    async deleteSession(id) {
      await bridge.request({ kind: 'session.delete', sessionId: id });
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id);
        const chat = { ...s.chat };
        delete chat[id];
        return {
          sessions,
          chat,
          activeSession: s.activeSession === id ? (sessions[0]?.id ?? null) : s.activeSession,
        };
      });
    },

    async send(text, scope) {
      const sessionId = get().activeSession;
      if (!sessionId) return;
      pushItem(sessionId, { id: nid(), kind: 'user', text });
      patchChat(sessionId, (c) => ({ ...c, busy: true, activity: null }));
      await bridge.request({ kind: 'session.send', sessionId, text, scope });
      void get().refreshSessions();
    },

    abort() {
      const sessionId = get().activeSession;
      if (sessionId) void bridge.request({ kind: 'session.abort', sessionId });
    },

    answerApproval(approvalId, answer) {
      void bridge.request({ kind: 'approval.answer', approvalId, answer }).catch(() => {});
      // 乐观更新卡片状态；approvalSettled 事件会再对齐一次
      const sessionId = get().activeSession;
      if (!sessionId) return;
      patchChat(sessionId, (c) => ({
        ...c,
        items: c.items.map((it) =>
          it.kind === 'approval' && it.approvalId === approvalId ? { ...it, decided: answer } : it,
        ),
      }));
    },

    async resetSession() {
      const sessionId = get().activeSession;
      if (!sessionId) return;
      await bridge.request({ kind: 'session.reset', sessionId });
      patchChat(sessionId, () => ({ ...emptyChat(), loaded: true }));
      pushItem(sessionId, { id: nid(), kind: 'note', text: i18n.t('chat.noteReset') });
    },

    async digestSession(collection) {
      const sessionId = get().activeSession;
      if (!sessionId) return;
      pushItem(sessionId, { id: nid(), kind: 'note', text: i18n.t('chat.noteDigesting') });
      try {
        const r = await bridge.request<{ id: string; collection: string; title: string }>({
          kind: 'session.digest',
          sessionId,
          collection,
        });
        pushItem(sessionId, {
          id: nid(),
          kind: 'note',
          text: i18n.t('chat.noteDigestSaved', { path: `${r.collection}/${r.id}`, title: r.title }),
        });
        void get().refreshCollections();
      } catch (err) {
        pushItem(sessionId, {
          id: nid(),
          kind: 'error',
          text: i18n.t('chat.noteDigestFailed', { error: (err as Error).message }),
        });
      }
    },

    async refreshQueue() {
      try {
        const queue = await bridge.request<QueueDigestDTO>({ kind: 'queue.digest' });
        set({ queue });
      } catch {
        /* engine 未就绪 */
      }
    },

    async retryDead() {
      await bridge.request({ kind: 'queue.retryDead' });
      await get().refreshQueue();
    },

    async clearDead() {
      await bridge.request({ kind: 'queue.clearDead' });
      await get().refreshQueue();
    },

    async loadSchedule() {
      try {
        const schedule = await bridge.request<ScheduledTaskDTO[]>({ kind: 'schedule.list' });
        set({ schedule });
      } catch {
        /* engine 未就绪 */
      }
    },

    async createSchedule(payload) {
      await bridge.request({ kind: 'schedule.create', payload });
      await get().loadSchedule();
    },

    async updateSchedule(id, payload) {
      await bridge.request({ kind: 'schedule.update', id, payload });
      await get().loadSchedule();
    },

    async deleteSchedule(id) {
      await bridge.request({ kind: 'schedule.delete', id });
      await get().loadSchedule();
    },

    async runScheduleNow(id) {
      await bridge.request({ kind: 'schedule.runNow', id });
    },

    async refreshDashboard() {
      try {
        const dash = await bridge.request<DashboardDTO>({ kind: 'dashboard.data' });
        set({ dash });
      } catch {
        /* ignore */
      }
    },

    async loadGraph(force = false) {
      // 节流：水合推进时 queue.update 也会触发，5s 内不重复拉
      const now = Date.now();
      if (!force && get().graph && now - graphLoadedAt < 5000) return;
      graphLoadedAt = now;
      try {
        const graph = await bridge.request<GraphDTO>({ kind: 'library.graph' });
        set({ graph });
      } catch {
        /* engine 未就绪 */
      }
    },

    async loadSettings() {
      const settings = await bridge.request<SettingsDTO>({ kind: 'settings.get' });
      set({ settings });
    },

    async saveSettings(payload) {
      // 保存 = Engine 全量重建：busy 轮次被中断，落盘会话随 engine.ready 自动恢复
      await bridge.request({ kind: 'settings.save', payload });
      await get().loadSettings();
    },

    async getSoul() {
      return bridge.request<SoulDTO>({ kind: 'settings.getSoul' });
    },

    async saveSoul(content) {
      // 保存 SOUL = Engine 全量重建（soul 烘焙在 system prompt 里）：同 saveSettings 语义
      await bridge.request({ kind: 'settings.saveSoul', content });
    },

    async getReview() {
      return bridge.request<SoulDTO>({ kind: 'settings.getReview' });
    },

    async saveReview(content) {
      // 保存 REVIEW = Engine 全量重建（rubric 在 Agent 构造时读入）
      await bridge.request({ kind: 'settings.saveReview', content });
    },

    async switchProvider(name) {
      // 即时切聊天 provider：改 activeProvider + Engine 全量重建（engine.ready 后刷新 boot）。
      // 失败要显式冒泡成通知——否则请求 reject 后 select 会静默弹回原值，看起来"切不动"。
      try {
        await bridge.request({ kind: 'settings.setActiveProvider', name });
      } catch (err) {
        set((s) => ({
          notices: [...s.notices, { id: nid(), level: 'error', text: `切换 provider 失败：${(err as Error).message}` }],
        }));
      } finally {
        await get().loadSettings(); // 同步设置页选择器到持久化值（失败时即回滚乐观更新）
      }
    },

    async setHydrationProvider(name) {
      // 即时切水合 provider（设置「水合模型」选择器）：写 hydrationProvider + Engine 全量重建。
      try {
        await bridge.request({ kind: 'settings.setHydrationProvider', name });
      } catch (err) {
        set((s) => ({
          notices: [...s.notices, { id: nid(), level: 'error', text: `切换水合 provider 失败：${(err as Error).message}` }],
        }));
      } finally {
        await get().loadSettings();
      }
    },

    async setReviewProvider(name) {
      // 即时切审稿 provider（设置「审稿模型」选择器）：写 reviewProvider + Engine 全量重建。
      try {
        await bridge.request({ kind: 'settings.setReviewProvider', name });
      } catch (err) {
        set((s) => ({
          notices: [...s.notices, { id: nid(), level: 'error', text: `切换审稿 provider 失败：${(err as Error).message}` }],
        }));
      } finally {
        await get().loadSettings();
      }
    },

    async saveOnboarding(p) {
      await bridge.request({ kind: 'app.saveOnboarding', ...p });
      await get().bootstrap();
    },

    async loadSkills() {
      try {
        const dto = await bridge.request<SkillsDTO>({ kind: 'skills.list' });
        set({ skills: dto.skills });
      } catch {
        /* engine 未就绪 */
      }
    },

    async installSkill(name) {
      // 安装 = Engine 全量重建（同 settings.save）：当前会话被中断、随 engine.ready 自动恢复
      set({ skillsBusy: true });
      try {
        await bridge.request({ kind: 'skills.install', name });
        await get().loadSkills();
      } finally {
        set({ skillsBusy: false });
      }
    },

    async removeSkill(name) {
      set({ skillsBusy: true });
      try {
        await bridge.request({ kind: 'skills.remove', name });
        await get().loadSkills();
      } finally {
        set({ skillsBusy: false });
      }
    },

    async setSkillEnv(key, value) {
      // 配置 appkey：写 config.json secrets + process.env，立即生效，无需重建
      await bridge.request({ kind: 'skills.setEnv', key, value });
      await get().loadSkills();
    },

    openInChat(entry) {
      set({ nav: 'chat', composerDraft: `@${entry.id} ` });
      const { sessions } = get();
      if (get().activeSession === null && sessions.length > 0)
        void get().selectSession(sessions[0].id);
      if (sessions.length === 0) void get().newSession();
    },

    dismissNotice(id) {
      set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    },

    handleEvent(evt) {
      // 重拉侧边栏 Collections + 图谱 + 当前打开的 collection 条目列表。
      // 后台写入 wiki（队列水合、定时任务产物）后调用，让新文件即时可见。
      const reloadLibraryView = () => {
        void get().refreshCollections();
        if (get().graph) void get().loadGraph();
        const col = get().collection;
        if (col && get().nav === 'library') {
          void bridge
            .request<EntrySummary[]>({ kind: 'library.entries', collection: col })
            .then((entries) => set({ entries }))
            .catch(() => {});
        }
      };
      switch (evt.kind) {
        case 'engine.ready':
          void get().bootstrap();
          return;
        case 'queue.update': {
          // 后台水合推进 → 侧边栏 Collections / 当前条目列表跟着长
          const prevDone = get().queue?.counts.completed ?? -1;
          set({ queue: evt.digest });
          if (evt.digest.counts.completed !== prevDone) reloadLibraryView();
          return;
        }
        case 'schedule.update':
          // tick 触发 / run 完成 / CRUD → 若正在看 Schedule 视图就重拉。
          // run 完成可能已写入 wiki（如定时日报写 output），故顺带刷新 library 视图，
          // 让产物无需手动切换 collection 即可显现。
          if (get().nav === 'schedule') void get().loadSchedule();
          reloadLibraryView();
          return;
        case 'engine.notice':
          set((s) => ({
            notices: [...s.notices, { id: nid(), level: evt.level, text: evt.text }],
          }));
          return;
        case 'session.thinking':
          patchChat(evt.sessionId, (c) => ({ ...c, activity: 'thinking…' }));
          return;
        case 'session.assistantText':
          if (evt.final) {
            pushItem(evt.sessionId, { id: nid(), kind: 'assistant', text: evt.text });
            patchChat(evt.sessionId, (c) => ({ ...c, activity: null }));
          } else {
            patchChat(evt.sessionId, (c) => ({ ...c, activity: evt.text.slice(0, 120) }));
          }
          return;
        case 'session.toolRound':
          pushItem(evt.sessionId, {
            id: nid(),
            kind: 'tool',
            name: evt.name,
            argsPreview: evt.argsPreview,
            ok: evt.ok,
            preview: evt.preview,
          });
          patchChat(evt.sessionId, (c) => ({
            ...c,
            activity: `${evt.name} ${evt.ok ? '✓' : '✗'}`,
          }));
          return;
        case 'session.artifact':
          // 去重：同一路径的产物卡片在一个会话里只保留一张（Write 后 Edit 会重复上报）
          patchChat(evt.sessionId, (c) =>
            c.items.some((it) => it.kind === 'artifact' && it.path === evt.path)
              ? c
              : {
                  ...c,
                  items: [
                    ...c.items,
                    { id: nid(), kind: 'artifact', path: evt.path, name: evt.name },
                  ],
                },
          );
          return;
        case 'session.refs':
          // 把本回合引用到的条目挂到最后一条助手消息上
          patchChat(evt.sessionId, (c) => {
            const items = [...c.items];
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i].kind === 'assistant') {
                items[i] = { ...items[i], refs: evt.refs, browsed: evt.browsed } as ChatItem;
                break;
              }
            }
            return { ...c, items };
          });
          return;
        case 'session.usage':
          patchChat(evt.sessionId, (c) => ({
            ...c,
            usage: {
              inTok: c.usage.inTok + evt.inputTokens,
              outTok: c.usage.outTok + evt.outputTokens,
            },
          }));
          return;
        case 'session.busy':
          patchChat(evt.sessionId, (c) => ({ ...c, busy: evt.busy }));
          return;
        case 'session.turnDone':
          patchChat(evt.sessionId, (c) => ({ ...c, busy: false, activity: null }));
          if (evt.error && evt.error !== 'cancelled') {
            pushItem(evt.sessionId, { id: nid(), kind: 'error', text: evt.error });
          } else if (evt.error === 'cancelled') {
            pushItem(evt.sessionId, {
              id: nid(),
              kind: 'note',
              text: i18n.t('chat.noteCancelled'),
            });
          }
          void get().refreshSessions();
          void get().refreshCollections();
          return;
        case 'session.approvalRequest':
          pushItem(evt.sessionId, {
            id: nid(),
            kind: 'approval',
            approvalId: evt.approvalId,
            approvalKind: evt.approvalKind,
            path: evt.path,
            preview: evt.preview,
            decided: null,
          });
          void get().refreshSessions();
          return;
        case 'session.approvalSettled':
          patchChat(evt.sessionId, (c) => ({
            ...c,
            items: c.items.map((it) =>
              it.kind === 'approval' && it.approvalId === evt.approvalId
                ? { ...it, decided: evt.answer as 'yes' | 'no' | 'always' }
                : it,
            ),
          }));
          void get().refreshSessions();
          return;
      }
    },
  };
});

/**
 * composer 文本里的 @-mention → ScopeDTO。
 * token 形态（由选择器产出，也兼容手打）：
 *   - `@集合/`            → 整个集合（collections）
 *   - `@集合/子目录/…/`   → 子文件夹前缀（folders，subpath = 首段之后的路径）
 *   - `@条目id`（无斜杠） → 钉死条目（entryIds）
 * 尾斜杠但首段不是已知集合 → 忽略。
 */
export function parseScopeFromText(
  text: string,
  collections: CollectionInfo[],
): ScopeDTO | undefined {
  const tokens = [...text.matchAll(/@([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1]);
  if (tokens.length === 0) return undefined;
  const colSet = new Set(collections.map((c) => c.id));
  const scope: ScopeDTO = { collections: [], folders: [], entryIds: [] };
  for (const t of tokens) {
    if (t.endsWith('/')) {
      const segs = t.replace(/\/+$/, '').split('/').filter(Boolean);
      const [collection, ...rest] = segs;
      if (!collection || !colSet.has(collection)) continue; // 首段非已知集合 → 忽略
      if (rest.length === 0) scope.collections.push(collection);
      else scope.folders.push({ collection, subpath: rest.join('/') });
    } else {
      scope.entryIds.push(t); // 无斜杠 → 条目候选
    }
  }
  return scope.collections.length || scope.folders.length || scope.entryIds.length
    ? scope
    : undefined;
}
