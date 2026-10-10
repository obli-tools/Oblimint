import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Unlink } from 'lucide-react';
import type { CwpInventory, MigrationPlanChoices } from '@oblimint/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card, EmptyState, Pill, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { MailSearch } from '@/components/mail/MailListParts';
import { matches, warningsFor } from '../migrationFormat';
import { InventoryStatus, TreeNode, WarningList, type InventoryLoad } from '../migrationUi';
import { ZonePreview } from './AccountEditor';
import type { PlanEditor } from './usePlanEditor';

type OrphanZones = NonNullable<MigrationPlanChoices['orphanZones']>;

/**
 * Zones of the source attached to no CWP account (forge, ns3/ns4, hostname…): the only way to migrate one is to
 * attach it to a migrated account (choices.orphanZones, compute.ts zoneOwner); empty = not migrated (zoneOrphan).
 */
function OrphanZonesCard({ editor, inventory }: { editor: PlanEditor; inventory: CwpInventory }) {
  const { t } = useTranslation();
  const orphans = inventory.dnsZones.filter((z) => z.account == null);
  if (orphans.length === 0) return null;
  const current: OrphanZones = editor.plan.choices.orphanZones ?? {};
  const users = inventory.accounts.map((a) => a.username).sort();
  const set = (zone: string, account: string | null) => {
    const next: OrphanZones = { ...current, [zone]: { account } };
    void editor.saveChoices({ orphanZones: next });
  };
  return (
    <Card
      title={t('migration.dns.orphansTitle') || 'Zones attached to no account'}
      icon={<Unlink size={14} className="text-amber-400" />}
      actions={editor.savingChoices ? <LoadingSpinner size="sm" /> : null}
    >
      <p className="mb-3 text-xs text-text-muted">{t('migration.dns.orphansHint') || 'These zones exist on the CWP server but belong to no account (forge, extra name servers, the hostname…). Attach one to a migrated account to import it into that account; otherwise it is not migrated.'}</p>
      <div className="space-y-1.5">
        {orphans.map((z) => {
          const value = current[z.name]?.account ?? current[z.name.toLowerCase()]?.account ?? '';
          return (
            <div key={z.name} className="flex flex-wrap items-center gap-2 rounded-md bg-bg-primary px-3 py-2 text-xs">
              <code className="font-mono text-text-primary">{z.name}</code>
              <span className="font-mono text-[11px] text-text-muted">{t('migration.dns.orphanRecords', { count: z.records.length, defaultValue: '{{count}} records' })}</span>
              {!z.declared && <Pill tone="amber">{t('migration.dns.orphanUndeclared') || 'not declared in named.conf'}</Pill>}
              <select
                aria-label={t('migration.dns.orphanAccount', { zone: z.name, defaultValue: 'Account of {{zone}}' })}
                className={cn(selectCls, 'ml-auto w-auto py-1.5 text-xs')}
                value={value}
                disabled={editor.savingChoices}
                onChange={(e) => set(z.name, e.target.value || null)}
              >
                <option value="">{t('migration.dns.orphanSkip') || 'Do not migrate'}</option>
                {users.map((u) => <option key={u} value={u}>{u}</option>)}
                {value && !users.includes(value) && <option value={value}>{value}</option>}
              </select>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Every planned zone of the plan (records imported, rewritten, dropped with the reason). */
export function PlanDnsTab({ editor, inventory, inventoryStatus }: { editor: PlanEditor; inventory: CwpInventory | null; inventoryStatus?: InventoryLoad }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const accounts = editor.plan.result?.accounts ?? [];
  const zones = accounts.flatMap((a) => a.zones.map((z) => ({ account: a, zone: z }))).filter(({ zone, account }) => matches(search, zone.name, account.cwpUsername));
  // The orphan-zones card needs the inventory: while it loads / when it failed, say so instead of hiding the card.
  const orphans = inventory ? <OrphanZonesCard editor={editor} inventory={inventory} />
    : inventoryStatus && (inventoryStatus.loading || inventoryStatus.error) ? <InventoryStatus status={inventoryStatus} compact /> : null;
  if (!editor.plan.result) return <div className="space-y-3">{orphans}<EmptyState icon={<Network />} text={t('migration.overview.noResult') || 'No dry-run yet.'} /></div>;
  return (
    <div className="space-y-3">
      {orphans}
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('migration.dns.search') || 'Zone or account…'} />
        <p className="min-w-0 flex-1 text-xs text-text-muted">{t('migration.dns.description') || 'Zones are read with the journal applied, the source IPs are rewritten exactly, SOA and apex NS are replaced by the platform ones, unsupported types and the records the mail DNS already provides are dropped.'}</p>
      </div>
      {zones.length === 0 ? <EmptyState icon={<Network />} text={t('migration.dns.empty') || 'No zone migrated by this plan.'} /> : (
        <div className="space-y-1 rounded-xl bg-bg-secondary p-2">
          {zones.map(({ account, zone }) => {
            const w = warningsFor(account.warnings, 'zone', zone.name);
            return (
              <TreeNode
                key={`${account.cwpUsername}-${zone.name}`}
                title={<span className="font-mono text-[13px]">{zone.name}</span>}
                badges={
                  <span className="inline-flex flex-wrap gap-1">
                    <Pill>{account.cwpUsername}</Pill>
                    {zone.domain && <Pill tone="blue">{zone.domain}</Pill>}
                    {zone.rewritten > 0 && <Pill tone="accent">{t('migration.dns.rewritten', { count: zone.rewritten, defaultValue: '{{count}} rewritten' })}</Pill>}
                    {zone.dropped.length > 0 && <Pill tone="amber">{t('migration.dns.dropped', { count: zone.dropped.length, defaultValue: '{{count}} dropped' })}</Pill>}
                  </span>
                }
                meta={`${zone.records.length} · TTL ${zone.defaultTtl}`}
              >
                <div className="space-y-2 px-1 pb-2">
                  <ZonePreview zone={zone} />
                  {w.length > 0 && <WarningList warnings={w} showScope={false} />}
                </div>
              </TreeNode>
            );
          })}
        </div>
      )}
    </div>
  );
}
