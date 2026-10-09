import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Database, Mail, FolderOpen } from 'lucide-react';
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
          <Route path="/databases" element={<ComingSoonPage icon={<Database />} titleKey="nav.databases" titleFallback="Databases" descriptionKey="comingSoon.databases" descriptionFallback="Start MariaDB, MySQL or PostgreSQL instances per account on demand, with their databases and users." />} />
          <Route path="/mail" element={<ComingSoonPage icon={<Mail />} titleKey="nav.mail" titleFallback="Mail" descriptionKey="comingSoon.mail" descriptionFallback="Manage mailboxes, aliases, forwards, quotas and DKIM keys on the mail engine chosen at installation." />} />
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
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          {/* Platform admin on the master tenant (god view) */}
          <Route element={<ProtectedRoute requiredRole="admin" requireMaster />}>
            <Route path="/manage/tenants" element={<TenantsPage />} />
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
