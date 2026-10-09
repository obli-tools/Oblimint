import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BrickWall, Globe, HardDrive, Network, RefreshCw, Rocket, Server, ShieldCheck, Workflow } from 'lucide-react';
import type { DnsServerStatus, EdgeStatus, FirewallStatus, InfraComponentId, InfraComponentStatus, InfraStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { infraApi } from '@/api/infra.api';
import { firewallApi } from '@/api/firewall.api';
// Owned by module ui-dns-db: read-only use (status + resync of the zones).
import { dnsApi } from '@/api/dns.api';
import { opsErrorMessage, toastOpsError } from '@/components/usage/opsErrors';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, hostingErrorMessage, toastHostingError, useHostingEvents } from './hostingUi';

type Loaded<T> = { data: T; error: null } | { data: null; error: string };

/** Platform infrastructure of the local node: edge, hostd, disk quota mode, reconcile, ACME. */
export function InfraCards() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [infra, setInfra] = useState<Loaded<InfraStatus> | null>(null);
  const [edge, setEdge] = useState<Loaded<EdgeStatus> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, e] = await Promise.allSettled([infraApi.status(), infraApi.edgeStatus()]);
    setInfra(i.status === 'fulfilled' ? { data: i.value, error: null } : { data: null, error: hostingErrorMessage(t, i.reason, t('infra.loadFailed') || 'Failed to load the infrastructure status') });
    setEdge(e.status === 'fulfilled' ? { data: e.value, error: null } : { data: null, error: hostingErrorMessage(t, e.reason, t('infra.edge.loadFailed') || 'Failed to load the edge status') });
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.CERTIFICATE_UPDATED], () => { void load(); }, undefined, 2000);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const deploy = async (component: InfraComponentId, deployed: boolean) => {
    // Redeploying recreates a running shared container: the edge serves every
    // tenant's sites and the panel vhost, hostd carries quota/provisioning calls.
    if (deployed && !(await confirm({
      title: t('infra.redeployTitle', { component, defaultValue: 'Redeploy {{component}}' }),
      message: component === 'edge'
        ? (t('infra.redeployEdgeConfirm') || 'The edge container (nginx) is recreated: every site of every workspace and the panel itself are briefly unreachable.')
        : component === 'dns'
          ? (t('platformSettings.infra.redeployDnsConfirm') || 'The PowerDNS container is recreated: the hosted zones do not answer for a few seconds (secondary servers keep answering).')
          : component === 'dbadmin'
            ? (t('platformSettings.infra.redeployDbAdminConfirm') || 'The phpMyAdmin and Adminer containers are recreated: open database admin sessions are closed.')
            : component === 'scanner'
              ? (t('scanner.infra.redeployConfirm') || 'The scanner container is recreated: analyses in progress fall back to the heuristics and the ClamAV signatures are reloaded (a few minutes).')
              : (t('infra.redeployHostdConfirm') || 'The hostd container is recreated: quota and provisioning operations in progress are interrupted.'),
      confirmLabel: t('infra.redeploy') || 'Redeploy',
      danger: true,
    }))) return;
    await runDeploy(component);
  };

  const runDeploy = (component: InfraComponentId) => run(`deploy-${component}`, async () => {
    try {
      setInfra({ data: await infraApi.deploy(component), error: null });
      toast.success(t('infra.deployed', { component, defaultValue: '{{component}} deployed' }));
    } catch (err) {
      toastHostingError(t, err, t('infra.deployFailed') || 'Deployment failed');
    }
  });

  const reconcile = async () => {
    if (!(await confirm({
      title: t('infra.reconcile') || 'Reconcile now',
      message: t('infra.reconcileConfirm') || 'Everything that drifted is recreated now (networks, containers, quotas, file servers): sites whose container is recreated are briefly unreachable.',
      confirmLabel: t('infra.reconcile') || 'Reconcile now',
      danger: true,
    }))) return;
    await runReconcile();
  };

  const runReconcile = () => run('reconcile', async () => {
    try {
      await infraApi.reconcile();
      toast.success(t('infra.reconcileStarted') || 'Reconciliation started');
    } catch (err) {
      toastHostingError(t, err, t('infra.reconcileFailed') || 'Reconciliation failed');
    }
  });

  if (!infra || !edge) return <div className="flex justify-center py-8"><LoadingSpinner /></div>;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title={t('infra.title') || 'Infrastructure'}
        icon={<Network size={14} className="text-accent" />}
        actions={
          <>
            <Button size="sm" variant="secondary" loading={busy === 'reconcile'} disabled={busy !== null} onClick={() => { void reconcile(); }}>
              <Workflow size={13} className="mr-1.5" />{t('infra.reconcile') || 'Reconcile now'}
            </Button>
            <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={13} />} onClick={() => { void load(); }} disabled={busy !== null} />
          </>
        }
      >
        {infra.data === null ? (
          <p className="text-xs text-text-muted">{infra.error}</p>
        ) : (
          <div className="space-y-3">
            {infra.data.components.map((c) => (
              <ComponentRow key={c.id} c={c} busy={busy} onDeploy={() => { void deploy(c.id, c.deployed); }} />
            ))}
            <QuotaModeRow mode={infra.data.quotaMode} />
          </div>
        )}
        <p className="mt-3 text-xs text-text-muted">{t('infra.reconcileHint') || 'Reconciliation recreates whatever drifted (networks, containers, quotas, file servers). It also runs at boot and every 5 minutes.'}</p>
      </Card>

      <EdgeCard edge={edge} onChanged={(s) => setEdge({ data: s, error: null })} onReload={() => { void load(); }} />
      <FirewallCard />
      <DnsServerCard />
    </div>
  );
}

