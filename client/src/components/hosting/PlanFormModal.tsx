import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, AlertTriangle } from 'lucide-react';
import type { Plan, PlanInput, PlanLimits, SiteBaseId, SiteEngine } from '@oblimint/shared';
import { DEFAULT_PLAN_LIMITS, SITE_BASES } from '@oblimint/shared';
import { plansApi } from '@/api/plans.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { cn } from '@/utils/cn';
import { inputCls, labelCls, sectionTitleCls, Pill, hostingErrorMessage, isStepUpHandled } from './hostingUi';
import { limitToField, parseLimitField } from './hostingFormat';

type NumKey = Exclude<keyof PlanLimits, 'allowedBases'>;

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

  const defs: FieldDef[] = [
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

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULT_PLAN_LIMITS, defs));
  /** Form as loaded: untouched fields send the exact stored value back (GB display rounds to 2 decimals). */
  const [initialForm, setInitialForm] = useState<FormState | null>(null);
  const [allBases, setAllBases] = useState(true);
  const [bases, setBases] = useState<Set<SiteBaseId>>(new Set());
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

  const engines: SiteEngine[] = ['apache', 'nginx'];

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
            {defs.map((d) => {
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
            })}
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
              {engines.map((engine) => (
                <div key={engine} className="rounded-lg bg-bg-primary p-3">
                  <div className="mb-2 text-xs font-semibold text-text-secondary">{engine === 'apache' ? 'Apache' : 'nginx'}</div>
                  <div className="space-y-1.5">
                    {SITE_BASES.filter((b) => b.engine === engine).map((b) => (
                      <label key={b.id} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary coarse:min-h-10">
                        <input type="checkbox" checked={bases.has(b.id)} onChange={() => toggleBase(b.id)} className="accent-accent" />
                        <span className="font-mono text-[13px]">{b.id}</span>
                        {b.unmaintained && (
                          <Pill tone="amber" title={t('plans.form.unmaintainedHint') || 'This PHP branch no longer receives security fixes.'}>
                            <AlertTriangle size={10} />{t('hostingCommon.unmaintained') || 'unmaintained runtime'}
                          </Pill>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
