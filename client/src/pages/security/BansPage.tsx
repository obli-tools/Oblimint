import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowUpCircle, Flame, Plus, RefreshCw, ShieldBan, ShieldOff } from 'lucide-react';
import {
  HostingSocketEvents,
  type ProxyHost, type WebBan, type WebBanList, type WebBanScope, type WebBanSource, type WebBanStats, type WebFirewallSummary,
} from '@oblimint/shared';
import { bansApi } from '@/api/bans.api';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { TenantBadge } from '@/components/common/TenantBadge';
import { AccountScopeSelect, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, headerBtnCls, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { MailSearch, Pager } from '@/components/mail/MailListParts';
import { useDebounced } from '@/components/mail/useDebounced';
import { ListState, useProxyAccess } from '@/components/proxy/proxyUi';
import { proxyLoadError, toastProxyError } from '@/components/proxy/proxyErrors';
import { BAN_SOURCES, GeoLine, ObliguardPill, useBanSourceLabel } from '@/components/security/bansUi';
import { BanCreateModal } from '@/components/security/BanCreateModal';
import { cn } from '@/utils/cn';

const PAGE = 50;

/**
 * /security/bans — web bans of the edge (honeypot, access-list trap, manual,
 * Obliguard, promotion): stats, filters, GeoIP, ban / unban, promotion to a
 * platform ban (docs/P4b-PLAN.md §9, §13). OWNED BY MODULE `ui-proxy`.
 */
export function BansPage() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const scope = useAccountScope();
  const { canManage, platformAdmin } = useProxyAccess();
  const { accountId, tenantId, accounts } = scope;

  const [scopeFilter, setScopeFilter] = useState<WebBanScope | ''>('');
  const [active, setActive] = useState<'active' | 'inactive' | ''>('active');
  const [source, setSource] = useState<WebBanSource | ''>('');
  const [hostId, setHostId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [offset, setOffset] = useState(0);

  const [list, setList] = useState<WebBanList>({ items: [], total: 0 });
  const [stats, setStats] = useState<WebBanStats | null>(null);
  const [firewall, setFirewall] = useState<WebFirewallSummary | null>(null);
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { setOffset(0); }, [accountId, tenantId, scopeFilter, active, source, hostId, q]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [l, s] = await Promise.all([
        bansApi.list({
          accountId: accountId ?? undefined, tenantId, scope: scopeFilter || undefined,
          active: active === '' ? undefined : active === 'active', source: source || undefined,
          proxyHostId: hostId ?? undefined, q: q || undefined, limit: PAGE, offset,
        }),
        bansApi.stats({ accountId: accountId ?? undefined, tenantId }).catch(() => null),
      ]);
      if (n !== seq.current) return;
      // The page emptied (bans lifted / expired): go back to the last page that has items.
      const lastPage = l.total > 0 ? Math.floor((l.total - 1) / PAGE) * PAGE : 0;
      if (l.items.length === 0 && offset > 0 && lastPage !== offset) {
        setOffset(lastPage);
        return;
      }
      setList(l);
      setStats(s);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setList({ items: [], total: 0 });
      setError(proxyLoadError(t, err, t('bans.loadFailed') || 'Failed to load the bans', 'bans'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, scopeFilter, active, source, hostId, q, offset, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.BAN_UPDATED], () => { void load(); }, undefined, 1500);

  useEffect(() => {
    let cancelled = false;
    proxyApi.listHosts({ accountId: accountId ?? undefined, tenantId }).then((h) => { if (!cancelled) setHosts(h); }).catch(() => { if (!cancelled) setHosts([]); });
    return () => { cancelled = true; };
  }, [accountId, tenantId]);

  useEffect(() => {
    if (!platformAdmin) return;
    bansApi.firewall().then(setFirewall).catch(() => setFirewall(null));
  }, [platformAdmin]);

  const unban = async (b: WebBan) => {
    if (!(await confirm({
      title: t('bans.unbanTitle') || 'Lift the ban',
      message: t('bans.unbanConfirm', { ip: b.ip, defaultValue: 'Lift the ban of {{ip}}? It is effective immediately.' }),
      confirmLabel: t('bans.unban') || 'Unban',
    }))) return;
    try {
      await bansApi.remove(b.id);
      toast.success(t('bans.unbanned') || 'Ban lifted');
      void load();
    } catch (err) {
      toastProxyError(t, err, t('bans.unbanFailed') || 'Failed to lift the ban', 'bans');
    }
  };

  const promote = async (b: WebBan) => {
    if (!(await confirm({
      title: t('bans.promoteTitle') || 'Promote to a platform ban',
      message: t('bans.promoteConfirm', { ip: b.ip, defaultValue: '{{ip}} will be refused on every host of the platform and dropped by the firewall on ports 80 / 443.' }),
      confirmLabel: t('bans.promote') || 'Promote',
      danger: true,
    }))) return;
    try {
      await bansApi.promote(b.id);
      toast.success(t('bans.promoted') || 'Promoted to a platform ban');
      void load();
    } catch (err) {
      toastProxyError(t, err, t('bans.promoteFailed') || 'Failed to promote the ban', 'bans');
    }
  };

  const sourceLabel = useBanSourceLabel();
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const mayManage = (b: WebBan) => (b.scope === 'platform' ? platformAdmin : canManage(b.accountId));
  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = manageable.length > 0 || platformAdmin
    ? <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('bans.add') || 'Ban an address'}</button>
    : null;

  const menu = (b: WebBan) => {
    const items = [
      { key: 'unban', icon: <ShieldOff className="h-4 w-4" />, label: t('bans.unban') || 'Unban', onClick: () => { void unban(b); }, hidden: !b.active || !mayManage(b) },
      { key: 'promote', icon: <ArrowUpCircle className="h-4 w-4" />, label: t('bans.promote') || 'Promote', onClick: () => { void promote(b); }, hidden: !platformAdmin || !b.active || b.scope !== 'account', separator: true },
    ];
    return items.some((i) => !i.hidden) ? <ActionMenu items={items} /> : null;
  };
  const { sorted, sort } = useTableSort(list.items, {
    ip: (b) => b.ip, origin: (b) => b.geo?.countryName ?? '', source: (b) => b.source, scope: (b) => b.scope, hits: (b) => b.hitCount,
    seen: (b) => b.lastSeenAt, until: (b) => (b.bannedUntil ?? '9999'), obliguard: (b) => b.obliguardStatus,
  });
  const until = (b: WebBan) => {
    if (!b.active) return <Pill>{t('bans.inactive') || 'lifted / expired'}</Pill>;
    return b.bannedUntil == null ? <Pill tone="amber">{t('bans.permanent') || 'permanent'}</Pill> : <span className="font-mono text-xs text-text-secondary">{fmt(b.bannedUntil)}</span>;
  };
  const scopePill = (b: WebBan) => (b.scope === 'platform'
    ? <Pill tone="accent">{t('bans.scope.platform') || 'Platform'}</Pill>
    : <span className="font-mono text-xs text-text-secondary">{b.accountUsername ?? '—'}</span>);

  const statCard = (label: string, value: number | undefined, tone?: string) => (
    <div className="rounded-xl bg-bg-secondary px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className={cn('mt-1 font-display text-2xl font-semibold text-text-primary', tone)}>{value ?? '—'}</div>
    </div>
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.bans') || 'Bans'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">{scopeSubtitle(scope, t('proxy.allAccountsShort') || 'all accounts')}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { setLoading(true); void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {createBtn}
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('bans.description') || 'Addresses refused by the web front end: caught by a honeypot bait, by the access-list trap, banned by hand or synchronised from Obliguard. Repeat offences ban longer.'}</p>

      <TenantFilterChips value={scope.tenantFilter.value} onChange={scope.setSingleTenant} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statCard(t('bans.stats.active') || 'Active bans', stats?.active, 'text-status-down')}
        {statCard(t('bans.stats.last24h') || 'Last 24 h', stats?.last24h)}
        {statCard(t('bans.stats.account') || 'Account bans', stats?.account)}
        {statCard(t('bans.stats.platform') || 'Platform bans', stats?.platform)}
      </div>
      {stats && (
        <div className="-mt-2 flex flex-wrap gap-1.5">
          {BAN_SOURCES.filter((s) => (stats.bySource[s] ?? 0) > 0).map((s) => (
            <button key={s} type="button" onClick={() => setSource(source === s ? '' : s)} className={cn('rounded-full px-2.5 py-0.5 text-[11px] transition-colors', source === s ? 'bg-accent text-white' : 'bg-bg-secondary text-text-muted hover:text-text-primary')}>
              {sourceLabel(s)} · {stats.bySource[s]}
            </button>
          ))}
        </div>
      )}
      {firewall && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-bg-secondary px-4 py-2.5 text-xs text-text-muted">
          <Flame size={14} className="text-accent" />
          <span>{t('bans.firewall.title') || 'Web firewall (nftables)'}</span>
          <span className="font-mono">{t('bans.firewall.summary', { bans: firewall.bans, ports: firewall.ports.join(', ') || '—', defaultValue: '{{bans}} address(es) dropped on {{ports}}' })}</span>
          <span>{t('bans.firewall.lastPush', { date: fmt(firewall.lastPushAt), defaultValue: 'last push {{date}}' })}</span>
          {firewall.lastPushError && <Tip content={firewall.lastPushError}><span className="cursor-help"><Pill tone="red">{t('bans.firewall.error') || 'push error'}</Pill></span></Tip>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('bans.search') || 'IP, reason, city, organisation…'} />
        <AccountScopeSelect scope={scope} className="sm:w-52" />
        <select aria-label={t('bans.scopeLabel') || 'Scope'} value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as WebBanScope | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-40')}>
          <option value="">{t('bans.scope.all') || 'Every scope'}</option>
          <option value="account">{t('bans.scope.account') || 'Account'}</option>
          <option value="platform">{t('bans.scope.platform') || 'Platform'}</option>
        </select>
        <select aria-label={t('bans.state') || 'State'} value={active} onChange={(e) => setActive(e.target.value as typeof active)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-36')}>
          <option value="active">{t('bans.activeOnly') || 'Active'}</option>
          <option value="inactive">{t('bans.inactiveOnly') || 'Lifted / expired'}</option>
          <option value="">{t('bans.allStates') || 'All'}</option>
        </select>
        <select aria-label={t('bans.sourceLabel') || 'Source'} value={source} onChange={(e) => setSource(e.target.value as WebBanSource | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-48')}>
          <option value="">{t('bans.allSources') || 'Every source'}</option>
          {BAN_SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        {hosts.length > 0 && (
          <select aria-label={t('bans.host') || 'Proxy host'} value={hostId ?? ''} onChange={(e) => setHostId(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-52')}>
            <option value="">{t('bans.allHosts') || 'Every host'}</option>
            {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        )}
      </div>

      <ListState loading={loading} error={error} empty={list.items.length === 0} emptyIcon={<ShieldBan />} emptyText={q || source || hostId ? (t('common.noMatch') || 'No match') : (t('bans.empty') || 'No ban.')}>
        <ul className="space-y-2 md:hidden">
          {list.items.map((b) => (
            <li key={b.id} className={cn('rounded-xl bg-bg-secondary px-3 py-2.5', !b.active && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-text-primary">{b.ip}</span>
                {until(b)}
                {menu(b)}
              </div>
              <div className="mt-1"><GeoLine geo={b.geo} /></div>
              {b.reason && <div className="mt-1 break-all font-mono text-[11px] text-text-muted">{b.reason}</div>}
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <span>{sourceLabel(b.source)}</span>
                {scopePill(b)}
                <span>{t('bans.hitsShort', { count: b.hitCount, defaultValue: '{{count}} hit(s)' })}</span>
                {b.offenseLevel > 1 && <Pill tone="amber">{t('bans.level', { level: b.offenseLevel, defaultValue: 'level {{level}}' })}</Pill>}
                {scope.showTenant && <TenantBadge tenantId={b.tenantId} />}
              </div>
            </li>
          ))}
        </ul>
        <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                {/* Sort of the page shown (the list is paged by the server, newest first). */}
                <SortTh k="ip" sort={sort} className={thCls}>{t('bans.ip') || 'Address'}</SortTh>
                <SortTh k="origin" sort={sort} className={thCls}>{t('bans.origin') || 'Origin'}</SortTh>
                <SortTh k="source" sort={sort} className={thCls}>{t('bans.sourceLabel') || 'Source'}</SortTh>
                <SortTh k="scope" sort={sort} className={thCls}>{t('bans.scopeLabel') || 'Scope'}</SortTh>
                <SortTh k="hits" sort={sort} className={thCls}>{t('bans.hits') || 'Hits'}</SortTh>
                <SortTh k="seen" sort={sort} className={thCls}>{t('bans.seen') || 'First / last seen'}</SortTh>
                <SortTh k="until" sort={sort} className={thCls}>{t('bans.until') || 'Until'}</SortTh>
                <SortTh k="obliguard" sort={sort} className={thCls}>Obliguard</SortTh>
                {scope.showTenant && <th className={thCls}>{t('proxy.tenant') || 'Workspace'}</th>}
                <th className={`${thCls} w-14`}><span className="sr-only">{t('proxy.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => (
                <tr key={b.id} className={cn('align-top transition-colors hover:bg-bg-hover', !b.active && 'opacity-60')}>
                  <td className="px-4 py-3">
                    <span className="font-mono font-medium text-text-primary">{b.ip}</span>
                    {b.reason && <div className="mt-0.5 max-w-[18rem] break-all font-mono text-[11px] text-text-muted">{b.reason}</div>}
                  </td>
                  <td className="px-4 py-3"><div className="flex w-[14rem] max-w-[14rem] min-w-0"><GeoLine geo={b.geo} /></div></td>
                  <td className="px-4 py-3 text-xs text-text-secondary">
                    {sourceLabel(b.source)}
                    {b.proxyHostId != null && <div className="mt-0.5"><Link to={`/proxy/hosts/${b.proxyHostId}`} className="text-accent hover:underline">{b.proxyHostName ?? `#${b.proxyHostId}`}</Link></div>}
                    {b.createdBy && <div className="mt-0.5 text-text-muted">{b.createdBy}</div>}
                  </td>
                  <td className="px-4 py-3">{scopePill(b)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                    {b.hitCount}
                    {b.offenseLevel > 1 && <Pill tone="amber" className="ml-2">{t('bans.level', { level: b.offenseLevel, defaultValue: 'level {{level}}' })}</Pill>}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-text-muted">{fmt(b.firstSeenAt)}<br />{fmt(b.lastSeenAt)}</td>
                  <td className="px-4 py-3">{until(b)}</td>
                  <td className="px-4 py-3"><ObliguardPill status={b.obliguardStatus} /></td>
                  {scope.showTenant && <td className="px-4 py-3"><TenantBadge tenantId={b.tenantId} /></td>}
                  <td className="px-4 py-3 text-right">{menu(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <Pager offset={offset} total={list.total} pageSize={PAGE} onOffset={setOffset} extra={<span>{t('bans.total', { count: list.total, defaultValue: '{{count}} ban(s)' })}</span>} />
      </ListState>

      <BanCreateModal
        open={creating}
        accounts={manageable}
        allowPlatform={platformAdmin}
        defaultAccountId={accountId}
        onClose={() => setCreating(false)}
        onSaved={(b) => { setCreating(false); toast.success(t('bans.created', { ip: b.ip, defaultValue: '{{ip}} banned' })); void load(); }}
      />
    </PageContainer>
  );
}
