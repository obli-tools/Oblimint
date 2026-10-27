import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Container, FileSearch, Play, RotateCw, Square } from 'lucide-react';
import type { AppContainerAction, AppContainerInspect, AppStackDetail } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Drawer } from '@/components/common/Drawer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, InfoRow, Pill, sectionTitleCls } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { appsErrorMessage, toastAppsError } from '../appsErrors';
import { formatDateTime, shortDigest, trimNum } from '../appsFormat';
import { ContainerStateBadge, containerStateLabel } from '../AppBadges';

type Service = AppStackDetail['services'][number];

/** Containers (one per service): state, health, ports, restarts, start / stop / restart, inspect drawer. */
export function AppContainersTab({ stack, canManage, onChanged }: { stack: AppStackDetail; canManage: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };

  const act = async (service: string, action: AppContainerAction) => {
    if (action === 'stop' && !(await confirm({
      title: t('apps.actions.stop') || 'Stop',
      message: t('apps.containers.stopConfirm', { service, defaultValue: 'Stop the service {{service}}? Services depending on it may fail.' }),
      confirmLabel: t('apps.actions.stop') || 'Stop',
    }))) return;
    setBusy(service);
    try {
      await appsApi.containerAction(stack.id, service, action);
      toast.success(t('apps.containers.done') || 'Done');
      onChanged();
    } catch (err) {
      toastAppsError(t, err, t('apps.actions.failed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  if (stack.services.length === 0) return <EmptyState icon={<Container />} text={t('apps.overview.noServices') || 'No service deployed yet.'} />;

  return (
    <>
      <GroupedTable<Service>
        storageKey="app-containers"
        singleGroupFlat
        minWidth={820}
        defaultSort={{ column: 'service' }}
        groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(stack.services, (x) => x.name) }]}
        columns={[
          {
            id: 'service', header: t('apps.effective.service') || 'Service', sort: (x) => x.name,
            cell: (x) => (
              <>
                <button type="button" onClick={() => setInspecting(x.name)} className="font-mono text-[13px] text-text-primary hover:text-accent">{x.name}</button>
                <div className="font-mono text-[10.5px] text-text-muted">{x.containerName}</div>
              </>
            ),
          },
          {
            id: 'status', header: t('apps.list.status') || 'Status', sort: (x) => x.state,
            cell: (x) => (
              <>
                <ContainerStateBadge state={x.state} health={x.health} />
                {x.restartCount > 0 && <div className="mt-1 text-[11px] text-amber-400">{t('apps.containers.restarts', { count: x.restartCount, defaultValue: '{{count}} restart(s)' })}</div>}
              </>
            ),
          },
          {
            id: 'image', header: t('apps.effective.image') || 'Image', sort: (x) => x.image ?? '',
            cell: (x) => (
              <>
                <div className="break-all font-mono text-xs text-text-secondary">{x.image ?? '—'}</div>
                <div className="font-mono text-[10.5px] text-text-muted">{shortDigest(x.currentDigest)}</div>
              </>
            ),
          },
          {
            id: 'ports', header: t('apps.effective.ports') || 'Exposed ports', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.exposedPorts[0]?.port ?? null,
            cell: (x) => (x.exposedPorts.length ? x.exposedPorts.map((p) => `${p.port}/${p.protocol}`).join(', ') : '—'),
          },
          {
            id: 'limits', header: t('apps.effective.limits') || 'Limits', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-secondary', sort: (x) => x.limits?.memoryMb ?? null,
            cell: (x) => (x.limits ? `${trimNum(x.limits.cpus)} CPU · ${formatMb(x.limits.memoryMb, units)} · ${x.limits.pids} PID` : '—'),
          },
          { id: 'started', header: t('apps.containers.started') || 'Started', tdClassName: 'text-xs text-text-muted', sort: (x) => x.startedAt ?? '', cell: (x) => formatDateTime(x.startedAt, i18n.language) },
          {
            id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2 py-2',
            cell: (x) => (busy === x.name ? <div className="p-2"><LoadingSpinner size="sm" /></div> : (
              <ActionMenu items={[
                { key: 'inspect', icon: <FileSearch size={14} />, label: t('apps.containers.inspect') || 'Inspect', onClick: () => setInspecting(x.name) },
                { key: 'start', icon: <Play size={14} />, label: t('apps.actions.start') || 'Start', onClick: () => { void act(x.name, 'start'); }, hidden: !canManage, disabled: x.state === 'running', separator: true },
                { key: 'restart', icon: <RotateCw size={14} />, label: t('apps.actions.restart') || 'Restart', onClick: () => { void act(x.name, 'restart'); }, hidden: !canManage, disabled: x.state === 'missing' },
                { key: 'stop', icon: <Square size={14} />, label: t('apps.actions.stop') || 'Stop', onClick: () => { void act(x.name, 'stop'); }, hidden: !canManage, disabled: x.state !== 'running' && x.state !== 'restarting', danger: true },
              ]} />
            )),
          },
        ]}
      />
      <InspectDrawer stackId={stack.id} service={inspecting} onClose={() => setInspecting(null)} />
    </>
  );
}

function InspectDrawer({ stackId, service, onClose }: { stackId: number; service: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<AppContainerInspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    setData(null);
    setError(null);
    appsApi.inspectContainer(stackId, service)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(appsErrorMessage(t, err, t('apps.containers.inspectFailed') || 'Failed to inspect the container')); });
    return () => { cancelled = true; };
  }, [stackId, service, t]);

  return (
    <Drawer open={service != null} onClose={onClose} size="lg" title={service ?? ''} icon={<FileSearch className="h-4 w-4 text-accent" />}>
      {error ? <p className="text-sm text-status-down">{error}</p> : !data ? <div className="flex justify-center py-10"><LoadingSpinner /></div> : (
        <div className="space-y-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('apps.list.status') || 'Status'}>{containerStateLabel(t, data.state)}</InfoRow>
            <InfoRow label={t('apps.containers.restartsLabel') || 'Restarts'} mono>{data.restartCount}</InfoRow>
            <div className="col-span-2"><InfoRow label={t('apps.effective.image') || 'Image'} mono>{data.image ?? '—'}</InfoRow></div>
            <div className="col-span-2"><InfoRow label={t('apps.containers.digest') || 'Digest'} mono>{data.imageDigest ?? '—'}</InfoRow></div>
            <InfoRow label={t('apps.containers.created') || 'Created'}>{formatDateTime(data.createdAt, i18n.language)}</InfoRow>
            <InfoRow label={t('apps.containers.started') || 'Started'}>{formatDateTime(data.startedAt, i18n.language)}</InfoRow>
            <InfoRow label={t('apps.effective.limits') || 'Limits'} mono>
              {[data.limits.cpus != null ? `${trimNum(data.limits.cpus)} CPU` : null, data.limits.memoryMb != null ? formatMb(data.limits.memoryMb, units) : null, data.limits.pids != null ? `${data.limits.pids} PID` : null].filter(Boolean).join(' · ') || '—'}
            </InfoRow>
            <InfoRow label={t('apps.effective.caps') || 'Capabilities'} mono>{data.capAdd.length ? data.capAdd.join(', ') : '—'}</InfoRow>
          </div>

          <section>
            <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.containers.networks') || 'Networks'}</h3>
            <ul className="space-y-1">
              {data.networks.map((n) => (
                <li key={n.name} className="rounded-lg bg-bg-primary px-3 py-2 font-mono text-xs">
                  <span className="text-text-primary">{n.name}</span> <span className="text-text-muted">{n.ip ?? ''}</span>
                  {n.aliases.length > 0 && <div className="text-[11px] text-text-muted">{n.aliases.join(', ')}</div>}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.containers.mounts') || 'Mounts'}</h3>
            {data.mounts.length === 0 ? <p className="text-xs text-text-muted">—</p> : (
              <ul className="space-y-1">
                {data.mounts.map((m, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg-primary px-3 py-2 font-mono text-xs">
                    <Pill tone="muted">{m.kind}</Pill>
                    <span className="break-all text-text-secondary">{m.source || '—'}</span>
                    <span className="text-text-muted">→</span>
                    <span className="break-all text-text-primary">{m.target}</span>
                    {m.readOnly && <Pill tone="amber">ro</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.containers.env') || 'Environment'}</h3>
            {data.envValuesHidden && data.env.length > 0 && (
              <p className="mb-2 text-xs text-text-muted">{t('apps.containers.envValuesHidden') || 'Only the names are shown: the values are visible to the users who manage the applications.'}</p>
            )}
            {data.env.length === 0 ? <p className="text-xs text-text-muted">—</p> : (
              <div className="overflow-x-auto rounded-lg bg-bg-primary p-3 font-mono text-[11.5px]">
                {data.env.map((e) => (
                  <div key={e.key} className="whitespace-pre break-all">
                    <span className="text-accent">{e.key}</span>=<span className={e.value == null ? 'italic text-text-muted' : 'text-text-secondary'}>{e.value ?? (data.envValuesHidden ? (t('apps.containers.hiddenValue') || '••••') : (t('apps.containers.masked') || '•••• (secret)'))}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {data.healthLog.length > 0 && (
            <section>
              <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.containers.healthLog') || 'Health checks'}</h3>
              <ul className="space-y-1">
                {data.healthLog.map((h, i) => (
                  <li key={i} className="rounded-lg bg-bg-primary px-3 py-2 font-mono text-[11px]">
                    <span className={h.exitCode === 0 ? 'text-green-400' : 'text-status-down'}>exit {h.exitCode}</span>
                    <span className="ml-2 text-text-muted">{formatDateTime(h.at, i18n.language)}</span>
                    {h.output && <div className="mt-1 whitespace-pre-wrap break-all text-text-secondary">{h.output}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {Object.keys(data.labels).length > 0 && (
            <section>
              <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.containers.labels') || 'Labels'}</h3>
              <div className="overflow-x-auto rounded-lg bg-bg-primary p-3 font-mono text-[11px] text-text-secondary">
                {Object.entries(data.labels).map(([k, v]) => (
                  <div key={k} className="whitespace-pre break-all">
                    <span className="text-text-muted">{k}</span>=<span className={v == null ? 'italic text-text-muted' : undefined}>{v ?? (data.labelValuesHidden ? (t('apps.containers.hiddenValue') || '••••') : (t('apps.containers.masked') || '•••• (secret)'))}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
