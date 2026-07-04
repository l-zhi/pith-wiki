/**
 * Electron main —— 哑壳（ADR-0006）：窗口管理 + spawn Engine + envelope 转发。
 * 不解析任何 EngineBridge payload；renderer ↔ Engine 的消息原样穿透。
 */
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
/** 退出流程标记：置位后不再向 renderer 转发、不再自动重启 Engine（避免 kill 后的 exit 触发重启/向已销毁窗口 send）。 */
let isQuitting = false;

/** 安全地把 envelope 发给 renderer：窗口/webContents 已销毁时静默丢弃（退出竞态下 send 会抛 "Object has been destroyed"）。 */
function sendToRenderer(msg: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('bridge', msg);
  }
}

/**
 * 品牌图标（脉络/橘络）。dev（未打包）下 dock 默认是 Electron 图标，必须运行时
 * app.dock.setIcon 才会变；打包后由 extraResources 落到 process.resourcesPath。
 * 母版见 resources/icon.svg，PNG 由它栅格化。
 */
function resolveIconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'), // 打包：extraResources
    path.join(app.getAppPath(), 'resources', 'icon.png'), // dev：app 根 = desktop/
    path.join(__dirname, '../../resources/icon.png'), // out/main → desktop/resources
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

let iconPath: string | null = null;

function spawnEngine(): void {
  // dev/prod 数据隔离：`electron-vite dev`（仅它会设 ELECTRON_RENDERER_URL）走
  // ~/.pith-wiki-dev，与 CLI 的 tsx dev 入口同语义（见根 src/paths.ts）。Engine 是
  // 打包后的 .js 入口，核心层的 isDevEntrypoint 判不出来，只能在 spawn 处注入。
  // 用户显式设置的 PITH_WIKI_HOME 永远优先。
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (isDev && !env.PITH_WIKI_HOME) {
    env.PITH_WIKI_HOME = path.join(os.homedir(), '.pith-wiki-dev');
  }
  engine = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
    serviceName: 'pith-engine',
    stdio: 'inherit',
    env,
  });
  engine.on('message', (msg: unknown) => {
    if (isQuitting) return;
    sendToRenderer(msg);
  });
  engine.on('exit', (code) => {
    // 退出流程里 Engine 被 kill 属正常收尾——别通知、更别重启（否则退出时又拉起一个 Engine）。
    if (isQuitting) return;
    // Engine 崩溃 = 所有会话中断（恢复靠 JSONL）。通知 UI 并自动拉起一次。
    sendToRenderer({
      t: 'evt',
      evt: { kind: 'engine.notice', level: 'error', text: `engine exited (code=${code}), restarting…` },
    });
    if (!app.isPackaged || code !== 0) spawnEngine();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    // macOS：隐藏标题栏，红绿灯悬浮在玻璃侧边栏上（设计稿 Sidebar 顶部布局）
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 19 },
    backgroundColor: '#f5f5f7',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url); // 外链交给系统浏览器
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null; // 释放引用，避免退出竞态下向已销毁窗口 send
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // dock 图标（macOS，未打包时必须运行时设置）
  iconPath = resolveIconPath();
  if (iconPath && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(iconPath);
    } catch {
      /* 图标设置失败不影响启动 */
    }
  }
  ipcMain.on('bridge', (_event, msg: unknown) => {
    engine?.postMessage(msg);
  });
  // Reader「查看源文件」：URL 交给浏览器，本地路径用系统默认应用打开。
  // shell 是 main-only API（Engine 是纯 Node utilityProcess 拿不到），所以走独立 IPC。
  ipcMain.handle('os.openSource', async (_event, target: unknown) => {
    if (typeof target !== 'string' || !target.trim()) return { ok: false, error: 'empty target' };
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return { ok: true };
    }
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // 「在 Finder 显示」：把文件在系统文件管理器里定位高亮（区别于 openSource 的直接打开）。
  ipcMain.handle('os.revealSource', (_event, target: unknown) => {
    if (typeof target !== 'string' || !target.trim()) return { ok: false, error: 'empty target' };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  // 设置界面「添加 watch 目录」：系统文件夹选择器（dialog 是 main-only API）。
  ipcMain.handle('os.pickFolder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  spawnEngine();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cmd+Q / 菜单退出：先置位,让随后 Engine kill 的 exit 事件走"正常收尾"分支。
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // 单窗口应用：关窗即退（队列后台消化随 Engine 退出而停止，符合"应用运行期间"语义）
  isQuitting = true;
  engine?.kill();
  app.quit();
});
