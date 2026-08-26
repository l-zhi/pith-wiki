import React from 'react';
import { Sidebar } from './views/Sidebar';
import { MiddleColumn } from './views/MiddleColumn';
import { ChatPane } from './views/ChatPane';
import { EntryReader } from './views/EntryReader';
import { Inbox } from './views/Inbox';
import { Dashboard } from './views/Dashboard';
import { Settings } from './views/Settings';
import { GraphView } from './views/GraphView';
import { Skills } from './views/Skills';
import { Schedule } from './views/Schedule';
import { Onboarding } from './views/Onboarding';
import { ErrorBoundary } from './ErrorBoundary';
import { NoticeCenter } from './components/NoticeCenter';
import { useStore } from './store';

/** pith 桌面壳：三栏布局（设计稿 App.jsx）+ 主题 + 通知 toast。 */
export function App() {
  const nav = useStore((s) => s.nav);
  const theme = useStore((s) => s.theme);
  const boot = useStore((s) => s.boot);
  const notices = useStore((s) => s.notices);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const dismissAllNotices = useStore((s) => s.dismissAllNotices);
  const refreshQueue = useStore((s) => s.refreshQueue);
  const refreshCollections = useStore((s) => s.refreshCollections);

  // 主题：auto 跟随系统（设计稿 App.jsx 同款逻辑）
  React.useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (theme === 'auto') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', dark ? 'dark' : 'light');
      } else {
        root.setAttribute('data-theme', theme);
      }
    };
    apply();
    if (theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  // 队列状态由 Engine 的 queue.update 事件推送（见 store.handleEvent）；
  // 这里只留一个低频兜底轮询，覆盖事件丢失/Engine 重启的缝隙。
  React.useEffect(() => {
    const t = setInterval(() => {
      void refreshQueue();
      // collection 计数兜底刷新：捕捉 write_file 等绕过队列的直接写盘（如定时任务写 output）
      void refreshCollections();
    }, 30000);
    return () => clearInterval(t);
  }, [refreshQueue, refreshCollections]);

  return (
    <ErrorBoundary>
      <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden' }}>
        <Sidebar />
      <MiddleColumn />
      <main style={{ flex: 1, minWidth: 0, height: '100%' }}>
        {nav === 'chat' && <ChatPane />}
        {nav === 'library' && <EntryReader />}
        {nav === 'inbox' && <Inbox />}
        {nav === 'dashboard' && <Dashboard />}
        {nav === 'settings' && <Settings />}
        {nav === 'graph' && <GraphView />}
        {nav === 'skills' && <Skills />}
        {nav === 'schedule' && <Schedule />}
      </main>

      {boot?.needsOnboarding && <Onboarding />}

      {/* engine notices → 右下角 toast；超过三条时默认折叠，可展开或批量关闭。 */}
      <NoticeCenter
        notices={notices}
        onDismiss={dismissNotice}
        onDismissAll={dismissAllNotices}
      />
      </div>
    </ErrorBoundary>
  );
}
