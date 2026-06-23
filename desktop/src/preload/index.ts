/**
 * preload —— renderer 唯一可见的桥：window.pith = { post, onMessage }。
 * contextIsolation 开启；renderer 拿不到 Node / Electron 任何其它能力。
 */
import { clipboard, contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pith', {
  post: (msg: unknown) => ipcRenderer.send('bridge', msg),
  onMessage: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('bridge', (_event, msg: unknown) => cb(msg));
  },
  /** 用系统默认应用打开源文件（URL → 浏览器）。 */
  openSource: (target: string) =>
    ipcRenderer.invoke('os.openSource', target) as Promise<{ ok: boolean; error?: string }>,
  /** 写系统剪贴板（Electron clipboard，比 web API 在 file:// 下可靠）。 */
  copyText: (text: string) => clipboard.writeText(text),
  /** 系统文件夹选择器（设置 → 添加 watch 目录）。取消返回 null。 */
  pickFolder: () => ipcRenderer.invoke('os.pickFolder') as Promise<string | null>,
});
