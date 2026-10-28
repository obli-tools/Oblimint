import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';

// i18n of the webmail bundle (its own instance: the panel's 18 locale files
// are not shipped here). en + fr; any other language falls back to English
// (every call site also carries its English fallback: t('key') || 'Fallback').

export const WEBMAIL_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
] as const;

const STORAGE_KEY = 'wm-lang';

function initialLanguage(): string {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  const wanted = (saved || navigator.language || 'en').split('-')[0].toLowerCase();
  return WEBMAIL_LANGUAGES.some((l) => l.code === wanted) ? wanted : 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});
document.documentElement.setAttribute('lang', i18n.language);

export function setWebmailLanguage(code: string): void {
  void i18n.changeLanguage(code);
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage unavailable */ }
  document.documentElement.setAttribute('lang', code);
}

export default i18n;