// ── P2: firewall (hostd + nftables) ─────────────────────────────────────────

function FirewallCard() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<Loaded<FirewallStatus> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus({ data: await firewallApi.status(), error: null });
    } catch (err) {
      setStatus({ data: null, error: opsErrorMessage(t, err, 'security', t('platformSettings.firewall.loadFailed') || 'Failed to load the firewall status') });
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    setBusy(true);
    try {
      setStatus({ data: await firewallApi.syncAll(), error: null });
      toast.success(t('platformSettings.firewall.synced') || 'Firewall state pushed again to the host');
    } catch (err) {
      toastOpsError(t, err, 'security', t('platformSettings.firewall.syncFailed') || 'Failed to synchronise the firewall');
    } finally {
      setBusy(false);
    }
  };

  const s = status?.data ?? null;
  const egressLabel = (f: FirewallStatus['egressFilter']) => t(`platformSettings.access.egress.${f}`) || f;
  return (
    <Card
      title={t('platformSettings.firewall.title') || 'Firewall'}
      icon={<BrickWall size={14} className="text-accent" />}
      actions={s ? (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => { void sync(); }}>
          <RefreshCw size={13} className="mr-1.5" />{t('infra.edge.sync') || 'Synchronise'}
        </Button>
      ) : undefined}
    >
      {status === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : s === null ? (
        <p className="text-xs text-text-muted">{status.error}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <InfoRow label={t('infra.edge.state') || 'State'}>
              {s.enabled && s.backend === 'nftables'
                ? <Pill tone="green">nftables</Pill>
                : <Pill tone="amber">{t('platformSettings.firewall.disabled') || 'inactive'}</Pill>}
            </InfoRow>
            <InfoRow label={t('platformSettings.firewall.listeners') || 'Gateway listeners'} mono>{s.gatewayListeners}</InfoRow>
            <InfoRow label={t('platformSettings.firewall.egress') || 'Egress filter'}>{egressLabel(s.egressFilter)}</InfoRow>
            <InfoRow label={t('platformSettings.firewall.lastApply') || 'Last applied'} mono>{s.lastApplyAt ? new Date(s.lastApplyAt).toLocaleString(i18n.language) : '—'}</InfoRow>
          </div>
          {s.lastApplyError && (
            <div>
              <div className="mb-1 text-xs text-text-muted">{t('infra.edge.lastError') || 'Last error'}</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{s.lastApplyError}</pre>
            </div>
          )}
          <p className="text-xs text-text-muted">{t('platformSettings.firewall.hint') || 'Allow-lists and bans of the account ports are applied by hostd (nftables) before Docker. The gateway listens on the SFTP ports and starts the file servers on connection.'}</p>
        </div>
      )}
    </Card>
  );
}

