import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Ban, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type CustomPage, type HostingAccount, type ProxyDeadHost, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { headerAccentBtnCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DomainPicker } from './DomainPicker';
import { AccountField, DomainNames, EdgeUnitBanner, EdgeUnitPill, ListState, SslState, useProxyAccess } from './proxyUi';
import { proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';

/** Dead hosts (404 everywhere, ACME still served) of an account / every visible account. */
export function DeadHostsPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const [items, setItems] = useState<ProxyDeadHost[]>([]);
  const [pages, setPages] = useState<CustomPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProxyDeadHost | 'new' | null>(null);
  const accountDir = useAccountDirectory();
  const domainKey = (d: ProxyDeadHost) => d.domains[0]?.name ?? `~${d.id}`;

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [list, cp] = await Promise.all([
        proxyApi.listDeadHosts({ accountId: accountId ?? undefined, tenantId }),
        proxyApi.listCustomPages({ accountId: accountId ?? undefined, tenantId }).catch(() => [] as CustomPage[]),
      ]);
      if (n !== seq.current) return;
      setItems(list);
      setPages(cp);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.deadHosts.loadFailed') || 'Failed to load the dead hosts'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    if (!payload || !['deadHost', 'edgeUnit', 'customPage', 'certificate'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const toggle = async (d: ProxyDeadHost, enabled: boolean) => {
    try {
      const saved = await proxyApi.updateDeadHost(d.id, { enabled });
      setItems((cur) => cur.map((x) => (x.id === d.id ? saved : x)));
    } catch (err) {
      toastProxyError(t, err, t('proxy.deadHosts.saveFailed') || 'Failed to save the dead host');
    }
  };

  const remove = async (d: ProxyDeadHost) => {
    if (!(await confirm({
      title: t('proxy.deadHosts.deleteTitle') || 'Delete the dead host',
      message: t('proxy.deadHosts.deleteConfirm') || 'Delete this dead host? Its domains are released.',
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteDeadHost(d.id);
      toast.success(t('proxy.deadHosts.deleted') || 'Dead host deleted');
      setItems((cur) => cur.filter((x) => x.id !== d.id));
    } catch (err) {
      toastProxyError(t, err, t('proxy.deadHosts.deleteFailed') || 'Failed to delete the dead host');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = canManage(accountId) && manageable.length > 0
    ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.deadHosts.add') || 'New dead host'}</button>
    : null;
  const pageName = (id: number | null) => (id == null ? (t('proxy.pages.platformDefault') || 'Default page') : pages.find((p) => p.id === id)?.name ?? `#${id}`);
  const menu = (d: ProxyDeadHost) => (canManage(d.accountId) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(d) },
        { key: 'toggle', icon: <Power className="h-4 w-4" />, label: d.enabled ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable'), onClick: () => { void toggle(d, !d.enabled); } },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(d); }, danger: true, separator: true },
      ]}
    />
  ) : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.deadHosts.description') || 'The domains answer 404 everywhere (parked names); the ACME challenge is still served so the certificates renew.'}</p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<Ban />} emptyText={t('proxy.deadHosts.empty') || 'No dead host yet.'} emptyAction={createBtn ?? undefined}>
        <GroupedTable<ProxyDeadHost>
          storageKey="proxy-dead-hosts"
          singleGroupFlat
          minWidth={760}
          defaultSort={{ column: 'domains' }}
          rowClassName={(d) => !d.enabled && 'opacity-60'}
          groups={showAccount
            ? groupRowsByAccount(items, accountDir, (d) => ({ id: d.accountId, username: d.accountUsername }), (rows) => domainTree(rows, domainKey, (d) => d.id))
            : [{ key: 'all', label: '', sortLabel: '', nodes: domainTree(items, domainKey, (d) => d.id) }]}
          renderCard={(d) => (
            <div className={cn('rounded-xl bg-bg-secondary px-3 py-2.5', !d.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1"><DomainNames domains={d.domains} /></span>
                <EdgeUnitPill unit={d.edge} />
                {menu(d)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <SslState domains={d.domains} enabled />
                <span>{pageName(d.customPageId)}</span>
                {showTenant && <TenantBadge tenantId={d.tenantId} />}
              </div>
            </div>
          )}
          columns={[
            { id: 'domains', header: t('proxy.domains.title') || 'Domains', tdClassName: 'max-w-[22rem]', sort: domainKey, cell: (d) => <DomainNames domains={d.domains} max={3} /> },
            { id: 'page', header: t('proxy.deadHosts.page') || '404 page', tdClassName: 'text-xs text-text-secondary', sort: (d) => pageName(d.customPageId), cell: (d) => pageName(d.customPageId) },
            { id: 'ssl', header: t('proxy.ssl.title') || 'SSL', cell: (d) => <SslState domains={d.domains} enabled /> },
            { id: 'edge', header: t('proxy.unit.title') || 'Edge', cell: (d) => <EdgeUnitPill unit={d.edge} /> },
            ...(showTenant && !showAccount ? [{ id: 'tenant', header: t('proxy.tenant') || 'Workspace', cell: (d: ProxyDeadHost) => <TenantBadge tenantId={d.tenantId} /> }] : []),
            {
              id: 'enabled', header: t('proxy.enabled') || 'Enabled', thClassName: 'w-20', sort: (d) => d.enabled,
              cell: (d) => <ToggleSwitch size="sm" checked={d.enabled} disabled={!canManage(d.accountId)} onChange={(v) => { void toggle(d, v); }} ariaLabel={t('proxy.enabled') || 'Enabled'} />,
            },
            { id: 'actions', header: <span className="sr-only">{t('proxy.actions') || 'Actions'}</span>, thClassName: 'w-14', tdClassName: 'text-right', cell: (d) => menu(d) },
          ]}
        />
      </ListState>

      <DeadHostModal
        open={editing !== null}
        deadHost={editing === 'new' ? null : editing}
        accounts={manageable}
        pages={pages}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.deadHosts.saved') || 'Dead host saved'); void load(); }}
      />
    </div>
  );
}

function DeadHostModal({ open, deadHost, accounts, pages, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  deadHost: ProxyDeadHost | null;
  accounts: HostingAccount[];
  pages: CustomPage[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [domainIds, setDomainIds] = useState<number[]>([]);
  const [forceSsl, setForceSsl] = useState(false);
  const [http2, setHttp2] = useState(true);
  const [pageId, setPageId] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAccountId(deadHost?.accountId ?? defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setDomainIds(deadHost?.domains.map((d) => d.domainId) ?? []);
    setForceSsl(deadHost?.ssl.forceSsl ?? false);
    setHttp2(deadHost?.ssl.http2 ?? true);
    setPageId(deadHost?.customPageId ?? null);
    setEnabled(deadHost?.enabled ?? true);
    setError('');
  }, [open, deadHost]); // eslint-disable-line react-hooks/exhaustive-deps

  const usablePages = pages.filter((p) => !p.isWakingPage && (p.accountId == null || p.accountId === accountId) && (p.codes.length === 0 || p.codes.includes(404)));
  const canSubmit = accountId != null && domainIds.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const body = { enabled, domainIds, ssl: { forceSsl, http2 }, customPageId: pageId };
    try {
      if (deadHost) await proxyApi.updateDeadHost(deadHost.id, body);
      else await proxyApi.createDeadHost({ accountId: accountId!, ...body });
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.deadHosts.saveFailed') || 'Failed to save the dead host'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={deadHost ? (t('proxy.deadHosts.editTitle') || 'Dead host') : (t('proxy.deadHosts.createTitle') || 'New dead host')}
      icon={<Ban className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{deadHost ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {deadHost && <EdgeUnitBanner unit={deadHost.edge} />}
        {!deadHost && accounts.length > 1 && <AccountField id="dh-account" accounts={accounts} value={accountId} onChange={(v) => { setAccountId(v); setDomainIds([]); }} />}
        <div>
          <span className={labelCls}>{t('proxy.domains.title') || 'Domains'}</span>
          <DomainPicker accountId={accountId} value={domainIds} onChange={setDomainIds} self={{ kind: 'dead', id: deadHost?.id ?? null }} />
        </div>
        <div>
          <label className={labelCls} htmlFor="dh-page">{t('proxy.deadHosts.page') || '404 page'}</label>
          <select id="dh-page" value={pageId ?? ''} onChange={(e) => setPageId(e.target.value ? Number(e.target.value) : null)} className={selectCls}>
            <option value="">{t('proxy.pages.platformDefault') || 'Default page'}</option>
            {usablePages.map((p) => <option key={p.id} value={p.id}>{p.name}{p.accountId == null ? ` (${t('proxy.pages.platform') || 'platform'})` : ''}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ToggleSwitch checked={forceSsl} onChange={setForceSsl} label={t('proxy.ssl.forceSsl') || 'Force HTTPS'} />
          <ToggleSwitch checked={http2} onChange={setHttp2} label="HTTP/2" />
          <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('proxy.enabled') || 'Enabled'} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
