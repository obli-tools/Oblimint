import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

interface ProtectedRouteProps {
  /** Hard role gate — only users with this exact platform role pass. */
  requiredRole?: string;
  /** Capability gate — passes if user is platform admin OR carries ANY
   *  of the listed tenant-wide capabilities. When both `requiredRole` and
   *  `requiredCapabilities` are passed, the role check wins. */
  requiredCapabilities?: string[];
  /** Master-tenant gate (platform admin on tenant 1, the god view). */
  requireMaster?: boolean;
}

export function ProtectedRoute({ requiredRole, requiredCapabilities, requireMaster }: ProtectedRouteProps) {
  const { user, isInitialized, permissions } = useAuthStore();
  const isMaster = useIsMasterTenant();

  if (!isInitialized) {
    return (
      <div className="flex h-dvh supports-[not(height:100dvh)]:h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" replace />;
  }

  if (requireMaster && !isMaster) {
    return <Navigate to="/" replace />;
  }

  // Capability gate — admin always passes. Otherwise the user must
  // carry at least one of the listed caps in `tenantCapabilities`
  // (resolved server-side from the permission set tied to their
  // user_tenants.role for the active tenant).
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    const isAdmin = user.role === 'admin';
    if (!isAdmin) {
      const caps = new Set(permissions?.tenantCapabilities ?? []);
      const ok = requiredCapabilities.some((c) => caps.has(c));
      if (!ok) return <Navigate to="/" replace />;
    }
  }

  return <Outlet />;
}
