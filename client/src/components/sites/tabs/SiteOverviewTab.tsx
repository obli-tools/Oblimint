import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock, FolderUp, RefreshCw, Rocket, ScanSearch, Timer, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import {
  APP_PROFILES, HostingSocketEvents, appProfileDef, normalizePathPrefix, normalizeRelPath, siteBaseDef,
  type AppProfileId, type PhpSettings, type ProfileDetection, type PublishMode, type SiteUpdate, type StagingStatus,
} from '@oblimint/shared';
import { releasesApi } from '@/api/releases.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { InfoTip } from '@/components/common/Tip';
import { BaseBadge, FileStatusIcon, Pill, PolicyBadge } from '../SiteBadges';
import { PublishModeField } from '../PublishModeField';
import { findDocrootDataPath, formatCountdown, formatDateTime, parseOptionalInt } from '../siteForm';
import { isNotImplemented, siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import { cardCls, fieldCls, labelCls, sectionLabelCls } from '../styles';
import type { SiteTabProps } from './types';

type GoTo = (tab: 'overview' | 'releases' | 'runtime' | 'routes' | 'data' | 'files', extra?: Record<string, string>) => void;

export function SiteOverviewTab(props: SiteTabProps & { onGoTo: GoTo }) {
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <div className="min-w-0 xl:col-span-3">
        <SettingsCard {...props} />
      </div>
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <StagingCard {...props} />
        <DetectCard {...props} />
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

interface SettingsForm {
  name: string;
  appProfile: AppProfileId | '';
  docroot: string;
  basePath: string;
  publishMode: PublishMode;
  debounce: string;
  healthcheckPath: string;
  memoryLimitMb: string;
  uploadMaxFilesizeMb: string;
  postMaxSizeMb: string;
  maxExecutionTime: string;
  customNginx: string;
}

function formFromSite(site: SiteTabProps['site']): SettingsForm {
  const n = (v: number | undefined) => (v == null ? '' : String(v));
  return {
    name: site.name,
    appProfile: site.appProfile ?? '',
    docroot: site.docroot,
    basePath: site.basePath,
    publishMode: site.publishMode,
    debounce: String(site.publishDebounceSec),
    healthcheckPath: site.healthcheckPath,
    memoryLimitMb: n(site.php?.memoryLimitMb),
    uploadMaxFilesizeMb: n(site.php?.uploadMaxFilesizeMb),
    postMaxSizeMb: n(site.php?.postMaxSizeMb),
    maxExecutionTime: n(site.php?.maxExecutionTime),
    customNginx: site.customNginx ?? '',
  };
}

// Same ranges as the server (hostingValidation.service.ts phpSettingsError);
// memory_limit is further capped by the plan memory server-side.
const PHP_FIELDS: Array<{ key: keyof PhpSettings & keyof SettingsForm; min: number; max: number; unit: string }> = [
  { key: 'memoryLimitMb', min: 32, max: 2048, unit: 'MB' },
  { key: 'uploadMaxFilesizeMb', min: 1, max: 2048, unit: 'MB' },
  { key: 'postMaxSizeMb', min: 1, max: 2048, unit: 'MB' },
  { key: 'maxExecutionTime', min: 5, max: 3600, unit: 's' },
];

function SettingsCard({ site, onSiteChange }: SiteTabProps) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const initial = useMemo(() => formFromSite(site), [site]);
  const [form, setForm] = useState<SettingsForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  // Follow server-side changes while the form is untouched.
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    if (JSON.stringify(form) === JSON.stringify(lastInitial)) setForm(initial);
  }

  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isNginx = siteBaseDef(site.base).engine === 'nginx';
  const phpLabels: Record<string, string> = {
    memoryLimitMb: t('sites.php.memoryLimit') || 'memory_limit',
    uploadMaxFilesizeMb: t('sites.php.uploadMax') || 'upload_max_filesize',
    postMaxSizeMb: t('sites.php.postMax') || 'post_max_size',
    maxExecutionTime: t('sites.php.maxExecution') || 'max_execution_time',
  };

  const save = async () => {
    setError('');
    const docroot = normalizeRelPath(form.docroot, true);
    const basePath = normalizePathPrefix(form.basePath);
    const debounce = Number(form.debounce);
    if (!form.name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (docroot === null) { setError(t('sites.form.docrootInvalid') || 'Invalid document root.'); return; }
    if (basePath === null) { setError(t('sites.form.basePathInvalid') || 'Invalid base path.'); return; }
    if (form.publishMode === 'auto' && !(Number.isInteger(debounce) && debounce >= 5 && debounce <= 3600)) {
      setError(t('sites.form.debounceInvalid') || 'The delay must be between 5 and 3600 seconds.'); return;
    }
    if (!/^\/[\x21-\x7e]{0,254}$/.test(form.healthcheckPath.trim())) {
      setError(t('sites.form.healthcheckInvalid') || 'The health check path must start with "/".'); return;
    }
    const php: PhpSettings = {};
    for (const f of PHP_FIELDS) {
      const v = parseOptionalInt(form[f.key], f.min, f.max);
      if (Number.isNaN(v)) {
        setError(t('sites.php.invalid', { field: phpLabels[f.key], min: f.min, max: f.max, defaultValue: '{{field}}: a whole number between {{min}} and {{max}}.' }));
        return;
      }
      // The server merges PHP settings and cannot reset one: an emptied stored
      // value would silently come back after the save.
      if (v === undefined && site.php?.[f.key] != null) {
        setError(t('sites.php.cannotClear', { field: phpLabels[f.key], defaultValue: '{{field}}: a saved value cannot be emptied, enter a value.' }));
        return;
      }
      if (v !== undefined) php[f.key] = v;
    }
    if (php.uploadMaxFilesizeMb !== undefined && php.postMaxSizeMb !== undefined && php.postMaxSizeMb < php.uploadMaxFilesizeMb) {
      setError(t('sites.php.postBelowUpload', {
        post: phpLabels.postMaxSizeMb, upload: phpLabels.uploadMaxFilesizeMb,
        defaultValue: '{{post}} must be greater than or equal to {{upload}}.',
      }));
      return;
    }
    const data: SiteUpdate = {
      name: form.name.trim(),
      appProfile: form.appProfile || null,
      docroot,
      basePath,
      publishMode: form.publishMode,
      ...(form.publishMode === 'auto' ? { publishDebounceSec: debounce } : {}),
      healthcheckPath: form.healthcheckPath.trim(),
      php,
      ...(isNginx ? { customNginx: form.customNginx.trim() ? form.customNginx : null } : {}),
    };
    setSaving(true);
    try {
      // The image refuses a docroot that is (inside) a data path.
      if (docroot !== site.docroot) {
        const covering = findDocrootDataPath(docroot, (await sitesApi.dataPaths(site.id)).map((p) => p.path));
        if (covering !== null) {
          setError(t('sites.form.docrootInDataPath', { path: covering, defaultValue: 'The document root cannot be inside the data path {{path}}/.' }));
          return;
        }
      }
      const updated = await sitesApi.update(site.id, data);
      onSiteChange(updated);
      setForm(formFromSite(updated));
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;

  return (
    <div className={cardCls}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{t('sites.form.title') || 'Settings'}</h2>
        {!canManage && <span className="text-xs text-text-muted">{t('sites.form.readOnly') || 'Read only'}</span>}
      </div>

      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="ov-name">{t('sites.fields.name') || 'Name'}</label>
            <input id="ov-name" value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldCls} disabled={disabled} maxLength={100} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ov-profile">{t('sites.fields.appProfile') || 'Application'}</label>
            <select id="ov-profile" value={form.appProfile} onChange={(e) => set('appProfile', e.target.value as AppProfileId | '')} className={fieldCls} disabled={disabled}>
              <option value="">{t('sites.profile.none') || 'Other / none'}</option>
              {APP_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.id === 'static' ? (t('sites.profile.static') || 'Static site') : p.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ov-docroot">
              {t('sites.fields.docroot') || 'Document root'}
              <InfoTip className="ml-1 align-middle" content={t('sites.form.docrootHint') || 'Folder of the release served by the web server, relative to its root (empty = the root; "public" for Laravel).'} />
            </label>
            <input id="ov-docroot" value={form.docroot} onChange={(e) => set('docroot', e.target.value)} className={`${fieldCls} font-mono`} placeholder={t('sites.form.rootPlaceholder') || '(root)'} disabled={disabled} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ov-basepath">
              {t('sites.fields.basePath') || 'Base path'}
              <InfoTip className="ml-1 align-middle" content={t('sites.form.basePathHint') || 'For a sub-site served under a prefix (e.g. /blog/): the path the application expects. "/" otherwise.'} />
            </label>
            <input id="ov-basepath" value={form.basePath} onChange={(e) => set('basePath', e.target.value)} className={`${fieldCls} font-mono`} disabled={disabled} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ov-health">
              {t('sites.fields.healthcheckPath') || 'Health check path'}
              <InfoTip className="ml-1 align-middle" content={t('sites.form.healthcheckHint') || 'Requested after each publication: an answer below 500 validates the release, otherwise the previous one is restored.'} />
            </label>
            <input id="ov-health" value={form.healthcheckPath} onChange={(e) => set('healthcheckPath', e.target.value)} className={`${fieldCls} font-mono`} disabled={disabled} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
        </div>

        <PublishModeField
          mode={form.publishMode}
          onModeChange={(m) => set('publishMode', m)}
          debounce={form.debounce}
          onDebounceChange={(v) => set('debounce', v)}
          disabled={disabled}
          autoDisabled={site.publishMode !== 'auto' && !can('releases.publish', site.accountId)}
        />

        {siteBaseDef(site.base).php && (
          <div>
            <div className={sectionLabelCls}>{t('sites.php.title') || 'PHP settings'}</div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {PHP_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className={`${labelCls} truncate font-mono`} htmlFor={`ov-${f.key}`}>
                    {phpLabels[f.key]} <span className="text-[10px] text-text-muted/80">({f.unit})</span>
                  </label>
                  <input
                    id={`ov-${f.key}`}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    value={form[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={site.php?.[f.key] == null ? (t('sites.php.default') || 'default') : undefined}
                    className={`${fieldCls} font-mono`}
                    disabled={disabled}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {isNginx && (
          <div>
            <div className={sectionLabelCls}>{t('sites.nginx.title') || 'Custom nginx rules'}</div>
            <textarea
              value={form.customNginx}
              onChange={(e) => set('customNginx', e.target.value)}
              rows={6}
              disabled={disabled}
              spellCheck={false}
              placeholder={'location /api/ {\n    try_files $uri /index.php?$query_string;\n}'}
              className={`${fieldCls} resize-y font-mono text-xs leading-relaxed`}
            />
            <p className="mt-1 text-xs text-text-muted">
              {t('sites.nginx.note') || 'Included in the server block of the site container only (never in the shared edge). Invalid rules are ignored at start-up and reported in the container log.'}
            </p>
          </div>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => { setForm(initial); setError(''); }} disabled={saving}>
                {t('common.cancel') || 'Cancel'}
              </Button>
            )}
            <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
              <Check size={14} className="mr-1" />
              {t('common.save') || 'Save'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Staging ──────────────────────────────────────────────────────────────────

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [active]);
  return now;
}

const STAGING_LIST_MAX = 50;

function StagingCard({ site, onPublish }: SiteTabProps) {
  const { t, i18n } = useTranslation();
  const { can } = useHostingMe();
  const [staging, setStaging] = useState<StagingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** Set on a 501: the endpoint is not wired on this server, stop polling it. */
  const unavailable = useRef(false);

  const load = useCallback(async () => {
    try {
      setStaging(await releasesApi.staging(site.id));
      setError('');
    } catch (err) {
      if (isNotImplemented(err)) unavailable.current = true;
      setError(isNotImplemented(err) ? (t('sites.errors.notImplemented') || 'This feature is not available on this server yet.') : siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { void load(); }, [load]);
  // SFTP uploads do not emit a socket event: poll while the tab is open.
  useEffect(() => {
    const h = window.setInterval(() => { if (document.visibilityState === 'visible' && !unavailable.current) void load(); }, 20_000);
    return () => window.clearInterval(h);
  }, [load]);
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RELEASE_UPDATED, (p) => { if (p.siteId === site.id) void load(); });

  const deadline = staging?.autoPublishAt ? new Date(staging.autoPublishAt).getTime() : null;
  const now = useNow(deadline !== null);
  const remaining = deadline !== null ? Math.max(0, (deadline - now) / 1000) : null;

  return (
    <div className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <FolderUp className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('sites.staging.title') || 'Staging folder'}</h2>
        <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-3.5 w-3.5" />} size="sm" onClick={() => void load()} />
      </div>
      <p className="mb-3 font-mono text-xs text-text-muted break-all">/staging/{site.slug}/</p>

      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : error ? (
        <p className="text-sm text-text-muted">{error}</p>
      ) : staging && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-display text-3xl font-semibold tabular-nums text-text-primary">{staging.pendingChanges}</span>
            <span className="text-sm text-text-secondary">
              {t('sites.staging.pending', { count: staging.pendingChanges, defaultValue: 'pending change(s)' })}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {t('sites.staging.lastUpload') || 'Last upload:'} <span className="font-mono">{formatDateTime(staging.lastUploadAt, i18n.language)}</span>
            </span>
            {remaining !== null && site.publishMode === 'auto' && (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <Timer className="h-3.5 w-3.5" />
                {t('sites.staging.autoPublishIn') || 'Automatic publication in'} <span className="font-mono tabular-nums">{formatCountdown(remaining)}</span>
              </span>
            )}
          </div>

          {stagingRestoreText(t, staging) && (
            <p className={`rounded-lg px-3 py-2 text-xs ${staging.restore?.status === 'failed' ? 'bg-red-400/10 text-red-400' : 'bg-bg-tertiary/60 text-text-secondary'}`}>
              {stagingRestoreText(t, staging)}
            </p>
          )}

          {staging.warnings.length > 0 && (
            <ul className="space-y-1">
              {stagingWarningTexts(t, staging).map((w) => (
                <li key={w} className="flex items-start gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{w}</span>
                </li>
              ))}
            </ul>
          )}

          {staging.files.length > 0 && (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto overscroll-contain rounded-lg bg-bg-tertiary/50 p-2">
              {staging.files.slice(0, STAGING_LIST_MAX).map((f) => (
                <li key={`${f.status}:${f.path}`} className="flex min-w-0 items-center gap-2 text-xs">
                  <FileStatusIcon status={f.status} />
                  <span className="truncate font-mono text-text-secondary" title={f.path}>{f.path}</span>
                </li>
              ))}
              {(staging.truncated || staging.files.length > STAGING_LIST_MAX) && (
                <li className="pt-1 text-[11px] text-text-muted">{t('sites.staging.truncated') || 'List truncated.'}</li>
              )}
            </ul>
          )}

          {staging.pendingChanges > 0 && can('releases.publish', site.accountId) && (
            <Button size="sm" onClick={onPublish} className="w-full sm:w-auto">
              <Rocket size={14} className="mr-1" />
              {t('releases.publish.button') || 'Publish'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Application detection ────────────────────────────────────────────────────

function DetectCard({ site, onSiteChange, onGoTo }: SiteTabProps & { onGoTo: GoTo }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const [detection, setDetection] = useState<ProfileDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [applying, setApplying] = useState(false);

  const detect = async () => {
    setDetecting(true);
    try {
      setDetection(await releasesApi.detectProfile(site.id));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setDetecting(false);
    }
  };

  const applyProfile = async () => {
    if (!detection?.profile) return;
    setApplying(true);
    try {
      const paths = await sitesApi.applyProfile(site.id, detection.profile);
      if (site.appProfile !== detection.profile) onSiteChange(await sitesApi.update(site.id, { appProfile: detection.profile }));
      // applyProfile returns every data path of the site, not only the added ones.
      toast.success(t('sites.detect.applied', { count: paths.length, defaultValue: 'Profile applied ({{count}} data paths in total)' }));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setApplying(false);
    }
  };

  const applyDocroot = async () => {
    if (detection?.suggestedDocroot == null) return;
    const docroot = detection.suggestedDocroot;
    try {
      const covering = findDocrootDataPath(docroot, (await sitesApi.dataPaths(site.id)).map((p) => p.path));
      if (covering !== null) {
        toast.error(t('sites.form.docrootInDataPath', { path: covering, defaultValue: 'The document root cannot be inside the data path {{path}}/.' }));
        return;
      }
      onSiteChange(await sitesApi.update(site.id, { docroot }));
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      toastSiteError(err, t);
    }
  };

  const profileLabel = (id: AppProfileId) => (id === 'static' ? (t('sites.profile.static') || 'Static site') : appProfileDef(id).label);

  return (
    <div className={cardCls}>
      <div className="mb-2 flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('sites.detect.title') || 'Application detection'}</h2>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        {t('sites.detect.explain') || 'Looks for well-known files in the staging folder to recognise the application and suggest its base and data paths.'}
      </p>
      <Button variant="secondary" size="sm" onClick={detect} loading={detecting}>
        <Wand2 size={14} className="mr-1" />
        {t('sites.detect.button') || 'Detect the application'}
      </Button>

      {detection && (
        <div className="mt-4 space-y-3 rounded-lg bg-bg-tertiary/60 p-3">
          {!detection.profile ? (
            <p className="text-sm text-text-secondary">{t('sites.detect.none') || 'No known application found in the staging folder.'}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text-secondary">{t('sites.detect.found') || 'Detected:'}</span>
                <Pill tone="accent">{profileLabel(detection.profile)}</Pill>
                {site.appProfile === detection.profile && <Pill tone="green"><Check className="h-3 w-3" />{t('sites.detect.current') || 'current profile'}</Pill>}
              </div>
              {detection.markers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detection.markers.map((m) => <code key={m} className="rounded bg-bg-primary/60 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">{m}</code>)}
                </div>
              )}

              {detection.suggestedDataPaths.length > 0 && (
                <div>
                  <div className={sectionLabelCls}>{t('sites.detect.dataPaths') || 'Suggested data paths'}</div>
                  <ul className="space-y-1">
                    {detection.suggestedDataPaths.map((d) => (
                      <li key={d.path} className="flex flex-wrap items-center gap-2 text-xs">
                        <code className="font-mono text-text-primary">{d.path}/</code>
                        <PolicyBadge policy={d.policy} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {canManage && (
                <div className="flex flex-col gap-2">
                  <Button size="sm" onClick={applyProfile} loading={applying}>
                    {t('sites.detect.apply') || 'Apply this profile (data paths)'}
                  </Button>
                  {detection.suggestedDocroot != null && detection.suggestedDocroot !== site.docroot && (
                    <Button size="sm" variant="secondary" onClick={() => void applyDocroot()}>
                      {t('sites.detect.useDocroot', { docroot: detection.suggestedDocroot || '/', defaultValue: 'Use the document root "{{docroot}}"' })}
                    </Button>
                  )}
                  {detection.suggestedBase && detection.suggestedBase !== site.base && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      <span>{t('sites.detect.suggestedBase') || 'Recommended base:'}</span>
                      <BaseBadge base={detection.suggestedBase} compact />
                      <Button size="sm" variant="ghost" onClick={() => onGoTo('runtime', { switchTo: detection.suggestedBase! })}>
                        {t('sites.detect.switchBase') || 'Switch…'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Staging warnings, translated from their codes (server French text as a last resort). */
function stagingWarningTexts(t: TFunction, staging: StagingStatus): string[] {
  const items = staging.warningItems;
  if (!Array.isArray(items) || items.length === 0) return staging.warnings;
  return items.map((w, i) => {
    switch (w.code) {
      case 'stagingMissing': return t('sites.staging.warnings.stagingMissing') || 'The staging folder does not exist yet.';
      case 'nestedRepo': return t('sites.staging.warnings.nestedRepo', { path: w.path ?? '' }) || `Nested git repository (excluded from publications): ${w.path ?? ''}`;
      case 'symlink': return t('sites.staging.warnings.symlink', { path: w.path ?? '' }) || `Symbolic link: ${w.path ?? ''}`;
      case 'moreSymlinks': return t('sites.staging.warnings.moreSymlinks', { count: w.count ?? 0 }) || `… and ${w.count ?? 0} more symbolic link(s)`;
      case 'liveOlderThanBase': return t('sites.staging.warnings.liveOlderThanBase', { releaseNumber: w.releaseNumber ?? '?', baseNumber: w.baseNumber ?? '?' })
        || `Rollback: the live release #${w.releaseNumber ?? '?'} is older than #${w.baseNumber ?? '?'}, whose code the staging still holds. Publishing it as is would undo the rollback: copy the live release into the staging first.`;
      case 'baseNotPublished': return t('sites.staging.warnings.baseNotPublished', { baseNumber: w.baseNumber ?? '?', status: w.status ?? '' })
        || `The staging was last committed as release #${w.baseNumber ?? '?'}, which is not live (${w.status ?? ''}).`;
      case 'autoPublishHeld': return t('sites.staging.warnings.autoPublishHeld', { count: w.count ?? 0, releaseNumber: w.releaseNumber ?? '?' })
        || `Automatic publication held: the staging would put back online ${w.count ?? 0} file(s) of release #${w.releaseNumber ?? '?'}, undone by a rollback. Publish manually or copy the live release into the staging.`;
      default: return staging.warnings[i] ?? '';
    }
  }).filter(Boolean);
}

/** Copy of a release into the staging, running or finished (StagingStatus.restore). */
function stagingRestoreText(t: TFunction, staging: StagingStatus): string | null {
  const r = staging.restore;
  if (!r) return null;
  if (r.status === 'running') return t('sites.staging.restore.running', { number: r.releaseNumber }) || `Copying release #${r.releaseNumber} into the staging…`;
  if (r.status === 'failed') return t('sites.staging.restore.failed', { number: r.releaseNumber }) || `The copy of release #${r.releaseNumber} into the staging failed.`;
  const done = t('sites.staging.restore.done', { number: r.releaseNumber, remaining: r.result?.remaining ?? 0 })
    || `Release #${r.releaseNumber} copied into the staging (${r.result?.remaining ?? 0} path(s) still differing).`;
  const lost = r.result?.modeLostCount ?? 0;
  if (!lost) return done;
  const paths = (r.result?.modeLost ?? []).slice(0, 5).join(', ');
  return `${done} ${t('sites.staging.restore.modeLost', { count: lost, paths })
    || `${lost} file(s) were copied without their executable bit (${paths}…): make them executable again in the staging (chmod +x over SFTP) before publishing.`}`;
}
