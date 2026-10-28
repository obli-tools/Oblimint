import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages, Moon, Sun } from 'lucide-react';
import type { WebmailVacation } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { useCurrentTheme } from '@/hooks/useCurrentTheme';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';
import { wmApi } from '../api';
import { setWebmailLanguage, WEBMAIL_LANGUAGES } from '../i18n';
import { useWebmail } from '../store';
import { Dialog } from './Dialog';

/** Language + light / dark theme (kept in this host's local storage). */
export function LanguageThemeBar({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const theme = useCurrentTheme();
  const light = theme === 'obli-daylight';
  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <label className="flex items-center gap-1.5 text-text-muted">
        <Languages size={14} />
        <span className="sr-only">{t('wm.prefs.language') || 'Language'}</span>
        <select
          value={i18n.language}
          onChange={(e) => setWebmailLanguage(e.target.value)}
          className="rounded-md bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {WEBMAIL_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </label>
      <button
        type="button"
        onClick={() => applyTheme(light ? 'obli-operator' : 'obli-daylight')}
        className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10"
        title={light ? (t('wm.prefs.dark') || 'Dark theme') : (t('wm.prefs.light') || 'Light theme')}
        aria-label={light ? (t('wm.prefs.dark') || 'Dark theme') : (t('wm.prefs.light') || 'Light theme')}
      >
        {light ? <Moon size={15} /> : <Sun size={15} />}
      </button>
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

  const inputCls = 'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('wm.vacation.title') || 'Vacation responder'}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('wm.common.cancel') || 'Cancel'}</Button>
          <Button onClick={() => { void save(); }} loading={busy} disabled={!v}>{t('wm.common.save') || 'Save'}</Button>
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
          {error && <p className="text-sm text-amber-400">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
