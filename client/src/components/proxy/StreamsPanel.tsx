import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Cable, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type ProxyStream, type ProxyTarget, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi, type StreamPortInfo } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { EMPTY_TARGET, TargetEditor, targetComplete } from './TargetEditor';
import { EdgeUnitBanner, EdgeUnitPill, ListState, useProxyAccess } from './proxyUi';
import { proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';
import { targetShort } from './proxyFormat';

/**
 * TCP / UDP streams on the platform-approved ports (settings edge.streamPorts,
 * published by the edge) — staff only; platform streams (no account) for the
 * platform admin. docs/P4b-PLAN.md §8.8, ED5.
 */
export function StreamsPanel({ accountId, tenantId, accounts, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage, platformAdmin } = useProxyAccess();
  const [items, setItems] = useState<ProxyStream[]>([]);
  const [ports, setPorts] = useState<StreamPortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountDir = useAccountDirectory();
  const [editing, setEditing] = useState<ProxyStream | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [list, p] = await Promise.all([
        proxyApi.listStreams({ accountId: accountId ?? undefined, tenantId }),
        proxyApi.streamPorts().catch(() => [] as StreamPortInfo[]),
      ]);
      if (n !== seq.current) return;
      setItems(list);
      setPorts(p);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.streams.loadFailed') || 'Failed to load the streams'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    return !!payload && ['stream', 'edgeUnit'].includes(payload.entity);
  }, 800);

  const toggle = async (s: ProxyStream, enabled: boolean) => {
    try {
      const saved = await proxyApi.updateStream(s.id, { enabled });
      setItems((cur) => cur.map((x) => (x.id === s.id ? saved : x)));
    } catch (err) {
      toastProxyError(t, err, t('proxy.streams.saveFailed') || 'Failed to save the stream');
    }
  };

  const remove = async (s: ProxyStream) => {
    if (!(await confirm({
      title: t('proxy.streams.deleteTitle') || 'Delete the stream',
      message: t('proxy.streams.deleteConfirm', { name: s.name, port: s.incomingPort, defaultValue: 'Delete the stream {{name}}? Port {{port}} stops forwarding immediately.' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteStream(s.id);
      toast.success(t('proxy.streams.deleted') || 'Stream deleted');
      setItems((cur) => cur.filter((x) => x.id !== s.id));
    } catch (err) {
      toastProxyError(t, err, t('proxy.streams.deleteFailed') || 'Failed to delete the stream');
    }
  };

  const mayEdit = (s: ProxyStream) => (s.accountId == null ? platformAdmin : canManage(s.accountId));
  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = (manageable.length > 0 || platformAdmin) && ports.length > 0
    ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.streams.add') || 'New stream'}</button>
    : null;
  const protos = (s: ProxyStream) => [s.tcp && 'tcp', s.udp && 'udp'].filter(Boolean).join(' + ');
  const menu = (s: ProxyStream) => (mayEdit(s) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(s) },
        { key: 'toggle', icon: <Power className="h-4 w-4" />, label: s.enabled ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable'), onClick: () => { void toggle(s, !s.enabled); } },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(s); }, danger: true, separator: true },
      ]}
    />
  ) : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">
          {t('proxy.streams.description') || 'Raw TCP / UDP forwarding on the ports approved by the platform (staff only).'}{' '}
          {ports.length === 0 && !loading && (
            platformAdmin
              ? <Link to="/settings#settings-edge" className="text-accent hover:underline">{t('proxy.streams.noPortsAdmin') || 'No port is approved yet: Settings → Edge.'}</Link>
              : <span className="text-amber-400">{t('proxy.streams.noPorts') || 'No port is approved by the platform yet.'}</span>
          )}
        </p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      {ports.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ports.map((p) => (
            <Pill key={`${p.port}/${p.protocol}`} tone={p.usedBy == null ? 'green' : 'muted'} title={p.usedBy == null ? undefined : `#${p.usedBy}`}>
              {p.port}/{p.protocol} {p.usedBy == null ? (t('proxy.streams.free') || 'free') : (t('proxy.streams.used') || 'used')}
            </Pill>
          ))}
        </div>
      )}
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<Cable />} emptyText={t('proxy.streams.empty') || 'No stream yet.'} emptyAction={createBtn ?? undefined}>
        <GroupedTable<ProxyStream>
          storageKey="proxy-streams"
          singleGroupFlat
          minWidth={760}
          defaultSort={{ column: 'name' }}
          rowClassName={(x) => !x.enabled && 'opacity-60'}
          groups={groupRowsByAccount(items, accountDir, (x) => ({ id: x.accountId, username: x.accountUsername }), (rows) => flatNodes(rows, (x) => x.id), t('proxy.platformGroup') || 'Platform')}
          columns={[
            { id: 'name', header: t('proxy.streams.name') || 'Stream', tdClassName: 'font-medium text-text-primary', sort: (x) => x.name, cell: (x) => x.name },
            { id: 'port', header: t('proxy.streams.port') || 'Incoming port', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.incomingPort, cell: (x) => <>{x.incomingPort} <span className="text-text-muted">{protos(x)}</span></> },
            { id: 'target', header: t('proxy.hosts.target') || 'Target', tdClassName: 'break-all font-mono text-xs text-text-secondary', sort: (x) => targetShort(x.target), cell: (x) => <>→ {targetShort(x.target)}</> },
            { id: 'edge', header: t('proxy.unit.title') || 'Edge', cell: (x) => <EdgeUnitPill unit={x.edge} /> },
            ...(showTenant ? [{ id: 'tenant', header: t('proxy.tenant') || 'Workspace', cell: (x: ProxyStream) => <TenantBadge tenantId={x.tenantId} /> }] : []),
            {
              id: 'enabled', header: t('proxy.enabled') || 'Enabled', thClassName: 'w-20', sort: (x) => x.enabled,
              cell: (x) => <ToggleSwitch size="sm" checked={x.enabled} disabled={!mayEdit(x)} onChange={(v) => { void toggle(x, v); }} ariaLabel={t('proxy.enabled') || 'Enabled'} />,
            },
            { id: 'actions', header: <span className="sr-only">{t('proxy.actions') || 'Actions'}</span>, thClassName: 'w-14', tdClassName: 'text-right', cell: (x) => menu(x) },
          ]}
        />
      </ListState>

      <StreamModal
        open={editing !== null}
        stream={editing === 'new' ? null : editing}
        accounts={manageable}
        ports={ports}
        allowPlatform={platformAdmin}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.streams.saved') || 'Stream saved'); void load(); }}
      />
    </div>
  );
}

