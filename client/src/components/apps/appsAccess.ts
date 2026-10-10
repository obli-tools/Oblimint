import type { HostingMe } from '@oblimint/shared';
import { useHostingMe } from '@/store/hostingStore';
import { useAuthStore } from '@/store/authStore';
import { p4bCan, type P4bNeed } from './appsFormat';

export { p4bCan, type P4bNeed };

/**
 * Needs of the P4b screens (docs/P4b-PLAN.md §12), mirroring
 * server/src/services/hosting/access.ts — the SERVER stays the authority: this
 * only hides / disables buttons. The shared hosting store does not know the
 * P4b needs, hence this module-local twin of `hostingCan` (pure part:
 * p4bCan in appsFormat.ts). Hook: `can(need, accountId)` + who the caller is.
 */
export function useP4bAccess(): {
  me: HostingMe | null;
  can: (need: P4bNeed, accountId?: number | null) => boolean;
  isStaff: boolean;
  isPlatformAdmin: boolean;
} {
  const { me } = useHostingMe();
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  return {
    me,
    can: (need, accountId) => p4bCan(me, need, accountId),
    isStaff: me?.kind === 'staff',
    isPlatformAdmin,
  };
}