// ── P2: DNS server (PowerDNS) ───────────────────────────────────────────────

function DnsServerCard() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<Loaded<DnsServerStatus> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus({ data: await dnsApi.serverStatus(), error: null });
    } catch (err) {
      setStatus({ data: null, error: hostingErrorMessage(t, err, t('platformSettings.dnsServer.loadFailed') || 'Failed to load the DNS server status') });
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.DNS_ZONE_UPDATED], () => { void load(); }, undefined, 3000);

  const sync = async () => {
    setBusy(true);
    try {
      setStatus({ data: await dnsApi.syncAll(), error: null });
      toast.success(t('platformSettings.dnsServer.synced') || 'Zones synchronised');
    } catch (err) {
      toastHostingError(t, err, t('platformSettings.dnsServer.syncFailed') || 'Failed to synchronise the zones');
    } finally {
      setBusy(false);
    }
  };

  const s = status?.data ?? null;
  return (
    <Card
      title={t('platformSettings.dnsServer.title') || 'DNS server'}
      icon={<Server size={14} className="text-accent" />}
      actions={s && s.enabled ? (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => { void sync(); }}>
          <RefreshCw size={13} className="mr-1.5" />{t('infra.edge.sync') || 'Synchronise'}
        </Button>
      ) : undefined}
    >
      {status === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : s === null ? (
        <p className="text-xs text-text-muted">{status.error}</p>
      ) : !s.enabled ? (
        <p className="text-xs text-text-muted">{t('platformSettings.dnsServer.disabled') || 'The DNS server is disabled in the settings: every zone is hosted elsewhere.'}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <InfoRow label={t('infra.edge.state') || 'State'}>
              {!s.deployed
                ? <Pill tone="red">{t('infra.notDeployed') || 'not deployed'}</Pill>
                : s.running
                  ? <Pill tone={s.apiReachable ? 'green' : 'amber'}>{s.apiReachable ? (t('infra.running') || 'running') : (t('platformSettings.dnsServer.apiDown') || 'API unreachable')}</Pill>
                  : <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>}
            </InfoRow>
            <InfoRow label={t('infra.version') || 'Version'} mono>{s.version ?? '—'}</InfoRow>
            <InfoRow label={t('infra.edge.lastSync') || 'Last sync'} mono>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : '—'}</InfoRow>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="muted">{t('platformSettings.dnsServer.zones', { count: s.zones.total, defaultValue: '{{count}} zones' })}</Pill>
            <Pill tone="green">{t('platformSettings.dnsServer.active', { count: s.zones.active, defaultValue: '{{count}} published' })}</Pill>
            <Pill tone={s.zones.pending > 0 ? 'blue' : 'muted'}>{t('platformSettings.dnsServer.pending', { count: s.zones.pending, defaultValue: '{{count}} pending' })}</Pill>
            <Pill tone={s.zones.error > 0 ? 'red' : 'muted'}>{t('platformSettings.dnsServer.error', { count: s.zones.error, defaultValue: '{{count}} in error' })}</Pill>
          </div>
          {s.lastSyncError && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{s.lastSyncError}</pre>
          )}
        </div>
      )}
    </Card>
  );
}

