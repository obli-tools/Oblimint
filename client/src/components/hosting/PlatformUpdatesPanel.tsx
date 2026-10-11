import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { CalendarClock, Download, PackageCheck, RefreshCw, Search, Zap } from 'lucide-react';
import type {
  AppMaintenanceSchedule, PlatformComponentKind, PlatformImageGroup, PlatformImageStatus, PlatformUpdatePolicy, PlatformUpdateStatus,
  PlatformUpdatesEvent, PlatformUpdatesState,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { platformUpdatesApi } from '@/api/platformUpdates.api';
import { getSocket } from '@/socket/socketClient';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, hostingErrorMessage, theadRowCls, thCls, toastHostingError, useHostingEvents } from './hostingUi';

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const INTERVALS = [60, 180, 360, 720, 1440];

export function kindLabel(t: TFunction, k: PlatformComponentKind): string {
  const fallback: Record<PlatformComponentKind, string> = {
    panel: 'Panel', hostd: 'hostd', edge: 'Edge (nginx)', filesrv: 'File servers', dns: 'PowerDNS', scanner: 'Scanner',
    mail: 'Mail engine', 'mail-relay': 'Mail relay', webmail: 'Webmail', dbadmin: 'Database admin', 'site-base': 'Site base', tools: 'Tools',
  };
  return t(`platformUpdates.kind.${k}`) || fallback[k];
}

export function updateStatusPill(t: TFunction, s: PlatformUpdateStatus) {
  const map: Record<PlatformUpdateStatus, { tone: 'muted' | 'green' | 'amber' | 'red' | 'accent' | 'blue'; label: string }> = {
    upToDate: { tone: 'green', label: t('platformUpdates.status.upToDate') || 'Up to date' },
    updateAvailable: { tone: 'amber', label: t('platformUpdates.status.updateAvailable') || 'Update available' },
    pendingRecreate: { tone: 'amber', label: t('platformUpdates.status.pendingRecreate') || 'Pulled, to recreate' },
    updating: { tone: 'blue', label: t('platformUpdates.status.updating') || 'Updating' },
    failed: { tone: 'red', label: t('platformUpdates.status.failed') || 'Failed' },
    unknown: { tone: 'muted', label: t('platformUpdates.status.unknown') || 'Cannot check' },
    unchecked: { tone: 'muted', label: t('platformUpdates.status.unchecked') || 'Not checked' },
  };
  const m = map[s];
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

const shortDigest = (d: string | null) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : '—');
const endOf = (w: AppMaintenanceSchedule) => {
  const [h, m] = w.start.split(':').map(Number);
  const end = (h * 60 + m + w.durationMinutes) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
};
const durationBetween = (start: string, end: string) => {
  const [h1, m1] = start.split(':').map(Number);
  const [h2, m2] = end.split(':').map(Number);
  const d = (h2 * 60 + m2) - (h1 * 60 + m1);
  return d > 0 ? d : d + 1440;
};

