import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Package, Save } from 'lucide-react';
import type { MigrationPackageChoice, MigrationTargetCatalog, PlanLimits } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { Card, EmptyState, Pill, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { checkboxCls } from '../migrationUi';
import type { PlanEditor } from './usePlanEditor';

type LimitKey = 'diskMb' | 'trafficMbPerMonth' | 'maxSites' | 'maxDomains' | 'maxMailboxes' | 'maxDatabases' | 'maxCronJobs' | 'maxProxyHosts' | 'mailQuotaMb';
const LIMIT_KEYS: LimitKey[] = ['diskMb', 'trafficMbPerMonth', 'maxSites', 'maxDomains', 'maxMailboxes', 'maxDatabases', 'maxCronJobs', 'maxProxyHosts', 'mailQuotaMb'];
const LIMIT_FALLBACK: Record<LimitKey, string> = {
  diskMb: 'Disk (MB)', trafficMbPerMonth: 'Traffic (MB/month)', maxSites: 'Sites', maxDomains: 'Domains', maxMailboxes: 'Mailboxes',
  maxDatabases: 'Databases', maxCronJobs: 'Crons', maxProxyHosts: 'Proxy hosts', mailQuotaMb: 'Mail quota (MB)',
};

/** Compact limits form: empty = from the mapping, "∞" (or "-") = unlimited. */
function LimitsForm({ limits, resolved, onChange }: { limits: Partial<PlanLimits>; resolved: PlanLimits | null; onChange: (l: Partial<PlanLimits>) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {LIMIT_KEYS.map((k) => {
        const has = Object.prototype.hasOwnProperty.call(limits, k);
        const v = limits[k];
        const shown = !has ? '' : v == null ? '∞' : String(v);
        const placeholder = resolved ? (resolved[k] == null ? '∞' : String(resolved[k])) : '';
        return (
          <div key={k}>
            <label className={labelCls} htmlFor={`lim-${k}`}>{t(`migration.packages.limits.${k}`, { defaultValue: LIMIT_FALLBACK[k] })}</label>
            <input
              id={`lim-${k}`}
              className={cn(inputCls, 'py-1.5 font-mono text-xs', has && 'ring-1 ring-accent/50')}
              value={shown}
              placeholder={placeholder}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const next = { ...limits };
                if (!raw) delete next[k];
                else if (raw === '∞' || raw === '-' || raw.toLowerCase() === 'inf') next[k] = null;
                else { const n = Number(raw.replace(/[^0-9]/g, '')); if (Number.isFinite(n)) next[k] = n; }
                onChange(next);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** CWP packages → plans: create a plan (name + limit overrides) or use an existing plan per workspace. */
export function PlanPackagesTab({ editor, catalog }: { editor: PlanEditor; catalog: MigrationTargetCatalog | null }) {
  const { t } = useTranslation();
  const { plan } = editor;
  // The draft lives in the editor: switching tab keeps it, and it counts as an unsaved change (badge + beforeunload).
  const pkgs: Record<string, MigrationPackageChoice> = editor.sectionValue('packages') ?? {};
  const dirty = editor.sectionDirty('packages');
  const [everyPackage, setEveryPackage] = useState(false);
  const allPlanned = plan.result?.packages ?? [];
  // Only the packages of the SELECTED accounts by default (a partial migration only creates those plans).
  const usedKeys = new Set((plan.result?.accounts ?? []).filter((a) => a.selected).map((a) => a.packageKey));
  const planned = everyPackage ? allPlanned : allPlanned.filter((p) => usedKeys.has(p.key));
  const ids = [...new Set([...planned.map((p) => String(p.cwpPackageId)), ...(everyPackage ? Object.keys(pkgs) : [])])].sort((a, b) => Number(a) - Number(b));
  const hidden = new Set(allPlanned.map((p) => String(p.cwpPackageId))).size
    - new Set(allPlanned.filter((p) => usedKeys.has(p.key)).map((p) => String(p.cwpPackageId))).size;
  const toggle = hidden > 0 || everyPackage ? (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-text-muted">
      <input type="checkbox" className={checkboxCls} checked={everyPackage} onChange={(e) => setEveryPackage(e.target.checked)} />
      {t('migration.packages.showUnused', { count: hidden, defaultValue: 'Show the packages of the unselected accounts ({{count}})' })}
    </label>
  ) : null;

  if (ids.length === 0) return <div className="space-y-3">{toggle}<EmptyState icon={<Package />} text={t('migration.packages.empty') || 'No CWP package in this plan.'} /></div>;

  const patch = (id: string, p: Partial<MigrationPackageChoice>) => editor.setSection('packages', (all) => {
    const cur = all ?? {};
    const prev: MigrationPackageChoice = cur[id] ?? { action: planned.find((x) => String(x.cwpPackageId) === id)?.action ?? 'create' };
    return { ...cur, [id]: { ...prev, ...p } };
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('migration.packages.description') || 'Each CWP package becomes a plan per target workspace: a new plan « CWP <package> » mapped from the package limits (raised to the biggest account), or an existing plan.'}</p>
        {dirty && <Button size="sm" variant="ghost" onClick={() => editor.resetSection('packages')}>{t('migration.common.reset') || 'Reset'}</Button>}
        <Button size="sm" loading={editor.savingChoices} disabled={!dirty} onClick={() => { void editor.saveSection('packages'); }}>
          <Save size={13} className="mr-1.5" />{t('migration.overview.saveAndCompute') || 'Save and recompute'}
        </Button>
      </div>
      {toggle}
      {ids.map((id) => {
        const rows = planned.filter((p) => String(p.cwpPackageId) === id);
        const choice = pkgs[id] ?? { action: rows[0]?.action ?? 'create' };
        const tenants = [...new Set(rows.map((r) => r.tenantId))];
        return (
          <Card key={id} title={<span>{rows[0]?.name ?? `#${id}`} <span className="font-mono text-text-muted">· CWP #{id}</span></span>} icon={<Package size={14} className="text-accent" />}>
            <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
              <div>
                <label className={labelCls} htmlFor={`pa-${id}`}>{t('migration.packages.action') || 'Target plan'}</label>
                <select id={`pa-${id}`} className={selectCls} value={choice.action} onChange={(e) => patch(id, { action: e.target.value as 'create' | 'existing' })}>
                  <option value="create">{t('migration.packages.create') || 'Create a plan'}</option>
                  <option value="existing">{t('migration.packages.existing') || 'Use an existing plan'}</option>
                </select>
              </div>
              {choice.action === 'create' ? (
                <div>
                  <label className={labelCls} htmlFor={`pn-${id}`}>{t('migration.packages.name') || 'Plan name'}</label>
                  <input id={`pn-${id}`} className={inputCls} value={choice.name ?? ''} placeholder={rows[0]?.name ?? `CWP ${id}`} onChange={(e) => patch(id, { name: e.target.value || null })} />
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {(tenants.length ? tenants : [plan.choices.global.defaultTenantId]).map((tid) => (
                    <div key={tid}>
                      <label className={labelCls} htmlFor={`pe-${id}-${tid}`}>{catalog?.tenants.find((x) => x.id === tid)?.name ?? `#${tid}`}</label>
                      <select
                        id={`pe-${id}-${tid}`}
                        className={selectCls}
                        value={choice.planIds?.[String(tid)] ?? ''}
                        onChange={(e) => {
                          // The placeholder removes the entry (planId 0 is refused by the schema).
                          const next: Record<string, number> = { ...(choice.planIds ?? {}) };
                          if (e.target.value) next[String(tid)] = Number(e.target.value); else delete next[String(tid)];
                          patch(id, { planIds: next });
                        }}
                      >
                        <option value="">{t('migration.packages.pickPlan') || 'Choose a plan…'}</option>
                        {(catalog?.plans ?? []).filter((p) => p.tenantId === tid).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {choice.action === 'create' && (
              <div className="mt-3">
                <span className={labelCls}>{t('migration.packages.limitsTitle') || 'Limits (empty = mapped from the package, ∞ = unlimited)'}</span>
                <LimitsForm limits={choice.limits ?? {}} resolved={rows[0]?.limits ?? null} onChange={(l) => patch(id, { limits: Object.keys(l).length ? l : null })} />
              </div>
            )}
            {rows.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {rows.map((r) => (
                  <Pill key={r.key} tone={r.action === 'create' ? 'accent' : 'blue'}>
                    {catalog?.tenants.find((x) => x.id === r.tenantId)?.name ?? `#${r.tenantId}`} → {r.name}{r.planId ? ` #${r.planId}` : ''}
                  </Pill>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