function StreamModal({ open, stream, accounts, ports, allowPlatform, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  stream: ProxyStream | null;
  accounts: HostingAccount[];
  ports: StreamPortInfo[];
  allowPlatform: boolean;
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { platformStaff } = useProxyAccess();
  // '' = platform stream (no account).
  const [owner, setOwner] = useState<string>('');
  const [name, setName] = useState('');
  const [port, setPort] = useState<number | null>(null);
  const [tcp, setTcp] = useState(true);
  const [udp, setUdp] = useState(false);
  const [target, setTarget] = useState<ProxyTarget>(EMPTY_TARGET);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const fallbackOwner = defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null);
    setOwner(stream ? (stream.accountId == null ? '' : String(stream.accountId)) : fallbackOwner != null ? String(fallbackOwner) : '');
    setName(stream?.name ?? '');
    setPort(stream?.incomingPort ?? null);
    setTcp(stream?.tcp ?? true);
    setUdp(stream?.udp ?? false);
    setTarget(stream?.target ?? { ...EMPTY_TARGET, kind: 'external', host: '', port: 0 });
    setEnabled(stream?.enabled ?? true);
    setError('');
  }, [open, stream]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountId = owner ? Number(owner) : null;
  const ownerOk = accountId != null || allowPlatform;
  // Free (port, protocol) entries: unused, or used by this stream itself. A protocol taken by another stream stays off.
  const freePorts = ports.filter((p) => p.usedBy == null || (stream != null && p.usedBy === stream.id));
  const portChoices = [...new Set(freePorts.map((p) => p.port))].sort((a, b) => a - b);
  const protosOf = (p: number) => freePorts.filter((x) => x.port === p).map((x) => x.protocol);
  const canSubmit = ownerOk && name.trim().length > 0 && port != null && (tcp || udp) && targetComplete(target) && (accountId != null || target.kind === 'external');

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const body = { name: name.trim(), enabled, incomingPort: port!, tcp, udp, target };
    try {
      if (stream) await proxyApi.updateStream(stream.id, body);
      else await proxyApi.createStream({ accountId, ...body });
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.streams.saveFailed') || 'Failed to save the stream'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={stream ? t('proxy.streams.editTitle', { name: stream.name, defaultValue: 'Stream {{name}}' }) : (t('proxy.streams.createTitle') || 'New stream')}
      icon={<Cable className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{stream ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {stream && <EdgeUnitBanner unit={stream.edge} />}
        {!stream && (
          <div>
            <label className={labelCls} htmlFor="st-owner">{t('proxy.streams.owner') || 'Owner'}</label>
            <select id="st-owner" value={owner} onChange={(e) => { setOwner(e.target.value); setTarget({ ...EMPTY_TARGET, kind: e.target.value ? 'app' : 'external', host: '', port: 0 }); }} className={selectCls}>
              {allowPlatform ? <option value="">{t('proxy.streams.platformOwner') || 'Platform (no account)'}</option> : <option value="">{t('proxy.chooseAccount') || 'Choose an account…'}</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="st-name">{t('proxy.streams.name') || 'Stream'}</label>
            <input id="st-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="postgres" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="st-port">{t('proxy.streams.port') || 'Incoming port'}</label>
            <select id="st-port" value={port ?? ''} onChange={(e) => {
              const p = e.target.value ? Number(e.target.value) : null;
              setPort(p);
              if (p != null) { const pr = protosOf(p); setTcp(pr.includes('tcp')); setUdp(!pr.includes('tcp') && pr.includes('udp')); }
            }} className={cn(selectCls, 'font-mono')}>
              <option value="">{t('proxy.streams.choosePort') || 'Choose an approved port…'}</option>
              {portChoices.map((p) => <option key={p} value={p}>{p} ({protosOf(p).join('/')})</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
          <ToggleSwitch checked={tcp} disabled={port != null && !protosOf(port).includes('tcp')} onChange={setTcp} label="TCP" />
          <ToggleSwitch checked={udp} disabled={port != null && !protosOf(port).includes('udp')} onChange={setUdp} label="UDP" />
        </div>
        <div>
          <span className={labelCls}>{t('proxy.hosts.target') || 'Target'}</span>
          <TargetEditor
            idPrefix="st-target"
            accountId={accountId}
            value={target}
            onChange={setTarget}
            kinds={accountId != null ? ['app', 'external'] : ['external']}
            protocol={udp && !tcp ? 'udp' : 'tcp'}
            platformStaff={platformStaff}
          />
        </div>
        <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('proxy.enabled') || 'Enabled'} />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