/** Nodes > Updates: platform images of a node, checks, update runs (live), maintenance policy. */
export function PlatformUpdatesPanel({ nodeId }: { nodeId?: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [state, setState] = useState<PlatformUpdatesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [redeploySites, setRedeploySites] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [policy, setPolicy] = useState<PlatformUpdatePolicy | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await platformUpdatesApi.state(nodeId);
      setState(s);
      setError(null);
      setPolicy((p) => p ?? s.policy);
      const run = s.run ?? null;
      if (run) setLines(run.log);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('platformUpdates.loadFailed') || 'Failed to load the platform updates'));
    }
  }, [nodeId, t]);

  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PLATFORM_UPDATES], () => { void load(); },
    (_e, p) => (p as PlatformUpdatesEvent | undefined)?.kind === 'state', 500);

  // Live log lines of the current run.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onEvent = (p: PlatformUpdatesEvent) => {
      if (p?.kind === 'log' && p.line) setLines((l) => [...l.slice(-299), `${new Date().toISOString().slice(11, 19)} ${p.line}`]);
    };
    socket.on(HostingSocketEvents.PLATFORM_UPDATES, onEvent);
    return () => { socket.off(HostingSocketEvents.PLATFORM_UPDATES, onEvent); };
  }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [lines]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };

  const check = (images?: string[]) => run(images ? `check:${images[0]}` : 'check', async () => {
    try {
      setState(await platformUpdatesApi.check(nodeId, images));
      toast.success(t('platformUpdates.checked') || 'Check complete');
    } catch (err) {
      toastHostingError(t, err, t('platformUpdates.checkFailed') || 'Check failed');
    }
  });

  const apply = async (images: string[] | undefined, force = false) => {
    const panelIncluded = (images ?? state?.images.filter((i) => ['updateAvailable', 'pendingRecreate', 'failed'].includes(i.status)).map((i) => i.image) ?? [])
      .some((ref) => state?.images.find((i) => i.image === ref)?.kind === 'panel');
    const ok = await confirm({
      title: images?.length === 1 ? (t('platformUpdates.confirmOneTitle') || 'Update this component') : (t('platformUpdates.confirmAllTitle') || 'Update the platform'),
      message: (
        <div className="space-y-2">
          <p>{t('platformUpdates.confirmMessage') || 'The new images are pulled first, then the containers are recreated one component at a time (each one briefly unavailable). A container that does not come back is restored.'}</p>
          {panelIncluded && <p className="text-amber-400">{t('platformUpdates.confirmPanel') || 'The panel itself restarts at the end: the page reconnects by itself. If the new panel is not healthy in time, the previous one is restored.'}</p>}
          {redeploySites && <p className="text-amber-400">{t('platformUpdates.confirmSites') || 'Every site container running an older base image is recreated (a few seconds of downtime per site).'}</p>}
          {force && <p>{t('platformUpdates.confirmForce') || 'The maintenance window is ignored.'}</p>}
        </div>
      ),
      confirmLabel: t('platformUpdates.update') || 'Update',
    });
    if (!ok) return;
    await run(images?.length === 1 ? `apply:${images[0]}` : 'apply', async () => {
      try {
        setLines([]);
        await platformUpdatesApi.apply({ nodeId, images, redeploySites, force });
        toast.success(t('platformUpdates.started') || 'Update started');
        await load();
      } catch (err) {
        toastHostingError(t, err, t('platformUpdates.applyFailed') || 'The update could not start');
      }
    });
  };

  const savePolicy = () => run('policy', async () => {
    if (!policy) return;
    try {
      const saved = await platformUpdatesApi.setPolicy(policy);
      setPolicy(saved);
      toast.success(t('platformUpdates.policy.saved') || 'Maintenance policy saved');
      await load();
    } catch (err) {
      toastHostingError(t, err, t('platformUpdates.policy.saveFailed') || 'Failed to save the policy');
    }
  });

  const groups = useMemo(() => {
    const out: Array<[PlatformImageGroup, PlatformImageStatus[]]> = [];
    for (const g of ['platform', 'sites', 'tools'] as PlatformImageGroup[]) {
      const items = (state?.images ?? []).filter((i) => i.group === g);
      if (items.length) out.push([g, items]);
    }
    return out;
  }, [state]);

  if (!state) {
    return error
      ? <div className="rounded-xl bg-bg-secondary p-4 text-sm text-status-down">{error}</div>
      : <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  }

  const running = state.run?.status === 'running';
  const pending = state.summary.available + state.summary.failed;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : (t('platformUpdates.never') || 'Never'));
  const groupLabel = (g: PlatformImageGroup) => g === 'platform' ? (t('platformUpdates.group.platform') || 'Platform components')
    : g === 'sites' ? (t('platformUpdates.group.sites') || 'Site base images (in use)') : (t('platformUpdates.group.tools') || 'Tools images');
  const lastRun = state.run ?? state.lastRun;

  return (
    <div className="flex flex-col gap-4">
      <Card
        icon={<PackageCheck size={15} className="text-text-muted" />}
        title={t('platformUpdates.title') || 'Platform updates'}
        actions={(
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ToggleSwitch size="sm" checked={redeploySites} onChange={setRedeploySites} label={t('platformUpdates.redeploySites') || 'Redeploy the sites'} title={t('platformUpdates.redeploySitesHint') || 'Also recreate the site containers running an older base image (otherwise they move at their next recreation).'} />
            <Button size="sm" variant="secondary" loading={busy === 'check' || state.checking} disabled={!!busy || running} onClick={() => { void check(); }}>
              <span className="inline-flex items-center gap-1.5"><Search size={14} />{t('platformUpdates.checkAll') || 'Check for updates'}</span>
            </Button>
            <Button size="sm" loading={busy === 'apply'} disabled={!!busy || running || pending === 0} onClick={() => { void apply(undefined); }}>
              <span className="inline-flex items-center gap-1.5"><Download size={14} />{t('platformUpdates.updateAll') || 'Update all'}</span>
            </Button>
          </div>
        )}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoRow label={t('platformUpdates.tag') || 'Tag'} mono>{state.tag}</InfoRow>
          <InfoRow label={t('platformUpdates.lastCheck') || 'Last check'}>{fmt(state.checkedAt)}</InfoRow>
          <InfoRow label={t('platformUpdates.available') || 'Updates'}>
            {pending > 0
              ? <Pill tone="amber">{t('platformUpdates.availableCount', { count: pending, defaultValue: '{{count}} to apply' })}</Pill>
              : <Pill tone="green">{t('platformUpdates.status.upToDate') || 'Up to date'}</Pill>}
          </InfoRow>
          <InfoRow label={t('platformUpdates.autoUpdate') || 'Automatic updates'}>
            {state.policy.autoUpdate
              ? (state.windowOpen ? (t('platformUpdates.windowOpen') || 'Window open') : t('platformUpdates.nextWindow', { date: fmt(state.nextWindowAt), defaultValue: 'Next window: {{date}}' }))
              : (t('platformUpdates.off') || 'Off')}
          </InfoRow>
        </div>
      </Card>

      {lastRun && (
        <Card
          icon={<RefreshCw size={15} className={running ? 'animate-spin text-accent' : 'text-text-muted'} />}
          title={running ? (t('platformUpdates.run.running') || 'Update in progress') : (t('platformUpdates.run.last') || 'Last update')}
          actions={(
            <div className="ml-auto flex items-center gap-2">
              {lastRun.status === 'running' && <Pill tone="blue">{lastRun.step ?? (t('platformUpdates.status.updating') || 'Updating')}</Pill>}
              {lastRun.status === 'succeeded' && <Pill tone="green">{t('platformUpdates.run.succeeded') || 'Succeeded'}</Pill>}
              {lastRun.status === 'failed' && <Pill tone="red">{t('platformUpdates.run.failed') || 'Failed'}</Pill>}
              {lastRun.status === 'rolledBack' && <Pill tone="red">{t('platformUpdates.run.rolledBack') || 'Rolled back'}</Pill>}
              <span className="text-xs font-mono text-text-muted">{fmt(lastRun.finishedAt ?? lastRun.startedAt)}</span>
            </div>
          )}
        >
          {lastRun.error && <p className="mb-2 text-sm text-status-down break-words">{lastRun.error}</p>}
          <pre ref={logRef} className="max-h-64 overflow-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
            {(running ? lines : lastRun.log).join('\n') || (t('platformUpdates.run.noLog') || 'No output yet.')}
          </pre>
        </Card>
      )}

      {groups.map(([g, items]) => (
        <Card key={g} title={groupLabel(g)}>
          <TableScroll className="-mx-4 -mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('platformUpdates.col.component') || 'Component'}</th>
                  <th className={thCls}>{t('platformUpdates.col.image') || 'Image'}</th>
                  <th className={thCls}>{t('platformUpdates.col.version') || 'Version'}</th>
                  <th className={thCls}>{t('platformUpdates.col.local') || 'Local digest'}</th>
                  <th className={thCls}>{t('platformUpdates.col.remote') || 'Registry digest'}</th>
                  <th className={thCls}>{t('platformUpdates.col.status') || 'Status'}</th>
                  <th className={thCls}>{t('platformUpdates.col.checked') || 'Checked'}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.image} className="hover:bg-bg-hover transition-colors align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">{kindLabel(t, i.kind)}</div>
                      <div className="text-xs text-text-muted" title={i.containers.join(', ')}>
                        {i.containers.length
                          ? t('platformUpdates.containers', { count: i.containers.length, defaultValue: '{{count}} container(s)' })
                          : (t('platformUpdates.noContainer') || 'image only')}
                        {i.outdatedContainers.length > 0 && <span className="text-amber-400"> · {t('platformUpdates.outdated', { count: i.outdatedContainers.length, defaultValue: '{{count}} on an older image' })}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary break-all">{i.image}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{i.version ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted" title={i.localDigest ?? undefined}>{shortDigest(i.localDigest)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted" title={i.remoteDigest ?? undefined}>{shortDigest(i.remoteDigest)}</td>
                    <td className="px-4 py-3">
                      <span title={i.error ?? undefined}>{updateStatusPill(t, i.status)}</span>
                      {i.error && <div className="mt-1 max-w-[16rem] text-xs text-text-muted break-words">{i.error}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted whitespace-nowrap">{i.checkedAt ? new Date(i.checkedAt).toLocaleString(i18n.language) : '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <IconButton label={t('platformUpdates.checkOne') || 'Check'} disabled={!!busy || running} onClick={() => { void check([i.image]); }}>
                          <Search size={14} />
                        </IconButton>
                        <IconButton label={t('platformUpdates.update') || 'Update'} disabled={!!busy || running || !['updateAvailable', 'pendingRecreate', 'failed'].includes(i.status)} onClick={() => { void apply([i.image]); }}>
                          <Download size={14} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ))}

      {policy && (
        <Card
          icon={<CalendarClock size={15} className="text-text-muted" />}
          title={t('platformUpdates.policy.title') || 'Maintenance policy'}
          actions={(
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={!!busy || running || pending === 0} onClick={() => { void apply(undefined, true); }}>
                <span className="inline-flex items-center gap-1.5"><Zap size={14} />{t('platformUpdates.policy.forceNow') || 'Force now'}</span>
              </Button>
              <Button size="sm" loading={busy === 'policy'} disabled={!!busy} onClick={() => { void savePolicy(); }}>{t('common.save') || 'Save'}</Button>
            </div>
          )}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <ToggleSwitch checked={policy.autoCheck} onChange={(v) => setPolicy({ ...policy, autoCheck: v })} label={t('platformUpdates.policy.autoCheck') || 'Check automatically'} />
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-text-muted">{t('platformUpdates.policy.interval') || 'Check interval'}</span>
                <select className="h-9 rounded-md bg-bg-tertiary px-2 text-text-primary" value={policy.checkIntervalMin} disabled={!policy.autoCheck}
                  onChange={(e) => setPolicy({ ...policy, checkIntervalMin: Number(e.target.value) })}>
                  {[...new Set([...INTERVALS, policy.checkIntervalMin])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>{m >= 60 ? t('platformUpdates.policy.everyHours', { count: m / 60, defaultValue: 'Every {{count}} h' }) : t('platformUpdates.policy.everyMinutes', { count: m, defaultValue: 'Every {{count}} min' })}</option>
                  ))}
                </select>
              </label>
              <ToggleSwitch checked={policy.notify} onChange={(v) => setPolicy({ ...policy, notify: v })} label={t('platformUpdates.policy.notify') || 'Notify (available / applied / failed)'} />
            </div>
            <div className="flex flex-col gap-3">
              <ToggleSwitch checked={policy.autoUpdate} onChange={(v) => setPolicy({ ...policy, autoUpdate: v, window: policy.window ?? { days: [0], start: '03:00', durationMinutes: 120, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } })}
                label={t('platformUpdates.policy.autoUpdate') || 'Update automatically'}
                description={t('platformUpdates.policy.autoUpdateHint') || 'Only inside the maintenance window, never the site containers.'} />
              {policy.window && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((d) => {
                      const on = policy.window!.days.includes(d);
                      return (
                        <button key={d} type="button" disabled={!policy.autoUpdate}
                          onClick={() => setPolicy({ ...policy, window: { ...policy.window!, days: on ? policy.window!.days.filter((x) => x !== d) : [...policy.window!.days, d] } })}
                          className={`h-8 min-w-10 rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-50 ${on ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover'}`}>
                          {t(`platformUpdates.day.${d}`) || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <label className="flex flex-col gap-1">
                      <span className="text-text-muted">{t('platformUpdates.policy.from') || 'From'}</span>
                      <input type="time" className="h-9 rounded-md bg-bg-tertiary px-2 text-text-primary" disabled={!policy.autoUpdate} value={policy.window.start}
                        onChange={(e) => setPolicy({ ...policy, window: { ...policy.window!, start: e.target.value, durationMinutes: durationBetween(e.target.value, endOf(policy.window!)) } })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-text-muted">{t('platformUpdates.policy.to') || 'To'}</span>
                      <input type="time" className="h-9 rounded-md bg-bg-tertiary px-2 text-text-primary" disabled={!policy.autoUpdate} value={endOf(policy.window)}
                        onChange={(e) => setPolicy({ ...policy, window: { ...policy.window!, durationMinutes: durationBetween(policy.window!.start, e.target.value) } })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-text-muted">{t('platformUpdates.policy.timezone') || 'Time zone'}</span>
                      <input className="h-9 rounded-md bg-bg-tertiary px-2 font-mono text-xs text-text-primary" disabled={!policy.autoUpdate} value={policy.window.timezone}
                        onChange={(e) => setPolicy({ ...policy, window: { ...policy.window!, timezone: e.target.value } })} />
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
