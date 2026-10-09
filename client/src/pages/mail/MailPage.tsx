import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AtSign, Forward, Mail, RefreshCw, ScrollText, Send, UserRound } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MailOverview, type MailUpdatedPayload } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { mailApi } from '@/api/mail.api';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { EmptyState, headerBtnCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { MailDomainsPanel } from '@/components/mail/MailDomainsPanel';
import { MailboxesPanel } from '@/components/mail/MailboxesPanel';
import { MailAliasesPanel } from '@/components/mail/MailAliasesPanel';
import { MailOutboundPanel } from '@/components/mail/MailOutboundPanel';
import { MailLogsPanel } from '@/components/mail/MailLogsPanel';
import { MailStatusBanner } from '@/components/mail/MailStatusBanner';
import { mailLoadError } from '@/components/mail/mailErrors';
import { applyParamsPatch, engineHasMailboxes, pickSingleTenant } from '@/components/mail/mailFormat';
import { cn } from '@/utils/cn';

type Tab = 'domains' | 'mailboxes' | 'aliases' | 'outbound' | 'logs';
const TABS: readonly Tab[] = ['domains', 'mailboxes', 'aliases', 'outbound', 'logs'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /mail — mail domains (DNS status), mailboxes, aliases, outbound (state,
 * site relay, queue) and logs, in tabs `?tab=domains|mailboxes|aliases|outbound|logs`,
 * for one account (`?account=<id>`) or every visible account
 * (docs/P4-PLAN.md §12). OWNED BY MODULE `ui-mail`.
 */
export function MailPage() {
  const { t } = useTranslation();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tenantFilter = useTenantFilter();
  // God view: one workspace at a time (the mail lists take a single tenantId).
  const tenantId = isMaster && tenantFilter.ids.length > 0 ? tenantFilter.ids[0] : undefined;
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'domains';
  const accountParam = Number(params.get('account')) || null;

  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [overview, setOverview] = useState<MailOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAccountsLoaded(false);
    accountsApi.list(tenantId ? { tenantId } : {})
      .then((list) => { if (!cancelled) setAccounts(list); })
      .catch(() => { if (!cancelled) setAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoaded(true); });
    return () => { cancelled = true; };
  }, [currentTenantId, tenantId]);

  // A caller with a single account always works on it (client users, small workspaces).
  const accountId = accountParam ?? (accounts.length === 1 ? accounts[0].id : null);

  const seq = useRef(0);
  const loadOverview = useCallback(async () => {
    const n = ++seq.current;
    try {
      const o = await mailApi.overview(accountId ?? undefined);
      if (n !== seq.current) return;
      setOverview(o);
      setOverviewError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setOverview(null);
      setOverviewError(mailLoadError(t, err, t('mail.overviewFailed') || 'Failed to load the mail state'));
    }
  }, [accountId, t]);
  useEffect(() => { void loadOverview(); }, [loadOverview, currentTenantId]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void loadOverview(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    return !!payload && (payload.entity === 'engine' || payload.entity === 'outbound' || accountId == null || payload.accountId === accountId);
  }, 1500);

  // Always a functional update on the latest URL: several keys changed by one
  // action (workspace + account) must land in a single navigation, otherwise
  // the last setParams built from this render's stale params wins and drops
  // the others. useTenantFilter re-reads `?tenants=` from the URL.
  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => applyParamsPatch(prev, patch), { replace: true });
  }, [setParams]);
  const setTab = (next: Tab) => update({ tab: next === 'domains' ? null : next });
  const setAccount = (id: number | null) => update({ account: id == null ? null : String(id) });
  const setSingleTenant = (next: Set<number>) => {
    const picked = pickSingleTenant(tenantFilter.value, next);
    // Changing the workspace also forgets the account (it belongs to the old one).
    update({ tenants: picked == null ? null : String(picked), account: null });
  };
  // God view takes one workspace at a time: a deep link `?tenants=1,2` is
  // normalised to the id actually applied (ids[0]) so the chips match the lists.
  const multiTenantUrl = isMaster && tenantFilter.ids.length > 1 ? tenantFilter.ids[0] : null;
  useEffect(() => {
    if (multiTenantUrl != null) update({ tenants: String(multiTenantUrl) });
  }, [multiTenantUrl, update]);

  const mailboxesAllowed = overview ? engineHasMailboxes(overview.engine) : true;
  const counts = overview?.counts;
  const badge = (n: number | undefined) => (n ? <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{n}</span> : null);
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'domains', label: t('mail.tabs.domains') || 'Domains', icon: <AtSign size={16} />, badge: badge(counts?.domains) },
    { id: 'mailboxes', label: t('mail.tabs.mailboxes') || 'Mailboxes', icon: <Mail size={16} />, badge: badge(counts?.mailboxes), hidden: !mailboxesAllowed },
    { id: 'aliases', label: t('mail.tabs.aliases') || 'Aliases', icon: <Forward size={16} />, badge: badge(counts?.aliases), hidden: !mailboxesAllowed },
    { id: 'outbound', label: t('mail.tabs.outbound') || 'Outbound', icon: <Send size={16} /> },
    { id: 'logs', label: t('mail.tabs.logs') || 'Logs', icon: <ScrollText size={16} /> },
  ];
  const shownTab: Tab = !mailboxesAllowed && (tab === 'mailboxes' || tab === 'aliases') ? 'domains' : tab;
  const selectedAccount = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId]);
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const unlimited = t('hostingCommon.unlimited') || 'unlimited';
  const panelKey = `${shownTab}-${accountId ?? 'all'}-${tenantId ?? ''}-${tick}`;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.mail') || 'Mail'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {selectedAccount ? selectedAccount.username : (t('mail.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void loadOverview(); setTick((n) => n + 1); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('mail.description') || 'Mail domains and their DNS records, mailboxes, aliases, outbound mail of the sites and logs.'}
      </p>

      <TenantFilterChips value={tenantFilter.value} onChange={setSingleTenant} />

      <div className="flex flex-wrap items-center gap-2">
        {accounts.length > 1 && (
          <select
            aria-label={t('mail.account') || 'Hosting account'}
            value={accountParam ?? ''}
            onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : null)}
            className={cn(selectCls, 'w-full bg-bg-secondary sm:w-64')}
          >
            <option value="">{t('mail.allAccounts') || 'All accounts'}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
          </select>
        )}
        {overview?.limits && overview.usage && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
            <span>{t('mail.limits.mailboxes', { used: overview.usage.mailboxes, max: overview.limits.maxMailboxes ?? unlimited, defaultValue: 'Mailboxes {{used}} / {{max}}' })}</span>
            <span>{t('mail.limits.quota', { used: formatMb(overview.usage.quotaAllocatedMb, units), max: overview.limits.mailQuotaMb == null ? unlimited : formatMb(overview.limits.mailQuotaMb, units), defaultValue: 'Allocated quota {{used}} / {{max}}' })}</span>
            <span>{t('mail.limits.aliases', { used: overview.usage.aliases, max: overview.limits.maxMailAliases ?? unlimited, defaultValue: 'Aliases {{used}} / {{max}}' })}</span>
            <span>{t('mail.limits.messageSize', { size: overview.limits.maxMessageSizeMb, defaultValue: 'Messages ≤ {{size}} MB' })}</span>
          </div>
        )}
      </div>

      <MailStatusBanner overview={overview} error={overviewError} />

      <SegmentedTabs<Tab> tabs={tabs} value={shownTab} onChange={setTab} ariaLabel={t('nav.mail') || 'Mail'} fill={false} />

      {shownTab === 'domains' && <MailDomainsPanel key={panelKey} accountId={accountId} tenantId={tenantId} accounts={accounts} showTenant={isMaster && tenantId == null} />}
      {shownTab === 'mailboxes' && (
        <MailboxesPanel key={panelKey} accountId={accountId} tenantId={tenantId} showAccount={accountId == null} showTenant={isMaster && tenantId == null} webmailAvailable={overview?.webmail.kind !== 'none'} />
      )}
      {shownTab === 'aliases' && <MailAliasesPanel key={panelKey} accountId={accountId} tenantId={tenantId} showTenant={isMaster && tenantId == null} />}
      {shownTab === 'outbound' && (accountId != null
        ? <MailOutboundPanel key={panelKey} accountId={accountId} />
        : <EmptyState icon={<UserRound />} text={accountsLoaded && accounts.length === 0 ? (t('mail.noAccount') || 'No hosting account is visible to you.') : (t('mail.pickAccount') || 'Choose a hosting account to see its outbound mail, site relays and queue.')} />)}
      {shownTab === 'logs' && <MailLogsPanel key={panelKey} accountId={accountId} tenantId={tenantId} />}
    </PageContainer>
  );
}
