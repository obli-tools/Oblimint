import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Code2, GitPullRequestArrow, Upload } from 'lucide-react';
import type {
  AppDeployment, AppMaintenanceWindow, AppSleepPolicy, AppStackDetail, AppStackUpdate, AppTemplateDetail, AppUpdatePolicy,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { automationApi } from '@/api/automation.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Card, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { appsErrorMessage, toastAppsError } from '../appsErrors';
import { formatDateTime, shortSha } from '../appsFormat';
import { GitSourceForm, gitDraftFrom, gitDraftOut, gitDraftProblem, gitTokenMissing, type GitDraft } from '../GitSourceForm';
import { RegistryPicker } from '../RegistryPicker';
import { TemplateFieldsForm, fieldValuesOut, firstFieldProblem, initialFieldValues, type FieldValues } from '../TemplateFieldsForm';

type SaveFn = (patch: AppStackUpdate) => Promise<boolean>;

/** Settings of a stack: general, updates (+ maintenance window), sleep, source (git / ZIP / catalog values), registries. */
export function AppSettingsTab({ stack, buildAllowed, onSaved, onStarted }: {
  stack: AppStackDetail;
  buildAllowed: boolean;
  onSaved: (s: AppStackDetail) => void;
  onStarted: (d: AppDeployment) => void;
}) {
  const { t } = useTranslation();
  const save: SaveFn = async (patch) => {
    try {
      onSaved(await appsApi.updateStack(stack.id, patch));
      toast.success(t('apps.settings.saved') || 'Settings saved');
      return true;
    } catch (err) {
      toastAppsError(t, err, t('apps.settings.saveFailed') || 'Failed to save the settings');
      return false;
    }
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <GeneralSection stack={stack} save={save} />
        <SourceSection stack={stack} buildAllowed={buildAllowed} save={save} onSaved={onSaved} onStarted={onStarted} />
        <RegistriesSection stack={stack} save={save} />
      </div>
      <div className="min-w-0 space-y-4">
        <UpdatesSection stack={stack} save={save} />
        <SleepSection stack={stack} save={save} />
      </div>
    </div>
  );
}

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useTranslation();
  if (!dirty) return null;
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button size="sm" variant="secondary" disabled={saving} onClick={onReset}>{t('common.cancel') || 'Cancel'}</Button>
      <Button size="sm" loading={saving} onClick={onSave}>{t('common.save') || 'Save'}</Button>
    </div>
  );
}

/** Local draft following the server value until edited. */
function useDraft<T>(value: T): [T, (patch: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T>(value);
  const key = JSON.stringify(value);
  useEffect(() => { setDraft(value); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, (patch) => setDraft((d) => ({ ...d, ...patch })), JSON.stringify(draft) !== key, () => setDraft(value)];
}

function GeneralSection({ stack, save }: { stack: AppStackDetail; save: SaveFn }) {
  const { t } = useTranslation();
  const [d, set, dirty, reset] = useDraft({ displayName: stack.displayName, description: stack.description ?? '' });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!d.displayName.trim()) { toast.error(t('common.requiredField') || 'This field is required'); return; }
    setSaving(true);
    await save({ displayName: d.displayName.trim(), description: d.description.trim() || null });
    setSaving(false);
  };
  return (
    <Card title={t('apps.create.general') || 'General'}>
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="set-display">{t('apps.create.displayName') || 'Display name'}</label>
          <input id="set-display" value={d.displayName} onChange={(e) => set({ displayName: e.target.value })} className={inputCls} maxLength={100} />
        </div>
        <div>
          <label className={labelCls} htmlFor="set-desc">{t('apps.create.description') || 'Description'}</label>
          <input id="set-desc" value={d.description} onChange={(e) => set({ description: e.target.value })} className={inputCls} maxLength={500} />
        </div>
        <p className="font-mono text-[11px] text-text-muted">{t('apps.create.name') || 'Identifier'}: {stack.name}</p>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => { void submit(); }} onReset={reset} />
    </Card>
  );
}

