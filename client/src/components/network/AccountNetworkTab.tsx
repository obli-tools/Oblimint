import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Globe, Network, Plug, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { AccountPortsInfo, PortAllocationPreview, PortBinding, PublicIp } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { fmtPortRange, publicPortsApi, systemPublicPortsApi } from '@/api/publicPorts.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import {
  Card, CopyButton, EmptyState, InfoRow, Pill, hostingErrorMessage, inputCls, labelCls, selectCls, thCls, theadRowCls, toastHostingError, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';

/**
 * Account page, « Network » tab (migration 032): the public ports of the shared IP (blocks, target, use), the
 * dedicated IP and the bindings of the account's apps. Everyone who reads the account sees it; the platform
 * administrator allocates the ports and assigns the IP (canManage).
 */
export function AccountNetworkTab({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AccountPortsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allocOpen, setAllocOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await publicPortsApi.account(accountId));
      setError(null);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('network.ports.loadFailed') || 'Failed to load the public ports'));
    }
  }, [accountId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.NETWORK_UPDATED], () => { void load(); }, undefined, 1500);

  if (!info) {
    return error
      ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      : <div className="flex justify-center py-8"><LoadingSpinner /></div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PortsCard info={info} onAllocate={() => setAllocOpen(true)} onRefresh={() => { void load(); }} />
        <DedicatedIpCard info={info} onChanged={setInfo} reload={load} />
      </div>
      <BindingsCard bindings={info.bindings} />
      {info.canManage && (
        <AllocateModal open={allocOpen} info={info} onClose={() => setAllocOpen(false)} onSaved={(i) => { setInfo(i); setAllocOpen(false); }} />
      )}
    </div>
  );
}

function stateTone(s: AccountPortsInfo['state']): 'green' | 'amber' | 'red' | 'muted' {
  return s === 'ok' ? 'green' : s === 'shortfall' ? 'amber' : s === 'excess' ? 'amber' : 'muted';
}

