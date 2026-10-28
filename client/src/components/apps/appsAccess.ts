import type { HostingMe } from '@oblimint/shared';
import { hostingCan, hostingCanOn, useHostingMe, type HostingNeed } from '@/store/hostingStore';
import { useAuthStore } from '@/store/authStore';

/** Needs of the P4b screens (docs/P4b-PLAN.md §12): a subset of the one HostingNeed. */
export type P4bNeed = Extract<HostingNeed, 'read' | 'apps.manage' | 'apps.console' | 'proxy.manage' | 'monitoring.manage'>;

/**
 * P4b screens (apps, network links, uptime, automation): the shared check
 * `hostingCan` (store/hostingStore.ts, mirror of server/src/services/hosting/
 * access.ts — the SERVER stays the authority: this only hides / disables
 * buttons). `can(need, accountId)`: undefined = "on some account", null = a
 * platform object (no account: staff only). Plus who the caller is.
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
    can: (need, accountId) => (accountId === undefined ? hostingCan(me, need) : hostingCanOn(me, need, accountId)),
    isStaff: me?.kind === 'staff',
    isPlatformAdmin,
  };
}
