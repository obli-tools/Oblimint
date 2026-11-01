import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Globe, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { NetInterface, PortPoolStatus, PublicIp, PublicIpCreate, PublishStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { fmtPortRange, systemPublicPortsApi } from '@/api/publicPorts.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, inputCls, labelCls, selectCls, thCls, theadRowCls, toastHostingError, useHostingEvents } from '@/components/hosting/hostingUi';
import { UsageMeter } from '@/components/apps/charts';
import { formatDateTime } from '@/components/apps/appsFormat';
import { accountHref } from '@/utils/links';

/** Platform admin, System → Network (migration 032): public IPs of the node, publication by hostd, port pool usage. */
export function PublicIpsPanel() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [ips, setIps] = useState<PublicIp[] | null>(null);
  const [pool, setPool] = useState<PortPoolStatus | null>(null);
  const [pub, setPub] = useState<PublishStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, p, s] = await Promise.all([systemPublicPortsApi.list(), systemPublicPortsApi.pool(), systemPublicPortsApi.publish()]);
      setIps(l); setPool(p); setPub(s); setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.NETWORK_UPDATED], () => { void load(); }, undefined, 2000);

  const check = async (ip: PublicIp) => {
    setBusy(ip.id);
    try { await systemPublicPortsApi.check(ip.id); await load(); } catch (err) { toastHostingError(t, err, t('network.publicIps.checkFailed') || 'The check failed'); } finally { setBusy(null); }
  };
  const remove = async (ip: PublicIp) => {
    if (!(await confirm({
      title: t('network.publicIps.deleteTitle') || 'Delete this public IP',
      message: t('network.publicIps.deleteMessage', { address: ip.address, defaultValue: '{{address}} is no longer published; a managed address is removed from its interface.' }),
      confirmLabel: t('common.delete') || 'Delete', danger: true,
    }))) return;
    setBusy(ip.id);
    try { await systemPublicPortsApi.remove(ip.id); await load(); toast.success(t('network.publicIps.deleted') || 'Public IP deleted'); } catch (err) { toastHostingError(t, err, t('network.publicIps.deleteFailed') || 'The IP could not be deleted'); } finally { setBusy(null); }
  };

  const acceptTone = pub?.dockerAccept === 'ok' ? 'green' : pub?.dockerAccept === 'unknown' ? 'muted' : 'red';
  return (
    <Card
      icon={<Globe size={14} className="text-accent" />}
      title={t('network.publicIps.title') || 'Public IPs and published ports'}
      actions={(
        <>
          <Button size="sm" variant="ghost" onClick={() => { void load(); }}><RefreshCw size={13} /></Button>
          <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}><Plus size={13} className="mr-1" />{t('network.publicIps.declare') || 'Declare an IP'}</Button>
        </>
      )}
    >
      {!ips ? (error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>) : (
        <div className="space-y-4">
          <TableScroll className="bg-bg-primary">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('network.publicIps.address') || 'Address'}</th>
                  <th className={thCls}>{t('network.publicIps.interface') || 'Interface'}</th>
                  <th className={thCls}>{t('network.publicIps.mode') || 'Mode'}</th>
                  <th className={thCls}>{t('network.publicIps.status') || 'Status'}</th>
                  <th className={thCls}>{t('network.publicIps.account') || 'Account'}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {ips.map((ip) => (
                  <tr key={ip.id} className="border-t border-border/40">
                    <td className="px-4 py-2 font-mono text-text-primary">
                      {ip.address}{ip.localAddress && <span className="text-text-muted"> → {ip.localAddress}</span>}
                      {ip.kind === 'shared' && <Pill tone="accent" className="ml-1">{t('network.publicIps.shared') || 'shared'}</Pill>}
                    </td>
                    <td className="px-4 py-2 font-mono text-text-secondary">{ip.interface ?? '—'}{ip.kind === 'dedicated' ? `/${ip.prefixLen}` : ''}</td>
                    <td className="px-4 py-2">{ip.kind === 'shared' ? '—' : (ip.management === 'managed' ? (t('network.publicIps.managed') || 'managed') : (t('network.publicIps.external') || 'external'))}</td>
                    <td className="px-4 py-2">
                      <Pill tone={ip.status === 'active' ? 'green' : ip.status === 'pending' ? 'muted' : 'red'}>{t(`network.ipStatus.${ip.status}`) || ip.status}</Pill>
                      {ip.statusMessage && <div className="mt-0.5 text-text-muted">{t(`network.ipWarning.${ip.statusMessage}`) || ip.statusMessage}</div>}
                    </td>
                    <td className="px-4 py-2">
                      {ip.accountId ? <Link className="text-accent hover:underline" to={accountHref(ip.accountId, 'network')}>{ip.accountUsername ?? `#${ip.accountId}`}</Link> : <span className="text-text-muted">—</span>}
                      {ip.takeoverWeb && <Pill tone="amber" className="ml-1">80/443</Pill>}
                      {ip.snatOutbound && <Pill tone="muted" className="ml-1">SNAT</Pill>}
                      {ip.bindings > 0 && <span className="ml-1 text-text-muted">· {t('network.publicIps.bindings', { count: ip.bindings, defaultValue: '{{count}} binding(s)' })}</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {ip.kind === 'dedicated' && (
                        <span className="inline-flex gap-1">
                          <IconButton icon={<RefreshCw size={13} />} label={t('network.publicIps.check') || 'Check'} onClick={() => { void check(ip); }} disabled={busy === ip.id} />
                          <IconButton icon={<Trash2 size={13} />} label={t('common.delete') || 'Delete'} onClick={() => { void remove(ip); }} disabled={busy === ip.id || ip.accountId !== null} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {ips.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-text-muted">{t('network.publicIps.none') || 'No public IP: set the public IPv4 of the node (Settings → Platform).'}</td></tr>}
              </tbody>
            </table>
          </TableScroll>

          {pub && (
            <div className="space-y-2 rounded-lg border border-border/60 bg-bg-primary px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text-primary">{t('network.publish.title') || 'Publication (hostd)'}</span>
                <Pill tone="muted">{pub.backend}</Pill>
                <Pill tone={acceptTone}>{t(`network.publish.accept.${pub.dockerAccept}`) || pub.dockerAccept}</Pill>
                <span className="text-text-muted">
                  {t('network.publish.rules', { count: pub.rules, defaultValue: '{{count}} rule(s)' })}
                  {pub.published !== null && ` · ${t('network.publish.counter', { count: pub.published, defaultValue: '{{count}} connection(s) published' })}`}
                  {' · '}{t('network.publish.lastPush', { date: formatDateTime(pub.lastPushAt, i18n.language), defaultValue: 'last push: {{date}}' })}
                </span>
              </div>
              {!pub.available && <p className="text-text-muted">{t('network.publish.unavailable') || 'hostd does not report the publication (older hostd or unreachable).'}</p>}
              {pub.remediation && <p className="flex items-start gap-2 text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{pub.remediation}</p>}
              {(pub.lastApplyError || pub.lastPushError) && <p className="text-status-down">{pub.lastApplyError || pub.lastPushError}</p>}
            </div>
          )}

          {pool && (
            <div className="space-y-2">
              <UsageMeter
                label={t('network.pool.usage', { from: pool.pool.from, to: pool.pool.to, defaultValue: 'Port pool {{from}}–{{to}}' })}
                used={pool.allocated} limit={pool.capacity} format={(v) => String(v)}
              />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <InfoRow label={t('network.pool.capacity') || 'Usable ports'} mono>{pool.capacity}</InfoRow>
                <InfoRow label={t('network.pool.free') || 'Free'} mono>{pool.free}</InfoRow>
                <InfoRow label={t('network.pool.largest') || 'Largest free block'} mono>{pool.largestFreeBlock}</InfoRow>
                <InfoRow label={t('network.pool.accounts') || 'Accounts'} mono>{pool.accounts.length}</InfoRow>
              </div>
              {pool.accounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {pool.accounts.map((a) => (
                    <Link key={a.accountId} to={accountHref(a.accountId, 'network')}>
                      <Pill tone={a.total < a.target ? 'amber' : 'muted'}><span className="font-mono">{a.username} · {a.blocks.map(fmtPortRange).join(', ')}</span></Pill>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <CreateIpModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />
    </Card>
  );
}

function CreateIpModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [ifaces, setIfaces] = useState<NetInterface[] | null>(null);
  const [form, setForm] = useState<PublicIpCreate>({ address: '', localAddress: null, prefixLen: 32, interface: null, management: 'managed', description: null });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({ address: '', localAddress: null, prefixLen: 32, interface: null, management: 'managed', description: null });
    systemPublicPortsApi.interfaces().then((l) => {
      setIfaces(l);
      const def = l.find((i) => i.defaultRoute);
      if (def) setForm((f) => ({ ...f, interface: f.interface ?? def.name }));
    }).catch(() => setIfaces([]));
  }, [open]);
  const set = (patch: Partial<PublicIpCreate>) => setForm((f) => ({ ...f, ...patch }));
  const save = async () => {
    setSaving(true);
    try {
      await systemPublicPortsApi.create({ ...form, address: form.address.trim(), localAddress: form.localAddress?.trim() || null, description: form.description?.trim() || null });
      toast.success(t('network.publicIps.created') || 'Public IP declared');
      onCreated();
    } catch (err) {
      toastHostingError(t, err, t('network.publicIps.createFailed') || 'The IP could not be declared');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open} onClose={onClose} size="md" title={t('network.publicIps.declareTitle') || 'Declare a dedicated IP'} icon={<Globe className="h-4 w-4 text-accent" />}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button onClick={() => { void save(); }} loading={saving} disabled={!form.address.trim()}>{t('network.publicIps.declare') || 'Declare an IP'}</Button>
        </>
      )}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className={labelCls} htmlFor="ip-address">{t('network.publicIps.publicAddress') || 'Public IPv4 address'}</label>
          <input id="ip-address" className={inputCls} value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder="203.0.113.20" />
        </div>
        <div>
          <label className={labelCls} htmlFor="ip-iface">{t('network.publicIps.interface') || 'Interface'}</label>
          <select id="ip-iface" className={selectCls} value={form.interface ?? ''} onChange={(e) => set({ interface: e.target.value || null })}>
            <option value="">—</option>
            {(ifaces ?? []).map((i) => <option key={i.name} value={i.name}>{i.name}{i.defaultRoute ? ` (${t('network.publicIps.defaultRoute') || 'default route'})` : ''}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ip-prefix">{t('network.publicIps.prefix') || 'Prefix'}</label>
          <input id="ip-prefix" type="number" min={8} max={32} className={inputCls} value={form.prefixLen ?? 32} onChange={(e) => set({ prefixLen: Number(e.target.value) || 32 })} />
        </div>
        <div className="col-span-2">
          <label className={labelCls} htmlFor="ip-mode">{t('network.publicIps.mode') || 'Mode'}</label>
          <select id="ip-mode" className={selectCls} value={form.management} onChange={(e) => set({ management: e.target.value as 'managed' | 'external' })}>
            <option value="managed">{t('network.publicIps.managedHint') || 'Managed: hostd adds the address to the interface (at every boot too)'}</option>
            <option value="external">{t('network.publicIps.externalHint') || 'External: configured in the OS, hostd only checks it'}</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className={labelCls} htmlFor="ip-local">{t('network.publicIps.localAddress') || 'Local address (1:1 NAT, optional)'}</label>
          <input id="ip-local" className={inputCls} value={form.localAddress ?? ''} onChange={(e) => set({ localAddress: e.target.value || null })} placeholder="172.31.0.20" />
        </div>
        <div className="col-span-2">
          <label className={labelCls} htmlFor="ip-desc">{t('network.publicIps.description') || 'Description'}</label>
          <input id="ip-desc" className={inputCls} value={form.description ?? ''} onChange={(e) => set({ description: e.target.value || null })} />
        </div>
      </div>
    </Modal>
  );
}
