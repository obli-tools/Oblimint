import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { ArrowRight, Boxes, Cable, Database, Globe, Pencil, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type HostingAccount, type NetworkLink, type NetworkLinkProtocol, type NetworkSegmentInfo, type SegmentKind, type SegmentRef,
} from '@oblimint/shared';
import { networkApi } from '@/api/network.api';
import { isStepUpHandled } from '@/api/client';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, inputCls, labelCls, payloadNumber, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';

export function SegmentIcon({ kind, size = 13 }: { kind: SegmentKind; size?: number }) {
  if (kind === 'db') return <Database size={size} />;
  if (kind === 'site') return <Globe size={size} />;
  return <Boxes size={size} />;
}

function segmentKindLabel(t: TFunction, k: SegmentKind): string {
  switch (k) {
    case 'site': return t('network.kind.site') || 'Site';
    case 'db': return t('network.kind.db') || 'Database';
    default: return t('network.kind.app') || 'Application';
  }
}

function linkStatusPill(t: TFunction, l: NetworkLink) {
  if (!l.enabled) return <Pill tone="muted">{t('network.status.disabled') || 'disabled'}</Pill>;
  const pill = l.status === 'active'
    ? <Pill tone="green">{t('network.status.active') || 'active'}</Pill>
    : l.status === 'pending'
      ? <Pill tone="amber">{t('network.status.pending') || 'pending'}</Pill>
      : <Pill tone="red">{t('network.status.error') || 'error'}</Pill>;
  return l.statusMessage ? <Tip content={l.statusMessage}><span className="cursor-help">{pill}</span></Tip> : pill;
}

function originPill(t: TFunction, l: NetworkLink) {
  if (l.origin === 'migration') {
    return (
      <Tip content={t('network.origin.migrationHint') || 'Created by the network migration: the sites of the account could reach every database instance before.'}>
        <span className="cursor-help"><Pill tone="blue">{t('network.origin.migration') || 'migration'}</Pill></span>
      </Tip>
    );
  }
  if (l.origin === 'catalog') return <Pill tone="accent">{t('network.origin.catalog') || 'catalog'}</Pill>;
  return null;
}

function Endpoint({ end }: { end: SegmentRef & { label: string } }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-text-muted"><SegmentIcon kind={end.kind} /></span>
      <span className="truncate text-text-primary">{end.label}</span>
      {end.service && <span className="shrink-0 font-mono text-[11px] text-text-muted">/{end.service}</span>}
    </span>
  );
}