function PortsCard({ info, onAllocate, onRefresh }: { info: AccountPortsInfo; onAllocate: () => void; onRefresh: () => void }) {
  const { t } = useTranslation();
  const stateLabel: Record<AccountPortsInfo['state'], string> = {
    ok: t('network.ports.state.ok') || 'allocated',
    shortfall: t('network.ports.state.shortfall') || 'short of ports',
    excess: t('network.ports.state.excess') || 'above the target',
    none: t('network.ports.state.none') || 'none',
  };
  return (
    <Card
      icon={<Plug size={14} className="text-accent" />}
      title={t('network.ports.title') || 'Public ports'}
      actions={(
        <>
          <Button size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={13} /></Button>
          {info.canManage && <Button size="sm" variant="secondary" onClick={onAllocate}><SlidersHorizontal size={13} className="mr-1" />{t('network.ports.allocate') || 'Allocate'}</Button>}
        </>
      )}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <InfoRow label={t('network.ports.target') || 'Target'} mono>
            {info.target}{' '}
            <span className="text-text-muted">({info.source === 'override' ? (t('network.ports.sourceOverride') || 'account') : (t('network.ports.sourcePlan') || 'plan')})</span>
          </InfoRow>
          <InfoRow label={t('network.ports.allocated') || 'Allocated'} mono>{info.allocated}</InfoRow>
          <InfoRow label={t('network.ports.used') || 'Used'} mono>{info.used} / {info.allocated}</InfoRow>
          <InfoRow label={t('network.ports.stateLabel') || 'State'}><Pill tone={stateTone(info.state)}>{stateLabel[info.state]}</Pill></InfoRow>
        </div>
        <InfoRow label={t('network.ports.sharedIp') || 'Shared IP'} mono>{info.sharedIp?.address ?? '—'}</InfoRow>
        {info.blocks.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {info.blocks.map((b) => (
              <Pill key={b.id} tone={b.origin === 'manual' ? 'accent' : 'muted'} title={b.origin === 'manual' ? (t('network.ports.manualBlock') || 'Explicit range') : undefined}>
                <span className="font-mono">{fmtPortRange(b)}</span>
              </Pill>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('network.ports.noBlock') || 'No public port: the applications of this account are reached through proxy hosts only.'}</p>
        )}
        {info.state === 'shortfall' && (
          <p className="flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('network.ports.shortfallHint') || 'The pool has not enough free ports for the target: widen the pool (Settings → Network) or lower the target.'}</p>
        )}
        {info.state === 'excess' && (
          <p className="flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('network.ports.excessHint') || 'More ports than the target: the ports in use are kept until the applications drop them.'}</p>
        )}
        <p className="text-xs text-text-muted">{t('network.ports.howTo') || 'An application publishes one of these ports with ports: ["<public port>:<container port>/udp"] in its compose (TCP and UDP each).'}</p>
      </div>
    </Card>
  );
}

function DedicatedIpCard({ info, onChanged, reload }: { info: AccountPortsInfo; onChanged: (i: AccountPortsInfo) => void; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [ips, setIps] = useState<PublicIp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ded = info.dedicatedIp;
  useEffect(() => {
    if (!info.canManage) return;
    let cancelled = false;
    systemPublicPortsApi.list().then((l) => { if (!cancelled) setIps(l); }).catch(() => { if (!cancelled) setIps([]); });
    return () => { cancelled = true; };
  }, [info.canManage, ded?.id]);
  const choices = (ips ?? []).filter((i) => i.kind === 'dedicated' && (i.accountId === null || i.accountId === info.accountId));

  const save = async (body: { publicIpId: number | null; takeoverWeb?: boolean; snatOutbound?: boolean }) => {
    setBusy(true);
    try {
      await publicPortsApi.setDedicatedIp(info.accountId, body);
      onChanged(await publicPortsApi.account(info.accountId));
      toast.success(t('network.dedicated.saved') || 'Dedicated IP updated');
    } catch (err) {
      toastHostingError(t, err, t('network.dedicated.saveFailed') || 'The dedicated IP could not be changed');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card icon={<Globe size={14} className="text-accent" />} title={t('network.dedicated.title') || 'Dedicated IP'}>
      <div className="space-y-3">
        {info.canManage ? (
          <div>
            <label className={labelCls} htmlFor="ded-ip">{t('network.dedicated.address') || 'Address'}</label>
            <select
              id="ded-ip" className={selectCls} disabled={busy || ips === null}
              value={ded?.id ?? ''}
              onChange={(e) => { void save({ publicIpId: e.target.value ? Number(e.target.value) : null }); }}
            >
              <option value="">{t('network.dedicated.none') || 'None (shared IP)'}</option>
              {choices.map((i) => <option key={i.id} value={i.id}>{i.address}{i.description ? ` — ${i.description}` : ''}</option>)}
            </select>
            {ips !== null && choices.length === 0 && !ded && (
              <p className="mt-1 text-xs text-text-muted">
                {t('network.dedicated.noneFree') || 'No free dedicated IP: declare one in System → Network.'}{' '}
                <Link to="/network" className="text-accent hover:underline">{t('network.dedicated.declare') || 'Public IPs'}</Link>
              </p>
            )}
          </div>
        ) : (
          <InfoRow label={t('network.dedicated.address') || 'Address'} mono>{ded?.address ?? (t('network.dedicated.none') || 'None (shared IP)')}</InfoRow>
        )}
        {ded && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={ded.status === 'active' ? 'green' : ded.status === 'pending' ? 'muted' : 'red'}>{t(`network.ipStatus.${ded.status}`) || ded.status}</Pill>
              {ded.statusMessage && <span className="text-text-muted">{t(`network.ipWarning.${ded.statusMessage}`) || ded.statusMessage}</span>}
              <CopyButton text={ded.address} />
            </div>
            <ToggleSwitch
              checked={ded.takeoverWeb} disabled={!info.canManage || busy}
              onChange={(v) => { void save({ publicIpId: ded.id, takeoverWeb: v }); }}
              label={t('network.dedicated.takeover') || 'The account takes over 80 / 443'}
              description={t('network.dedicated.takeoverHint') || 'Its applications may publish 80 and 443 of this IP; its sites then stay on the shared IP (edge, certificates): their DNS records point there.'}
            />
            <ToggleSwitch
              checked={ded.snatOutbound} disabled={!info.canManage || busy}
              onChange={(v) => { void save({ publicIpId: ded.id, snatOutbound: v }); }}
              label={t('network.dedicated.snat') || 'Outbound traffic through this IP'}
              description={t('network.dedicated.snatHint') || 'The containers of the account leave the node with this address (only when it sits on the interface of the default route). Mail still leaves through the relay of the platform.'}
            />
            <p className="text-xs text-text-muted">
              {ded.takeoverWeb
                ? (t('network.dedicated.dnsShared') || 'DNS: the A records of the domains of the account point to the shared IP.')
                : (t('network.dedicated.dnsDedicated', { address: ded.address, defaultValue: 'DNS: the A records of the domains of the account point to {{address}} (external DNS: point them there).' }))}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

const STATUS_TONE: Record<PortBinding['status'], 'green' | 'amber' | 'red' | 'muted'> = { active: 'green', pending: 'muted', inactive: 'amber', error: 'red' };

export function BindingsCard({ bindings, title }: { bindings: PortBinding[]; title?: string }) {
  const { t } = useTranslation();
  return (
    <Card icon={<Network size={14} className="text-accent" />} title={title ?? (t('network.bindings.title') || 'Published ports')}>
      {bindings.length === 0 ? (
        <EmptyState icon={<Plug size={18} />} text={<><div>{t('network.bindings.empty') || 'No published port'}</div><div className="mt-1 text-xs">{t('network.bindings.emptyHint') || 'An application publishes a port of the account by deploying its compose with ports: ["<public>:<container>"].'}</div></>} />
      ) : (
        <TableScroll className="bg-bg-primary">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('network.bindings.public') || 'Public'}</th>
                <th className={thCls}>{t('network.bindings.target') || 'Application'}</th>
                <th className={thCls}>{t('network.bindings.containerPort') || 'Container port'}</th>
                <th className={thCls}>{t('network.bindings.status') || 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((b) => {
                const pub = `${b.address}:${b.publicPort}/${b.protocol}`;
                return (
                  <tr key={b.id} className="border-t border-border/40">
                    <td className="px-4 py-2 font-mono text-text-primary"><span className="inline-flex items-center gap-1">{pub}<CopyButton text={`${b.address}:${b.publicPort}`} /></span>{b.dedicated && <Pill tone="accent" className="ml-1">{t('network.bindings.dedicated') || 'dedicated'}</Pill>}</td>
                    <td className="px-4 py-2">{b.stackId ? <Link to={`/apps/${b.stackId}`} className="text-accent hover:underline">{b.stackName ?? `#${b.stackId}`}</Link> : '—'}<span className="text-text-muted"> / {b.service}</span></td>
                    <td className="px-4 py-2 font-mono text-text-secondary">{b.containerPort}</td>
                    <td className="px-4 py-2">
                      <Pill tone={STATUS_TONE[b.status]}>{t(`network.bindings.statuses.${b.status}`) || b.status}</Pill>
                      {b.statusMessage && <div className="mt-0.5 text-text-muted">{t(`network.binding.${b.statusMessage}`) || b.statusMessage}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
  );
}

type AllocMode = 'count' | 'range';

function AllocateModal({ open, info, onClose, onSaved }: { open: boolean; info: AccountPortsInfo; onClose: () => void; onSaved: (i: AccountPortsInfo) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AllocMode>('count');
  const [usePlan, setUsePlan] = useState(info.override === null);
  const [count, setCount] = useState(String(info.target));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [require, setRequire] = useState(false);
  const [preview, setPreview] = useState<PortAllocationPreview | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('count'); setUsePlan(info.override === null); setCount(String(info.target)); setFrom(''); setTo(''); setRequire(false); setPreview(null);
  }, [open, info.override, info.target]);

  const body = useMemo(() => {
    if (mode === 'range') {
      const f = Number(from); const l = Number(to || from);
      return Number.isInteger(f) && Number.isInteger(l) && f > 0 && l >= f ? { range: { from: f, to: l } } : null;
    }
    if (usePlan) return { count: null, contiguous: require ? 'require' as const : 'prefer' as const };
    const n = Number(count);
    return Number.isInteger(n) && n >= 0 ? { count: n, contiguous: require ? 'require' as const : 'prefer' as const } : null;
  }, [mode, from, to, usePlan, count, require]);

  useEffect(() => {
    if (!open || !body) { setPreview(null); return; }
    let cancelled = false;
    const h = setTimeout(() => {
      publicPortsApi.preview(info.accountId, body).then((p) => { if (!cancelled) setPreview(p); }).catch(() => { if (!cancelled) setPreview(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(h); };
  }, [open, body, info.accountId]);

  const save = async () => {
    if (!body) return;
    setSaving(true);
    try {
      onSaved(await publicPortsApi.setAllocation(info.accountId, body));
      toast.success(t('network.ports.saved') || 'Allocation saved');
    } catch (err) {
      toastHostingError(t, err, t('network.ports.saveFailed') || 'The allocation could not be changed');
    } finally {
      setSaving(false);
    }
  };

  const errMsg = preview?.error ? (t(`network.ports.errors.${preview.error.code}`, { defaultValue: preview.error.message }) || preview.error.message) : null;
  return (
    <Modal
      open={open} onClose={onClose} size="md" title={t('network.ports.allocateTitle') || 'Public ports of the account'} icon={<Plug className="h-4 w-4 text-accent" />}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button onClick={() => { void save(); }} loading={saving} disabled={!body || !!preview?.error}>{t('common.save') || 'Save'}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <SegmentedTabs<AllocMode>
          tabs={[{ id: 'count', label: t('network.ports.byCount') || 'Number of ports' }, { id: 'range', label: t('network.ports.byRange') || 'Explicit range' }]}
          value={mode} onChange={setMode}
        />
        {mode === 'count' ? (
          <>
            <ToggleSwitch checked={usePlan} onChange={setUsePlan} label={t('network.ports.followPlan', { count: info.planValue, defaultValue: 'Follow the plan ({{count}} ports)' })} />
            {!usePlan && (
              <div>
                <label className={labelCls} htmlFor="ports-count">{t('network.ports.count') || 'Ports (TCP and UDP each)'}</label>
                <input id="ports-count" type="number" min={0} max={65535} className={inputCls} value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
            )}
            <ToggleSwitch checked={require} onChange={setRequire} label={t('network.ports.requireContiguous') || 'Require one contiguous block'}
              description={t('network.ports.requireContiguousHint') || 'Otherwise, without a block long enough, the first free ports are taken in several blocks.'} />
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="ports-from">{t('network.ports.from') || 'From'}</label>
              <input id="ports-from" type="number" min={1024} max={65535} className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} htmlFor="ports-to">{t('network.ports.to') || 'To'}</label>
              <input id="ports-to" type="number" min={1024} max={65535} className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <p className="col-span-2 text-xs text-text-muted">{t('network.ports.rangeHint') || 'Added to the blocks of the account (inside the pool, free, not reserved); the target becomes the new total.'}</p>
          </div>
        )}
        <div className={cn('rounded-lg border px-3 py-2 text-xs', errMsg ? 'border-red-400/30 bg-red-500/10 text-red-400' : 'border-border/60 bg-bg-primary text-text-secondary')}>
          {!preview ? (t('network.ports.previewPending') || 'Preview…') : errMsg ? errMsg : (
            <div className="space-y-1">
              <div>{t('network.ports.previewTotal', { count: preview.total, defaultValue: '{{count}} port(s) after the change' })}</div>
              {preview.added.length > 0 && <div className="text-green-400">+ {preview.added.map(fmtPortRange).join(', ')}</div>}
              {preview.removed.length > 0 && <div className="text-amber-400">− {preview.removed.map(fmtPortRange).join(', ')}</div>}
              {preview.blocks.length > 0 && <div className="font-mono text-text-muted">{preview.blocks.map(fmtPortRange).join(', ')}</div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
