import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Tenant, TenantLimits } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { tenantsApi } from '@/api/tenants.api';
import { apiErrorMessage } from '@/api/client';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { InfoTip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';

// ── Limits <-> form conversion ──────────────────────────────────────────────
// TenantLimits stores sizes in MiB; the form speaks GB (×1024). An empty
// field means "unlimited" (null).

const MIB_PER_GB = 1024;

type LimitField = 'diskGb' | 'trafficGb' | 'maxAccounts' | 'maxSites' | 'maxDomains' | 'maxMailboxes' | 'maxDatabases' | 'cpuCores' | 'memoryGb';
type LimitForm = Record<LimitField, string> & { allowOversell: boolean };

const EMPTY_LIMITS: TenantLimits = {
  diskMb: null, trafficMbPerMonth: null, maxAccounts: null, maxSites: null, maxDomains: null,
  maxMailboxes: null, maxDatabases: null, cpuCores: null, memoryMb: null, allowOversell: false,
};

function numToField(n: number | null | undefined, divisor = 1): string {
  if (n == null) return '';
  const v = n / divisor;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function limitsToForm(l: TenantLimits | null | undefined): LimitForm {
  const x = { ...EMPTY_LIMITS, ...(l ?? {}) };
  return {
    diskGb: numToField(x.diskMb, MIB_PER_GB),
    trafficGb: numToField(x.trafficMbPerMonth, MIB_PER_GB),
    maxAccounts: numToField(x.maxAccounts),
    maxSites: numToField(x.maxSites),
    maxDomains: numToField(x.maxDomains),
    maxMailboxes: numToField(x.maxMailboxes),
    maxDatabases: numToField(x.maxDatabases),
    cpuCores: numToField(x.cpuCores),
    memoryGb: numToField(x.memoryMb, MIB_PER_GB),
    allowOversell: !!x.allowOversell,
  };
}

/** null = unlimited; NaN = invalid. */
function fieldToNum(v: string, multiplier = 1, integer = true): number | null {
  const s = v.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  const r = n * multiplier;
  return integer ? Math.round(r) : r;
}

function formToLimits(f: LimitForm): TenantLimits | null {
  const l: TenantLimits = {
    diskMb: fieldToNum(f.diskGb, MIB_PER_GB),
    trafficMbPerMonth: fieldToNum(f.trafficGb, MIB_PER_GB),
    maxAccounts: fieldToNum(f.maxAccounts),
    maxSites: fieldToNum(f.maxSites),
    maxDomains: fieldToNum(f.maxDomains),
    maxMailboxes: fieldToNum(f.maxMailboxes),
    maxDatabases: fieldToNum(f.maxDatabases),
    cpuCores: fieldToNum(f.cpuCores, 1, false),
    memoryMb: fieldToNum(f.memoryGb, MIB_PER_GB),
    allowOversell: f.allowOversell,
  };
  for (const [k, v] of Object.entries(l)) {
    if (k !== 'allowOversell' && typeof v === 'number' && Number.isNaN(v)) return null;
  }
  return l;
}

// ── Inline form for creating / editing a tenant ────────────────────────────
function TenantForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: { name: string; slug: string; limits: TenantLimits };
  onSave: (name: string, slug: string, limits: TenantLimits) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [limits, setLimits] = useState<LimitForm>(() => limitsToForm(initial?.limits));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const autoSlug = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const handleNameChange = (v: string) => {
    setName(v);
    if (!initial) setSlug(autoSlug(v));
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    const parsed = formToLimits(limits);
    if (!parsed) { setError(t('tenant.limits.invalid') || 'Limits must be positive numbers (leave empty for unlimited).'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), slug.trim(), parsed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : (t('common.error') || 'Error'));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full rounded-lg bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-10';
  const unlimited = t('tenant.limits.unlimited') || 'Unlimited';

  const limitFields: Array<{ key: LimitField; label: string; unit?: string; step?: string }> = [
    { key: 'diskGb', label: t('tenant.limits.disk') || 'Disk', unit: t('units.gb') || 'GB' },
    { key: 'trafficGb', label: t('tenant.limits.traffic') || 'Traffic', unit: t('units.gbPerMonth') || 'GB/month' },
    { key: 'maxAccounts', label: t('tenant.limits.accounts') || 'Hosting accounts' },
    { key: 'maxSites', label: t('tenant.limits.sites') || 'Sites' },
    { key: 'maxDomains', label: t('tenant.limits.domains') || 'Domains' },
    { key: 'maxMailboxes', label: t('tenant.limits.mailboxes') || 'Mailboxes' },
    { key: 'maxDatabases', label: t('tenant.limits.databases') || 'Databases' },
    { key: 'cpuCores', label: t('tenant.limits.cpu') || 'CPU', unit: t('units.cores') || 'cores', step: '0.5' },
    { key: 'memoryGb', label: t('tenant.limits.memory') || 'RAM', unit: t('units.gb') || 'GB' },
  ];

  return (
    <div className="space-y-4">
      {/* Phones: fields stacked full width. */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs text-text-muted mb-1">{t('tenant.name') || 'Name'}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            className={inputCls}
            placeholder={t('tenant.namePlaceholder') || 'Reseller name'}
            autoFocus
          />
        </div>
        <div className="w-full sm:w-48">
          <label className="block text-xs text-text-muted mb-1">{t('tenant.slug') || 'Slug'}</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={`${inputCls} font-mono`}
            placeholder={t('tenant.slugPlaceholder') || 'my-reseller'}
          />
        </div>
      </div>

      {/* Resource envelope */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
            {t('tenant.limits.title') || 'Resource envelope'}
          </span>
          <InfoTip content={t('tenant.limits.hint') || 'Maximum resources this workspace can allocate to its plans and accounts. Leave a field empty for unlimited.'} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {limitFields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs text-text-muted mb-1 truncate">
                {f.label}{f.unit ? <span className="font-mono text-[10px] text-text-muted/80"> ({f.unit})</span> : null}
              </label>
              <input
                type="number"
                min="0"
                step={f.step ?? '1'}
                inputMode="decimal"
                value={limits[f.key]}
                onChange={(e) => setLimits((p) => ({ ...p, [f.key]: e.target.value }))}
                placeholder={unlimited}
                className={`${inputCls} font-mono`}
              />
            </div>
          ))}
        </div>
        <div className="mt-3">
          <ToggleSwitch
            checked={limits.allowOversell}
            onChange={(v) => setLimits((p) => ({ ...p, allowOversell: v }))}
            label={t('tenant.limits.allowOversell') || 'Allow overselling'}
            description={t('tenant.limits.allowOversellHint') || 'Plans of this workspace may add up to more than its envelope; real usage is still capped.'}
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving} className="coarse:min-h-10">
          <X size={14} className="mr-1" />
          {t('common.cancel') || 'Cancel'}
        </Button>
        <Button size="sm" onClick={handleSubmit} loading={saving} className="coarse:min-h-10">
          <Check size={14} className="mr-1" />
          {t('common.save') || 'Save'}
        </Button>
      </div>
    </div>
  );
}

/** Compact chips summarising a tenant's envelope (only the set limits). */
function LimitChips({ limits }: { limits: TenantLimits | null | undefined }) {
  const { t } = useTranslation();
  const l = { ...EMPTY_LIMITS, ...(limits ?? {}) };
  const gb = (mb: number) => `${numToField(mb, MIB_PER_GB)} ${t('units.gb') || 'GB'}`;
  const chips: string[] = [];
  if (l.diskMb != null) chips.push(`${t('tenant.limits.disk') || 'Disk'} ${gb(l.diskMb)}`);
  if (l.trafficMbPerMonth != null) chips.push(`${t('tenant.limits.traffic') || 'Traffic'} ${gb(l.trafficMbPerMonth)}`);
  if (l.maxAccounts != null) chips.push(`${l.maxAccounts} ${t('tenant.limits.accountsShort') || 'accounts'}`);
  if (l.maxSites != null) chips.push(`${l.maxSites} ${t('tenant.limits.sitesShort') || 'sites'}`);
  if (l.maxDomains != null) chips.push(`${l.maxDomains} ${t('tenant.limits.domainsShort') || 'domains'}`);
  if (l.maxMailboxes != null) chips.push(`${l.maxMailboxes} ${t('tenant.limits.mailboxesShort') || 'mailboxes'}`);
  if (l.maxDatabases != null) chips.push(`${l.maxDatabases} ${t('tenant.limits.databasesShort') || 'databases'}`);
  if (l.cpuCores != null) chips.push(`${l.cpuCores} ${t('units.cores') || 'cores'}`);
  if (l.memoryMb != null) chips.push(`${t('tenant.limits.memory') || 'RAM'} ${gb(l.memoryMb)}`);
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {chips.length === 0 ? (
        <span className="text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 bg-bg-tertiary text-text-muted">
          {t('tenant.limits.noLimits') || 'No limits'}
        </span>
      ) : chips.map((c) => (
        <span key={c} className="text-[10px] font-mono rounded px-1.5 py-0.5 bg-bg-tertiary text-text-secondary">{c}</span>
      ))}
      {l.allowOversell && (
        <span className="text-[10px] font-mono rounded px-1.5 py-0.5 bg-amber-400/10 text-amber-400">
          {t('tenant.limits.oversell') || 'oversell'}
        </span>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      setTenants(await tenantsApi.list());
    } catch {
      toast.error(t('tenant.loadFailed') || 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchTenants(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the header TenantSwitcher in sync with the list.
  const refreshAll = async () => {
    await fetchTenants();
    void useTenantStore.getState().fetchTenants();
  };

  const handleCreate = async (name: string, slug: string, limits: TenantLimits) => {
    try {
      await tenantsApi.create({ name, slug, limits });
    } catch (err) {
      throw new Error(apiErrorMessage(err, t('common.error') || 'Error'));
    }
    toast.success(t('tenant.created') || 'Workspace created');
    setCreating(false);
    await refreshAll();
  };

  const handleUpdate = async (id: number, name: string, slug: string, limits: TenantLimits) => {
    try {
      await tenantsApi.update(id, { name, slug, limits });
    } catch (err) {
      throw new Error(apiErrorMessage(err, t('common.error') || 'Error'));
    }
    toast.success(t('tenant.updated') || 'Workspace updated');
    setEditingId(null);
    await refreshAll();
  };

  const handleDelete = async (tenant: Tenant) => {
    if (!(await confirm({
      message: t('tenant.confirmDelete', { name: tenant.name, defaultValue: 'Delete workspace "{{name}}"? This cannot be undone.' }),
      danger: true,
      requireText: tenant.slug,
    }))) return;
    try {
      await tenantsApi.delete(tenant.id);
      toast.success(t('tenant.deleted') || 'Workspace deleted');
      await refreshAll();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error') || 'Error'));
    }
  };

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary flex items-center gap-2">
            <Building2 size={20} className="text-accent" />
            {t('tenant.pageTitle') || 'Workspaces'}
          </h1>
          <p className="text-xs font-mono tracking-wider text-text-muted mt-0.5">
            {t('tenant.pageDesc') || 'Resellers and their resource envelopes.'}
          </p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => { setCreating(true); setEditingId(null); }}>
            <Plus size={14} className="mr-1" />
            {t('tenant.create') || 'New workspace'}
          </Button>
        )}
      </div>

      {creating && (
        <div className="mb-4 p-4 rounded-xl bg-bg-secondary">
          <TenantForm onSave={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-text-muted">{t('tenant.noTenants') || 'No workspace.'}</p>
      ) : (
        <div className="space-y-2">
          {tenants.map((tenant) => (
            <div key={tenant.id} className="group rounded-xl bg-bg-secondary px-4 py-3">
              {editingId === tenant.id ? (
                <TenantForm
                  initial={{ name: tenant.name, slug: tenant.slug, limits: tenant.limits }}
                  onSave={(name, slug, limits) => handleUpdate(tenant.id, name, slug, limits)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Building2 size={14} className="text-accent shrink-0" />
                      <span className="text-sm font-semibold text-text-primary break-words min-w-0">{tenant.name}</span>
                      {tenant.id === MASTER_TENANT_ID && (
                        <span className="text-[10px] bg-accent/15 text-accent rounded px-1.5 py-0.5">
                          {t('tenant.default') || 'Default'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-text-muted mt-0.5">
                      /{tenant.slug} · {t('tenant.createdAt') || 'Created'} {new Date(tenant.createdAt).toLocaleDateString(i18n.language)}
                    </p>
                    <LimitChips limits={tenant.limits} />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <IconButton
                      label={t('common.edit') || 'Edit'}
                      icon={<Pencil size={13} />}
                      onClick={() => { setEditingId(tenant.id); setCreating(false); }}
                      className="rounded-md"
                    />
                    {tenant.id !== MASTER_TENANT_ID && (
                      <IconButton
                        label={t('common.delete') || 'Delete'}
                        icon={<Trash2 size={13} />}
                        onClick={() => handleDelete(tenant)}
                        className="rounded-md hover:text-red-400"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
