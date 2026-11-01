import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ListTree, MapPin, Network, RefreshCw, Shuffle } from 'lucide-react';
import { HostingSocketEvents, type NetworkFlowView, type NetworkSystemStatus } from '@oblimint/shared';
import { systemNetworkApi } from '@/api/network.api';
import { Button } from '@/components/common/Button';
import { Drawer } from '@/components/common/Drawer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, inputCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { UsageMeter } from '@/components/apps/charts';
import { formatDateTime } from '@/components/apps/appsFormat';

/** Platform admin: segmentation policy state (mode, pools, migration, last push, flows) — /system/network. */
export function NetworkSystemPanel({ accountId }: { accountId: number | null }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [status, setStatus] = useState<NetworkSystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'migrate' | 'pin' | null>(null);
  const [flowsOpen, setFlowsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await systemNetworkApi.status());
      setError(null);
    } catch (err) {
      setError(appsErrorMessage(t, err, t('network.system.loadFailed') || 'Failed to load the network state', 'network'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.NETWORK_UPDATED], () => { void load(); }, undefined, 2000);

  const sync = async () => {
    setBusy('sync');
    try {
      setStatus(await systemNetworkApi.sync());
      toast.success(t('network.system.synced') || 'Policy pushed');
    } catch (err) {
      toastAppsError(t, err, t('network.system.syncFailed') || 'The push failed', 'network');
    } finally {
      setBusy(null);
    }
  };

  const migrate = async () => {
    if (!(await confirm({
      title: t('network.system.migrateTitle') || 'Migrate to segmented networks',
      message: accountId != null
        ? (t('network.system.migrateOne') || 'Register the networks of this account and create a link from each site to each database instance (what they could reach before). No container is recreated.')
        : (t('network.system.migrateAll') || 'Same for every account still on the legacy model. No container is recreated.'),
      confirmLabel: t('network.system.migrate') || 'Migrate',
    }))) return;
    setBusy('migrate');
    try {
      setStatus(await systemNetworkApi.migrate(accountId != null ? { accountId } : {}));
      toast.success(t('network.system.migrated') || 'Migration started');
    } catch (err) {
      toastAppsError(t, err, t('network.system.migrateFailed') || 'The migration failed', 'network');
    } finally {
      setBusy(null);
    }
  };

  const pin = async () => {
    if (!(await confirm({
      title: t('network.system.addresses.pinTitle') || 'Pin the container addresses now',
      message: t('network.system.addresses.pinMessage') || 'Every container whose address is still dynamic gets it as a fixed one, without being recreated: about 250 ms of network interruption per running container (open TCP connections survive), platform first, one every half second. The address rules then stay right across reboots.',
      confirmLabel: t('network.system.addresses.pin') || 'Pin now',
    }))) return;
    setBusy('pin');
    try {
      const r = await systemNetworkApi.pin();
      setStatus(r.status);
      if (r.failed > 0) toast.error(t('network.system.addresses.pinPartial', { pinned: r.pinned, failed: r.failed, defaultValue: '{{pinned}} pinned, {{failed}} failed (see the logs)' }));
      else toast.success(t('network.system.addresses.pinned', { count: r.pinned, defaultValue: '{{count}} address(es) pinned' }));
    } catch (err) {
      toastAppsError(t, err, t('network.system.addresses.pinFailed') || 'The pinning failed', 'network');
    } finally {
      setBusy(null);
    }
  };

  const modePill = (m: NetworkSystemStatus['mode']) => (m === 'enforce'
    ? <Pill tone="green">{t('network.mode.enforce') || 'enforce'}</Pill>
    : m === 'monitor' ? <Pill tone="amber">{t('network.mode.monitor') || 'monitor'}</Pill>
      : <Pill tone="muted">{t('network.mode.off') || 'off'}</Pill>);

  return (
    <Card
      icon={<Network size={14} className="text-accent" />}
      title={t('network.system.title') || 'Segmentation (platform)'}
      actions={status ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setFlowsOpen(true)}><ListTree size={13} className="mr-1" />{t('network.system.flows') || 'Flows'}</Button>
          <Button size="sm" variant="secondary" loading={busy === 'migrate'} disabled={busy !== null} onClick={() => { void migrate(); }}><Shuffle size={13} className="mr-1" />{t('network.system.migrate') || 'Migrate'}</Button>
          {accountId == null && (
            <Button size="sm" variant="secondary" loading={busy === 'pin'} disabled={busy !== null} onClick={() => { void pin(); }}><MapPin size={13} className="mr-1" />{t('network.system.addresses.pin') || 'Pin now'}</Button>
          )}
          <Button size="sm" variant="secondary" loading={busy === 'sync'} disabled={busy !== null} onClick={() => { void sync(); }}><RefreshCw size={13} className="mr-1" />{t('network.system.sync') || 'Push now'}</Button>
        </>
      ) : undefined}
    >
      {!status ? (error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <InfoRow label={t('network.system.mode') || 'Mode'}>{modePill(status.mode)}</InfoRow>
            <InfoRow label={t('network.system.accounts') || 'Accounts'}>
              <span className="font-mono text-xs">
                {t('network.system.accountsCounts', { segmented: status.accounts.segmented, legacy: status.accounts.legacy, defaultValue: '{{segmented}} segmented · {{legacy}} legacy' })}
                {status.accounts.failed > 0 && <span className="text-status-down"> · {t('network.system.failedCount', { count: status.accounts.failed, defaultValue: '{{count}} failed' })}</span>}
              </span>
            </InfoRow>
            <InfoRow label={t('network.system.rules') || 'Bridges / flows'} mono>{status.bridges} / {status.rules}</InfoRow>
            <InfoRow label={t('network.system.dropped') || 'Dropped frames'} mono>{status.dropped ?? '—'}</InfoRow>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {status.pools.map((p) => (p.error ? (
              <p key={p.name} className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {t('network.system.poolInvalid', { pool: p.name, error: p.error, defaultValue: 'Pool {{pool}} invalid: {{error}}' })}
              </p>
            ) : (
              <UsageMeter key={p.name} label={`${p.name} · ${p.cidr} /${p.prefix}`} used={p.used} limit={p.total} format={(v) => String(v)} />
            )))}
          </div>
          <p className="text-xs text-text-muted">
            {t('network.system.lastPush', { date: formatDateTime(status.lastPushAt, i18n.language), defaultValue: 'Last push: {{date}}' })}
          </p>
          {status.addresses && accountId == null && <AddressesBlock a={status.addresses} />}
          {status.lastPushError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{status.lastPushError}</p>}
          {status.mode !== 'enforce' && (
            <p className="flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('network.system.notEnforced') || 'The policy is not enforced: containers of an account can reach each other (Settings → Network).'}</p>
          )}
        </div>
      )}
      <FlowsDrawer open={flowsOpen} accountId={accountId} onClose={() => setFlowsOpen(false)} />
    </Card>
  );
}

