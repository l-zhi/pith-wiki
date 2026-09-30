import { app, BrowserWindow, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Keep OS menus and Finder access in main; renderer supplies resolved collection folders. */
export async function showFolderContextMenu(
  event: IpcMainInvokeEvent,
  targets: unknown,
  language: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const zh = typeof language === 'string' && language.startsWith('zh');
  const missing = zh ? '对应文件夹不存在或暂时无法访问。' : 'The folder is missing or unavailable.';
  const isDirectory = (target: unknown): target is string => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  };
  const folders = Array.isArray(targets) ? [...new Set(targets.filter(isDirectory))] : [];
  if (!folders.length) return { ok: false, error: missing };
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return { ok: false, error: missing };
  const label =
    process.platform === 'darwin'
      ? zh
        ? '在 Finder 中显示'
        : 'Show in Finder'
      : zh
        ? '在文件管理器中显示'
        : 'Show in File Manager';
  const icon = await app.getFileIcon(folders[0], { size: 'small' }).catch(() => undefined);
  if (window.isDestroyed()) return { ok: false, error: missing };
  return new Promise((resolve) => {
    let result: { ok: boolean; error?: string } = { ok: true };
    const reveal = (target: string) => {
      if (!isDirectory(target)) {
        result = { ok: false, error: missing };
        return;
      }
      shell.showItemInFolder(target);
    };
    const menu = Menu.buildFromTemplate([
      {
        label,
        icon,
        ...(folders.length === 1
          ? { click: () => reveal(folders[0]) }
          : { submenu: folders.map((target) => ({ label: target, click: () => reveal(target) })) }),
      },
    ]);
    menu.popup({ window, callback: () => resolve(result) });
  });
}
