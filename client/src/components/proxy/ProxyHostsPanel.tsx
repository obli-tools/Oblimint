import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { BarChart3, Pencil, Plus, Power, RotateCcw, Trash2, Waypoints } from 'lucide-react';
import { HostingSocketEvents, type CertificateListItem, type ProxyHost, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { MailSearch } from '@/components/mail/MailListParts';
import { useDebounced } from '@/components/mail/useDebounced';
import { cn } from '@/utils/cn';
import { DomainNames, EdgeUnitPill, ListState, SslState, useProxyAccess } from './proxyUi';
import { proxyLoadError, toastProxyError } from './proxyErrors';
import { unitNeedsAttention } from './proxyFormat';

/** Proxy hosts of an account / every visible account: domains, target, SSL, edge unit state, quick actions. */
export function ProxyHostsPanel({ accountId, tenantId, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const [items, setItems] = useState<ProxyHost[]>([]);
  const [importedCerts, setImportedCerts] = useState<Map<number, CertificateListItem>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [list, certs] = await Promise.all([
        proxyApi.listHosts({ accountId: accountId ?? undefined, tenantId, search: q || undefined }),
        // Imported certificates: SSL column of the hosts in ssl.mode 'imported' (best effort).
        proxyApi.listCertificates({ accountId: accountId ?? undefined, tenantId }).catch(() => [] as CertificateListItem[]),
      ]);
      if (n !== seq.current) return;
      setItems(list);
      setImportedCerts(new Map(certs.filter((c) => c.kind === 'imported').map((c) => [c.id, c])));
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.hosts.loadFailed') || 'Failed to load the proxy hosts'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, q, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    if (!payload || !['host', 'edgeUnit', 'certificate'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const importedOf = (h: ProxyHost) => (h.ssl.mode === 'imported'
    ? (h.ssl.importedCertificateId != null ? importedCerts.get(h.ssl.importedCertificateId) ?? null : null)
    : undefined);
  const replace = (h: ProxyHost) => setItems((cur) => cur.map((x) => (x.id === h.id ? h : x)));

  const setEnabled = async (h: ProxyHost, enabled: boolean) => {
    setBusy(h.id);
    try {
      replace(await proxyApi.updateHost(h.id, { enabled }));
      toast.success(enabled ? (t('proxy.hosts.enabledToast') || 'Proxy host enabled') : (t('proxy.hosts.disabledToast') || 'Proxy host disabled'));
    } catch (err) {
      toastProxyError(t, err, t('proxy.hosts.saveFailed') || 'Failed to save the proxy host');
    } finally {
      setBusy(null);
    }
  };

  const retry = async (h: ProxyHost) => {
    setBusy(h.id);
    try {
      replace(await proxyApi.retryHost(h.id));
      toast.success(t('proxy.hosts.retried') || 'Applied again');
    } catch (err) {
      toastProxyError(t, err, t('proxy.hosts.retryFailed') || 'The new attempt failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (h: ProxyHost) => {
    if (!(await confirm({
      title: t('proxy.hosts.deleteTitle') || 'Delete the proxy host',
      message: t('proxy.hosts.deleteConfirm', { name: h.name, defaultValue: 'Delete {{name}}? Its domains are released (they can be bound again or routed to a site).' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteHost(h.id);
      toast.success(t('proxy.hosts.deleted') || 'Proxy host deleted');
      setItems((cur) => cur.filter((x) => x.id !== h.id));
    } catch (err) {
      toastProxyError(t, err, t('proxy.hosts.deleteFailed') || 'Failed to delete the proxy host');
    }
  };

  const manageAny = canManage(accountId);
  const newHref = accountId != null ? `/proxy/hosts/new?account=${accountId}` : '/proxy/hosts/new';
  const createBtn = manageAny ? <Link to={newHref} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.hosts.add') || 'New proxy host'}</Link> : null;

  const rowMenu = (h: ProxyHost) => {
    const manage = canManage(h.accountId);
    return (
      <ActionMenu
        items={[
          { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: manage ? (t('common.edit') || 'Edit') : (t('proxy.open') || 'Open'), onClick: () => navigate(`/proxy/hosts/${h.id}`) },
          { key: 'traffic', icon: <BarChart3 className="h-4 w-4" />, label: t('proxy.hosts.traffic') || 'Traffic', onClick: () => navigate(`/traffic/${h.id}`) },
          { key: 'retry', icon: <RotateCcw className="h-4 w-4" />, label: t('proxy.unit.retry') || 'Retry now', onClick: () => { void retry(h); }, hidden: !manage },
          { key: 'toggle', icon: <Power className="h-4 w-4" />, label: h.enabled ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable'), onClick: () => { void setEnabled(h, !h.enabled); }, hidden: !manage },
          { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(h); }, danger: true, separator: true, hidden: !manage },
        ]}
      />
    );
  };

  const target = (h: ProxyHost) => (
    <span className="break-all font-mono text-xs text-text-secondary">→ {h.targetLabel}</span>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('proxy.hosts.search') || 'Search a host or a domain…'} />
        <div className="ml-auto">{createBtn}</div>
      </div>

      <ListState
        loading={loading}
        error={error}
        empty={items.length === 0}
        emptyIcon={<Waypoints />}
        emptyText={q ? (t('common.noMatch') || 'No match') : (t('proxy.hosts.empty') || 'No proxy host yet. A proxy host publishes an application, a site or an external machine on verified domains.')}
        emptyAction={!q ? createBtn ?? undefined : undefined}
      >
        <ul className="space-y-2 md:hidden">
          {items.map((h) => (
            <li key={h.id} className={cn('rounded-xl bg-bg-secondary px-3 py-2.5', !h.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <Link to={`/proxy/hosts/${h.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary hover:text-accent">{h.name}</Link>
                <EdgeUnitPill unit={h.edge} />
                {rowMenu(h)}
              </div>
              <div className="mt-1"><DomainNames domains={h.domains} /></div>
              <div className="mt-1">{target(h)}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <SslState domains={h.domains} enabled={h.ssl.mode !== 'none'} imported={importedOf(h)} />
                {!h.enabled && <Pill>{t('proxy.disabled') || 'disabled'}</Pill>}
                {showAccount && <span className="font-mono">{h.accountUsername}</span>}
                {showTenant && <TenantBadge tenantId={h.tenantId} />}
              </div>
            </li>
          ))}
        </ul>
        <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('proxy.hosts.name') || 'Proxy host'}</th>
                <th className={thCls}>{t('proxy.hosts.target') || 'Target'}</th>
                <th className={thCls}>{t('proxy.ssl.title') || 'SSL'}</th>
                <th className={thCls}>{t('proxy.unit.title') || 'Edge'}</th>
                {showAccount && <th className={thCls}>{t('proxy.account') || 'Hosting account'}</th>}
                {showTenant && <th className={thCls}>{t('proxy.tenant') || 'Workspace'}</th>}
                <th className={`${thCls} w-20`}>{t('proxy.enabled') || 'Enabled'}</th>
                <th className={`${thCls} w-14`}><span className="sr-only">{t('proxy.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.id} className={cn('align-top transition-colors hover:bg-bg-hover', !h.enabled && 'opacity-60', unitNeedsAttention(h.edge?.status) && 'bg-amber-400/[0.03]')}>
                  <td className="max-w-[22rem] px-4 py-3">
                    <Link to={`/proxy/hosts/${h.id}`} className="font-medium text-text-primary hover:text-accent">{h.name}</Link>
                    <div className="mt-0.5"><DomainNames domains={h.domains} /></div>
                  </td>
                  <td className="max-w-[18rem] px-4 py-3">{target(h)}</td>
                  <td className="px-4 py-3"><SslState domains={h.domains} enabled={h.ssl.mode !== 'none'} imported={importedOf(h)} /></td>
                  <td className="px-4 py-3"><EdgeUnitPill unit={h.edge} /></td>
                  {showAccount && <td className="px-4 py-3 font-mono text-xs text-text-secondary">{h.accountUsername}</td>}
                  {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={h.tenantId} /></td>}
                  <td className="px-4 py-3">
                    <ToggleSwitch size="sm" checked={h.enabled} disabled={!canManage(h.accountId) || busy === h.id} onChange={(v) => { void setEnabled(h, v); }} ariaLabel={t('proxy.enabled') || 'Enabled'} />
                  </td>
                  <td className="px-4 py-3 text-right">{rowMenu(h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </ListState>
    </div>
  );
}
