import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronRight, KeyRound, Network, Plus, RefreshCw, Search, Server } from 'lucide-react';
import { HostingSocketEvents, type DnsServerStatus, type DnsZone } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { EmptyState, Pill, headerAccentBtnCls, headerBtnCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { ZoneKindBadge, ZoneStatusBadge } from './DnsBadges';
import { DnsZoneCreateModal } from './DnsZoneCreateModal';
import { dnsErrorMessage, toastDnsError } from './dnsErrors';

/** Platform DNS server state (platform admin): PowerDNS reachability + full resync. */
function DnsServerStrip() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<DnsServerStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    dnsApi.serverStatus().then((s) => { if (!cancelled) setStatus(s); }).catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;

  const sync = async () => {
    setSyncing(true);
    try {
      setStatus(await dnsApi.syncAll());
      toast.success(t('dns.server.synced') || 'Zones resynchronised');
    } catch (err) {
      toastDnsError(t, err, t('dns.server.syncFailed') || 'Resynchronisation failed');
    } finally {
      setSyncing(false);
    }
  };

  const healthy = status.enabled && status.running && status.apiReachable;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-bg-secondary px-4 py-3 text-xs">
      <Server size={14} className="text-accent" />
      <span className="font-mono uppercase tracking-[0.12em] text-text-muted">{t('dns.server.title') || 'DNS server'}</span>
      {!status.enabled ? (
        <Pill>{t('dns.server.disabled') || 'Disabled (every zone external)'}</Pill>
      ) : healthy ? (
        <Pill tone="green">{t('dns.server.running') || 'Running'}{status.version ? ` · ${status.version}` : ''}</Pill>
      ) : (
        <Pill tone="red">{!status.deployed ? (t('dns.server.notDeployed') || 'Not deployed') : (t('dns.server.unreachable') || 'Unreachable')}</Pill>
      )}
      <span className="text-text-secondary">
        {t('dns.server.zones', {
          total: status.zones.total, active: status.zones.active, pending: status.zones.pending, error: status.zones.error,
          defaultValue: '{{total}} zones · {{active}} active · {{pending}} pending · {{error}} in error',
        })}
      </span>
      {status.lastSyncError && <span className="min-w-0 break-words text-status-down">{status.lastSyncError}</span>}
      <span className="ml-auto flex items-center gap-2">
        {status.lastSyncAt && <span className="font-mono text-text-muted">{new Date(status.lastSyncAt).toLocaleString(i18n.language)}</span>}
        {status.enabled && (
          <Button size="sm" variant="secondary" loading={syncing} onClick={() => { void sync(); }}>
            <RefreshCw size={13} className="mr-1.5" />{t('dns.server.syncAll') || 'Resync all'}
          </Button>
        )}
      </span>
    </div>
  );
}

/** Zones tab of « Domains & DNS ». */
export function DnsZonesTab() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  // Platform admin = role admin in the master tenant (server: caps '*' && globalView).
  const isMaster = useIsMasterTenant();
  const platformAdmin = isMaster;
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setZones(await dnsApi.listZones({ platform }));
      setLoadError(null);
    } catch (err) {
      setZones([]);
      setLoadError(dnsErrorMessage(t, err, t('dns.zones.loadFailed') || 'Failed to load the zones'));
    } finally {
      setLoading(false);
    }
  }, [t, platform]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.DNS_ZONE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (e, p) => (
    e === HostingSocketEvents.DNS_ZONE_UPDATED || ['dnsZone', 'domain'].includes(String((p as { entity?: string } | null)?.entity))
  ));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => z.name.includes(q) || (z.accountUsername ?? '').toLowerCase().includes(q));
  }, [zones, search]);

  const canCreate = can('dns.manage');
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');

  return (
    <div className="flex flex-col gap-4">
      {platformAdmin && <DnsServerStrip />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('dns.zones.searchPlaceholder') || 'Search a zone or an account…'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
        {platformAdmin && (
          <ToggleSwitch size="sm" checked={platform} onChange={setPlatform} label={t('dns.zones.showPlatform') || 'Platform zones'} />
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('dns.zones.create') || 'New zone'}</button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Network />}
          text={search ? (t('common.noMatch') || 'No match') : (t('dns.zones.empty') || 'No DNS zone yet: zones are created with the domains.')}
        />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {filtered.map((z) => (
              <li key={z.id}>
                <Link to={`/dns/zones/${z.id}`} className="block w-full rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{z.name}</span>
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    <ZoneStatusBadge status={z.status} message={z.statusMessage} />
                    <ZoneKindBadge kind={z.kind} />
                    {z.dnssec && <Pill tone="green"><KeyRound size={10} />DNSSEC</Pill>}
                    <span className="font-mono">{z.accountUsername ?? (t('dns.zones.platform') || 'platform')}</span>
                    <span>{t('dns.zones.recordCount', { count: z.recordCount, defaultValue: '{{count}} record(s)' })}</span>
                    {isMaster && <TenantBadge tenantId={z.tenantId} />}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('dns.zones.col.name') || 'Zone'}</th>
                  <th className={thCls}>{t('domains.col.account') || 'Account'}</th>
                  {isMaster && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
                  <th className={thCls}>{t('dns.zones.col.kind') || 'Kind'}</th>
                  <th className={thCls}>{t('dns.zones.col.status') || 'Status'}</th>
                  <th className={`${thCls} text-right`}>{t('dns.zones.col.records') || 'Records'}</th>
                  <th className={thCls}>DNSSEC</th>
                  <th className={thCls}>{t('dns.zones.col.lastSync') || 'Last sync'}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((z) => (
                  <tr key={z.id} onClick={() => navigate(`/dns/zones/${z.id}`)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-3">
                      <Link to={`/dns/zones/${z.id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-text-primary hover:text-accent">{z.name}</Link>
                    </td>
                    <td className="px-4 py-3">
                      {z.accountId != null ? (
                        <Link to={`/accounts/${z.accountId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-text-secondary hover:text-accent">{z.accountUsername}</Link>
                      ) : (
                        <Pill>{t('dns.zones.platform') || 'platform'}</Pill>
                      )}
                    </td>
                    {isMaster && <td className="px-4 py-3"><TenantBadge tenantId={z.tenantId} /></td>}
                    <td className="px-4 py-3"><ZoneKindBadge kind={z.kind} /></td>
                    <td className="px-4 py-3"><ZoneStatusBadge status={z.status} message={z.statusMessage} /></td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{z.recordCount}</td>
                    <td className="px-4 py-3">{z.dnssec ? <KeyRound size={14} className="text-green-400" /> : <span className="text-text-muted">—</span>}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted">{fmt(z.lastSyncedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}

      <DnsZoneCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(z) => {
          setCreating(false);
          toast.success(t('dns.zones.created', { name: z.name, defaultValue: 'Zone {{name}} created' }));
          navigate(`/dns/zones/${z.id}`);
        }}
      />
    </div>
  );
}