/** Fixed container addresses (migration 031): pinned / dynamic / conflicts, networks where Docker refuses them. */
function AddressesBlock({ a }: { a: NonNullable<NetworkSystemStatus['addresses']> }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-bg-primary px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <MapPin size={13} className="text-accent" />
        <span className="font-semibold text-text-primary">{t('network.system.addresses.title') || 'Fixed addresses'}</span>
        <Pill tone="green">{t('network.system.addresses.pinnedCount', { count: a.pinned, defaultValue: '{{count}} pinned' })}</Pill>
        {a.unpinned > 0 && <Pill tone="amber">{t('network.system.addresses.unpinnedCount', { count: a.unpinned, defaultValue: '{{count}} dynamic' })}</Pill>}
        {a.conflicts > 0 && <Pill tone="red">{t('network.system.addresses.conflictCount', { count: a.conflicts, defaultValue: '{{count}} conflict(s)' })}</Pill>}
        <span className="text-text-muted">
          {a.pinning === 'auto'
            ? (t('network.system.addresses.modeAuto') || 'automatic pinning')
            : (t('network.system.addresses.modeManual') || 'manual pinning (Settings → Network)')}
          {' · '}
          {t('network.system.addresses.lastSweep', { date: formatDateTime(a.lastSweepAt, i18n.language), defaultValue: 'last sweep: {{date}}' })}
        </span>
      </div>
      {a.unpinned > 0 && (
        <p className="flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('network.system.addresses.unpinnedHint') || 'Containers with a dynamic address may get another one at the next reboot: the rules restored by hostd would then name the wrong containers until the panel pushes fresh ones. Pin them now (a brief network interruption per container).'}</p>
      )}
      {a.conflicts > 0 && (
        <p className="flex items-start gap-2 text-xs text-status-down"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('network.system.addresses.conflictHint') || 'A container uses an address allocated to another one (connected by hand?): it gets no flow on the account networks until it is reconnected or recreated.'}</p>
      )}
      {a.refusedNetworks.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {t('network.system.addresses.refused', { networks: a.refusedNetworks.join(', '), defaultValue: 'Docker refuses fixed addresses on {{networks}} (subnet chosen by Docker, Docker 28 or older): update Docker to 29 or later (live-restore keeps the containers running), or recreate these networks with an explicit subnet.' })}
        </p>
      )}
      {a.unknownNetworks.length > 0 && (
        <p className="text-xs text-text-muted">{t('network.system.addresses.unknown', { networks: a.unknownNetworks.join(', '), defaultValue: 'Support of fixed addresses not checked yet on {{networks}}.' })}</p>
      )}
      {a.lastSweepError && <p className="text-xs text-status-down">{a.lastSweepError}</p>}
    </div>
  );
}

