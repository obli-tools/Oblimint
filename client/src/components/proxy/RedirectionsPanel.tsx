import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CornerUpRight, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type ProxyRedirection, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, inputCls, labelCls, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DomainPicker } from './DomainPicker';
import { AccountField, DomainNames, EdgeUnitBanner, EdgeUnitPill, ListState, SslState, useProxyAccess } from './proxyUi';
import { proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';
import { isValidHostname, isValidTargetPath } from './proxyFormat';

/** Redirections (301/302/307/308) of an account / every visible account. */
export function RedirectionsPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const [items, setItems] = useState<ProxyRedirection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProxyRedirection | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await proxyApi.listRedirections({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.redirections.loadFailed') || 'Failed to load the redirections'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    if (!payload || !['redirection', 'edgeUnit', 'certificate'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const toggle = async (r: ProxyRedirection, enabled: boolean) => {
    try {
      const saved = await proxyApi.updateRedirection(r.id, { enabled });
      setItems((cur) => cur.map((x) => (x.id === r.id ? saved : x)));
    } catch (err) {
      toastProxyError(t, err, t('proxy.redirections.saveFailed') || 'Failed to save the redirection');
    }
  };

  const remove = async (r: ProxyRedirection) => {
    if (!(await confirm({
      title: t('proxy.redirections.deleteTitle') || 'Delete the redirection',
      message: t('proxy.redirections.deleteConfirm', { target: r.targetDomain, defaultValue: 'Delete the redirection to {{target}}? Its domains are released.' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteRedirection(r.id);
      toast.success(t('proxy.redirections.deleted') || 'Redirection deleted');
      setItems((cur) => cur.filter((x) => x.id !== r.id));
    } catch (err) {
      toastProxyError(t, err, t('proxy.redirections.deleteFailed') || 'Failed to delete the redirection');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = canManage(accountId) && manageable.length > 0
    ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.redirections.add') || 'New redirection'}</button>
    : null;

  const targetUrl = (r: ProxyRedirection) => `${r.targetScheme === 'auto' ? '$scheme' : r.targetScheme}://${r.targetDomain}${r.targetPath ?? ''}${r.preservePath ? '…' : ''}`;
  const menu = (r: ProxyRedirection) => (canManage(r.accountId) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(r) },
        { key: 'toggle', icon: <Power className="h-4 w-4" />, label: r.enabled ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable'), onClick: () => { void toggle(r, !r.enabled); } },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(r); }, danger: true, separator: true },
      ]}
    />
  ) : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.redirections.description') || 'Every request on the domains is redirected to another address (the ACME challenge is still served).'}</p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<CornerUpRight />} emptyText={t('proxy.redirections.empty') || 'No redirection yet.'} emptyAction={createBtn ?? undefined}>
        <ul className="space-y-2 md:hidden">
          {items.map((r) => (
            <li key={r.id} className={cn('rounded-xl bg-bg-secondary px-3 py-2.5', !r.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1"><DomainNames domains={r.domains} /></span>
                <EdgeUnitPill unit={r.edge} />
                {menu(r)}
              </div>
              <div className="mt-1 break-all font-mono text-xs text-text-secondary">{r.statusCode} → {targetUrl(r)}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <SslState domains={r.domains} enabled />
                {showAccount && <span className="font-mono">{r.accountUsername}</span>}
                {showTenant && <TenantBadge tenantId={r.tenantId} />}
              </div>
            </li>
          ))}
        </ul>
        <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('proxy.domains.title') || 'Domains'}</th>
                <th className={thCls}>{t('proxy.redirections.target') || 'Redirect to'}</th>
                <th className={thCls}>{t('proxy.ssl.title') || 'SSL'}</th>
                <th className={thCls}>{t('proxy.unit.title') || 'Edge'}</th>
                {showAccount && <th className={thCls}>{t('proxy.account') || 'Hosting account'}</th>}
                {showTenant && <th className={thCls}>{t('proxy.tenant') || 'Workspace'}</th>}
                <th className={`${thCls} w-20`}>{t('proxy.enabled') || 'Enabled'}</th>
                <th className={`${thCls} w-14`}><span className="sr-only">{t('proxy.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={cn('align-top transition-colors hover:bg-bg-hover', !r.enabled && 'opacity-60')}>
                  <td className="max-w-[20rem] px-4 py-3"><DomainNames domains={r.domains} /></td>
                  <td className="px-4 py-3"><Pill tone="blue" className="mr-2">{r.statusCode}</Pill><span className="break-all font-mono text-xs text-text-secondary">{targetUrl(r)}</span></td>
                  <td className="px-4 py-3"><SslState domains={r.domains} enabled /></td>
                  <td className="px-4 py-3"><EdgeUnitPill unit={r.edge} /></td>
                  {showAccount && <td className="px-4 py-3 font-mono text-xs text-text-secondary">{r.accountUsername}</td>}
                  {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={r.tenantId} /></td>}
                  <td className="px-4 py-3"><ToggleSwitch size="sm" checked={r.enabled} disabled={!canManage(r.accountId)} onChange={(v) => { void toggle(r, v); }} ariaLabel={t('proxy.enabled') || 'Enabled'} /></td>
                  <td className="px-4 py-3 text-right">{menu(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </ListState>

      <RedirectionModal
        open={editing !== null}
        redirection={editing === 'new' ? null : editing}
        accounts={manageable}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.redirections.saved') || 'Redirection saved'); void load(); }}
      />
    </div>
  );
}

function RedirectionModal({ open, redirection, accounts, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  redirection: ProxyRedirection | null;
  accounts: HostingAccount[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [domainIds, setDomainIds] = useState<number[]>([]);
  const [scheme, setScheme] = useState<ProxyRedirection['targetScheme']>('auto');
  const [domain, setDomain] = useState('');
  const [path, setPath] = useState('');
  const [preservePath, setPreservePath] = useState(true);
  const [code, setCode] = useState<ProxyRedirection['statusCode']>(301);
  const [forceSsl, setForceSsl] = useState(true);
  const [http2, setHttp2] = useState(true);
  const [hsts, setHsts] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const r = redirection;
    setAccountId(r?.accountId ?? defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setDomainIds(r?.domains.map((d) => d.domainId) ?? []);
    setScheme(r?.targetScheme ?? 'auto');
    setDomain(r?.targetDomain ?? '');
    setPath(r?.targetPath ?? '');
    setPreservePath(r?.preservePath ?? true);
    setCode(r?.statusCode ?? 301);
    setForceSsl(r?.ssl.forceSsl ?? true);
    setHttp2(r?.ssl.http2 ?? true);
    setHsts(r?.ssl.hsts ?? false);
    setEnabled(r?.enabled ?? true);
    setError('');
  }, [open, redirection]); // eslint-disable-line react-hooks/exhaustive-deps

  const domainOk = isValidHostname(domain);
  const pathOk = !path.trim() || isValidTargetPath(path);
  const canSubmit = accountId != null && domainIds.length > 0 && domainOk && pathOk;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const body = {
      enabled, domainIds, targetScheme: scheme, targetDomain: domain.trim().toLowerCase(), targetPath: path.trim() || null,
      preservePath, statusCode: code, ssl: { forceSsl, http2, hsts },
    };
    try {
      if (redirection) await proxyApi.updateRedirection(redirection.id, body);
      else await proxyApi.createRedirection({ accountId: accountId!, ...body });
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.redirections.saveFailed') || 'Failed to save the redirection'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={redirection ? (t('proxy.redirections.editTitle') || 'Redirection') : (t('proxy.redirections.createTitle') || 'New redirection')}
      icon={<CornerUpRight className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{redirection ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {redirection && <EdgeUnitBanner unit={redirection.edge} />}
        {!redirection && accounts.length > 1 && <AccountField id="rd-account" accounts={accounts} value={accountId} onChange={(v) => { setAccountId(v); setDomainIds([]); }} />}
        <div>
          <span className={labelCls}>{t('proxy.domains.title') || 'Domains'}</span>
          <DomainPicker accountId={accountId} value={domainIds} onChange={setDomainIds} self={{ kind: 'redirect', id: redirection?.id ?? null }} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_1fr]">
          <div>
            <label className={labelCls} htmlFor="rd-scheme">{t('proxy.target.scheme') || 'Scheme'}</label>
            <select id="rd-scheme" value={scheme} onChange={(e) => setScheme(e.target.value as ProxyRedirection['targetScheme'])} className={selectCls}>
              <option value="auto">{t('proxy.redirections.schemeAuto') || 'same'}</option>
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rd-domain">{t('proxy.redirections.targetDomain') || 'Target domain'}</label>
            <input id="rd-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', domain && !domainOk && 'ring-2 ring-status-down/50')} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="rd-path">{t('proxy.redirections.targetPath') || 'Target path (optional)'}</label>
            <input id="rd-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/fr" autoCapitalize="off" spellCheck={false} className={cn(inputCls, 'font-mono', !pathOk && 'ring-2 ring-status-down/50')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="rd-code">{t('proxy.redirections.code') || 'Status code'}</label>
            <select id="rd-code" value={code} onChange={(e) => setCode(Number(e.target.value) as ProxyRedirection['statusCode'])} className={selectCls}>
              <option value={301}>{t('proxy.redirections.code301') || '301 — permanent'}</option>
              <option value={302}>{t('proxy.redirections.code302') || '302 — temporary'}</option>
              <option value={307}>{t('proxy.redirections.code307') || '307 — temporary, same method'}</option>
              <option value={308}>{t('proxy.redirections.code308') || '308 — permanent, same method'}</option>
            </select>
          </div>
        </div>
        <ToggleSwitch checked={preservePath} onChange={setPreservePath} label={t('proxy.redirections.preservePath') || 'Keep the requested path'} description={t('proxy.redirections.preservePathHint') || 'Appends the path and query of the request to the target.'} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ToggleSwitch checked={forceSsl} onChange={setForceSsl} label={t('proxy.ssl.forceSsl') || 'Force HTTPS'} />
          <ToggleSwitch checked={http2} onChange={setHttp2} label="HTTP/2" />
          <ToggleSwitch checked={hsts} onChange={setHsts} label="HSTS" />
        </div>
        <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('proxy.enabled') || 'Enabled'} />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
