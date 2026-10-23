import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Mail, Boxes } from 'lucide-react';
import type { DbEngine, DbTuningProfile, OverQuotaAction, Plan, PlanInput, PlanLimits, SiteBaseId, SiteEngine } from '@oblimint/shared';
import { DB_ENGINE_VERSIONS, DB_PROFILE_MEMORY_MB, DEFAULT_PLAN_LIMITS, SITE_BASES } from '@oblimint/shared';
import { plansApi } from '@/api/plans.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { cn } from '@/utils/cn';
import { inputCls, labelCls, sectionTitleCls, hostingErrorMessage, isStepUpHandled } from './hostingUi';
import { PhpBranchBadges } from '@/components/sites/SiteBadges';
import { limitToField, parseLimitField } from './hostingFormat';

// P2 non-numeric / non-nullable limits are edited separately (module ui-ops).
type NumKey = Exclude<keyof PlanLimits, 'allowedBases' | 'dbProfile' | 'dbEngines' | 'dbExternalAccess' | 'overQuotaAction' | 'cronMinIntervalMin'
  // P4 (ui-mail adds the mail fields): non-nullable, edited outside the numeric fields.
  | 'mailMaxMessageSizeMb'
  // P4b (ui-apps adds the apps / proxy / monitoring fields): non-nullable or boolean, edited outside the numeric fields.
  | 'appsPidsPerContainer' | 'appsBuild' | 'appsConsole' | 'proxyExternalTargets'>;

interface FieldDef {
  key: NumKey;
  label: string;
  unit?: string;
  /** Form unit → MiB multiplier (GB fields). */
  multiplier?: number;
  integer?: boolean;
  step?: string;
  /** Label of the "no value" toggle (default: unlimited). */
  nullLabel?: string;
}

type FieldState = { value: string; none: boolean };
type FormState = Record<NumKey, FieldState>;

const MIB_PER_GB = 1024;

/** Engines of the database catalog, in catalog order. */
const DB_ENGINES: DbEngine[] = [...new Set(DB_ENGINE_VERSIONS.map((v) => v.engine))];
const DB_ENGINE_LABELS: Record<DbEngine, string> = { mariadb: 'MariaDB', mysql: 'MySQL', postgresql: 'PostgreSQL' };
const DB_PROFILES: DbTuningProfile[] = ['S', 'M', 'L'];
const OVER_QUOTA_ACTIONS: OverQuotaAction[] = ['warn', 'block-uploads', 'suspend'];
const OVER_QUOTA_FALLBACK: Record<OverQuotaAction, { label: string; hint: string }> = {
  warn: { label: 'Warn only', hint: 'Alerts and notifications only.' },
  'block-uploads': { label: 'Block uploads', hint: 'SFTP becomes read + delete only until the usage is back under the quota; the sites keep running.' },
  suspend: { label: 'Suspend the account', hint: 'The account is suspended (once per period); a staff member can resume it.' },
};
const OVER_QUOTA_KEY: Record<OverQuotaAction, string> = { warn: 'warn', 'block-uploads': 'blockUploads', suspend: 'suspend' };
// P4: largest message of the plan (MiB), capped by the platform setting mail.maxMessageSizeMb.
const MAIL_SIZE_MIN = 1;
const MAIL_SIZE_MAX = 100;
const CRON_INTERVAL_MIN = 1;
const CRON_INTERVAL_MAX = 1440;
// P4b: processes of ONE app container (server zod: 32 … 32768).
const APPS_PIDS_MIN = 32;
const APPS_PIDS_MAX = 32768;

function toForm(l: PlanLimits, defs: FieldDef[]): FormState {
  const f = {} as FormState;
  for (const d of defs) {
    const v = l[d.key];
    f[d.key] = { value: v == null ? '' : limitToField(v, d.multiplier ?? 1), none: v == null };
  }
  return f;
}

