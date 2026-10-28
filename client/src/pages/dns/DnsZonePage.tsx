import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Download, EyeOff, FileStack, KeyRound, Lock, Network, Pencil, Plus, RotateCcw, Search, Trash2,
} from 'lucide-react';
import { HostingSocketEvents, type DnsRecord, type DnsRecordType, type DnsZoneDetail } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { AccountLink, DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, Pill, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { RecordOriginBadge, ZoneKindBadge, ZoneStatusBadge } from '@/components/dns/DnsBadges';
import { DnsRecordModal } from '@/components/dns/DnsRecordModal';
import { ApplyTemplateModal, DelegationCard, ExpectedRecordsCard, ZoneResetModal, ZoneSettingsCard } from '@/components/dns/DnsZoneCards';
import { RECORD_TYPES, compareRecords, fqdnOf } from '@/components/dns/dnsRecords';
import { apiErrorStatus, dnsErrorMessage, toastDnsError } from '@/components/dns/dnsErrors';
import { saveText } from '@/utils/download';
import { accountHref } from '@/utils/links';
import { cn } from '@/utils/cn';

type TypeFilter = 'all' | DnsRecordType;

/** /dns/zones/:id — record editor of a zone (read-only without dns.manage on the account). */
export function DnsZonePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const zoneId = Number(id);
  const { me, can } = useHostingMe();

  const [zone, setZone] = useState<DnsZoneDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [editing, setEditing] = useState<DnsRecord | 'new' | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  // A late answer for a previous zone (/dns/zones/1 → /2) must not land here.
  const reqSeq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!Number.isInteger(zoneId) || zoneId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const z = await dnsApi.getZone(zoneId);
      if (seq !== reqSeq.current) return;
      setZone(z);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (apiErrorStatus(err) === 404) setNotFound(true);
      else if (!quiet) setLoadError(dnsErrorMessage(t, err, t('dns.zone.loadFailed') || 'Failed to load the zone'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [zoneId, t]);

  useEffect(() => { setZone(null); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.DNS_ZONE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(true); }, (e, p) => {
    if (e === HostingSocketEvents.DNS_ZONE_UPDATED) return payloadNumber(p, 'zoneId') === zoneId;
    const entity = (p as { entity?: string } | null)?.entity;
    return entity === 'dnsZone' && payloadNumber(p, 'id') === zoneId;
  });

  const records = useMemo(() => {
    if (!zone) return [];
    const q = search.trim().toLowerCase();
    return zone.records
      .filter((r) => showSystem || r.origin !== 'system')
      .filter((r) => typeFilter === 'all' || r.type === typeFilter)
      .filter((r) => !q || r.name.includes(q) || r.content.toLowerCase().includes(q) || (r.comment ?? '').toLowerCase().includes(q))
      .sort(compareRecords);
  }, [zone, typeFilter, search, showSystem]);

  const typeCounts = useMemo(() => {
    const counts = new Map<DnsRecordType, number>();
    for (const r of zone?.records ?? []) if (showSystem || r.origin !== 'system') counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return counts;
  }, [zone, showSystem]);

  if (loading && !zone) {
    return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;
  }
  if (notFound || !zone) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Network className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('dns.zone.notFound') || 'This zone does not exist or is not visible to you.') : loadError}</p>
        <Link to="/domains?tab=zones" className="text-sm text-accent hover:underline">{t('dns.zone.backToList') || 'Back to the zones'}</Link>
      </PageContainer>
    );
  }

  const hosted = zone.kind === 'hosted';
  const manage = can('dns.manage', zone.accountId);
  const editable = manage && hosted;
  // Back without history / after a deletion: the domains of the account, not the global list.
  const fallbackHref = zone.accountId != null ? accountHref(zone.accountId, 'domains') : '/domains?tab=zones';
  const systemCount = zone.records.filter((r) => r.origin === 'system').length;

  const exportZone = async () => {
    try {
      const text = await dnsApi.exportZone(zone.id);
      if (!(await saveText(text, `${zone.name}.zone`))) toast.error(t('dns.zone.exportFailed') || 'Export failed');
    } catch (err) {
      toastDnsError(t, err, t('dns.zone.exportFailed') || 'Export failed');
    }
  };

  const removeRecord = async (r: DnsRecord) => {
    if (!(await confirm({
      title: t('dns.records.deleteTitle') || 'Delete the record',
      message: t('dns.records.deleteConfirm', { name: fqdnOf(r.name, zone.name), type: r.type, content: r.content, defaultValue: 'Delete {{type}} {{name}} → {{content}}?' }),
      danger: true,
    }))) return;
    try {
      await dnsApi.deleteRecord(zone.id, r.id);
      setZone((z) => (z ? { ...z, records: z.records.filter((x) => x.id !== r.id), recordCount: z.recordCount - 1 } : z));
      toast.success(t('dns.records.deleted') || 'Record deleted');
      void load(true); // serial / status
    } catch (err) {
      toastDnsError(t, err, t('dns.records.deleteFailed') || 'Failed to delete the record');
    }
  };

  /** Auto records cannot be deleted: disabling one stores a manual, disabled override. */
  const disableAutoRecord = async (r: DnsRecord) => {
    if (!(await confirm({
      title: t('dns.records.disableAutoTitle') || 'Disable the automatic record',
      message: t('dns.records.disableAutoConfirm', {
        name: fqdnOf(r.name, zone.name), type: r.type, content: r.content,
        defaultValue: 'Automatic records follow the domain and cannot be deleted. Disable {{type}} {{name}} → {{content}}? It becomes a manual record that stays disabled (a zone reset restores it).',
      }),
    }))) return;
    try {
      await dnsApi.updateRecord(zone.id, r.id, {
        name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority, disabled: true, comment: r.comment,
      });
      toast.success(t('dns.records.disabledAuto') || 'Record disabled');
      void load(true);
    } catch (err) {
      toastDnsError(t, err, t('dns.records.saveFailed') || 'Failed to save the record');
    }
  };

  const removeZone = async () => {
    if (!(await confirm({
      title: t('dns.zone.deleteTitle') || 'Delete the zone',
      message: t('dns.zone.deleteConfirm', { name: zone.name, defaultValue: 'Delete the zone {{name}} and all its records? Our name servers stop answering for it.' }),
      danger: true,
      requireText: zone.name,
    }))) return;
    try {
      await dnsApi.deleteZone(zone.id);
      toast.success(t('dns.zone.deleted') || 'Zone deleted');
      navigate(fallbackHref, { replace: true });
    } catch (err) {
      toastDnsError(t, err, t('dns.zone.deleteFailed') || 'Failed to delete the zone');
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const recordActions = (r: DnsRecord) => {
    if (!editable || r.origin === 'system') return r.origin === 'system' ? <Lock size={13} className="text-text-muted" /> : null;
    return (
      <span className="inline-flex">
        <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={13} />} size="sm" onClick={() => setEditing(r)} />
        {r.origin === 'auto' ? (
          // Auto records follow the domain: the server refuses to delete them
          // (409 recordConflict field=origin). Disabling turns the record into a
          // manual override that suppresses the generated one.
          !r.disabled && (
            <IconButton
              label={t('dns.records.disableAuto') || 'Disable (automatic records cannot be deleted)'}
              icon={<EyeOff size={13} />}
              size="sm"
              onClick={() => { void disableAutoRecord(r); }}
            />
          )
        ) : (
          <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={13} />} size="sm" variant="danger" onClick={() => { void removeRecord(r); }} />
        )}
      </span>
    );
  };

  return (
    <PageContainer className="flex flex-col gap-5">
      {/* Header */}
      <DetailHeader
        backTo={fallbackHref}
        title={zone.name}
        badges={(
          <>
            <ZoneStatusBadge status={zone.status} message={zone.statusMessage} />
            <ZoneKindBadge kind={zone.kind} />
            {zone.dnssec && <Pill tone="green"><KeyRound size={10} />DNSSEC</Pill>}
            {!manage && <Pill><Lock size={10} />{t('dns.zone.readOnly') || 'read-only'}</Pill>}
            <TenantBadge tenantId={zone.tenantId} size="md" />
          </>
        )}
        subtitle={(
          <>
            {zone.accountId != null
              ? <AccountLink accountId={zone.accountId} username={zone.accountUsername} tab="domains" />
              : <span>{t('dns.zones.platform') || 'platform'}</span>}
            <span>·</span>
            <span className="font-mono">{t('dns.zone.serial') || 'serial'} {zone.serial}</span>
            <span>·</span>
            <span className="font-mono">TTL {zone.defaultTtl}</span>
            <span>·</span>
            <span>{t('dns.zone.lastSync', { date: fmt(zone.lastSyncedAt), defaultValue: 'synced {{date}}' })}</span>
          </>
        )}
        message={zone.status === 'error' ? zone.statusMessage : null}
        onRefresh={() => { void load(true); }}
        actions={(
          <>
            {editable && (
              <Button size="sm" onClick={() => setEditing('new')} className="coarse:min-h-10">
                <Plus size={14} className="mr-1" />{t('dns.records.add') || 'Add a record'}
              </Button>
            )}
            <ActionMenu
              triggerSize="lg"
              triggerVariant="solid"
              triggerClassName="rounded-lg"
              items={[
                { key: 'export', icon: <Download className="h-4 w-4" />, label: t('dns.zone.export') || 'Export (BIND)', onClick: () => { void exportZone(); } },
                { key: 'template', icon: <FileStack className="h-4 w-4" />, label: t('dns.templates.applyTitle') || 'Apply a template', onClick: () => setTemplateOpen(true), hidden: !editable || me?.kind !== 'staff' },
                { key: 'reset', icon: <RotateCcw className="h-4 w-4" />, label: t('dns.reset.title') || 'Reset the zone', onClick: () => setResetOpen(true), hidden: !manage },
                { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('dns.zone.delete') || 'Delete the zone', onClick: () => { void removeZone(); }, danger: true, separator: true, hidden: !manage },
              ]}
            />
          </>
        )}
      />

      {!hosted && <ExpectedRecordsCard zone={zone} />}

      {/* Records */}
      <Card
        title={t('dns.records.title') || 'Records'}
        icon={<Network size={14} className="text-accent" />}
        actions={systemCount > 0 ? (
          <ToggleSwitch size="sm" checked={showSystem} onChange={setShowSystem} label={t('dns.records.showSystem', { count: systemCount, defaultValue: 'System ({{count}})' })} />
        ) : undefined}
      >
        {!hosted && (
          <p className="mb-3 flex items-start gap-2 text-xs text-text-muted">
            <EyeOff size={14} className="mt-0.5 shrink-0" />
            {t('dns.records.externalNotice') || 'This zone is hosted elsewhere: these records are not published by our name servers.'}
          </p>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {(['all', ...RECORD_TYPES] as TypeFilter[]).filter((ty) => ty === 'all' || typeCounts.has(ty)).map((ty) => (
              <button
                key={ty}
                type="button"
                onClick={() => setTypeFilter(ty)}
                className={cn(
                  'rounded-full px-2.5 py-1 font-mono text-[11px] transition-colors coarse:min-h-8',
                  typeFilter === ty ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                )}
              >
                {ty === 'all' ? (t('hostingCommon.all') || 'All') : ty}
                <span className="ml-1 opacity-70">{ty === 'all' ? [...typeCounts.values()].reduce((a, b) => a + b, 0) : typeCounts.get(ty)}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full sm:ml-auto sm:w-60">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-text-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('dns.records.search') || 'Filter…'}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className="w-full rounded-md border border-bg-tertiary bg-bg-primary py-1 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
            />
          </div>
        </div>

        {records.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">
            {zone.records.length === 0 ? (t('dns.records.empty') || 'No record yet.') : (t('common.noMatch') || 'No match')}
          </p>
        ) : (
          <GroupedTable<DnsRecord>
            singleGroupFlat
            minWidth={820}
            className="bg-bg-primary"
            rowClassName={(r) => r.disabled && 'opacity-60'}
            // Default order: compareRecords (apex first, then by name / type); every column sorts; a record sits
            // under the record of its parent name (www.example.com under example.com).
            groups={[{ key: 'records', label: '', sortLabel: '', nodes: domainTree(records, (r) => fqdnOf(r.name, zone.name), (r) => r.id) }]}
            renderCard={(r) => (
              <div className={cn('rounded-lg bg-bg-primary p-2.5', r.disabled && 'opacity-60')}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-accent">{r.type}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">{r.name}</span>
                  {recordActions(r)}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-text-secondary">
                  {r.priority != null && <span className="text-text-muted">{r.priority} </span>}{r.content}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                  <RecordOriginBadge origin={r.origin} />
                  <span className="font-mono">TTL {r.ttl}</span>
                  {r.disabled && <Pill>{t('dns.records.disabled') || 'Disabled'}</Pill>}
                  {r.comment && <span className="truncate">{r.comment}</span>}
                </div>
              </div>
            )}
            columns={[
              {
                id: 'name', header: t('dns.records.fields.name') || 'Name', sort: (r) => fqdnOf(r.name, zone.name),
                cell: (r) => (
                  <div>
                    <div className="font-mono text-text-primary">{r.name}</div>
                    {r.comment && <div className="text-[11px] text-text-muted">{r.comment}</div>}
                  </div>
                ),
              },
              { id: 'type', header: t('dns.records.fields.type') || 'Type', tdClassName: 'font-mono text-xs font-semibold text-accent', sort: (r) => r.type, cell: (r) => r.type },
              {
                id: 'content', header: t('dns.records.fields.content') || 'Content', tdClassName: 'max-w-[28rem]',
                sort: (r) => `${r.priority ?? ''} ${r.content}`.trim(),
                cell: (r) => (
                  <span>
                    <span className="break-all font-mono text-xs text-text-secondary">
                      {r.priority != null && <span className="text-text-muted">{r.priority} </span>}{r.content}
                    </span>
                    {r.disabled && <Pill className="ml-2">{t('dns.records.disabled') || 'Disabled'}</Pill>}
                  </span>
                ),
              },
              { id: 'ttl', header: 'TTL', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (r) => r.ttl, cell: (r) => r.ttl },
              { id: 'origin', header: t('dns.records.fields.origin') || 'Origin', sort: (r) => r.origin, cell: (r) => <RecordOriginBadge origin={r.origin} /> },
              { id: 'actions', header: <span className="sr-only">{t('common.edit') || 'Edit'}</span>, thClassName: 'w-20', tdClassName: 'text-right', cell: (r) => recordActions(r) },
            ]}
          />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ZoneSettingsCard zone={zone} manage={manage} onChanged={setZone} />
        <div className="flex flex-col gap-5">
          {hosted && <ExpectedRecordsCard zone={zone} />}
          {hosted && <DelegationCard zone={zone} />}
        </div>
      </div>

      <DnsRecordModal
        open={editing !== null}
        zone={zone}
        record={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(r) => {
          const wasNew = editing === 'new';
          setEditing(null);
          setZone((z) => (z ? { ...z, records: wasNew ? [...z.records, r] : z.records.map((x) => (x.id === r.id ? r : x)) } : z));
          toast.success(t('dns.records.saved') || 'Record saved');
          void load(true);
        }}
      />
      <ZoneResetModal open={resetOpen} zone={zone} onClose={() => setResetOpen(false)} onDone={(z) => { setResetOpen(false); setZone(z); toast.success(t('dns.reset.done') || 'Zone reset'); }} />
      <ApplyTemplateModal open={templateOpen} zone={zone} onClose={() => setTemplateOpen(false)} onDone={(z) => { setTemplateOpen(false); setZone(z); toast.success(t('dns.templates.applied') || 'Template applied'); }} />
    </PageContainer>
  );
}