function FlowsDrawer({ open, accountId, onClose }: { open: boolean; accountId: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [flows, setFlows] = useState<NetworkFlowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFlows(null);
    systemNetworkApi.flows(accountId ?? undefined)
      .then((f) => { if (!cancelled) { setFlows(f); setError(null); } })
      .catch((err) => { if (!cancelled) { setFlows([]); setError(appsErrorMessage(t, err, t('network.system.flowsFailed') || 'Failed to load the flows', 'network')); } });
    return () => { cancelled = true; };
  }, [open, accountId, t]);
  const q = filter.trim().toLowerCase();
  const shown = (flows ?? []).filter((f) => !q || [f.bridge, f.src.container, f.src.ip, f.dst.container, f.dst.ip, f.reason, String(f.port)].some((v) => v.toLowerCase().includes(q)));
  const { sorted: sortedFlows, sort } = useTableSort(shown, {
    bridge: (f) => f.bridge, source: (f) => f.src.container, target: (f) => f.dst.container, port: (f) => f.port, reason: (f) => f.reason,
  });
  return (
    <Drawer open={open} onClose={onClose} size="full" title={t('network.system.flowsTitle') || 'Allowed flows'} icon={<ListTree className="h-4 w-4 text-accent" />}>
      <div className="space-y-3 pb-4">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('apps.logs.filter') || 'Filter…'} className={cn(inputCls, 'sm:w-72')} />
        {error && <p className="text-sm text-status-down">{error}</p>}
        {flows === null ? <div className="flex justify-center py-8"><LoadingSpinner /></div> : (
          <TableScroll className="bg-bg-primary">
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr className={theadRowCls}>
                  <SortTh k="bridge" sort={sort} className={thCls}>{t('network.system.bridge') || 'Bridge'}</SortTh>
                  <SortTh k="source" sort={sort} className={thCls}>{t('network.source') || 'From'}</SortTh>
                  <SortTh k="target" sort={sort} className={thCls}>{t('network.target') || 'To'}</SortTh>
                  <SortTh k="port" sort={sort} className={thCls}>{t('network.port') || 'Port'}</SortTh>
                  <SortTh k="reason" sort={sort} className={thCls}>{t('network.system.reason') || 'Reason'}</SortTh>
                </tr>
              </thead>
              <tbody>
                {sortedFlows.map((f, i) => (
                  <tr key={i} className="border-t border-border/40 font-mono">
                    <td className="px-4 py-2 text-text-muted">{f.bridge}</td>
                    <td className="px-4 py-2"><div className="text-text-primary">{f.src.container}</div><div className="text-text-muted">{f.src.ip} · {f.src.segment}</div></td>
                    <td className="px-4 py-2"><div className="text-text-primary">{f.dst.container}</div><div className="text-text-muted">{f.dst.ip} · {f.dst.segment}</div></td>
                    <td className="px-4 py-2 text-text-secondary">{f.port}/{f.protocol}</td>
                    <td className="px-4 py-2"><Pill tone={f.reason === 'link' ? 'accent' : 'muted'}>{f.reason}{f.linkId ? ` #${f.linkId}` : ''}</Pill></td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-text-muted">{t('network.system.noFlow') || 'No flow.'}</td></tr>}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </Drawer>
  );
}
