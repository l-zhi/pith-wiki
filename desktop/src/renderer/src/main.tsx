import React from 'react';
import ReactDOM from 'react-dom/client';
import './theme/index.css';
import './i18n'; // 初始化 i18next（语言偏好来自 localStorage / 系统）
import { App } from './App';
import { bridge } from './bridge';
import { useStore } from './store';

// Engine 事件 → store 分发（engine.ready 触发 bootstrap；ready 事件可能在
// 订阅前已发出，所以这里也主动拉一次 bootstrap，幂等）。
bridge.onEvent((evt) => useStore.getState().handleEvent(evt));
void useStore
  .getState()
  .bootstrap()
  .catch(() => {
    /* engine 未就绪：等 engine.ready 事件再 bootstrap */
  });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
