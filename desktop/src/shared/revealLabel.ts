/**
 * 「在 Finder / 文件管理器中显示」——文件夹右键菜单与产物卡片共用同一组文案。
 * 平台只决定选哪一句；不引入新的标题栏或菜单机制。
 */

export function revealLabel(platform: string, language: string): string {
  const zh = language.startsWith('zh');
  if (platform === 'darwin') return zh ? '在 Finder 中显示' : 'Show in Finder';
  return zh ? '在文件管理器中显示' : 'Show in File Manager';
}

/** Renderer 看不到 Node 的 `process.platform`；用 Electron UA 做同样的 darwin 判断。 */
export function rendererPlatform(
  nav: { userAgent?: string; platform?: string } | undefined = readNavigator(),
): string {
  const ua = nav?.userAgent ?? '';
  const platform = nav?.platform ?? '';
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/.test(ua)) return 'darwin';
  if (/Win/i.test(platform) || /Windows/.test(ua)) return 'win32';
  return 'linux';
}

function readNavigator(): { userAgent?: string; platform?: string } | undefined {
  return (globalThis as { navigator?: { userAgent?: string; platform?: string } }).navigator;
}
