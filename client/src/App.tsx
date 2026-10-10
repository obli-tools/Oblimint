import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { SetupMode } from '@oblimint/shared';
import { useNativeTopOffset } from '@/hooks/useNativeTopOffset';
import { useAuthStore } from '@/store/authStore';
import { setupApi } from '@/api/setup.api';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { TenantsPage } from '@/pages/TenantsPage';
import { NodesPage } from '@/pages/NodesPage';
import { AuditLogPage } from '@/pages/AuditLogPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ComingSoonPage } from '@/pages/ComingSoonPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SetupWizardPage } from '@/pages/SetupWizardPage';
// P1 — hosting core (docs/P1-PLAN.md §UI)
import { AccountsPage } from '@/pages/hosting/AccountsPage';
import { AccountDetailPage } from '@/pages/hosting/AccountDetailPage';
import { PlansPage } from '@/pages/hosting/PlansPage';
import { DomainsPage } from '@/pages/hosting/DomainsPage';
import { SitesPage } from '@/pages/sites/SitesPage';
import { SiteDetailPage } from '@/pages/sites/SiteDetailPage';
// P2 — hosting complete (docs/P2-PLAN.md §8)
import { DatabasesPage } from '@/pages/databases/DatabasesPage';     // ui-dns-db
import { DbInstancePage } from '@/pages/databases/DbInstancePage';   // ui-dns-db
import { DnsZonePage } from '@/pages/dns/DnsZonePage';               // ui-dns-db
import { UsagePage } from '@/pages/usage/UsagePage';                 // ui-ops
// P3 — updates and modification windows (docs/P3-PLAN.md §13)
import { MaintenancePage } from '@/pages/maintenance/MaintenancePage';     // ui-maintenance
import { WindowReviewPage } from '@/pages/maintenance/WindowReviewPage';   // ui-maintenance
// P4 — mail (docs/P4-PLAN.md §13)
import { MailPage } from '@/pages/mail/MailPage';                  // ui-mail
import { MailDomainPage } from '@/pages/mail/MailDomainPage';      // ui-mail
import { MailboxPage } from '@/pages/mail/MailboxPage';            // ui-mail
// P4b — apps + proxy (docs/P4b-PLAN.md §13)
import { AppsPage } from '@/pages/apps/AppsPage';                          // ui-apps
import { AppCreatePage } from '@/pages/apps/AppCreatePage';                // ui-apps
import { AppDetailPage } from '@/pages/apps/AppDetailPage';                // ui-apps
import { AppEditorPage } from '@/pages/apps/AppEditorPage';                // ui-apps
import { NetworkLinksPage } from '@/pages/network/NetworkLinksPage';       // ui-apps
import { UptimePage } from '@/pages/uptime/UptimePage';                    // ui-apps
import { UptimeMonitorPage } from '@/pages/uptime/UptimeMonitorPage';      // ui-apps
import { AutomationPage } from '@/pages/automation/AutomationPage';        // ui-apps
import { WorkflowPage } from '@/pages/automation/WorkflowPage';            // ui-apps
import { StatusPublicPage } from '@/pages/public/StatusPublicPage';        // ui-apps (public)
import { ProxyPage } from '@/pages/proxy/ProxyPage';                       // ui-proxy
import { ProxyHostEditorPage } from '@/pages/proxy/ProxyHostEditorPage';   // ui-proxy
import { BansPage } from '@/pages/security/BansPage';                      // ui-proxy
import { TrafficPage } from '@/pages/traffic/TrafficPage';                 // ui-proxy
import { EdgeUnitsPage } from '@/pages/edge/EdgeUnitsPage';                // ui-proxy
// P5 — CWP migration (docs/P5-PLAN.md §11)
import { MigrationPage } from '@/pages/migration/MigrationPage';                   // ui-migration
import { MigrationDiscoveryPage } from '@/pages/migration/MigrationDiscoveryPage'; // ui-migration
import { MigrationPlanPage } from '@/pages/migration/MigrationPlanPage';           // ui-migration
import { MigrationRunPage } from '@/pages/migration/MigrationRunPage';             // ui-migration
import { TwoFactorGate } from '@/components/common/TwoFactorGate';
import { ConfirmProvider } from '@/components/common/ConfirmDialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import '@/i18n';

