import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, UserRound } from 'lucide-react';
import type { CwpInventory, MigrationAccountPlan, MigrationTargetCatalog } from '@oblimint/shared';
import { Drawer } from '@/components/common/Drawer';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { MailSearch } from '@/components/mail/MailListParts';
import { EmptyState, Pill, inputCls, selectCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, matches, severityCounts } from '../migrationFormat';
import { SeverityCounts, checkboxCls, tdCls, useByteUnits, type InventoryLoad } from '../migrationUi';
import { AccountEditor } from './AccountEditor';
import type { PlanEditor } from './usePlanEditor';

type Filter = 'all' | 'selected' | 'blocked' | 'warnings';

/** Accounts of the plan: selection, workspace, target name, plan, counts, blocking / warnings; row → account editor (drawer). */
export function PlanAccountsTab({ editor, inventory, inventoryStatus, catalog, openAccount, onOpenAccount }: {
  editor: PlanEditor;
  inventory: CwpInventory | null;
  inventoryStatus?: InventoryLoad;
  catalog: MigrationTargetCatalog | null;
  openAccount: string | null;
  onOpenAccount: (u: string | null) => void;
}) {
  const { t } = useTranslation();
  const units = useByteUnits();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const accounts = editor.plan.result?.accounts ?? [];
  const planName = useMemo(() => {
    const m = new Map((catalog?.plans ?? []).map((p) => [p.id, p.name]));
    const pkg = new Map((editor.plan.result?.packages ?? []).map((p) => [p.key, p.name]));
    return (a: MigrationAccountPlan) => (a.planId != null ? m.get(a.planId) ?? `#${a.planId}` : pkg.get(a.packageKey) ?? a.packageKey);
  }, [catalog, editor.plan.result]);

  const shown = accounts.filter((a) => {
    const c = editor.accountChoice(a.cwpUsername);
    const selected = c.selected ?? a.selected;
    if (filter === 'selected' && !selected) return false;
    if (filter === 'blocked' && !a.blocked) return false;
    if (filter === 'warnings' && !a.warnings.some((w) => w.severity === 'warning')) return false;
    return matches(search, a.cwpUsername, a.targetUsername, ...a.domains.map((d) => d.fqdn));
  });
  const allSelected = shown.length > 0 && shown.every((a) => editor.accountChoice(a.cwpUsername).selected ?? a.selected);
  // One write (PUT /choices, one recompute) for the whole selection, not one PUT per account.
  const toggleAll = (v: boolean) => editor.editAccounts(shown.map((a) => a.cwpUsername), (c) => ({ ...c, selected: v }));

  if (!editor.plan.result) return <EmptyState icon={<UserRound />} text={t('migration.overview.noResult') || 'No dry-run yet.'} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('migration.accounts.search') || 'Account or domain…'} />
        <select aria-label={t('migration.accounts.filter') || 'Filter'} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-48')}>
          <option value="all">{t('migration.accounts.filterAll') || 'Every account'}</option>
          <option value="selected">{t('migration.accounts.filterSelected') || 'Selected'}</option>
          <option value="blocked">{t('migration.accounts.filterBlocked') || 'Blocked'}</option>
          <option value="warnings">{t('migration.accounts.filterWarnings') || 'With warnings'}</option>
        </select>
        {editor.saving.size > 0 && <span className="flex items-center gap-1.5 text-xs text-text-muted"><LoadingSpinner size="sm" />{t('migration.plan.saving') || 'Saving and recomputing…'}</span>}
      </div>
      <TableScroll className="rounded-xl bg-bg-secondary" stickyFirstCol>
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className={theadRowCls}>
              <th className={`${thCls} w-10`}><input type="checkbox" className={checkboxCls} checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} aria-label={t('migration.accounts.selectAll') || 'Select every shown account'} /></th>
              <th className={thCls}>{t('migration.accounts.cwpUser') || 'CWP account'}</th>
              <th className={thCls}>{t('migration.accounts.tenant') || 'Workspace'}</th>
              <th className={thCls}>{t('migration.accounts.targetUsername') || 'Target username'}</th>
              <th className={thCls}>{t('migration.accounts.plan') || 'Plan'}</th>
              <th className={thCls}>{t('migration.accounts.content') || 'Domains / sites / proxies / DB / mail'}</th>
              <th className={thCls}>{t('migration.accounts.volume') || 'Volume'}</th>
              <th className={thCls}>{t('migration.accounts.dryRun') || 'Dry-run'}</th>
              <th className={`${thCls} w-12`}><span className="sr-only">{t('common.edit') || 'Edit'}</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const c = editor.accountChoice(a.cwpUsername);
              const selected = c.selected ?? a.selected;
              const tenantId = c.tenantId ?? a.tenantId;
              const counts = severityCounts(a.warnings);
              return (
                <tr key={a.cwpUsername} className={cn('transition-colors hover:bg-bg-hover', a.blocked && 'bg-status-down/[0.04]', !selected && 'opacity-60')}>
                  <td className={tdCls}><input type="checkbox" className={checkboxCls} checked={selected} onChange={(e) => editor.editAccount(a.cwpUsername, (x) => ({ ...x, selected: e.target.checked }))} aria-label={a.cwpUsername} /></td>
                  <td className={tdCls}>
                    <button type="button" className="font-mono text-sm text-text-primary hover:text-accent" onClick={() => onOpenAccount(a.cwpUsername)}>{a.cwpUsername}</button>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {a.suspended && <Pill tone="amber">{t('migration.inventory.suspended') || 'suspended'}</Pill>}
                      {a.existingAccountId != null && <Link to={`/accounts/${a.existingAccountId}`} className="text-[11px] text-accent hover:underline">{t('migration.accounts.existing') || 'already created'} #{a.existingAccountId}</Link>}
                      {editor.saving.has(a.cwpUsername) && <LoadingSpinner size="sm" />}
                    </div>
                  </td>
                  <td className={tdCls}>
                    <select aria-label={t('migration.accounts.tenant') || 'Workspace'} className={cn(selectCls, 'w-36 py-1.5 text-xs')} value={tenantId} onChange={(e) => editor.editAccount(a.cwpUsername, (x) => ({ ...x, tenantId: Number(e.target.value), planId: null }))}>
                      {(catalog?.tenants ?? [{ id: tenantId, name: `#${tenantId}` }]).map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
                    </select>
                  </td>
                  <td className={tdCls}>
                    <input aria-label={t('migration.accounts.targetUsername') || 'Target username'} className={cn(inputCls, 'w-36 py-1.5 font-mono text-xs')} value={c.targetUsername ?? a.targetUsername} onChange={(e) => editor.editAccount(a.cwpUsername, (x) => ({ ...x, targetUsername: e.target.value.trim().toLowerCase() || null }))} spellCheck={false} />
                  </td>
                  <td className={`${tdCls} text-xs text-text-secondary`}>{planName(a)}</td>
                  <td className={`${tdCls} font-mono text-xs text-text-secondary`}>
                    {a.domains.length} / {a.sites.length} / {a.proxies.length} / {a.databases.length} / {a.mailboxes.length}
                  </td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatBytes(a.estimates.filesBytes + a.estimates.dbBytes + a.estimates.mailBytes, units)}</td>
                  <td className={tdCls}>{a.warnings.length ? <SeverityCounts counts={counts} /> : <Pill tone="green">OK</Pill>}</td>
                  <td className={`${tdCls} text-right`}><IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={14} />} onClick={() => onOpenAccount(a.cwpUsername)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      {shown.length === 0 && <EmptyState icon={<UserRound />} text={t('common.noMatch') || 'No match'} />}

      <Drawer
        open={openAccount != null}
        onClose={() => onOpenAccount(null)}
        side="right"
        size="lg"
        className="lg:w-[min(95vw,820px)]"
        title={openAccount ? t('migration.editor.title', { user: openAccount, defaultValue: 'Account {{user}}' }) : ''}
        icon={<UserRound className="h-4 w-4 text-accent" />}
        headerExtra={openAccount && editor.saving.has(openAccount) ? <LoadingSpinner size="sm" /> : null}
      >
        {openAccount && <AccountEditor username={openAccount} editor={editor} inventory={inventory} inventoryStatus={inventoryStatus} catalog={catalog} />}
      </Drawer>
    </div>
  );
}