function ComponentRow({ c, busy, onDeploy }: { c: InfraComponentStatus; busy: string | null; onDeploy: () => void }) {
  const { t } = useTranslation();
  const name = ({
    edge: t('infra.component.edge') || "Edge (nginx + Let's Encrypt)",
    hostd: t('infra.component.hostd') || 'hostd (host daemon)',
    dns: t('platformSettings.infra.dns') || 'DNS server (PowerDNS)',
    dbadmin: t('platformSettings.infra.dbadmin') || 'Database admin (phpMyAdmin + Adminer)',
    scanner: t('scanner.infra.label') || 'Scanner (ClamAV + YARA)',
  } as Record<InfraComponentId, string>)[c.id] ?? c.id;
  const description = c.id === 'dns'
    ? (t('platformSettings.infra.dnsHint') || 'Authoritative DNS of the hosted zones, on port 53 (TCP + UDP) of the host. Its API stays on the internal network.')
    : c.id === 'dbadmin'
      ? (t('platformSettings.infra.dbadminHint') || 'Shared phpMyAdmin and Adminer, opened from the panel with single sign-on, on the host name of the settings.')
      : c.id === 'scanner'
        ? (t('scanner.infra.description') || 'Shared ClamAV + YARA scanner on the internal network: analyzes the releases before publication and the changes of the modification windows. It never mounts a tenant tree.')
        : null;
  return (
    <div className="rounded-lg bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">{name}</span>
        {!c.deployed
          ? <Pill tone="red">{t('infra.notDeployed') || 'not deployed'}</Pill>
          : c.running
            ? <Pill tone="green">{t('infra.running') || 'running'}</Pill>
            : <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>}
        <Button size="sm" variant={c.deployed ? 'secondary' : 'primary'} className="ml-auto" loading={busy === `deploy-${c.id}`} disabled={busy !== null} onClick={onDeploy}>
          <Rocket size={13} className="mr-1.5" />{c.deployed ? (t('infra.redeploy') || 'Redeploy') : (t('infra.deploy') || 'Deploy')}
        </Button>
      </div>
      {description && <p className="mt-1.5 text-xs text-text-muted">{description}</p>}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <InfoRow label={t('infra.image') || 'Image'} mono>{c.image ?? '—'}</InfoRow>
        <InfoRow label={t('infra.version') || 'Version'} mono>{c.version ?? '—'}</InfoRow>
      </div>
      {c.detail && <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{c.detail}</pre>}
    </div>
  );
}

function QuotaModeRow({ mode }: { mode: InfraStatus['quotaMode'] }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive size={14} className="text-text-muted" />
        <span className="text-sm font-medium text-text-primary">{t('infra.quota.title') || 'Disk quotas'}</span>
        {mode === 'xfs' && <Pill tone="green">{t('accounts.quota.xfs') || 'XFS'}</Pill>}
        {mode === 'measured' && <Pill tone="amber">{t('accounts.quota.measured') || 'measured'}</Pill>}
        {mode == null && <Pill tone="red">{t('infra.quota.unknown') || 'unknown'}</Pill>}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {mode === 'xfs'
          ? (t('infra.quota.xfsHint') || '/srv/oblimint is on XFS with project quotas: every account has a hard disk quota.')
          : mode === 'measured'
            ? (t('infra.quota.measuredHint') || 'No XFS project quota on /srv/oblimint: usage is only measured periodically and a full account is not stopped by the file system.')
            : (t('infra.quota.unknownHint') || 'hostd is unreachable: the quota mode cannot be read.')}
      </p>
      {mode === 'measured' && (
        <div className="mt-2 rounded-md bg-amber-400/5 p-2 text-xs text-amber-400">
          <div className="flex items-start gap-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t('infra.quota.remediation') || 'To get hard quotas, put /srv/oblimint on an XFS volume mounted with the prjquota option, then redeploy hostd and reconcile:'}</span>
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">/dev/sdX1  /srv/oblimint  xfs  defaults,prjquota  0 2</pre>
        </div>
      )}
    </div>
  );
}

