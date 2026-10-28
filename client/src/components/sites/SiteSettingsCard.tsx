import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  APP_PROFILES, normalizePathPrefix, normalizeRelPath, siteBaseDef,
  type AppProfileId, type PhpSettings, type PublishMode, type SiteUpdate,
} from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { InfoTip } from '@/components/common/Tip';
import { PublishModeField } from './PublishModeField';
import { findDocrootDataPath, parseOptionalInt } from './siteForm';
import { siteErrorMessage } from './siteErrors';
import { cardCls, fieldCls, labelCls, sectionLabelCls } from './styles';
import type { SiteTabProps } from './tabs/types';

// Settings of a site, in two cards of the site page (coherence plan 1.3):
// « general » (name, profile, docroot, base path, health check, publication,
// custom nginx) in the Configuration tab, « php » (php.ini limits) in the
// Runtime & PHP tab. Each card saves its own fields only.

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

type Part = 'general' | 'php';

const PART_FIELDS: Record<Part, Array<keyof SettingsForm>> = {
  general: ['name', 'appProfile', 'docroot', 'basePath', 'publishMode', 'debounce', 'healthcheckPath', 'customNginx'],
  php: ['memoryLimitMb', 'uploadMaxFilesizeMb', 'postMaxSizeMb', 'maxExecutionTime'],
};

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

const sameFields = (a: SettingsForm, b: SettingsForm, part: Part) => PART_FIELDS[part].every((k) => a[k] === b[k]);

// Same ranges as the server (hostingValidation.service.ts phpSettingsError);
// memory_limit is further capped by the plan memory server-side.
const PHP_FIELDS: Array<{ key: keyof PhpSettings & keyof SettingsForm; min: number; max: number; unit: string }> = [
  { key: 'memoryLimitMb', min: 32, max: 2048, unit: 'MB' },
  { key: 'uploadMaxFilesizeMb', min: 1, max: 2048, unit: 'MB' },
  { key: 'postMaxSizeMb', min: 1, max: 2048, unit: 'MB' },
  { key: 'maxExecutionTime', min: 5, max: 3600, unit: 's' },
];

/** The site's base runs PHP (the « php » part has nothing to show otherwise). */
export function siteHasPhp(site: SiteTabProps['site']): boolean {
  return !!siteBaseDef(site.base).php;
}

export function SiteSettingsCard({ site, onSiteChange, part }: Pick<SiteTabProps, 'site' | 'onSiteChange'> & { part: Part }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const initial = useMemo(() => formFromSite(site), [site]);
  const [form, setForm] = useState<SettingsForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = !sameFields(form, initial, part);

  // Follow server-side changes while the form is untouched.
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    if (sameFields(form, lastInitial, part)) setForm(initial);
  }

  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isNginx = siteBaseDef(site.base).engine === 'nginx';
  const phpLabels: Record<string, string> = {
    memoryLimitMb: t('sites.php.memoryLimit') || 'memory_limit',
    uploadMaxFilesizeMb: t('sites.php.uploadMax') || 'upload_max_filesize',
    postMaxSizeMb: t('sites.php.postMax') || 'post_max_size',
    maxExecutionTime: t('sites.php.maxExecution') || 'max_execution_time',
  };

  /** The update of the general part, or an error message. */
  const generalUpdate = (): SiteUpdate | string => {
    const docroot = normalizeRelPath(form.docroot, true);
    const basePath = normalizePathPrefix(form.basePath);
    const debounce = Number(form.debounce);
    if (!form.name.trim()) return t('common.requiredField') || 'This field is required';
    if (docroot === null) return t('sites.form.docrootInvalid') || 'Invalid document root.';
    if (basePath === null) return t('sites.form.basePathInvalid') || 'Invalid base path.';
    if (form.publishMode === 'auto' && !(Number.isInteger(debounce) && debounce >= 5 && debounce <= 3600)) {
      return t('sites.form.debounceInvalid') || 'The delay must be between 5 and 3600 seconds.';
    }
    if (!/^\/[\x21-\x7e]{0,254}$/.test(form.healthcheckPath.trim())) {
      return t('sites.form.healthcheckInvalid') || 'The health check path must start with "/".';
    }
    return {
      name: form.name.trim(),
      appProfile: form.appProfile || null,
      docroot,
      basePath,
      publishMode: form.publishMode,
      ...(form.publishMode === 'auto' ? { publishDebounceSec: debounce } : {}),
      healthcheckPath: form.healthcheckPath.trim(),
      ...(isNginx ? { customNginx: form.customNginx.trim() ? form.customNginx : null } : {}),
    };
  };

  /** The update of the php part, or an error message. */
  const phpUpdate = (): SiteUpdate | string => {
    const php: PhpSettings = {};
    for (const f of PHP_FIELDS) {
      const v = parseOptionalInt(form[f.key], f.min, f.max);
      if (Number.isNaN(v)) {
        return t('sites.php.invalid', { field: phpLabels[f.key], min: f.min, max: f.max, defaultValue: '{{field}}: a whole number between {{min}} and {{max}}.' });
      }
      // The server merges PHP settings and cannot reset one: an emptied stored
      // value would silently come back after the save.
      if (v === undefined && site.php?.[f.key] != null) {
        return t('sites.php.cannotClear', { field: phpLabels[f.key], defaultValue: '{{field}}: a saved value cannot be emptied, enter a value.' });
      }
      if (v !== undefined) php[f.key] = v;
    }
    if (php.uploadMaxFilesizeMb !== undefined && php.postMaxSizeMb !== undefined && php.postMaxSizeMb < php.uploadMaxFilesizeMb) {
      return t('sites.php.postBelowUpload', {
        post: phpLabels.postMaxSizeMb, upload: phpLabels.uploadMaxFilesizeMb,
        defaultValue: '{{post}} must be greater than or equal to {{upload}}.',
      });
    }
    return { php };
  };

  const save = async () => {
    setError('');
    const data = part === 'general' ? generalUpdate() : phpUpdate();
    if (typeof data === 'string') { setError(data); return; }
    setSaving(true);
    try {
      // The image refuses a docroot that is (inside) a data path.
      if (data.docroot != null && data.docroot !== site.docroot) {
        const covering = findDocrootDataPath(data.docroot, (await sitesApi.dataPaths(site.id)).map((p) => p.path));
        if (covering !== null) {
          setError(t('sites.form.docrootInDataPath', { path: covering, defaultValue: 'The document root cannot be inside the data path {{path}}/.' }));
          return;
        }
      }
      const updated = await sitesApi.update(site.id, data);
      onSiteChange(updated);
      // The other part keeps what is being typed in its own card.
      setForm((f) => {
        const next = { ...f };
        const fresh = formFromSite(updated);
        for (const k of PART_FIELDS[part]) (next as Record<string, string>)[k] = fresh[k];
        return next;
      });
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;
  const reset = () => {
    setForm((f) => {
      const next = { ...f };
      for (const k of PART_FIELDS[part]) (next as Record<string, string>)[k] = initial[k];
      return next;
    });
    setError('');
  };

  return (
    <div className={cardCls}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {part === 'php' ? (t('sites.php.title') || 'PHP settings') : (t('sites.form.title') || 'Settings')}
        </h2>
        {!canManage && <span className="text-xs text-text-muted">{t('sites.form.readOnly') || 'Read only'}</span>}
      </div>

      <div className="space-y-5">
        {part === 'general' && (
          <>
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
          </>
        )}

        {part === 'php' && (
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
        )}

        {canManage && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
            {dirty && (
              <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
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
