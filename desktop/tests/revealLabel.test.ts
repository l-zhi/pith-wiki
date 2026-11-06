import { describe, expect, it } from 'vitest';
import { rendererPlatform, revealLabel } from '../src/shared/revealLabel.js';

describe('revealLabel', () => {
  it('uses the folder context-menu wording for Finder and File Manager', () => {
    expect(revealLabel('darwin', 'en')).toBe('Show in Finder');
    expect(revealLabel('darwin', 'zh')).toBe('在 Finder 中显示');
    expect(revealLabel('darwin', 'zh-CN')).toBe('在 Finder 中显示');
    expect(revealLabel('win32', 'en')).toBe('Show in File Manager');
    expect(revealLabel('win32', 'en-US')).toBe('Show in File Manager');
    expect(revealLabel('linux', 'zh')).toBe('在文件管理器中显示');
  });
});

describe('rendererPlatform', () => {
  it('maps the host user agent the same way the menu maps process.platform', () => {
    expect(rendererPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' })).toBe(
      'win32',
    );
    expect(
      rendererPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' }),
    ).toBe('darwin');
    expect(rendererPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' })).toBe('linux');
    expect(rendererPlatform(undefined)).toBe('linux');
  });
});