function EdgeCard({ edge, onChanged, onReload }: { edge: Loaded<EdgeStatus>; onChanged: (s: EdgeStatus) => void; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'sync' | 'acme' | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const sync = async () => {
    setBusy('sync');
    setSyncError(null);
    try {
      const r = await infraApi.edgeSync();
      if (r.ok) toast.success(t('infra.edge.synced', { count: r.vhostCount, defaultValue: 'Edge synchronised ({{count}} vhosts)' }));
      else setSyncError(r.error ?? (t('infra.edge.syncFailed') || 'Synchronisation failed'));
      onReload();
    } catch (err) {
      toastHostingError(t, err, t('infra.edge.syncFailed') || 'Synchronisation failed');
    } finally {
      setBusy(null);
    }
  };

  const setDirectory = async (dir: 'production' | 'staging') => {
    if (!edge.data || dir === edge.data.acmeDirectory) return;
    if (dir === 'staging' && !(await confirm({
      title: t('infra.edge.stagingTitle') || "Let's Encrypt staging",
      message: t('infra.edge.stagingConfirm') || 'Certificates issued from now on come from the staging directory: browsers will NOT trust them. Use it only to test without hitting the production rate limits.',
      confirmLabel: t('infra.edge.useStaging') || 'Use staging',
      danger: true,
    }))) return;
    setBusy('acme');
    try {
      onChanged(await infraApi.setAcmeDirectory(dir));
      toast.success(t('infra.edge.directorySaved') || 'ACME directory saved');
    } catch (err) {
      toastHostingError(t, err, t('infra.edge.directoryFailed') || 'Failed to change the ACME directory');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={t('infra.edge.title') || 'Edge'}
      icon={<Globe size={14} className="text-accent" />}
      actions={edge.data ? (
        <Button size="sm" variant="secondary" loading={busy === 'sync'} disabled={busy !== null} onClick={() => { void sync(); }}>
          <RefreshCw size={13} className="mr-1.5" />{t('infra.edge.sync') || 'Synchronise'}
        </Button>
      ) : undefined}
    >
      {edge.data === null ? (
        <p className="text-xs text-text-muted">{edge.error}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <InfoRow label={t('infra.edge.state') || 'State'}>
              {edge.data.running ? <Pill tone="green">{t('infra.running') || 'running'}</Pill> : <Pill tone="red">{t('infra.stopped') || 'stopped'}</Pill>}
            </InfoRow>
            <InfoRow label={t('infra.edge.vhosts') || 'Virtual hosts'} mono>{edge.data.vhostCount}</InfoRow>
            <InfoRow label={t('infra.edge.lastSync') || 'Last sync'} mono>
              {edge.data.lastSyncAt ? new Date(edge.data.lastSyncAt).toLocaleString(i18n.language) : '—'}
            </InfoRow>
          </div>
          {(syncError || edge.data.lastSyncError) && (
            <div>
              <div className="mb-1 text-xs text-text-muted">{t('infra.edge.lastError') || 'Last error'}</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{syncError ?? edge.data.lastSyncError}</pre>
            </div>
          )}

          <div className="rounded-lg bg-bg-primary p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ShieldCheck size={14} className="text-text-muted" />
              <span className="text-sm font-medium text-text-primary">{t('infra.edge.acme') || "Let's Encrypt directory"}</span>
            </div>
            <SegmentedTabs
              size="sm"
              value={edge.data.acmeDirectory}
              onChange={(d) => { if (busy === null) void setDirectory(d); }}
              tabs={[
                { id: 'production', label: t('infra.edge.production') || 'Production' },
                { id: 'staging', label: t('infra.edge.staging') || 'Staging (tests)' },
              ]}
            />
            {edge.data.acmeDirectory === 'staging' && (
              <p className="mt-2 flex items-start gap-2 text-xs text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {t('infra.edge.stagingWarning') || 'Staging certificates are not trusted by browsers. Switch back to production, then renew the certificates.'}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Pill tone="green">{t('infra.edge.certValid', { count: edge.data.certificates.valid, defaultValue: '{{count}} valid' })}</Pill>
              <Pill tone="blue">{t('infra.edge.certPending', { count: edge.data.certificates.pending, defaultValue: '{{count}} pending' })}</Pill>
              <Pill tone={edge.data.certificates.expiringSoon > 0 ? 'amber' : 'muted'}>{t('infra.edge.certExpiring', { count: edge.data.certificates.expiringSoon, defaultValue: '{{count}} expiring' })}</Pill>
              <Pill tone={edge.data.certificates.failed > 0 ? 'red' : 'muted'}>{t('infra.edge.certFailed', { count: edge.data.certificates.failed, defaultValue: '{{count}} failed' })}</Pill>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
