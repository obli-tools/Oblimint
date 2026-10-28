import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, KeyRound, Plus, RefreshCw, Server, Workflow as WorkflowIcon } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { WorkflowsPanel } from '@/components/automation/WorkflowsPanel';
import { SshKeysPanel } from '@/components/automation/SshKeysPanel';
import { SftpTargetsPanel } from '@/components/automation/SftpTargetsPanel';
import { MaintenanceWindowsPanel } from '@/components/automation/MaintenanceWindowsPanel';

type Tab = 'workflows' | 'ssh-keys' | 'sftp-targets' | 'maintenance-windows';
const TABS: readonly Tab[] = ['workflows', 'ssh-keys', 'sftp-targets', 'maintenance-windows'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /automation — workflows (certificate export by SFTP, app restart), SSH keys,
 * SFTP targets and maintenance windows of the automatic updates, tabs
 * `?tab=workflows|ssh-keys|sftp-targets|maintenance-windows` (docs/P4b-PLAN.md §11).
 * OWNED BY MODULE `ui-apps`.
 */
export function AutomationPage() {
  const { t } = useTranslation();
  const scope = useAccountScope();
  const { can, isStaff } = useP4bAccess();
  const tabParam = scope.params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'workflows';
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const setTab = (next: Tab) => { setCreating(false); scope.update({ tab: next === 'workflows' ? null : next }); };
  const canCreate = scope.accountId != null
    ? can('monitoring.manage', scope.accountId)
    : (isStaff && can('monitoring.manage')) || scope.accounts.some((a) => can('monitoring.manage', a.id));

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'workflows', label: t('automation.tabs.workflows') || 'Workflows', icon: <WorkflowIcon size={16} /> },
    { id: 'ssh-keys', label: t('automation.tabs.sshKeys') || 'SSH keys', icon: <KeyRound size={16} /> },
    { id: 'sftp-targets', label: t('automation.tabs.sftpTargets') || 'SFTP targets', icon: <Server size={16} /> },
    { id: 'maintenance-windows', label: t('automation.tabs.windows') || 'Maintenance windows', icon: <CalendarClock size={16} /> },
  ];
  const addLabel = {
    workflows: t('automation.add') || 'New workflow',
    'ssh-keys': t('automation.keys.add') || 'New SSH key',
    'sftp-targets': t('automation.sftp.add') || 'New SFTP target',
    'maintenance-windows': t('automation.windows.add') || 'New window',
  }[tab];
  const panelKey = `${tab}-${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${tick}`;
  const props = {
    accountId: scope.accountId, tenantId: scope.tenantId, accounts: scope.accounts, showAccount: scope.accountId == null,
    creating, onCreatingChange: setCreating,
  };

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.automation') || 'Automation'}</h1>
        <span className="font-mono text-xs tracking-wider text-text-muted">
          {scopeSubtitle(scope, t('apps.scope.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setTick((n) => n + 1)} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && <button type="button" onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{addLabel}</button>}
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('automation.description') || 'Automatic tasks of the accounts: export the certificates by SFTP when they are renewed, restart applications on a schedule, and the windows of the automatic updates.'}</p>
      <AccountScopeBar scope={scope} />
      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('nav.automation') || 'Automation'} fill={false} />
      {tab === 'workflows' && <WorkflowsPanel key={panelKey} {...props} />}
      {tab === 'ssh-keys' && <SshKeysPanel key={panelKey} {...props} />}
      {tab === 'sftp-targets' && <SftpTargetsPanel key={panelKey} {...props} />}
      {tab === 'maintenance-windows' && <MaintenanceWindowsPanel key={panelKey} {...props} />}
    </PageContainer>
  );
}
