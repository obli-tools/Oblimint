import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Download, Trash2 } from 'lucide-react';
import type { AdapterId, AdapterRunOptions, AdapterSchedule, AdapterUpdate } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useAdapterName } from './MaintenanceBadges';
import { browserTimezone, COMPOSER_PACKAGE_RE, splitList, WP_SLUG_RE } from './maintenanceFormat';
import { ScheduleEditor, isWindowCron, useCronHuman } from './ScheduleEditor';

type Scope = 'all' | 'selected' | 'none';

interface OptionsDraft {
  core: boolean;
  plugins: Scope;
  pluginList: string;
  themes: Scope;
  themeList: string;
  translations: boolean;
  minorOnly: boolean;
  composerCommand: 'install' | 'update';
  packages: string;
  noDev: boolean;
  runMigrations: boolean;
}

function scopeOf(v: AdapterRunOptions['plugins']): Scope {
  if (v === 'all') return 'all';
  if (Array.isArray(v)) return 'selected';
  return 'none';
}

function toDraft(o: AdapterRunOptions | null, available: AdapterUpdate[]): OptionsDraft {
  const names = (kind: AdapterUpdate['kind']) => available.filter((u) => u.kind === kind).map((u) => u.name).join(', ');
  return {
    core: o?.core ?? true,
    plugins: o ? scopeOf(o.plugins) : 'all',
    pluginList: Array.isArray(o?.plugins) ? o!.plugins.join(', ') : names('plugin'),
    themes: o ? scopeOf(o.themes) : 'all',
    themeList: Array.isArray(o?.themes) ? o!.themes.join(', ') : names('theme'),
    translations: o?.translations ?? true,
    minorOnly: o?.minorOnly ?? false,
    composerCommand: o?.composerCommand ?? 'update',
    packages: (o?.packages ?? []).join(', '),
    noDev: o?.noDev ?? true,
    runMigrations: o?.runMigrations ?? true,
  };
}

/** Options draft → AdapterRunOptions of this adapter (null + error key when invalid). */
function toOptions(adapter: AdapterId, d: OptionsDraft): { options: AdapterRunOptions; invalid: string | null } {
  if (adapter === 'wordpress') {
    const plugins = splitList(d.pluginList);
    const themes = splitList(d.themeList);
    const badSlug = [...(d.plugins === 'selected' ? plugins : []), ...(d.themes === 'selected' ? themes : [])].find((s) => !WP_SLUG_RE.test(s));
    const emptySel = (d.plugins === 'selected' && plugins.length === 0) || (d.themes === 'selected' && themes.length === 0);
    return {
      options: {
        core: d.core,
        plugins: d.plugins === 'all' ? 'all' : d.plugins === 'selected' ? plugins : false,
        themes: d.themes === 'all' ? 'all' : d.themes === 'selected' ? themes : false,
        translations: d.translations,
        minorOnly: d.minorOnly,
        runMigrations: d.runMigrations,
      },
      invalid: badSlug ? badSlug : emptySel ? 'empty' : null,
    };
  }
  if (adapter === 'composer' || adapter === 'drupal') {
    const packages = splitList(d.packages);
    const bad = packages.find((p) => !COMPOSER_PACKAGE_RE.test(p));
    const opts: AdapterRunOptions = { minorOnly: d.minorOnly, packages, noDev: d.noDev };
    if (adapter === 'composer') opts.composerCommand = d.composerCommand;
    else opts.runMigrations = d.runMigrations;
    return { options: opts, invalid: bad ?? null };
  }
  return { options: { runMigrations: d.runMigrations }, invalid: null };
}

