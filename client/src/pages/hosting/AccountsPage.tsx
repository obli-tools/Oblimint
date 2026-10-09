import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronRight, Plus, RefreshCw, Search, Server } from 'lucide-react';
import type { HostingAccount, HostingAccountStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { useAuthStore } from '@/store/authStore';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { AccountCreateModal } from '@/components/hosting/AccountCreateModal';
import {
  AccountStatusBadge, DiskBar, EmptyState, accountStatusLabel, headerAccentBtnCls, headerBtnCls, hostingErrorMessage,
  thCls, theadRowCls, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';

const STATUSES: HostingAccountStatus[] = ['active', 'provisioning', 'suspended', 'error', 'deleting'];

export function AccountsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const isClient = useAuthStore((s) => s.user?.kind === 'client');
  const { me, can } = useHostingMe();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const canCreate = !isClient && me?.kind === 'staff' && can('accounts.manage');

  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<HostingAccountStatus | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  // Request sequence: a slower answer to an older search must not replace a newer one.
  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const list = await accountsApi.list({ search: debounced || undefined, status: status ?? undefined });
      if (seq !== seqRef.current) return;
      setAccounts(list);
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setAccounts([]);
      setLoadError(hostingErrorMessage(t, err, t('accounts.loadFailed') || 'Failed to load the hosting accounts'));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [debounced, status, t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); });

  const title = isClient ? (t('clientSpace.myAccounts') || 'My accounts') : (t('accounts.title') || 'Hosting accounts');

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{title}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('accounts.count', { count: accounts.length, defaultValue: '{{count}} account(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('accounts.create') || 'New account'}</button>
          )}
        </div>
      </div>

      {/* Search + status chips */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('accounts.searchPlaceholder') || 'Search an account…'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none sm:w-72 coarse:min-h-10"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatus(null)}
            className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-3',
              status === null ? 'border-accent bg-accent/10 text-accent' : 'border-transparent text-text-muted hover:border-accent/30')}
          >
            {t('hostingCommon.all') || 'All'}
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus((cur) => (cur === s ? null : s))}
              className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-3',
                status === s ? 'border-accent bg-accent/10 text-accent' : 'border-transparent text-text-muted hover:border-accent/30')}
            >
              {accountStatusLabel(t, s)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={<Server />}
          text={debounced || status
            ? (t('common.noMatch') || 'No match')
            : isClient
              ? (t('clientSpace.noAccount') || 'No hosting account is linked to your login yet.')
              : (t('accounts.empty') || 'No hosting account yet.')}
          action={canCreate && !debounced && !status
            ? <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('accounts.create') || 'New account'}</button>
            : undefined}
        />
      ) : (
        <>
          {/* Phone: cards */}
          <ul className="space-y-2 md:hidden">
            {accounts.map((a) => (
              <li key={a.id}>
                <Link to={`/accounts/${a.id}`} className="block rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-semibold text-text-primary">{a.username}</span>
                    <AccountStatusBadge status={a.status} message={a.statusMessage} />
                    {isMaster && <TenantBadge tenantId={a.tenantId} tenantName={a.tenantName} />}
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                  </div>
                  {a.displayName && <div className="mt-0.5 truncate text-xs text-text-muted">{a.displayName}</div>}
                  <div className="mt-2"><DiskBar usedMb={a.diskUsedMb} quotaMb={a.diskQuotaMb} mode={a.quotaMode} /></div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
                    <span>{t('accounts.col.plan') || 'Plan'}: <span className="text-text-primary">{a.planName ?? '—'}</span></span>
                    <span>{t('accounts.col.sites') || 'Sites'}: <span className="text-text-primary">{a.siteCount}</span></span>
                    <span>{t('accounts.col.domains') || 'Domains'}: <span className="text-text-primary">{a.domainCount}</span></span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('accounts.col.username') || 'Account'}</th>
                  {isMaster && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
                  <th className={thCls}>{t('accounts.col.plan') || 'Plan'}</th>
                  <th className={thCls}>{t('accounts.col.status') || 'Status'}</th>
                  <th className={thCls}>{t('accounts.col.disk') || 'Disk'}</th>
                  <th className={`${thCls} text-right`}>{t('accounts.col.sites') || 'Sites'}</th>
                  <th className={`${thCls} text-right`}>{t('accounts.col.domains') || 'Domains'}</th>
                  <th className={thCls}>{t('accounts.col.created') || 'Created'}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} onClick={() => navigate(`/accounts/${a.id}`)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-3">
                      <Link to={`/accounts/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-text-primary hover:text-accent">{a.username}</Link>
                      {a.displayName && <div className="max-w-[14rem] truncate text-xs text-text-muted">{a.displayName}</div>}
                    </td>
                    {isMaster && <td className="px-4 py-3"><TenantBadge tenantId={a.tenantId} tenantName={a.tenantName} /></td>}
                    <td className="px-4 py-3 text-text-secondary">{a.planName ?? '—'}</td>
                    <td className="px-4 py-3"><AccountStatusBadge status={a.status} message={a.statusMessage} /></td>
                    <td className="px-4 py-3"><DiskBar usedMb={a.diskUsedMb} quotaMb={a.diskQuotaMb} mode={a.quotaMode} compact /></td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{a.siteCount}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{a.domainCount}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-muted">{new Date(a.createdAt).toLocaleDateString(i18n.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}

      <AccountCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => {
          setCreating(false);
          toast.success(t('accounts.created', { username: a.username, defaultValue: 'Account {{username}} created' }));
          navigate(`/accounts/${a.id}`);
        }}
      />
    </PageContainer>
  );
}