/** Routes of the normal (configured) mode. */
function NormalRoutes() {
  const { checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      {/* P4b: public status pages (no session) */}
      <Route path="/status/:slug" element={<StatusPublicPage />} />
      {/* The wizard is gone once the server runs in normal mode. */}
      <Route path="/setup" element={<Navigate to="/login" replace />} />

      {/* Protected */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          {/* Hosting */}
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/sites/:id" element={<SiteDetailPage />} />
          <Route path="/domains" element={<DomainsPage />} />
          {/* P2: Domains & DNS (zone editor under /dns/zones/:id), databases, usage */}
          <Route path="/dns/zones/:id" element={<DnsZonePage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/databases/:id" element={<DbInstancePage />} />
          <Route path="/usage" element={<UsagePage />} />
          {/* P3: maintenance overview (reviews, windows, updates, quarantine) + window review */}
          <Route path="/maintenance" element={<MaintenancePage />} />
          <Route path="/sites/:id/windows/:windowId" element={<WindowReviewPage />} />
          {/* P4: mail (tabs ?tab=domains|mailboxes|aliases|outbound|logs), mail domain, mailbox — client space too (server scopes) */}
          <Route path="/mail" element={<MailPage />} />
          <Route path="/mail/domains/:id" element={<MailDomainPage />} />
          <Route path="/mail/mailboxes/:id" element={<MailboxPage />} />
          {/* P4b: apps, network links, proxy, bans, traffic, uptime, automation — client space too (server scopes) */}
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/new" element={<AppCreatePage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/apps/:id/edit" element={<AppEditorPage />} />
          <Route path="/network" element={<NetworkLinksPage />} />
          <Route path="/proxy" element={<ProxyPage />} />
          <Route path="/proxy/hosts/new" element={<ProxyHostEditorPage />} />
          <Route path="/proxy/hosts/:id" element={<ProxyHostEditorPage />} />
          <Route path="/security/bans" element={<BansPage />} />
          <Route path="/traffic" element={<TrafficPage />} />
          <Route path="/traffic/:hostId" element={<TrafficPage />} />
          <Route path="/uptime" element={<UptimePage />} />
          <Route path="/uptime/monitors/:id" element={<UptimeMonitorPage />} />
          <Route path="/automation" element={<AutomationPage />} />
          <Route path="/automation/workflows/:id" element={<WorkflowPage />} />
          <Route path="/files" element={<ComingSoonPage icon={<FolderOpen />} titleKey="nav.files" titleFallback="Files" descriptionKey="comingSoon.files" descriptionFallback="Browse and edit the files of an account, and open an SFTP/FTPS server on demand for it." />} />

          {/* Plans: platform admin or the plans.manage capability of the tenant */}
          <Route element={<ProtectedRoute requiredCapabilities={['plans.manage']} />}>
            <Route path="/manage/plans" element={<PlansPage />} />
          </Route>

          {/* User */}
          <Route path="/profile" element={<ProfilePage />} />

          {/* Admin-only */}
          <Route element={<ProtectedRoute requiredRole="admin" />}>
            <Route path="/manage/users" element={<AdminUsersPage />} />
            <Route path="/manage/nodes" element={<NodesPage />} />
            <Route path="/manage/audit-log" element={<AuditLogPage />} />
            {/* P4b: edge configuration units (platform admin) */}
            <Route path="/manage/edge" element={<EdgeUnitsPage />} />
          </Route>

          {/* Settings: platform admin (every section), or tenant staff with the 'settings'
              capability (notification channels only; SettingsPage gates each section). */}
          <Route element={<ProtectedRoute requiredCapabilities={['settings']} />}>
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          {/* Platform admin on the master tenant (god view) */}
          <Route element={<ProtectedRoute requiredRole="admin" requireMaster />}>
            <Route path="/manage/tenants" element={<TenantsPage />} />
            {/* P5: CWP migration (tabs ?tab=sources|discoveries|plans|runs|commands), discovery tree, plan editor + cutover, run monitor */}
            <Route path="/manage/migration" element={<MigrationPage />} />
            <Route path="/manage/migration/discoveries/:id" element={<MigrationDiscoveryPage />} />
            <Route path="/manage/migration/plans/:id" element={<MigrationPlanPage />} />
            <Route path="/manage/migration/runs/:id" element={<MigrationRunPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** Routes of the first-run setup mode: everything leads to the wizard. */
function SetupRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupWizardPage />} />
      <Route path="*" element={<Navigate to="/setup" replace />} />
    </Routes>
  );
}

export default function App() {
  const { t } = useTranslation();
  const nativeTop = useNativeTopOffset();
  // Boot: ask the server which mode it runs in BEFORE rendering any route.
  // A failure (server down, older server) falls back to the normal mode.
  const [mode, setMode] = useState<SetupMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setupApi.status()
      .then((m) => { if (!cancelled) setMode(m); })
      .catch(() => { if (!cancelled) setMode('normal'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <BrowserRouter>
      {mode === null ? (
        <div
          className="flex h-dvh supports-[not(height:100dvh)]:h-screen items-center justify-center bg-bg-primary"
          aria-label={t('common.loading') || 'Loading...'}
        >
          <LoadingSpinner size="lg" />
        </div>
      ) : mode === 'setup' ? (
        <SetupRoutes />
      ) : (
        <NormalRoutes />
      )}

      <Toaster
        position="top-right"
        // Safe-area offsets (status bar / notch / gesture bar). The insets are
        // 0 on desktop, so these resolve to react-hot-toast's own 16 px defaults.
        containerStyle={{
          top: `calc(${nativeTop ? nativeTop + 8 : 16}px + var(--safe-top))`,
          right: 'calc(16px + var(--safe-right))',
          bottom: 'calc(16px + var(--safe-bottom))',
          left: 'calc(16px + var(--safe-left))',
        }}
        toastOptions={{
          className: '!bg-bg-secondary !text-text-primary !border !border-transparent',
          duration: 4000,
        }}
      />

      {/* Singleton modal that pops whenever the server replies
          401 twoFactorRequired — no need to wire anything at call sites. */}
      <TwoFactorGate />
      {/* Host for useConfirm() / usePrompt() / confirmDialog() / promptDialog(). */}
      <ConfirmProvider />
    </BrowserRouter>
  );
}
