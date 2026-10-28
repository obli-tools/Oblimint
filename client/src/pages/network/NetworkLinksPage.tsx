import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { NetworkLinksPanel } from '@/components/network/NetworkLinksPanel';
import { NetworkSystemPanel } from '@/components/network/NetworkSystemPanel';

/**
 * /network — declared links between the segments of an account (app → database,
 * app → app, site → app…): only the declared port is open (docs/P4b-PLAN.md §4,
 * §13). Platform admins also see the policy state (/system/network).
 * OWNED BY MODULE `ui-apps`.
 */
export function NetworkLinksPage() {
  const { t } = useTranslation();
  const scope = useAccountScope();
  const { can, isPlatformAdmin } = useP4bAccess();
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const canCreate = scope.accountId != null ? can('apps.manage', scope.accountId) : scope.accounts.some((a) => can('apps.manage', a.id));

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.network') || 'Network links'}</h1>
        <span className="font-mono text-xs tracking-wider text-text-muted">
          {scopeSubtitle(scope, t('apps.scope.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setTick((n) => n + 1)} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && <button type="button" onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('network.add') || 'New link'}</button>}
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('network.description') || 'Containers of an account cannot reach each other by default. A link opens one port from a site or an application to a database instance or an application service of the same account.'}
      </p>

      <AccountScopeBar scope={scope} />

      {isPlatformAdmin && <NetworkSystemPanel key={`sys-${tick}`} accountId={scope.accountId} />}

      <NetworkLinksPanel
        key={`links-${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${tick}`}
        accountId={scope.accountId}
        tenantId={scope.tenantId}
        accounts={scope.accounts}
        showAccount={scope.accountId == null}
        creating={creating}
        onCreatingChange={setCreating}
      />
    </PageContainer>
  );
}
