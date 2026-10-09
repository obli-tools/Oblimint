import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Locale files: locales/<lng>/translation.json (P0 shell) + one file per
// feature module (locales/<lng>/<module>.json — hosting.json, sites.json…),
// all deep-merged into the single 'translation' namespace: t('sites.title')
// works wherever the key lives, and each module edits only its own files.
// A module file owns its TOP-LEVEL keys: two files never define the same
// top-level key (docs/P1-PLAN.md §i18n). Bundled eagerly (no lazy loading
// needed at this app size).
type Dict = { [key: string]: unknown };

const localeFiles = import.meta.glob<Dict>('./locales/*/*.json', { eager: true, import: 'default' });

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(target: Dict, source: Dict): Dict {
  for (const [k, v] of Object.entries(source)) {
    const cur = target[k];
    target[k] = isDict(cur) && isDict(v) ? deepMerge({ ...cur }, v) : v;
  }
  return target;
}

/** lng → merged dictionary (translation.json first, then the module files by name). */
function buildResources(): Record<string, { translation: Dict }> {
  const byLang = new Map<string, Array<[string, Dict]>>();
  for (const [file, dict] of Object.entries(localeFiles)) {
    const m = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(file);
    if (!m || !isDict(dict)) continue;
    const list = byLang.get(m[1]) ?? [];
    list.push([m[2], dict]);
    byLang.set(m[1], list);
  }
  const resources: Record<string, { translation: Dict }> = {};
  for (const [lng, list] of byLang) {
    list.sort(([a], [b]) => (a === 'translation' ? -1 : b === 'translation' ? 1 : a.localeCompare(b)));
    const merged: Dict = {};
    for (const [, dict] of list) deepMerge(merged, dict);
    resources[lng] = { translation: merged };
  }
  return resources;
}

export const SUPPORTED_LANGUAGES: Array<{ code: string; name: string; nativeName: string; dir?: 'rtl' }> = [
  { code: 'en',    name: 'English',            nativeName: 'English' },
  { code: 'fr',    name: 'French',             nativeName: 'Français' },
  { code: 'es',    name: 'Spanish',            nativeName: 'Español' },
  { code: 'de',    name: 'German',             nativeName: 'Deutsch' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'ja',    name: 'Japanese',           nativeName: '日本語' },
  { code: 'ko',    name: 'Korean',             nativeName: '한국어' },
  { code: 'ru',    name: 'Russian',            nativeName: 'Русский' },
  { code: 'ar',    name: 'Arabic',             nativeName: 'العربية', dir: 'rtl' },
  { code: 'it',    name: 'Italian',            nativeName: 'Italiano' },
  { code: 'nl',    name: 'Dutch',              nativeName: 'Nederlands' },
  { code: 'pl',    name: 'Polish',             nativeName: 'Polski' },
  { code: 'tr',    name: 'Turkish',            nativeName: 'Türkçe' },
  { code: 'sv',    name: 'Swedish',            nativeName: 'Svenska' },
  { code: 'da',    name: 'Danish',             nativeName: 'Dansk' },
  { code: 'cs',    name: 'Czech',              nativeName: 'Čeština' },
  { code: 'uk',    name: 'Ukrainian',          nativeName: 'Українська' },
];

const savedLang = localStorage.getItem('i18n_language') || navigator.language.split('-')[0] || 'en';
const initialLang = SUPPORTED_LANGUAGES.find(l => l.code === savedLang || l.code.startsWith(savedLang))?.code ?? 'en';

i18n
  .use(initReactI18next)
  .init({
    resources: buildResources(),
    lng: initialLang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

/** Change the active language, persist the choice, update <html dir> for RTL. */
export function setLanguage(code: string) {
  i18n.changeLanguage(code);
  localStorage.setItem('i18n_language', code);
  const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
  document.documentElement.setAttribute('lang', code);
  document.documentElement.setAttribute('dir', lang?.dir ?? 'ltr');
}

export default i18n;