/** Links table + create / edit modals (NETWORK_UPDATED refetch). */
export function NetworkLinksPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: {
  accountId: number | null;
  tenantId: number | undefined;
  accounts: HostingAccount[];
  showAccount: boolean;
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [links, setLinks] = useState<NetworkLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NetworkLink | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await networkApi.listLinks({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setLinks(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setLinks((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('network.loadFailed') || 'Failed to load the links', 'network'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.NETWORK_UPDATED], () => { void load(); }, (_e, p) => {
    const acc = payloadNumber(p, 'accountId');
    return accountId == null || acc == null || acc === accountId;
  }, 800);

  const toggle = async (l: NetworkLink, enabled: boolean) => {
    setBusy(l.id);
    try {
      const next = await networkApi.updateLink(l.id, { enabled });
      setLinks((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? null);
    } catch (err) {
      toastAppsError(t, err, t('network.saveFailed') || 'Failed to save the link', 'network');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (l: NetworkLink) => {
    // A default site → database link (origin migration) is only DISABLED by the server
    // (it would otherwise be re-created by the next pass): say so instead of "delete".
    const keepsDisabled = l.origin === 'migration' && l.source.kind === 'site' && l.target.kind === 'db';
    if (keepsDisabled && !l.enabled) {
      toast(t('network.defaultAlreadyDisabled') || 'This default link is already disabled: it stays listed so that it is not re-created.');
      return;
    }
    if (!(await confirm({
      title: keepsDisabled ? (t('network.disableDefaultTitle') || 'Disable the default link') : (t('network.deleteTitle') || 'Delete the link'),
      message: t('network.deleteConfirm', { source: l.source.label, target: l.target.label, port: l.port, defaultValue: '{{source}} will no longer reach {{target}} on port {{port}}.' })
        + (keepsDisabled
          ? `\n\n${t('network.disableDefaultConfirm') || 'This default link (site to database instance) is kept, disabled, so that it is not re-created: you can enable it again at any time. Check that the site does not use this database first.'}`
          : l.origin === 'migration' ? `\n\n${t('network.deleteMigrationWarn') || 'This link was created by the migration: check that the site does not use this database before deleting it.'}` : ''),
      danger: true,
    }))) return;
    try {
      await networkApi.deleteLink(l.id);
      if (keepsDisabled) toast.success(t('network.disabledDefault') || 'Default link disabled: enable it again at any time');
      else toast.success(t('network.deleted') || 'Link deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('network.deleteFailed') || 'Failed to delete the link', 'network');
    }
  };

  const manageable = accounts.filter((a) => can('apps.manage', a.id));

  return (
    <>
      {links === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : links.length === 0 ? <EmptyState icon={<Cable />} text={error ?? (t('network.empty') || 'No link: the containers of the account are isolated from each other.')} />
          : (
            <TableScroll className="bg-bg-secondary" stickyFirstCol>
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className={theadRowCls}>
                    <th className={thCls}>{t('network.source') || 'From'}</th>
                    <th className={thCls}><span className="sr-only">→</span></th>
                    <th className={thCls}>{t('network.target') || 'To'}</th>
                    <th className={thCls}>{t('network.port') || 'Port'}</th>
                    {showAccount && <th className={thCls}>{t('apps.list.account') || 'Account'}</th>}
                    <th className={thCls}>{t('apps.list.status') || 'Status'}</th>
                    <th className={thCls}>{t('network.enabled') || 'Enabled'}</th>
                    <th className={cn(thCls, 'w-12')}><span className="sr-only">{t('apps.list.actions') || 'Actions'}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => {
                    const manage = can('apps.manage', l.accountId);
                    return (
                      <tr key={l.id} className="border-t border-border/40 align-top">
                        <td className="max-w-[16rem] px-4 py-3"><Endpoint end={l.source} /></td>
                        <td className="px-1 py-3 text-text-muted"><ArrowRight size={14} /></td>
                        <td className="max-w-[16rem] px-4 py-3">
                          <Endpoint end={l.target} />
                          {l.description && <div className="mt-0.5 truncate text-[11px] text-text-muted">{l.description}</div>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-text-secondary">{l.port}/{l.protocol}</td>
                        {showAccount && (
                          <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                            {accounts.find((a) => a.id === l.accountId)?.username ?? `#${l.accountId}`}
                            {isStaff && <TenantBadge tenantId={l.tenantId} className="ml-1" />}
                          </td>
                        )}
                        <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{linkStatusPill(t, l)}{originPill(t, l)}</div></td>
                        <td className="px-4 py-3">
                          <ToggleSwitch size="sm" checked={l.enabled} disabled={!manage || busy === l.id} onChange={(c) => { void toggle(l, c); }} ariaLabel={t('network.enabled') || 'Enabled'} />
                        </td>
                        <td className="px-2 py-2">
                          {manage && (
                            <ActionMenu items={[
                              { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(l) },
                              { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(l); }, danger: true, separator: true },
                            ]} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
      {creating && (
        <LinkCreateModal
          accountId={accountId}
          accounts={manageable}
          onClose={() => onCreatingChange(false)}
          onSaved={() => { onCreatingChange(false); void load(); }}
        />
      )}
      {editing && <LinkEditModal link={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </>
  );
}

/** Option value of a segment ref: kind:id:service ('' = every service). */
function refKey(r: SegmentRef): string {
  return `${r.kind}:${r.id}:${r.service ?? ''}`;
}
function parseRef(key: string): SegmentRef | null {
  const [kind, id, service] = key.split(':');
  if (!kind || !id) return null;
  return { kind: kind as SegmentKind, id: Number(id), service: service || null };
}

function LinkCreateModal({ accountId, accounts, onClose, onSaved }: {
  accountId: number | null;
  accounts: HostingAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [account, setAccount] = useState<number | null>(accountId ?? (accounts.length === 1 ? accounts[0].id : null));
  const [segments, setSegments] = useState<NetworkSegmentInfo[] | null>(null);
  const [segError, setSegError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [protocol, setProtocol] = useState<NetworkLinkProtocol>('tcp');
  const [port, setPort] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (account == null) { setSegments(null); return; }
    let cancelled = false;
    setSegments(null);
    setSegError(null);
    networkApi.segments(account)
      .then((s) => { if (!cancelled) setSegments(s); })
      .catch((err) => { if (!cancelled) { setSegments([]); setSegError(appsErrorMessage(t, err, t('network.segmentsFailed') || 'Failed to load the segments', 'network')); } });
    return () => { cancelled = true; };
  }, [account, t]);

  // Sources: sites, stacks (every service) and app services. Targets: database instances and app services.
  const sourceOptions = useMemo(() => {
    const out: Array<{ key: string; label: string; kind: SegmentKind }> = [];
    const seenStacks = new Set<number>();
    for (const s of segments ?? []) {
      if (s.ref.kind === 'site') out.push({ key: refKey(s.ref), label: s.label, kind: 'site' });
      if (s.ref.kind === 'app') {
        if (!seenStacks.has(s.ref.id)) {
          seenStacks.add(s.ref.id);
          const stackLabel = s.ref.service ? s.label.replace(new RegExp(`\\s*/\\s*${s.ref.service}$`), '') : s.label;
          out.push({ key: refKey({ kind: 'app', id: s.ref.id, service: null }), label: t('network.allServices', { name: stackLabel, defaultValue: '{{name}} (every service)' }), kind: 'app' });
        }
        if (s.ref.service) out.push({ key: refKey(s.ref), label: s.label, kind: 'app' });
      }
    }
    return out;
  }, [segments, t]);
  const targetOptions = useMemo(() => (segments ?? [])
    .filter((s) => s.ref.kind === 'db' || (s.ref.kind === 'app' && s.ref.service))
    .map((s) => ({ key: refKey(s.ref), label: s.label, kind: s.ref.kind, ports: s.linkablePorts })), [segments]);
  const targetSeg = targetOptions.find((o) => o.key === target) ?? null;

  useEffect(() => {
    if (targetSeg && targetSeg.ports.length > 0 && !targetSeg.ports.includes(Number(port))) setPort(String(targetSeg.ports[0]));
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setError('');
    const src = parseRef(source);
    const dst = parseRef(target);
    if (account == null || !src || !dst) { setError(t('network.pickEnds') || 'Choose the source and the target.'); return; }
    if (src.kind === dst.kind && src.id === dst.id && (src.service ?? null) === (dst.service ?? null)) { setError(t('network.errors.linkInvalidEndpoint') || 'Invalid link.'); return; }
    const p = port.trim() ? Number(port) : undefined;
    if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) { setError(t('network.portInvalid') || 'Invalid port (1–65535).'); return; }
    setSaving(true);
    try {
      await networkApi.createLink({ accountId: account, source: src, target: dst, protocol, port: p, description: description.trim() || null });
      toast.success(t('network.created') || 'Link created');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('network.saveFailed') || 'Failed to save the link', 'network'));
    } finally {
      setSaving(false);
    }
  };

  const groupLabel = (k: SegmentKind) => segmentKindLabel(t, k);
  const groups = <T extends { kind: SegmentKind }>(opts: T[]) => (['site', 'app', 'db'] as SegmentKind[]).map((k) => ({ kind: k, items: opts.filter((o) => o.kind === k) })).filter((g) => g.items.length);

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Cable className="h-4 w-4 text-accent" />}
      title={t('network.createTitle') || 'New network link'}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!source || !target} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {accountId == null && (
          <div>
            <label className={labelCls} htmlFor="link-account">{t('apps.list.account') || 'Account'}</label>
            <select id="link-account" value={account ?? ''} onChange={(e) => { setAccount(e.target.value ? Number(e.target.value) : null); setSource(''); setTarget(''); }} className={selectCls}>
              <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
            </select>
          </div>
        )}
        {account != null && segments === null && <div className="flex justify-center py-4"><LoadingSpinner /></div>}
        {segError && <p className="text-xs text-status-down">{segError}</p>}
        {segments && (
          <>
            <div>
              <label className={labelCls} htmlFor="link-src">{t('network.source') || 'From'}</label>
              <select id="link-src" value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
                <option value="">{t('network.pickSource') || 'Choose a site or an application…'}</option>
                {groups(sourceOptions).map((g) => (
                  <optgroup key={g.kind} label={groupLabel(g.kind)}>
                    {g.items.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="link-dst">{t('network.target') || 'To'}</label>
              <select id="link-dst" value={target} onChange={(e) => setTarget(e.target.value)} className={selectCls}>
                <option value="">{t('network.pickTarget') || 'Choose a database or an application service…'}</option>
                {groups(targetOptions).map((g) => (
                  <optgroup key={g.kind} label={groupLabel(g.kind)}>
                    {g.items.map((o) => <option key={o.key} value={o.key} disabled={o.ports.length === 0}>{o.label}{o.ports.length === 0 ? ` (${t('network.noPort') || 'no exposed port'})` : ''}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="link-proto">{t('network.protocol') || 'Protocol'}</label>
                <select id="link-proto" value={protocol} onChange={(e) => setProtocol(e.target.value as NetworkLinkProtocol)} className={selectCls}>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="link-port">{t('network.port') || 'Port'}</label>
                {targetSeg && targetSeg.ports.length > 1 ? (
                  <select id="link-port" value={port} onChange={(e) => setPort(e.target.value)} className={cn(selectCls, 'font-mono')}>
                    {targetSeg.ports.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <input id="link-port" type="number" min="1" max="65535" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder={t('network.portAuto') || 'automatic'} className={cn(inputCls, 'font-mono')} />
                )}
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="link-desc">{t('network.descriptionField') || 'Description'}</label>
              <input id="link-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} maxLength={200} />
            </div>
            <p className="text-xs text-text-muted">{t('network.createHint') || 'Only this port of the target opens, from the containers of the source. The link is applied within a few seconds.'}</p>
          </>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

function LinkEditModal({ link, onClose, onSaved }: { link: NetworkLink; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [port, setPort] = useState(String(link.port));
  const [description, setDescription] = useState(link.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { setError(t('network.portInvalid') || 'Invalid port (1–65535).'); return; }
    setSaving(true);
    setError('');
    try {
      await networkApi.updateLink(link.id, { port: p, description: description.trim() || null });
      toast.success(t('network.saved') || 'Link saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('network.saveFailed') || 'Failed to save the link', 'network'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<Cable className="h-4 w-4 text-accent" />}
      title={t('network.editTitle') || 'Edit the link'}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><Endpoint end={link.source} /><ArrowRight size={14} className="text-text-muted" /><Endpoint end={link.target} /></div>
        <div>
          <label className={labelCls} htmlFor="edit-port">{t('network.port') || 'Port'}</label>
          <input id="edit-port" type="number" min="1" max="65535" value={port} onChange={(e) => setPort(e.target.value)} className={cn(inputCls, 'font-mono')} />
        </div>
        <div>
          <label className={labelCls} htmlFor="edit-desc">{t('network.descriptionField') || 'Description'}</label>
          <input id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} maxLength={200} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
