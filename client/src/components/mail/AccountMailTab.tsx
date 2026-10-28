import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AtSign, ExternalLink, Forward, Mail, Send } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MailOverview, type MailUpdatedPayload } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useHostingEvents } from '@/components/hosting/hostingUi';
import { MailDomainsPanel } from './MailDomainsPanel';
import { MailboxesPanel } from './MailboxesPanel';
import { MailAliasesPanel } from './MailAliasesPanel';
import { MailOutboundPanel } from './MailOutboundPanel';
import { MailStatusBanner } from './MailStatusBanner';
import { mailLoadError } from './mailErrors';
import { engineHasMailboxes } from './mailFormat';

type Sub = 'domains' | 'mailboxes' | 'aliases' | 'outbound';
const SUBS: readonly Sub[] = ['domains', 'mailboxes', 'aliases', 'outbound'];

/**
 * Mail tab of the account page (coherence plan 1.2 / D4): the same panels as
 * /mail, with the account fixed, in sub-tabs (`&sub=`). The logs and the
 * cross-account views stay on /mail?account=<id>.
 */
export function AccountMailTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('sub');
  const sub: Sub = raw && (SUBS as readonly string[]).includes(raw) ? (raw as Sub) : 'domains';
  const setSub = (next: Sub) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (next === 'domains') p.delete('sub'); else p.set('sub', next);
    return p;
  }, { replace: true });

  const [overview, setOverview] = useState<MailOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const o = await mailApi.overview(account.id);
      if (n !== seq.current) return;
      setOverview(o);
      setOverviewError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setOverview(null);
      setOverviewError(mailLoadError(t, err, t('mail.overviewFailed') || 'Failed to load the mail state'));
    }
  }, [account.id, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    return !!payload && (payload.entity === 'engine' || payload.accountId === account.id);
  }, 1500);

  const mailboxesAllowed = overview ? engineHasMailboxes(overview.engine) : true;
  const counts = overview?.counts;
  const badge = (n: number | undefined) => (n ? <span className="font-mono text-[10px] opacity-70">{n}</span> : null);
  const tabs: SegmentedTab<Sub>[] = [
    { id: 'domains', label: t('mail.tabs.domains') || 'Domains', icon: <AtSign size={14} />, badge: badge(counts?.domains) },
    { id: 'mailboxes', label: t('mail.tabs.mailboxes') || 'Mailboxes', icon: <Mail size={14} />, badge: badge(counts?.mailboxes), hidden: !mailboxesAllowed },
    { id: 'aliases', label: t('mail.tabs.aliases') || 'Aliases', icon: <Forward size={14} />, badge: badge(counts?.aliases), hidden: !mailboxesAllowed },
    { id: 'outbound', label: t('mail.tabs.outbound') || 'Outbound', icon: <Send size={14} /> },
  ];
  const shown: Sub = !mailboxesAllowed && (sub === 'mailboxes' || sub === 'aliases') ? 'domains' : sub;

  return (
    <div className="flex flex-col gap-4">
      <MailStatusBanner overview={overview} error={overviewError} />
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs<Sub> tabs={tabs} value={shown} onChange={setSub} size="sm" fill={false} className="self-start" ariaLabel={t('nav.mail') || 'Mail'} />
        <Link to={`/mail?account=${account.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">
          <ExternalLink size={12} />{t('objectPage.account.mailAdvanced') || 'Logs and every account: Mail page'}
        </Link>
      </div>
      {shown === 'domains' && <MailDomainsPanel accountId={account.id} tenantId={account.tenantId} accounts={[account]} showTenant={false} />}
      {shown === 'mailboxes' && <MailboxesPanel accountId={account.id} tenantId={account.tenantId} showAccount={false} webmailAvailable={overview?.webmail.kind !== 'none'} />}
      {shown === 'aliases' && <MailAliasesPanel accountId={account.id} tenantId={account.tenantId} />}
      {shown === 'outbound' && <MailOutboundPanel accountId={account.id} />}
    </div>
  );
}
