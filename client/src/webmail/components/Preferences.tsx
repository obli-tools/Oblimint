import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudMoon, Languages, Moon, Sun } from 'lucide-react';
import type { WebmailVacation } from '@oblimint/shared';
import { useCurrentTheme } from '@/hooks/useCurrentTheme';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';
import { wmApi } from '../api';
import { setWebmailLanguage, WEBMAIL_LANGUAGES } from '../i18n';
import { useWebmail } from '../store';
import { Dialog } from './Dialog';
import { PillButton } from './ui';

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

const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Vacation responder = the mailbox's autoresponder managed by the panel. */
export function VacationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useWebmail((s) => s.toast);
  const [v, setV] = useState<WebmailVacation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    wmApi.vacation().then(setV).catch((err) => setError((err as Error).message));
  }, [open]);

  const save = async () => {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await wmApi.saveVacation({
        ...v,
        startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null,
        endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
      });
      setV(saved);
      toast('ok', t('wm.vacation.saved') || 'Vacation responder saved');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full rounded-[7px] bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60 coarse:min-h-10';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('wm.vacation.title') || 'Vacation responder'}
      closeLabel={t('wm.common.close') || 'Close'}
      footer={(
        <>
          <PillButton variant="ghost" onClick={onClose}>{t('wm.common.cancel') || 'Cancel'}</PillButton>
          <PillButton variant="primary" onClick={() => { void save(); }} loading={busy} disabled={!v}>{t('wm.common.save') || 'Save'}</PillButton>
        </>
      )}
    >
      {!v ? <p className="text-sm text-text-muted">{error ?? (t('wm.common.loading') || 'Loading…')}</p> : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            {t('wm.vacation.enabled') || 'Send an automatic reply'}
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-text-secondary">{t('wm.compose.subject') || 'Subject'}</span>
            <input value={v.subject} maxLength={200} onChange={(e) => setV({ ...v, subject: e.target.value })} className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-text-secondary">{t('wm.vacation.message') || 'Message'}</span>
            <textarea value={v.body} maxLength={10000} rows={6} onChange={(e) => setV({ ...v, body: e.target.value })} className={inputCls} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm text-text-secondary">{t('wm.vacation.from') || 'From (optional)'}</span>
              <input type="datetime-local" value={toLocalInput(v.startsAt)} onChange={(e) => setV({ ...v, startsAt: e.target.value || null })} className={inputCls} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-text-secondary">{t('wm.vacation.until') || 'Until (optional)'}</span>
              <input type="datetime-local" value={toLocalInput(v.endsAt)} onChange={(e) => setV({ ...v, endsAt: e.target.value || null })} className={inputCls} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-sm text-text-secondary">{t('wm.vacation.interval') || 'Answer the same sender at most every (days)'}</span>
            <input type="number" min={1} max={30} value={v.intervalDays} onChange={(e) => setV({ ...v, intervalDays: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} className={cn(inputCls, 'max-w-[8rem]')} />
          </label>
          {error && <p className="wm-warn text-sm">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
