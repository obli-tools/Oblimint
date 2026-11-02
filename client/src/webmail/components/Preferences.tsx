import { useTranslation } from 'react-i18next';
import { CloudMoon, Languages, Moon, Sun } from 'lucide-react';
import { useCurrentTheme } from '@/hooks/useCurrentTheme';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';
import { setWebmailLanguage, WEBMAIL_LANGUAGES } from '../i18n';

const THEMES = [
  { id: 'obli-operator', icon: Moon, key: 'wm.prefs.themeDark', fallback: 'Dark' },
  { id: 'obli-daylight', icon: Sun, key: 'wm.prefs.themeLight', fallback: 'Light' },
  { id: 'obli-dim', icon: CloudMoon, key: 'wm.prefs.themeDim', fallback: 'Slate' },
] as const;

/** Theme: the three Obli themes as a segmented pill (kept in this host's local storage). */
export function ThemePicker({ className, labels = true }: { className?: string; labels?: boolean }) {
  const { t } = useTranslation();
  const theme = useCurrentTheme();
  return (
    <div className={cn('flex items-center gap-0.5 rounded-[7px] bg-bg-tertiary p-0.5', className)} role="radiogroup" aria-label={t('wm.prefs.theme') || 'Theme'}>
      {THEMES.map(({ id, icon: Icon, key, fallback }) => {
        const on = theme === id || (id === 'obli-operator' && !THEMES.some((x) => x.id === theme));
        const label = t(key) || fallback;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} title={label} onClick={() => applyTheme(id)}
            className={cn(
              'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[6px] px-2 text-[12px] transition-colors coarse:h-9',
              on ? 'wm-card bg-bg-secondary font-medium text-text-primary' : 'text-text-muted hover:text-text-primary',
            )}>
            <Icon size={13} className={cn(on && 'text-accent')} />
            {labels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Language of the webmail (en / fr; kept in this host's local storage). */
export function LanguagePicker({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <label className={cn('flex items-center gap-2 rounded-[7px] bg-bg-tertiary py-1 pl-2.5 pr-1 text-[12px] text-text-muted', className)}>
      <Languages size={13} className="shrink-0" />
      <span className="sr-only">{t('wm.prefs.language') || 'Language'}</span>
      <select value={i18n.language} onChange={(e) => setWebmailLanguage(e.target.value)}
        className="wm-select min-w-0 flex-1 cursor-pointer bg-transparent py-0.5 text-[12px] text-text-primary outline-none">
        {WEBMAIL_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
    </label>
  );
}

/** Language + theme, side by side (login and confirmation screens). */
export function LanguageThemeBar({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
      <LanguagePicker />
      <ThemePicker labels={false} />
    </div>
  );
}