/** Create / edit a plan: every PlanLimits field + allowed bases. */
export function PlanFormModal({ open, plan, onClose, onSaved }: {
  open: boolean;
  /** null = create. */
  plan: Plan | null;
  onClose: () => void;
  onSaved: (p: Plan) => void;
}) {
  const { t } = useTranslation();
  const unlimited = t('hostingCommon.unlimited') || 'unlimited';

  const baseDefs: FieldDef[] = [
    { key: 'diskMb', label: t('plans.limits.disk') || 'Disk', unit: t('units.gb') || 'GB', multiplier: MIB_PER_GB, step: '0.5' },
    { key: 'trafficMbPerMonth', label: t('plans.limits.traffic') || 'Traffic', unit: t('units.gbPerMonth') || 'GB/month', multiplier: MIB_PER_GB },
    { key: 'maxSites', label: t('plans.limits.sites') || 'Sites' },
    { key: 'maxDomains', label: t('plans.limits.domains') || 'Domains' },
    { key: 'maxMailboxes', label: t('plans.limits.mailboxes') || 'Mailboxes' },
    { key: 'maxDatabases', label: t('plans.limits.databases') || 'Databases' },
    { key: 'cpuCores', label: t('plans.limits.cpu') || 'CPU', unit: t('units.cores') || 'cores', integer: false, step: '0.25' },
    { key: 'memoryMb', label: t('plans.limits.memory') || 'Memory', unit: t('units.mb') || 'MB', step: '64' },
    { key: 'pidsLimit', label: t('plans.limits.pids') || 'Processes', nullLabel: t('plans.limits.pidsDefault') || 'default (256)' },
  ];
  // P2 numeric limits (same "unlimited" toggle and unchanged-value logic as above).
  const dbDefs: FieldDef[] = [
    { key: 'maxDbInstances', label: t('platformSettings.plan.maxDbInstances') || 'DB instances' },
    { key: 'dbMaxSizeMb', label: t('platformSettings.plan.dbMaxSize') || 'Size of one database', unit: t('units.gb') || 'GB', multiplier: MIB_PER_GB, step: '0.5' },
  ];
  const cronDefs: FieldDef[] = [
    { key: 'maxCronJobs', label: t('platformSettings.plan.maxCronJobs') || 'Cron jobs' },
  ];
  // P4 mail limits (maxMailboxes is in baseDefs); mailMaxMessageSizeMb is edited apart (non-nullable).
  const mailDefs: FieldDef[] = [
    { key: 'mailQuotaMb', label: t('mail.plan.mailQuota') || 'Total mail quota', unit: t('units.gb') || 'GB', multiplier: MIB_PER_GB, step: '0.5' },
    { key: 'mailboxQuotaMaxMb', label: t('mail.plan.mailboxQuotaMax') || 'Largest mailbox', unit: t('units.gb') || 'GB', multiplier: MIB_PER_GB, step: '0.5' },
    { key: 'maxMailAliases', label: t('mail.plan.maxAliases') || 'Mail aliases' },
    { key: 'mailOutboundPerHour', label: t('mail.plan.outboundPerHour') || 'Outbound mail / hour (account)' },
    { key: 'mailSiteOutboundPerHour', label: t('mail.plan.siteOutboundPerHour') || 'Outbound mail / hour (per site)' },
  ];
  // P4b apps / proxy / monitoring limits (ui-apps); appsPidsPerContainer and the booleans are edited apart.
  const appsDefs: FieldDef[] = [
    { key: 'maxAppStacks', label: t('apps.plan.maxAppStacks') || 'Applications' },
    { key: 'maxAppContainers', label: t('apps.plan.maxAppContainers') || 'Application containers' },
    { key: 'appsCpuCores', label: t('apps.plan.appsCpu') || 'CPU of all the applications', unit: t('units.cores') || 'cores', integer: false, step: '0.25', nullLabel: t('apps.plan.nodeCeiling') || 'node ceiling' },
    { key: 'appsMemoryMb', label: t('apps.plan.appsMemory') || 'Memory of all the applications', unit: t('units.gb') || 'GB', multiplier: MIB_PER_GB, step: '0.5', nullLabel: t('apps.plan.nodeCeiling') || 'node ceiling' },
  ];
  const proxyDefs: FieldDef[] = [
    { key: 'maxProxyHosts', label: t('apps.plan.maxProxyHosts') || 'Proxy hosts' },
    { key: 'maxRedirections', label: t('apps.plan.maxRedirections') || 'Redirections and dead hosts' },
    { key: 'maxUptimeMonitors', label: t('apps.plan.maxUptimeMonitors') || 'Uptime monitors' },
    { key: 'maxWorkflows', label: t('apps.plan.maxWorkflows') || 'Workflows' },
  ];
  const defs: FieldDef[] = [...baseDefs, ...dbDefs, ...cronDefs, ...mailDefs, ...appsDefs, ...proxyDefs];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULT_PLAN_LIMITS, defs));
  /** Form as loaded: untouched fields send the exact stored value back (GB display rounds to 2 decimals). */
  const [initialForm, setInitialForm] = useState<FormState | null>(null);
  const [allBases, setAllBases] = useState(true);
  const [bases, setBases] = useState<Set<SiteBaseId>>(new Set());
  // P2 non-numeric / non-nullable limits (outside NumKey): separate form state.
  const [dbProfile, setDbProfile] = useState<DbTuningProfile>(DEFAULT_PLAN_LIMITS.dbProfile);
  const [allEngines, setAllEngines] = useState(true);
  const [engines, setEngines] = useState<Set<DbEngine>>(new Set(DB_ENGINES));
  const [dbExternal, setDbExternal] = useState(DEFAULT_PLAN_LIMITS.dbExternalAccess);
  const [cronInterval, setCronInterval] = useState(String(DEFAULT_PLAN_LIMITS.cronMinIntervalMin));
  const [overQuotaAction, setOverQuotaAction] = useState<OverQuotaAction>(DEFAULT_PLAN_LIMITS.overQuotaAction);
  const [mailMaxSize, setMailMaxSize] = useState(String(DEFAULT_PLAN_LIMITS.mailMaxMessageSizeMb));
  // P4b non-nullable / boolean limits (outside NumKey).
  const [appsPids, setAppsPids] = useState(String(DEFAULT_PLAN_LIMITS.appsPidsPerContainer));
  const [appsBuild, setAppsBuild] = useState(DEFAULT_PLAN_LIMITS.appsBuild);
  const [appsConsole, setAppsConsole] = useState(DEFAULT_PLAN_LIMITS.appsConsole);
  const [proxyExternal, setProxyExternal] = useState(DEFAULT_PLAN_LIMITS.proxyExternalTargets);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const limits = plan?.limits ?? DEFAULT_PLAN_LIMITS;
    setName(plan?.name ?? '');
    setDescription(plan?.description ?? '');
    setIsActive(plan?.isActive ?? true);
    const loaded = toForm({ ...DEFAULT_PLAN_LIMITS, ...limits }, defs);
    setForm(loaded);
    setInitialForm(loaded);
    setAllBases(limits.allowedBases == null);
    setBases(new Set(limits.allowedBases ?? SITE_BASES.filter((b) => !b.unmaintained).map((b) => b.id)));
    const full = { ...DEFAULT_PLAN_LIMITS, ...limits };
    setDbProfile(full.dbProfile);
    setAllEngines(full.dbEngines == null);
    setEngines(new Set(full.dbEngines ?? DB_ENGINES));
    setDbExternal(full.dbExternalAccess);
    setCronInterval(String(full.cronMinIntervalMin));
    setOverQuotaAction(full.overQuotaAction);
    setMailMaxSize(String(full.mailMaxMessageSizeMb));
    setAppsPids(String(full.appsPidsPerContainer));
    setAppsBuild(full.appsBuild);
    setAppsConsole(full.appsConsole);
    setProxyExternal(full.proxyExternalTargets);
    setError('');
  }, [open, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (key: NumKey, patch: Partial<FieldState>) => setForm((f) => ({ ...f, [key]: { ...f[key], ...patch } }));

  const toggleBase = (id: SiteBaseId) => setBases((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    const limits = { allowedBases: allBases ? null : SITE_BASES.map((b) => b.id).filter((id) => bases.has(id)) } as PlanLimits;
    for (const d of defs) {
      const st = form[d.key];
      if (st.none) { limits[d.key] = null; continue; }
      const init = initialForm?.[d.key];
      if (plan && init && !init.none && init.value === st.value) {
        // Unchanged field: keep the stored value (e.g. diskMb 1000 shows 0.98 GB, re-multiplying would save 1004).
        limits[d.key] = { ...DEFAULT_PLAN_LIMITS, ...plan.limits }[d.key];
        continue;
      }
      const n = parseLimitField(st.value, { multiplier: d.multiplier, integer: d.integer });
      if (n === null || Number.isNaN(n)) {
        setError(t('plans.form.invalidNumber', { field: d.label, defaultValue: '{{field}}: enter a positive number or tick "unlimited".' }));
        return;
      }
      limits[d.key] = n;
    }
    if (!allBases && limits.allowedBases!.length === 0) { setError(t('plans.form.noBase') || 'Allow at least one base.'); return; }
    const interval = Number(cronInterval);
    if (!Number.isInteger(interval) || interval < CRON_INTERVAL_MIN || interval > CRON_INTERVAL_MAX) {
      setError(t('platformSettings.plan.cronIntervalRange', { min: CRON_INTERVAL_MIN, max: CRON_INTERVAL_MAX, defaultValue: 'Cron minimum interval: between {{min}} and {{max}} minutes.' }));
      return;
    }
    const mailSize = Number(mailMaxSize);
    if (!Number.isInteger(mailSize) || mailSize < MAIL_SIZE_MIN || mailSize > MAIL_SIZE_MAX) {
      setError(t('mail.plan.maxMessageSizeRange', { min: MAIL_SIZE_MIN, max: MAIL_SIZE_MAX, defaultValue: 'Largest mail message: between {{min}} and {{max}} MB.' }));
      return;
    }
    const pids = Number(appsPids);
    if (!Number.isInteger(pids) || pids < APPS_PIDS_MIN || pids > APPS_PIDS_MAX) {
      setError(t('apps.plan.pidsRange', { min: APPS_PIDS_MIN, max: APPS_PIDS_MAX, defaultValue: 'Processes per application container: between {{min}} and {{max}}.' }));
      return;
    }
    const engineList = DB_ENGINES.filter((e) => engines.has(e));
    if (!allEngines && engineList.length === 0) { setError(t('platformSettings.plan.noEngine') || 'Allow at least one database engine.'); return; }
    limits.dbProfile = dbProfile;
    limits.dbEngines = allEngines ? null : engineList;
    limits.dbExternalAccess = dbExternal;
    limits.cronMinIntervalMin = interval;
    limits.overQuotaAction = overQuotaAction;
    limits.mailMaxMessageSizeMb = mailSize;
    limits.appsPidsPerContainer = pids;
    limits.appsBuild = appsBuild;
    limits.appsConsole = appsConsole;
    limits.proxyExternalTargets = proxyExternal;
    const input: PlanInput = { name: name.trim(), description: description.trim() || null, limits, isActive };
    setSaving(true);
    setError('');
    try {
      onSaved(plan ? await plansApi.update(plan.id, input) : await plansApi.create(input));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('plans.saveFailed') || 'Failed to save the plan'));
    } finally {
      setSaving(false);
    }
  };

  const siteEngines: SiteEngine[] = ['apache', 'nginx'];

  const toggleEngine = (e: DbEngine) => setEngines((cur) => {
    const next = new Set(cur);
    if (next.has(e)) next.delete(e); else next.add(e);
    return next;
  });

  const numField = (d: FieldDef) => {
    const st = form[d.key];
    return (
      <div key={d.key} className="rounded-lg bg-bg-primary p-2.5">
        <label className={cn(labelCls, 'truncate')} htmlFor={`plan-${d.key}`}>
          {d.label}{d.unit ? <span className="font-mono text-[10px]"> ({d.unit})</span> : null}
        </label>
        <input
          id={`plan-${d.key}`}
          type="number"
          min="0"
          step={d.step ?? '1'}
          inputMode="decimal"
          disabled={st.none}
          value={st.none ? '' : st.value}
          placeholder={st.none ? (d.nullLabel ?? unlimited) : ''}
          onChange={(e) => setField(d.key, { value: e.target.value })}
          className={cn(inputCls, 'font-mono')}
        />
        <div className="mt-2">
          <ToggleSwitch size="sm" checked={st.none} onChange={(v) => setField(d.key, { none: v })} label={<span className="text-xs">{d.nullLabel ?? unlimited}</span>} />
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={plan ? t('plans.form.editTitle', { name: plan.name, defaultValue: 'Edit plan {{name}}' }) : (t('plans.form.createTitle') || 'New plan')}
      icon={<Layers className="h-4 w-4 text-accent" />}
      size="xl"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{plan ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="plan-name">{t('plans.form.name') || 'Name'}</label>
            <input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} autoFocus placeholder={t('plans.form.namePlaceholder') || 'Starter'} />
          </div>
          <div>
            <label className={labelCls} htmlFor="plan-desc">{t('plans.form.description') || 'Description'}</label>
            <input id="plan-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} maxLength={500} />
          </div>
        </div>
        <ToggleSwitch
          checked={isActive}
          onChange={setIsActive}
          label={t('plans.form.active') || 'Active'}
          description={t('plans.form.activeHint') || 'An inactive plan stays on its accounts but cannot be chosen for new ones.'}
        />

        <div>
          <div className={cn(sectionTitleCls, 'mb-2')}>{t('plans.form.limitsTitle') || 'Limits per account'}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {baseDefs.map(numField)}
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('plans.form.perContainerHint') || 'CPU, memory and processes apply to each site container of the account.'}</p>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className={sectionTitleCls}>{t('plans.form.basesTitle') || 'Allowed bases'}</span>
            <ToggleSwitch size="sm" checked={allBases} onChange={setAllBases} label={<span className="text-xs">{t('plans.form.allBases') || 'The whole catalog'}</span>} />
          </div>
          {!allBases && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {siteEngines.map((engine) => (
                <div key={engine} className="rounded-lg bg-bg-primary p-3">
                  <div className="mb-2 text-xs font-semibold text-text-secondary">{engine === 'apache' ? 'Apache' : 'nginx'}</div>
                  <div className="space-y-1.5">
                    {SITE_BASES.filter((b) => b.engine === engine).map((b) => (
                      <label key={b.id} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary coarse:min-h-10">
                        <input type="checkbox" checked={bases.has(b.id)} onChange={() => toggleBase(b.id)} className="accent-accent" />
                        <span className="font-mono text-[13px]">{b.id}</span>
                        {b.php && <PhpBranchBadges branch={b.php} compact />}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className={cn(sectionTitleCls, 'mb-2')}>{t('platformSettings.plan.dbTitle') || 'Databases'}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dbDefs.map(numField)}
            <div className="rounded-lg bg-bg-primary p-2.5">
              <div className={labelCls}>{t('platformSettings.plan.dbProfile') || 'Instance profile'}</div>
              <SegmentedTabs<DbTuningProfile>
                size="sm"
                value={dbProfile}
                onChange={setDbProfile}
                tabs={DB_PROFILES.map((p) => ({ id: p, label: <span className="font-mono">{p}</span> }))}
              />
              <p className="mt-1.5 font-mono text-[11px] text-text-muted">
                {t('platformSettings.plan.dbProfileMemory', { value: DB_PROFILE_MEMORY_MB[dbProfile], defaultValue: '{{value}} MB of memory per instance' })}
              </p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-bg-primary p-3">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold text-text-secondary">{t('platformSettings.plan.dbEngines') || 'Allowed engines'}</span>
                <ToggleSwitch size="sm" checked={allEngines} onChange={setAllEngines} label={<span className="text-xs">{t('platformSettings.plan.allEngines') || 'All engines'}</span>} />
              </div>
              {!allEngines && (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {DB_ENGINES.map((e) => (
                    <label key={e} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary coarse:min-h-10">
                      <input type="checkbox" checked={engines.has(e)} onChange={() => toggleEngine(e)} className="accent-accent" />
                      {DB_ENGINE_LABELS[e]}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg bg-bg-primary p-3">
              <ToggleSwitch
                checked={dbExternal}
                onChange={setDbExternal}
                label={t('platformSettings.plan.dbExternal') || 'External SQL access'}
                description={t('platformSettings.plan.dbExternalHint') || 'The account may publish an instance on a dedicated port, filtered by its allow-list.'}
              />
            </div>
          </div>
        </div>

        <div>
          <div className={cn(sectionTitleCls, 'mb-2')}>{t('platformSettings.plan.cronTitle') || 'Cron'}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cronDefs.map(numField)}
            <div className="rounded-lg bg-bg-primary p-2.5">
              <label className={cn(labelCls, 'truncate')} htmlFor="plan-cron-interval">
                {t('platformSettings.plan.cronMinInterval') || 'Minimum interval'}<span className="font-mono text-[10px]"> ({t('platformSettings.plan.minutes') || 'min'})</span>
              </label>
              <input
                id="plan-cron-interval"
                type="number"
                min={CRON_INTERVAL_MIN}
                max={CRON_INTERVAL_MAX}
                inputMode="numeric"
                value={cronInterval}
                onChange={(e) => setCronInterval(e.target.value)}
                className={cn(inputCls, 'font-mono')}
              />
              <p className="mt-1.5 text-[11px] text-text-muted">{t('platformSettings.plan.cronMinIntervalHint') || 'Between two runs of the same job.'}</p>
            </div>
          </div>
        </div>

        <div>
          <div className={cn(sectionTitleCls, 'mb-2 flex items-center gap-1.5')}><Mail size={12} />{t('mail.plan.title') || 'Mail'}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mailDefs.map(numField)}
            <div className="rounded-lg bg-bg-primary p-2.5">
              <label className={cn(labelCls, 'truncate')} htmlFor="plan-mail-size">
                {t('mail.plan.maxMessageSize') || 'Largest message'}<span className="font-mono text-[10px]"> ({t('units.mb') || 'MB'})</span>
              </label>
              <input
                id="plan-mail-size"
                type="number"
                min={MAIL_SIZE_MIN}
                max={MAIL_SIZE_MAX}
                inputMode="numeric"
                value={mailMaxSize}
                onChange={(e) => setMailMaxSize(e.target.value)}
                className={cn(inputCls, 'font-mono')}
              />
              <p className="mt-1.5 text-[11px] text-text-muted">{t('mail.plan.maxMessageSizeHint') || 'Also capped by the platform setting.'}</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('mail.plan.hint') || 'The mailbox count is set with the limits above. An unlimited mailbox is refused while the total mail quota is capped.'}</p>
        </div>

        <div>
          <div className={cn(sectionTitleCls, 'mb-2 flex items-center gap-1.5')}><Boxes size={12} />{t('apps.plan.title') || 'Applications, proxy and monitoring'}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {appsDefs.map(numField)}
            <div className="rounded-lg bg-bg-primary p-2.5">
              <label className={cn(labelCls, 'truncate')} htmlFor="plan-apps-pids">{t('apps.plan.appsPids') || 'Processes per application container'}</label>
              <input
                id="plan-apps-pids"
                type="number"
                min={APPS_PIDS_MIN}
                max={APPS_PIDS_MAX}
                inputMode="numeric"
                value={appsPids}
                onChange={(e) => setAppsPids(e.target.value)}
                className={cn(inputCls, 'font-mono')}
              />
            </div>
            {proxyDefs.map(numField)}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg bg-bg-primary p-3">
              <ToggleSwitch checked={appsBuild} onChange={setAppsBuild} label={t('apps.plan.appsBuild') || 'Build images from source'} description={t('apps.plan.appsBuildHint') || 'Also gated by the platform setting and the workspace policy.'} />
            </div>
            <div className="rounded-lg bg-bg-primary p-3">
              <ToggleSwitch checked={appsConsole} onChange={setAppsConsole} label={t('apps.plan.appsConsole') || 'Application console'} description={t('apps.plan.appsConsoleHint') || 'Interactive shell in the containers (+ capability, setting and policy).'} />
            </div>
            <div className="rounded-lg bg-bg-primary p-3">
              <ToggleSwitch checked={proxyExternal} onChange={setProxyExternal} label={t('apps.plan.proxyExternal') || 'Proxy to external targets'} description={t('apps.plan.proxyExternalHint') || 'Proxy hosts towards an IP / host name outside the platform (+ workspace policy).'} />
            </div>
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('apps.plan.hint') || 'CPU and memory are the sum of every application container of the account; each container gets at most the processes above.'}</p>
        </div>

        <div>
          <div className={cn(sectionTitleCls, 'mb-2')}>{t('platformSettings.plan.overQuotaTitle') || 'At 100 % of the disk or traffic quota'}</div>
          <div role="radiogroup" aria-label={t('platformSettings.plan.overQuotaTitle') || 'At 100 % of the disk or traffic quota'} className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {OVER_QUOTA_ACTIONS.map((a) => {
              const selected = overQuotaAction === a;
              const key = OVER_QUOTA_KEY[a];
              return (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setOverQuotaAction(a)}
                  className={cn('rounded-lg border-2 p-3 text-left transition-all', selected ? 'border-accent bg-accent/5' : 'border-transparent bg-bg-primary hover:border-accent/30')}
                >
                  <div className="text-sm font-semibold text-text-primary">{t(`platformSettings.plan.overQuota.${key}`) || OVER_QUOTA_FALLBACK[a].label}</div>
                  <p className="mt-1 text-xs text-text-secondary">{t(`platformSettings.plan.overQuota.${key}Hint`) || OVER_QUOTA_FALLBACK[a].hint}</p>
                </button>
              );
            })}
          </div>
        </div>

        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