function UpdatesSection({ stack, save }: { stack: AppStackDetail; save: SaveFn }) {
  const { t, i18n } = useTranslation();
  const [d, set, dirty, reset] = useDraft<AppUpdatePolicy>(stack.updatePolicy);
  const [interval, setInterval_] = useState(String(stack.updatePolicy.checkIntervalMin));
  const [windows, setWindows] = useState<AppMaintenanceWindow[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setInterval_(String(stack.updatePolicy.checkIntervalMin)); }, [stack.updatePolicy.checkIntervalMin]);
  useEffect(() => {
    let cancelled = false;
    automationApi.listWindows({ accountId: stack.accountId })
      .then((l) => { if (!cancelled) setWindows(l.filter((w) => w.enabled)); })
      .catch(() => { if (!cancelled) setWindows([]); });
    return () => { cancelled = true; };
  }, [stack.accountId]);
  const intervalDirty = interval !== String(stack.updatePolicy.checkIntervalMin);
  const submit = async () => {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 5 || n > 10080) { toast.error(t('apps.settings.checkIntervalRange') || 'Check interval: between 5 and 10080 minutes.'); return; }
    setSaving(true);
    await save({ updatePolicy: { ...d, checkIntervalMin: n } });
    setSaving(false);
  };
  const current = windows.find((w) => w.id === d.maintenanceWindowId);
  return (
    <Card title={t('apps.settings.updates') || 'Image updates'}>
      <div className="space-y-3">
        <ToggleSwitch checked={d.autoUpdate} onChange={(c) => set({ autoUpdate: c })} label={t('apps.settings.autoUpdate') || 'Automatic updates'} description={t('apps.settings.autoUpdateHint') || 'New images are applied inside the maintenance window, with an automatic return to the previous image if a service does not become healthy.'} />
        <ToggleSwitch checked={d.notify} onChange={(c) => set({ notify: c })} label={t('apps.settings.notify') || 'Notify the new images'} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="set-interval">{t('apps.settings.checkEvery') || 'Check every'} ({t('apps.settings.minutesShort') || 'min'})</label>
            <input id="set-interval" type="number" min="5" inputMode="numeric" value={interval} onChange={(e) => setInterval_(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="set-window">{t('apps.settings.window') || 'Maintenance window'}</label>
            <select id="set-window" value={d.maintenanceWindowId ?? ''} onChange={(e) => set({ maintenanceWindowId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              <option value="">{t('apps.settings.windowDefault') || 'Default window (or any time)'}</option>
              {windows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ` (${t('automation.windows.default') || 'default'})` : ''}</option>)}
            </select>
          </div>
        </div>
        {current && (
          <p className="text-xs text-text-muted">
            {current.openNow ? (t('automation.windows.openNow') || 'Open now') : t('automation.windows.nextOpen', { date: formatDateTime(current.nextOpenAt, i18n.language), defaultValue: 'Next opening: {{date}}' })}
            {' · '}<Link to="/automation?tab=maintenance-windows" className="text-accent hover:underline">{t('apps.settings.manageWindows') || 'Manage the windows'}</Link>
          </p>
        )}
        {!current && <Link to="/automation?tab=maintenance-windows" className="text-xs text-accent hover:underline">{t('apps.settings.manageWindows') || 'Manage the windows'}</Link>}
      </div>
      <SaveBar dirty={dirty || intervalDirty} saving={saving} onSave={() => { void submit(); }} onReset={() => { reset(); setInterval_(String(stack.updatePolicy.checkIntervalMin)); }} />
    </Card>
  );
}

function SleepSection({ stack, save }: { stack: AppStackDetail; save: SaveFn }) {
  const { t } = useTranslation();
  const toForm = (p: AppSleepPolicy) => ({ enabled: p.enabled, idle: String(p.idleMinutes), mode: p.mode, timeout: String(p.wakeTimeoutSec), readyPath: p.readyPath ?? '' });
  const [d, set, dirty, reset] = useDraft(toForm(stack.sleepPolicy));
  const [saving, setSaving] = useState(false);
  const exposed = stack.proxyHosts.length > 0;
  const submit = async () => {
    const idle = Number(d.idle);
    const timeout = Number(d.timeout);
    if (!Number.isInteger(idle) || idle < 5 || idle > 10080) { toast.error(t('apps.settings.idleRange') || 'Idle time: between 5 and 10080 minutes.'); return; }
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600) { toast.error(t('apps.settings.wakeTimeoutRange') || 'Wake-up timeout: between 10 and 600 seconds.'); return; }
    if (d.readyPath && !d.readyPath.startsWith('/')) { toast.error(t('apps.settings.readyPathInvalid') || 'The readiness path must start with /.'); return; }
    setSaving(true);
    await save({ sleepPolicy: { enabled: d.enabled, idleMinutes: idle, mode: d.mode, wakeTimeoutSec: timeout, readyPath: d.readyPath.trim() || null } });
    setSaving(false);
  };
  return (
    <Card title={t('apps.settings.sleep') || 'Sleep when idle'}>
      <div className="space-y-3">
        <ToggleSwitch
          checked={d.enabled}
          onChange={(c) => set({ enabled: c })}
          label={t('apps.settings.sleepEnabled') || 'Put the application to sleep when idle'}
          description={t('apps.settings.sleepHint') || 'Without proxied request for the idle time, the containers stop; the first request wakes them up behind a waiting page.'}
        />
        {!exposed && d.enabled && <p className="text-xs text-amber-400">{t('apps.settings.sleepNoProxy') || 'No proxy host targets this application: nothing would wake it up.'}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="set-idle">{t('apps.settings.idleMinutes') || 'Idle time (min)'}</label>
            <input id="set-idle" type="number" min="5" inputMode="numeric" value={d.idle} disabled={!d.enabled} onChange={(e) => set({ idle: e.target.value })} className={cn(inputCls, 'font-mono')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="set-mode">{t('apps.settings.sleepMode') || 'Mode'}</label>
            <select id="set-mode" value={d.mode} disabled={!d.enabled} onChange={(e) => set({ mode: e.target.value as 'stop' | 'pause' })} className={selectCls}>
              <option value="stop">{t('apps.settings.modeStop') || 'Stop (frees the memory)'}</option>
              <option value="pause">{t('apps.settings.modePause') || 'Pause (faster wake-up)'}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="set-timeout">{t('apps.settings.wakeTimeout') || 'Wake-up timeout (s)'}</label>
            <input id="set-timeout" type="number" min="10" inputMode="numeric" value={d.timeout} disabled={!d.enabled} onChange={(e) => set({ timeout: e.target.value })} className={cn(inputCls, 'font-mono')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="set-ready">{t('apps.settings.readyPath') || 'Readiness path (HTTP)'}</label>
            <input id="set-ready" value={d.readyPath} disabled={!d.enabled} onChange={(e) => set({ readyPath: e.target.value })} placeholder={t('apps.settings.readyPathNone') || 'empty = TCP connection'} className={cn(inputCls, 'font-mono')} />
          </div>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => { void submit(); }} onReset={reset} />
    </Card>
  );
}

function SourceSection({ stack, buildAllowed, save, onSaved, onStarted }: {
  stack: AppStackDetail;
  buildAllowed: boolean;
  save: SaveFn;
  onSaved: (s: AppStackDetail) => void;
  onStarted: (d: AppDeployment) => void;
}) {
  const { t } = useTranslation();
  let body: ReactNode = null;
  if (stack.sourceType === 'git') body = <GitSettings stack={stack} buildAllowed={buildAllowed} save={save} onStarted={onStarted} />;
  else if (stack.sourceType === 'zip') body = <ZipSettings stack={stack} onSaved={onSaved} />;
  else if (stack.sourceType === 'catalog') body = <CatalogSettings stack={stack} save={save} />;
  else {
    body = (
      <Link to={`/apps/${stack.id}/edit`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
        <Code2 size={14} />{t('apps.list.editCompose') || 'Edit the compose'}
      </Link>
    );
  }
  return <Card title={t('apps.overview.source') || 'Source'}>{body}</Card>;
}

function GitSettings({ stack, buildAllowed, save, onStarted }: { stack: AppStackDetail; buildAllowed: boolean; save: SaveFn; onStarted: (d: AppDeployment) => void }) {
  const { t, i18n } = useTranslation();
  const initial = gitDraftFrom(stack.git);
  const [draft, setDraft] = useState<GitDraft>(initial);
  const key = JSON.stringify(stack.git);
  useEffect(() => { setDraft(gitDraftFrom(stack.git)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(gitDraftFrom(stack.git));
  const [saving, setSaving] = useState(false);
  const [pulling, setPulling] = useState(false);
  const submit = async () => {
    const p = gitDraftProblem(t, draft)
      ?? (gitTokenMissing(draft, stack.git) ? (t('apps.git.tokenRequired') || 'The repository changed: the stored token is not sent to another repository. Enter its access token again, or remove the stored token.') : null);
    if (p) { toast.error(p); return; }
    setSaving(true);
    await save({ git: gitDraftOut(draft) });
    setSaving(false);
  };
  const pull = async (deploy: boolean) => {
    setPulling(true);
    try {
      const r = await appsApi.pullGit(stack.id, deploy);
      if (r.deployment) onStarted(r.deployment);
      toast.success(r.changed
        ? t('apps.git.pulledNew', { commit: shortSha(r.commit), defaultValue: 'New commit {{commit}} fetched' })
        : (t('apps.git.pulledSame') || 'No new commit'));
    } catch (err) {
      toastAppsError(t, err, t('apps.git.pullFailed') || 'Failed to fetch the repository');
    } finally {
      setPulling(false);
    }
  };
  return (
    <div className="space-y-3">
      {stack.git && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>{t('apps.overview.commit') || 'Commit'} <span className="font-mono text-text-secondary">{shortSha(stack.git.lastCommit)}</span></span>
          {stack.git.lastCheckedAt && <span>· {t('apps.git.checkedAt', { date: formatDateTime(stack.git.lastCheckedAt, i18n.language), defaultValue: 'checked {{date}}' })}</span>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" loading={pulling} onClick={() => { void pull(false); }}><GitPullRequestArrow size={13} className="mr-1" />{t('apps.git.pull') || 'Fetch'}</Button>
            <Button size="sm" variant="secondary" disabled={pulling} onClick={() => { void pull(true); }}>{t('apps.git.pullDeploy') || 'Fetch and deploy'}</Button>
          </div>
        </div>
      )}
      {stack.git?.lastError && <p className="text-xs text-status-down">{stack.git.lastError}</p>}
      <GitSourceForm value={draft} onChange={setDraft} buildAllowed={buildAllowed} hasToken={stack.git?.hasToken ?? false} stored={stack.git} idPrefix="set-git" />
      <SaveBar dirty={dirty} saving={saving} onSave={() => { void submit(); }} onReset={() => setDraft(gitDraftFrom(stack.git))} />
    </div>
  );
}

function ZipSettings({ stack, onSaved }: { stack: AppStackDetail; onSaved: (s: AppStackDetail) => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const upload = async () => {
    if (!file) return;
    setPct(0);
    try {
      onSaved(await appsApi.uploadZip(stack.id, file, setPct));
      setFile(null);
      toast.success(t('apps.settings.zipUploaded') || 'Archive uploaded');
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(appsErrorMessage(t, err, t('apps.create.zipFailed') || 'The archive upload failed: upload it again from the application settings.'), { duration: 7000 });
    } finally {
      setPct(null);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">{t('apps.settings.zipHint') || 'Replace the files of the application with a new archive. The compose file is validated again; deploy afterwards to apply it.'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary hover:bg-bg-hover">
          <Upload size={14} />{file ? file.name : (t('apps.create.zipPick') || 'Choose a .zip archive')}
          <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <Button size="sm" disabled={!file} loading={pct !== null} onClick={() => { void upload(); }}>{t('apps.settings.zipUpload') || 'Upload'}</Button>
      </div>
      {pct !== null && <div className="h-1.5 w-full rounded bg-bg-tertiary"><div className="h-full rounded bg-accent transition-all" style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

function CatalogSettings({ stack, save }: { stack: AppStackDetail; save: SaveFn }) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<AppTemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<FieldValues>({});
  const [base, setBase] = useState<FieldValues>({});
  const [saving, setSaving] = useState(false);
  const slug = stack.catalogSource?.templateSlug ?? stack.catalog?.slug ?? null;
  const sourceKey = JSON.stringify(stack.catalogSource);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    appsApi.getTemplate(slug)
      .then((tpl) => {
        if (cancelled) return;
        const init = initialFieldValues(tpl.fields, stack.catalogSource?.values ?? {});
        setTemplate(tpl);
        setValues(init);
        setBase(init);
      })
      .catch((err) => { if (!cancelled) setError(appsErrorMessage(t, err, t('apps.catalog.loadFailed') || 'Failed to load the catalog')); });
    return () => { cancelled = true; };
  }, [slug, sourceKey, t]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!slug) return null;
  if (error) return <p className="text-sm text-status-down">{error}</p>;
  if (!template) return <div className="flex justify-center py-6"><LoadingSpinner /></div>;
  const dirty = JSON.stringify(values) !== JSON.stringify(base);
  const submit = async () => {
    const p = firstFieldProblem(t, template.fields, values, true);
    if (p) { toast.error(p); return; }
    setSaving(true);
    if (await save({ catalogValues: fieldValuesOut(template.fields, values) })) setBase(values);
    setSaving(false);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">{t('apps.settings.catalogHint', { name: template.name, version: stack.catalogSource?.templateVersion ?? template.version, defaultValue: 'Template {{name}} {{version}}. Saving renders the compose file again; deploy afterwards to apply it.' })}</p>
      <TemplateFieldsForm fields={template.fields} values={values} onChange={setValues} keepSecrets idPrefix="set-tpl" />
      <SaveBar dirty={dirty} saving={saving} onSave={() => { void submit(); }} onReset={() => setValues(base)} />
    </div>
  );
}

function RegistriesSection({ stack, save }: { stack: AppStackDetail; save: SaveFn }) {
  const { t } = useTranslation();
  const [ids, setIds] = useState<number[]>(stack.registryCredentialIds);
  const [saving, setSaving] = useState(false);
  const key = stack.registryCredentialIds.join(',');
  useEffect(() => { setIds(stack.registryCredentialIds); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = [...ids].sort().join(',') !== [...stack.registryCredentialIds].sort().join(',');
  return (
    <Card title={t('apps.tabs.registries') || 'Registries'}>
      <RegistryPicker accountId={stack.accountId} value={ids} onChange={setIds} />
      <p className="mt-2 text-xs text-text-muted">
        {t('apps.settings.registriesHint') || 'Credentials of the account used to pull private images.'}{' '}
        <Link to={`/apps?tab=registries&account=${stack.accountId}`} className="text-accent hover:underline">{t('apps.settings.manageRegistries') || 'Manage'}</Link>
      </p>
      <SaveBar dirty={dirty} saving={saving} onSave={() => { setSaving(true); void save({ registryCredentialIds: ids }).finally(() => setSaving(false)); }} onReset={() => setIds(stack.registryCredentialIds)} />
    </Card>
  );
}