function OptionsEditor({ adapter, draft, set, available }: {
  adapter: AdapterId;
  draft: OptionsDraft;
  set: (patch: Partial<OptionsDraft>) => void;
  available: AdapterUpdate[];
}) {
  const { t } = useTranslation();
  const scopeLabel = (s: Scope) => ({
    all: t('adapters.options.scopeAll') || 'All',
    selected: t('adapters.options.scopeSelected') || 'Selected',
    none: t('adapters.options.scopeNone') || 'None',
  })[s];
  const scopeRow = (id: string, label: string, value: Scope, onScope: (s: Scope) => void, list: string, onList: (v: string) => void, hint: string) => (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-sm text-text-secondary">{label}</span>
        <div role="radiogroup" aria-label={label} className="flex gap-1">
          {(['all', 'selected', 'none'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={value === s}
              onClick={() => onScope(s)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium coarse:min-h-9', value === s ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30')}
            >
              {scopeLabel(s)}
            </button>
          ))}
        </div>
      </div>
      {value === 'selected' && (
        <>
          <input id={id} value={list} onChange={(e) => onList(e.target.value)} placeholder="akismet, contact-form-7" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono text-[13px]')} />
          <p className="mt-1 text-xs text-text-muted">{hint}</p>
        </>
      )}
    </div>
  );

  if (adapter === 'wordpress') {
    return (
      <div className="space-y-3">
        <ToggleSwitch checked={draft.core} onChange={(v) => set({ core: v })} label={t('adapters.options.core') || 'WordPress core'} />
        {scopeRow('opt-plugins', t('adapters.options.plugins') || 'Plugins', draft.plugins, (s) => set({ plugins: s }), draft.pluginList, (v) => set({ pluginList: v }), t('adapters.options.slugsHint') || 'Slugs separated by commas.')}
        {scopeRow('opt-themes', t('adapters.options.themes') || 'Themes', draft.themes, (s) => set({ themes: s }), draft.themeList, (v) => set({ themeList: v }), t('adapters.options.slugsHint') || 'Slugs separated by commas.')}
        <ToggleSwitch checked={draft.translations} onChange={(v) => set({ translations: v })} label={t('adapters.options.translations') || 'Translations'} />
        <ToggleSwitch checked={draft.minorOnly} onChange={(v) => set({ minorOnly: v })} label={t('adapters.options.minorOnly') || 'Minor updates only'} description={t('adapters.options.minorOnlyHint') || 'No major version change (safer for unattended updates).'} />
        <ToggleSwitch checked={draft.runMigrations} onChange={(v) => set({ runMigrations: v })} label={t('adapters.options.runMigrations') || 'Run the database migrations'} description={t('adapters.options.runMigrationsWp') || 'wp core update-db after the deployment.'} />
      </div>
    );
  }
  if (adapter === 'composer' || adapter === 'drupal') {
    const suggestions = available.filter((u) => u.kind === 'package' || u.kind === 'module' || u.kind === 'core').map((u) => u.name);
    return (
      <div className="space-y-3">
        {adapter === 'composer' && (
          <div>
            <span className={labelCls}>{t('adapters.options.composerCommand') || 'Command'}</span>
            <div role="radiogroup" className="flex gap-1.5">
              {(['update', 'install'] as const).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={draft.composerCommand === c} onClick={() => set({ composerCommand: c })} className={cn('rounded-full border px-3 py-1 font-mono text-xs coarse:min-h-10', draft.composerCommand === c ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30')}>
                  composer {c}
                </button>
              ))}
            </div>
          </div>
        )}
        {(adapter === 'drupal' || draft.composerCommand === 'update') && (
          <div>
            <label className={labelCls} htmlFor="opt-packages">{t('adapters.options.packages') || 'Packages (empty = all)'}</label>
            <input id="opt-packages" value={draft.packages} onChange={(e) => set({ packages: e.target.value })} placeholder={suggestions.slice(0, 2).join(', ') || 'vendor/package'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono text-[13px]')} />
            {suggestions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestions.slice(0, 12).map((name) => (
                  <button key={name} type="button" onClick={() => set({ packages: [...new Set([...splitList(draft.packages), name])].join(', ') })} className="rounded-full bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-muted hover:text-text-primary">
                    + {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <ToggleSwitch checked={draft.minorOnly} onChange={(v) => set({ minorOnly: v })} label={t('adapters.options.minorOnly') || 'Minor updates only'} description={t('adapters.options.patchOnlyHint') || 'composer update --patch-only: no minor or major version change.'} />
        <ToggleSwitch checked={draft.noDev} onChange={(v) => set({ noDev: v })} label={t('adapters.options.noDev') || 'Without the dev dependencies'} />
        {adapter === 'drupal' && (
          <ToggleSwitch checked={draft.runMigrations} onChange={(v) => set({ runMigrations: v })} label={t('adapters.options.runMigrations') || 'Run the database migrations'} description={t('adapters.options.runMigrationsDrupal') || 'drush updatedb then cache:rebuild after the deployment.'} />
        )}
      </div>
    );
  }
  return (
    <ToggleSwitch checked={draft.runMigrations} onChange={(v) => set({ runMigrations: v })} label={t('adapters.options.runMigrations') || 'Run the database migrations'} description={t('adapters.options.runMigrationsNextcloud') || 'occ upgrade after the deployment.'} />
  );
}

function invalidText(t: (k: string, o?: Record<string, unknown>) => string, invalid: string): string {
  return invalid === 'empty'
    ? (t('adapters.options.emptySelection') || 'Select at least one item, or choose « All » / « None ».')
    : t('adapters.options.invalidName', { name: invalid, defaultValue: 'Invalid name: {{name}}' });
}

/** « Update » with options: the update is applied on a copy of the release, then published through the pipeline. */
export function AdapterUpdateModal({ adapter, available, onClose, onRun }: {
  adapter: AdapterId | null;
  available: AdapterUpdate[];
  onClose: () => void;
  onRun: (adapter: AdapterId, options: AdapterRunOptions) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const name = useAdapterName();
  const [draft, setDraft] = useState<OptionsDraft>(() => toDraft(null, available));
  const [busy, setBusy] = useState(false);
  const key = adapter ?? '';
  useEffect(() => { if (adapter) setDraft(toDraft(null, available)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = adapter ? toOptions(adapter, draft) : null;

  return (
    <Modal
      open={adapter !== null}
      onClose={onClose}
      title={adapter ? t('adapters.updateTitle', { name: name(adapter), defaultValue: 'Update {{name}}' }) : ''}
      icon={<Download className="h-4 w-4 text-accent" />}
      size="lg"
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={busy} disabled={!result || result.invalid !== null} onClick={() => {
            if (!adapter || !result || result.invalid) return;
            setBusy(true);
            void onRun(adapter, result.options).then((ok) => { setBusy(false); if (ok) onClose(); });
          }}>
            <Download size={14} className="mr-1" />{t('adapters.update') || 'Update'}
          </Button>
        </>
      )}
    >
      {adapter && (
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {t('adapters.updateExplain') || 'The update runs on a COPY of the live release in a disposable container, is analyzed like a window, then published through the normal pipeline (health check, automatic rollback). The databases are snapshotted first.'}
          </p>
          <OptionsEditor adapter={adapter} draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} available={available} />
          {result?.invalid && <p className="text-xs text-status-down">{invalidText(t, result.invalid)}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Schedule of an adapter (cron + zone + options + enabled). */
export function AdapterScheduleModal({ adapter, schedule, available, onClose, onSave, onDelete }: {
  adapter: AdapterId | null;
  schedule: AdapterSchedule | null;
  available: AdapterUpdate[];
  onClose: () => void;
  onSave: (adapter: AdapterId, input: { cron: string; timezone: string; options: AdapterRunOptions; enabled: boolean }) => Promise<string | null>;
  onDelete: (adapter: AdapterId) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const name = useAdapterName();
  const human = useCronHuman();
  const [cron, setCron] = useState('0 4 * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [enabled, setEnabled] = useState(true);
  const [draft, setDraft] = useState<OptionsDraft>(() => toDraft(null, available));
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${adapter ?? ''}:${schedule?.updatedAt ?? ''}`;
  useEffect(() => {
    if (!adapter) return;
    setCron(schedule?.cron ?? '0 4 * * *');
    setTimezone(schedule?.timezone ?? browserTimezone());
    setEnabled(schedule?.enabled ?? true);
    setDraft(toDraft(schedule?.options ?? { minorOnly: true, core: true, plugins: 'all', themes: 'all', translations: true, runMigrations: true }, available));
    setError(null);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => (adapter ? toOptions(adapter, draft) : null), [adapter, draft]);
  const cronOk = isWindowCron(cron);
  const text = cronOk ? human(cron, timezone) : null;

  return (
    <Modal
      open={adapter !== null}
      onClose={onClose}
      title={adapter ? t('adapters.scheduleTitle', { name: name(adapter), defaultValue: 'Automatic updates — {{name}}' }) : ''}
      icon={<CalendarClock className="h-4 w-4 text-accent" />}
      size="lg"
      footer={(
        <>
          {schedule && adapter && (
            <Button size="sm" variant="ghost" className="mr-auto text-status-down" loading={busy === 'delete'} disabled={busy !== null} onClick={() => {
              setBusy('delete');
              void onDelete(adapter).then((ok) => { setBusy(null); if (ok) onClose(); });
            }}>
              <Trash2 size={14} className="mr-1" />{t('adapters.scheduleDelete') || 'Remove the schedule'}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={busy === 'save'} disabled={busy !== null || !cronOk || !result || result.invalid !== null} onClick={() => {
            if (!adapter || !result || result.invalid) return;
            setBusy('save');
            void onSave(adapter, { cron: cron.trim(), timezone, options: result.options, enabled }).then((err) => {
              setBusy(null);
              if (err === null) onClose(); else setError(err);
            });
          }}>
            {t('common.save') || 'Save'}
          </Button>
        </>
      )}
    >
      {adapter && (
        <div className="space-y-4">
          <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('adapters.scheduleEnabled') || 'Enabled'} />
          <ScheduleEditor idPrefix="ad-sched" cron={cron} timezone={timezone} onChange={(v) => { setCron(v.cron); setTimezone(v.timezone); }} />
          {text && <p className="text-xs text-text-secondary">{text}</p>}
          <div className="rounded-lg bg-bg-primary p-3">
            <OptionsEditor adapter={adapter} draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} available={available} />
          </div>
          {result?.invalid && <p className="text-xs text-status-down">{invalidText(t, result.invalid)}</p>}
          <p className="text-xs text-text-muted">{t('adapters.scheduleHint') || 'A scheduled update is published automatically when its analysis is clean; a blocked analysis is never published without a staff review.'}</p>
          {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
