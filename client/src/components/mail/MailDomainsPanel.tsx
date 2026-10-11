import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, AtSign, ChevronRight, Plus } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MailDomain, type MailUpdatedPayload } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { EmptyState, headerAccentBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatBytes } from '@/components/databases/dbFormat';
import { DnsDots, MailDomainStatusBadge, dotsFromHealthy } from './MailBadges';
import { MailDomainCreateModal } from './MailDomainCreateModal';
import { MailSearch } from './MailListParts';
import { mailLoadError } from './mailErrors';
import { dotsFromRecords, type DotState } from './mailFormat';

/** Above this many domains the per-domain DNS detail is not fetched (summary flag only). */
const DOTS_DETAIL_MAX = 40;

/** Domains tab of /mail: list with DNS dots, creation from a domain of the account. */
export function MailDomainsPanel({ accountId, tenantId, accounts, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  /** Accounts of the selector (creation offers those the caller may manage). */
  accounts: HostingAccount[];
  showTenant: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const [domains, setDomains] = useState<MailDomain[]>([]);
  const [dots, setDots] = useState<Record<number, Record<string, DotState>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const seq = useRef(0);
  /**
   * `dns`: which per-domain DNS details to (re)fetch for the dots — 'all'
   * (first load, domain created / deleted), the ids whose DNS or DKIM changed,
   * or 'none' (mailbox / alias events: only the list and its counts change).
   */
  const load = useCallback(async (dns: 'all' | 'none' | number[] = 'all') => {
    const n = ++seq.current;
    try {
      const list = await mailApi.listDomains({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setDomains(list);
      setError(null);
      // DNS detail (expected records + last check, no network on the server side) for the dots.
      if (list.length > DOTS_DETAIL_MAX) {
        setDots({});
        return;
      }
      const ids = new Set(list.map((d) => d.id));
      const wanted = dns === 'all' ? list.map((d) => d.id) : dns === 'none' ? [] : dns.filter((id) => ids.has(id));
      const results = await Promise.allSettled(wanted.map((id) => mailApi.dnsStatus(id)));
      if (n !== seq.current) return;
      setDots((prev) => {
        const next: Record<number, Record<string, DotState>> = {};
        // Keep the known dots of the domains still listed, replace the refetched ones.
        if (dns !== 'all') for (const [k, v] of Object.entries(prev)) if (ids.has(Number(k))) next[Number(k)] = v;
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') next[wanted[i]] = dotsFromRecords(r.value.records, [r.value.ptr.ipv4?.status ?? null, r.value.ptr.ipv6?.status ?? null]);
        });
        return next;
      });
    } catch (err) {
      if (n !== seq.current) return;
      setDomains([]);
      setError(mailLoadError(t, err, t('mail.domains.loadFailed') || 'Failed to load the mail domains'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  // Events accumulated during the debounce window: what the next reload refetches.
  const pending = useRef<Set<number>>(new Set());
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => {
    const ids = pending.current;
    pending.current = new Set();
    void load([...ids]);
  }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    if (!payload || !['mailDomain', 'dns', 'dkim', 'mailbox', 'alias'].includes(payload.entity)) return false;
    if (!(accountId == null || payload.accountId == null || payload.accountId === accountId)) return false;
    // mailDomain / dns / dkim: that domain's DNS detail (a deleted one simply drops out of the list).
    if (payload.entity === 'mailDomain' || payload.entity === 'dns' || payload.entity === 'dkim') pending.current.add(payload.id);
    return true;
  }, 800);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return domains;
    return domains.filter((d) => d.name.includes(q) || d.accountUsername.toLowerCase().includes(q));
  }, [domains, search]);

  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const manageable = useMemo(() => accounts.filter((a) => can('mail.manage', a.id)), [accounts, can]);
  const canCreate = accountId != null ? can('mail.manage', accountId) : manageable.length > 0;
  const createBtn = canCreate ? (
    <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('mail.domains.add') || 'Enable mail on a domain'}</button>
  ) : null;
  const dotsOf = (d: MailDomain) => dots[d.id] ?? dotsFromHealthy(d.dnsHealthy);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('mail.domains.search') || 'Search a domain…'} />
        <div className="ml-auto">{createBtn}</div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<AtSign />} text={search ? (t('common.noMatch') || 'No match') : (t('mail.domains.empty') || 'No mail domain yet: enable mail on one of your domains.')} action={!search ? createBtn ?? undefined : undefined} />
      ) : (
        <>
          <GroupedTable<MailDomain>
            storageKey="mail-domains"
            singleGroupFlat
            minWidth={820}
            defaultSort={{ column: 'name' }}
            groups={groupRowsByAccount(filtered, accountDir, (d) => ({ id: d.accountId, username: d.accountUsername }), (rows) => domainTree(rows, (d) => d.name, (d) => d.id))}
            onRowClick={(d) => navigate(`/mail/domains/${d.id}`)}
            renderCard={(d) => (
              <Link to={`/mail/domains/${d.id}`} className="block w-full rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{d.name}</span>
                  <MailDomainStatusBadge status={d.status} message={d.statusMessage} />
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                </div>
                <DnsDots dots={dotsOf(d)} className="mt-1.5" />
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                  <span>{t('mail.domains.counts', { mailboxes: d.mailboxCount, aliases: d.aliasCount, defaultValue: '{{mailboxes}} mailbox(es) · {{aliases}} alias(es)' })}</span>
                  {d.usedBytes != null && <span>{formatBytes(t, d.usedBytes)}</span>}
                  {showTenant && <TenantBadge tenantId={d.tenantId} />}
                </div>
              </Link>
            )}
            columns={[
              {
                id: 'name', header: t('mail.domains.domain') || 'Mail domain', sort: (d) => d.name,
                cell: (d) => (
                  <>
                    <Link to={`/mail/domains/${d.id}`} className="font-mono font-medium text-text-primary hover:text-accent">{d.name}</Link>
                    {!d.dnsManaged && <div className="text-[11px] text-text-muted">{t('mail.domains.externalDns') || 'DNS hosted elsewhere'}</div>}
                  </>
                ),
              },
              { id: 'status', header: t('mail.domains.status') || 'Status', sort: (d) => d.status, cell: (d) => <MailDomainStatusBadge status={d.status} message={d.statusMessage} /> },
              {
                id: 'dns', header: 'DNS', sort: (d) => d.dnsHealthy ?? null,
                cell: (d) => (
                  <>
                    <DnsDots dots={dotsOf(d)} />
                    {d.dnsCheckedAt && <div className="mt-0.5 text-[10px] text-text-muted">{new Date(d.dnsCheckedAt).toLocaleString(i18n.language)}</div>}
                  </>
                ),
              },
              { id: 'mailboxes', header: t('mail.domains.mailboxes') || 'Mailboxes', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (d) => d.mailboxCount, cell: (d) => d.mailboxCount },
              { id: 'aliases', header: t('mail.domains.aliases') || 'Aliases', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (d) => d.aliasCount, cell: (d) => d.aliasCount },
              { id: 'used', header: t('mail.domains.used') || 'Used', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (d) => d.usedBytes ?? null, cell: (d) => formatBytes(t, d.usedBytes) },
            ]}
          />
          {filtered.some((d) => d.status === 'pending') && (
            <p className="flex items-start gap-2 text-xs text-text-muted">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-sky-300" />
              {t('mail.domains.pendingHint') || 'The ownership of this domain is not verified yet: the mail domain stays pending (no mail is received or sent) until the verification succeeds on the Domains page.'}
            </p>
          )}
        </>
      )}

      <MailDomainCreateModal
        open={creating}
        accounts={accountId != null ? accounts.filter((a) => a.id === accountId) : manageable}
        defaultAccountId={accountId}
        onClose={() => setCreating(false)}
        onCreated={(d) => {
          setCreating(false);
          toast.success(t('mail.domains.created', { name: d.name, defaultValue: 'Mail enabled on {{name}}' }));
          navigate(`/mail/domains/${d.id}`);
        }}
      />
    </div>
  );
}
