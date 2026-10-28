import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Ban, KeyRound, ShieldCheck, Users } from 'lucide-react';
import type { HostingAccount } from '@oblimint/shared';
import { useHostingMe } from '@/store/hostingStore';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountSecurityTab } from '@/components/security/AccountSecurityTab';
import type { AccountAccessSection } from '@/utils/links';
import { AccountApiKeysTab } from './AccountApiKeysTab';
import { AccountUsersTab } from './AccountUsersTab';

/**
 * « Access & security » tab of the account page (coherence plan 1.2): who
 * may act on the account — its users (staff, accounts.manage), the access
 * keys and Claude connectors (sites.manage), the firewall of its SFTP / SQL
 * ports and their bans (files.manage to edit). `&section=users|keys|firewall`;
 * the old tabs ?tab=users|keys|security land here (utils/links.ts aliases).
 */
export function AccountAccessTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  const [params, setParams] = useSearchParams();
  const canUsers = me?.kind === 'staff' && can('accounts.manage', account.id);
  const canKeys = can('sites.manage', account.id);

  const sections: SegmentedTab<AccountAccessSection>[] = [
    { id: 'users', label: t('accounts.tabs.users') || 'Users', icon: <Users size={14} />, hidden: !canUsers },
    { id: 'keys', label: t('apiKeys.tab') || 'Access keys', icon: <KeyRound size={14} />, hidden: !canKeys },
    { id: 'firewall', label: t('objectPage.account.firewall') || 'SFTP / SQL firewall', icon: <ShieldCheck size={14} /> },
  ];
  const visible = sections.filter((s) => !s.hidden).map((s) => s.id);
  const raw = params.get('section') as AccountAccessSection | null;
  const section: AccountAccessSection = raw && visible.includes(raw) ? raw : visible[0];
  const setSection = (next: AccountAccessSection) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('section', next);
    p.delete('new');
    p.delete('site');
    return p;
  }, { replace: true });

  // Deep link ?section=keys&new=1[&site=<id>]: the new-key form opens with the site ticked.
  const presetSite = Number(params.get('site'));
  const openNew = section === 'keys' && params.get('new') === '1';
  // Once the form is closed, the deep link goes (a reload must not reopen it).
  const clearNew = () => {
    if (!params.has('new') && !params.has('site')) return;
    setParams((prev) => { const p = new URLSearchParams(prev); p.delete('new'); p.delete('site'); return p; }, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      {visible.length > 1 && (
        <SegmentedTabs<AccountAccessSection>
          tabs={sections}
          value={section}
          onChange={setSection}
          size="sm"
          fill={false}
          className="self-start"
          ariaLabel={t('objectPage.account.access') || 'Access & security'}
        />
      )}
      {section === 'users' && canUsers && <AccountUsersTab accountId={account.id} tenantId={account.tenantId} />}
      {section === 'keys' && canKeys && (
        <AccountApiKeysTab
          accountId={account.id}
          openNew={openNew}
          onNewClosed={clearNew}
          presetSiteIds={Number.isInteger(presetSite) && presetSite > 0 ? [presetSite] : undefined}
        />
      )}
      {section === 'firewall' && (
        <>
          <AccountSecurityTab accountId={account.id} />
          <Link to={`/security/bans?account=${account.id}`} className="inline-flex items-center gap-1.5 self-start text-xs text-accent hover:underline">
            <Ban size={13} />{t('objectPage.account.webBans') || 'Web bans (edge) of this account'}
          </Link>
        </>
      )}
    </div>
  );
}
