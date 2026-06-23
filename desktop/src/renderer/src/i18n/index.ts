import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zh } from './zh';
import { en } from './en';

/** 语言偏好：zh / en / auto（跟随系统）。与主题同构，localStorage 持久化。 */
export type LangPref = 'zh' | 'en' | 'auto';

export function resolveLang(pref: LangPref): 'zh' | 'en' {
  if (pref !== 'auto') return pref;
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function storedLangPref(): LangPref {
  const v = localStorage.getItem('pith-lang');
  return v === 'zh' || v === 'en' || v === 'auto' ? v : 'auto';
}

void i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: resolveLang(storedLangPref()),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React 自带转义
  returnNull: false,
});

export default i18n;
