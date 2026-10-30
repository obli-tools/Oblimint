import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Users,
  UserSquare,
  UserCircle,
  LogOut,
  Server,
  Building2,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Pin,
  PinOff,
  Globe,
  AtSign,
  Database,
  BarChart3,
  Mail,
  FolderOpen,
  Package,
  ScrollText,
  Wrench,
  X,
  // P4b
  Boxes,
  Waypoints,
  Network,
  Activity,
  Workflow,
  ShieldBan,
  ShieldCheck,
  ShieldAlert,
  LineChart,
  ServerCog,
  // P5
  ArrowRightLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { IconButton } from '@/components/common/IconButton';
import { useRememberedAccount } from '@/components/common/AccountScope';
import { hostingCan, useHostingMe, type HostingNeed } from '@/store/hostingStore';
import { useMaintenanceBadge } from './useNavBadges';
import { usePendingActionsStore } from '@/store/pendingActionsStore';

// ── localStorage helpers ─────────────────────────────────────────────────────

function usePersisted<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [key]);
  return [value, set];
}

// ── Nav link ──────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  /** Optional red pill showing a pending-work count next to the label. */
  badgeCount?: number;
  /**
   * Other pages of this entry living outside its path (a prefix such as
   * '/dns', or a pattern for a nested page such as /sites/:id/windows/:wid).
   */
  activePrefixes?: Array<string | RegExp>;
  /** Pages under `path` that belong to another entry. */
  inactivePatterns?: RegExp[];
  /** Link target when it differs from `path` (account scope kept for the session). */
  href?: string;
  /** Family of the entry (coherence plan 1.1): a separator marks each change. */
  family?: NavFamily;
}

/** Families of the Hosting section, in this order (coherence plan 1.1, D16). */
type NavFamily = 'objects' | 'services' | 'network' | 'observation' | 'operations';

/** Is a family separator drawn before items[i]? */
function startsFamily(items: NavItem[], i: number): boolean {
  return i > 0 && items[i].family !== undefined && items[i - 1].family !== undefined && items[i].family !== items[i - 1].family;
}

/** Separator between two families (and, in the rail, before Administration). */
function FamilySeparator({ rail = false }: { rail?: boolean }) {
  return <div aria-hidden className={rail ? 'mx-2 my-2 h-px bg-border' : 'mx-3 my-1.5 h-px bg-border/60'} />;
}

/** Cross-account pages reading `?account=` (coherence plan C1): their link carries the session's account. */
const SCOPED_PATHS = new Set(['/sites', '/domains', '/files', '/databases', '/usage', '/mail', '/apps', '/proxy', '/network', '/traffic', '/uptime', '/automation', '/security/bans']);

/** /sites/:id/windows/:windowId — the window review belongs to Maintenance, not Sites. */
const WINDOW_REVIEW_RE = /^\/sites\/\d+\/windows\/\d+\/?$/;

function isPathActive(pathname: string, path: string): boolean {
  return pathname === path || (path !== '/' && pathname.startsWith(path + '/'));
}

function isItemActive(pathname: string, item: NavItem): boolean {
  if (item.inactivePatterns?.some((re) => re.test(pathname))) return false;
  return isPathActive(pathname, item.path)
    || (item.activePrefixes ?? []).some((p) => (typeof p === 'string' ? isPathActive(pathname, p) : p.test(pathname)));
}

function NavLink({ item }: { item: NavItem }) {
  const location = useLocation();
  const isActive = isItemActive(location.pathname, item);
  return (
    <Link
      to={item.href ?? item.path}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors coarse:py-2.5',
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {item.badgeCount !== undefined && item.badgeCount > 0 && (
        <span className="shrink-0 min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 text-[10px] font-semibold text-center">
          {item.badgeCount > 99 ? '99+' : item.badgeCount}
        </span>
      )}
    </Link>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

interface SidebarProps {
  /**
   * 'drawer' = rendered inside the phone / tablet off-canvas Drawer
   * (AppLayout, < 1024 px): always expanded, a close button instead of the
   * collapse / float toggles. Default: the desktop column.
   */
  variant?: 'default' | 'drawer';
  /** Drawer variant: close the drawer (before opening a modal, etc.). */
  onRequestClose?: () => void;
}

/**
 * Sidebar — ported from Obliance (same classes, modes and localStorage keys:
 * pinned resizable / collapsed 64 px rail / floating / drawer < 1024 px).
 * Oblimint has no device tree: the "Hosting" section takes the flexible
 * height, "Administration" sits below it.
 */
export function Sidebar({ variant = 'default', onRequestClose }: SidebarProps = {}) {
  const { t } = useTranslation();
  const inDrawer = variant === 'drawer';
  const location = useLocation();
  const { user, isAdmin, hasCapability } = useAuthStore();
  const isMaster = useIsMasterTenant();
  const { toggleSidebarFloating, toggleSidebarCollapsed } = useUiStore();
  // Effective (device-aware) mode — see useEffectiveSidebar(). The drawer is
  // always the full, expanded sidebar.
  const effective = useEffectiveSidebar();
  const sidebarCollapsed = !inDrawer && effective.collapsed;
  const sidebarFloating = !inDrawer && effective.floating;
  const canFloat = !inDrawer && effective.canFloat;

  const admin = isAdmin();
  // Client users (users.kind = 'client') get the "espace client": their
  // accounts, sites and domains only (the server scopes every list).
  const isClient = user?.kind === 'client';
  const canPlans = admin || (!isClient && hasCapability('plans.manage'));
  // Settings: every section for the platform admin; tenant staff with 'settings' see the
  // notification channels only (SettingsPage gates each section).
  const canSettings = admin || (!isClient && hasCapability('settings'));

  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);
  const [navMenuOpen, setNavMenuOpen] = usePersisted<boolean>('sidebar:nav-open', true);

  // ── Nav items ──────────────────────────────────────────────────────────────
  const rememberedAccount = useRememberedAccount();
  // Entry hidden without rights (coherence plan 1.1): nothing to manage on any
  // account AND nothing to read there. `read` is « member » for a client (the
  // lists are scoped by the server), so it mostly hides the hosting area from
  // a staff member without any hosting capability, or a client without an
  // account; the file explorer needs files.manage even to read. Until
  // /hosting/me answers nothing is hidden (no menu flash on a slow request).
  const { me: hostingMe } = useHostingMe();
  const may = (need: HostingNeed) => hostingMe === null || hostingCan(hostingMe, need);
  const canRead = may('read');
  const maintenanceBadge = useMaintenanceBadge(canRead && hostingMe !== null);
  // Sensitive actions waiting for me (my confirmations + approvals I may give): staff and clients.
  const approvalsBadge = usePendingActionsStore((s) => s.todo);
  // A client of a single account: « My account » leads straight to it.
  const clientAccounts = hostingMe?.kind === 'client' ? Object.keys(hostingMe.accounts).map(Number) : [];
  const ownAccount = clientAccounts.length === 1 ? clientAccounts[0] : null;

  // Hosting entries by family (coherence plan 1.1, D16): objects, services,
  // network & security, observation, operations.
  const navItems: NavItem[] = ([
    // ── Objects
    { family: 'objects', label: t('nav.dashboard') || 'Dashboard', path: '/', icon: <LayoutDashboard size={18} /> },
    ownAccount != null
      ? { family: 'objects', label: t('nav.myAccount') || 'My account', path: '/accounts', href: `/accounts/${ownAccount}`, icon: <UserSquare size={18} /> }
      : { family: 'objects', label: t('nav.accounts') || 'Accounts', path: '/accounts', icon: <UserSquare size={18} />, hidden: !canRead },
    { family: 'objects', label: t('nav.sites') || 'Sites', path: '/sites', icon: <Globe size={18} />, inactivePatterns: [WINDOW_REVIEW_RE], hidden: !canRead },
    // The zone editor lives under /dns/zones/:id.
    { family: 'objects', label: t('nav.domains') || 'Domains & DNS', path: '/domains', icon: <AtSign size={18} />, activePrefixes: ['/dns'], hidden: !canRead },
    // ── Services
    { family: 'services', label: t('nav.mail') || 'Mail', path: '/mail', icon: <Mail size={18} />, hidden: !canRead },
    { family: 'services', label: t('nav.databases') || 'Databases', path: '/databases', icon: <Database size={18} />, hidden: !canRead },
    // Web file explorer: files.manage on an account (the same right as SFTP), even to read.
    { family: 'services', label: t('nav.files') || 'Files', path: '/files', icon: <FolderOpen size={18} />, hidden: !may('files.manage') },
    { family: 'services', label: t('nav.apps') || 'Applications', path: '/apps', icon: <Boxes size={18} />, hidden: !canRead },
    // ── Network & security
    { family: 'network', label: t('nav.proxy') || 'Proxy', path: '/proxy', icon: <Waypoints size={18} />, hidden: !canRead },
    { family: 'network', label: t('nav.network') || 'Network links', path: '/network', icon: <Network size={18} />, hidden: !canRead },
    { family: 'network', label: t('nav.bans') || 'Bans', path: '/security/bans', icon: <ShieldBan size={18} />, hidden: !canRead },
    // Confirmations / approvals of the protected actions: everyone (the server lists only his own).
    { family: 'network', label: t('nav.approvals') || 'Approvals', path: '/approvals', icon: <ShieldCheck size={18} />, badgeCount: approvalsBadge },
    // ── Observation
    { family: 'observation', label: t('nav.uptime') || 'Uptime', path: '/uptime', icon: <Activity size={18} />, hidden: !canRead },
    { family: 'observation', label: t('nav.traffic') || 'HTTP requests', path: '/traffic', icon: <LineChart size={18} />, hidden: !canRead },
    { family: 'observation', label: t('nav.usage') || 'Usage', path: '/usage', icon: <BarChart3 size={18} />, hidden: !canRead },
    // ── Operations: reviews + quarantine pending in the badge.
    { family: 'operations', label: t('nav.maintenance') || 'Maintenance', path: '/maintenance', icon: <Wrench size={18} />, activePrefixes: [WINDOW_REVIEW_RE], badgeCount: maintenanceBadge, hidden: !canRead },
    { family: 'operations', label: t('nav.automation') || 'Automation', path: '/automation', icon: <Workflow size={18} />, hidden: !canRead },
  ] as Array<NavItem & { hidden?: boolean }>)
    .filter((item) => !item.hidden)
    .map((item) => (rememberedAccount != null && !item.href && SCOPED_PATHS.has(item.path) ? { ...item, href: `${item.path}?account=${rememberedAccount}` } : item));

  // Admin-tier section — hidden entirely when the list is empty.
  const adminNavItems: NavItem[] = [
    ...(admin ? [{ label: t('nav.users') || 'Users', path: '/manage/users', icon: <Users size={18} /> } as NavItem] : []),
    ...(canPlans ? [{ label: t('nav.plans') || 'Plans', path: '/manage/plans', icon: <Package size={18} /> } as NavItem] : []),
    // Workspaces — platform admin on the master tenant only (god view).
    ...(isMaster ? [{ label: t('nav.workspaces') || 'Workspaces', path: '/manage/tenants', icon: <Building2 size={18} /> } as NavItem] : []),
    ...(admin ? [{ label: t('nav.nodes') || 'Nodes', path: '/manage/nodes', icon: <Server size={18} /> } as NavItem] : []),
    // P4b: edge configuration units (quarantine, applies, rollback) — platform admin.
    ...(admin ? [{ label: t('nav.edge') || 'Edge', path: '/manage/edge', icon: <ServerCog size={18} /> } as NavItem] : []),
    // P5: CWP migration (sources, discovery, plans, runs, cutover) — platform admin on the master tenant.
    ...(admin && isMaster ? [{ label: t('nav.migration') || 'CWP migration', path: '/manage/migration', icon: <ArrowRightLeft size={18} /> } as NavItem] : []),
    ...(admin ? [{ label: t('nav.auditLog') || 'Audit log', path: '/manage/audit-log', icon: <ScrollText size={18} /> } as NavItem] : []),
    ...(canSettings ? [{ label: t('nav.settings') || 'Settings', path: '/settings', icon: <Settings size={18} /> } as NavItem] : []),
    // Protected actions matrix: platform admins find it in Users; workspace staff with 'settings' here.
    ...(!admin && canSettings ? [{ label: t('nav.restrictions') || 'Protected actions', path: '/manage/restrictions', icon: <ShieldAlert size={18} /> } as NavItem] : []),
  ];

  const strippedUsername = user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username;
  const displayName = user?.displayName || strippedUsername || '';
  const signOutLabel = t('nav.signOut') || 'Sign out';

  // ── Collapsed mode (Obli Design v1) ─────────────────────────────────
  // 64 px icon-only column. Navigation items keep their tooltips, the user
  // avatar + logout stay visible at the bottom.
  if (sidebarCollapsed) {
    const allItems = [...navItems, ...adminNavItems];
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary">
        <div className="flex h-12 shrink-0 items-center justify-center">
          <button
            onClick={toggleSidebarCollapsed}
            title={t('nav.expandSidebar') || 'Expand sidebar'}
            aria-label={t('nav.expandSidebar') || 'Expand sidebar'}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pt-3 space-y-1">
          {allItems.map((item, i) => {
            const isActive = isItemActive(location.pathname, item);
            return (
              <div key={item.path}>
                {((i === navItems.length && adminNavItems.length > 0) || (i < navItems.length && startsFamily(navItems, i))) && <FamilySeparator rail />}
                <Link
                  to={item.href ?? item.path}
                  title={item.label}
                  aria-label={item.label}
                  className={cn(
                    'relative flex h-10 w-full items-center justify-center rounded-md transition-colors',
                    isActive
                      ? 'bg-accent/12 text-accent'
                      : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {item.icon}
                  {item.badgeCount !== undefined && item.badgeCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[1.1rem] px-1 py-0 rounded-full bg-red-500/20 text-red-400 text-[9px] font-semibold text-center">
                      {item.badgeCount > 99 ? '99+' : item.badgeCount}
                    </span>
                  )}
                </Link>
              </div>
            );
          })}
        </nav>

        <div className="p-2 space-y-1">
          <Link
            to="/profile"
            title={displayName}
            aria-label={t('nav.profile') || 'Profile'}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-md transition-colors',
              location.pathname === '/profile'
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
            ) : (
              <UserCircle size={18} />
            )}
          </Link>
          <button
            onClick={() => useAuthStore.getState().logout()}
            title={signOutLabel}
            aria-label={signOutLabel}
            className="flex h-10 w-full items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col bg-bg-secondary">

      {/* Sidebar head — collapse + float/pin toggles only. The logo and
          tenant selector live in the topbar (Header.tsx) so they remain
          visible when the sidebar is collapsed or floating. */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2 coarse:h-auto">
        {inDrawer ? (
          <IconButton
            label={t('nav.closeMenu') || 'Close menu'}
            icon={<X className="h-4 w-4" />}
            size="md"
            onClick={onRequestClose}
          />
        ) : (
          <div className="flex items-center gap-1">
            {/* Collapse and Float are mutually exclusive. */}
            {!sidebarFloating && (
              <button
                onClick={toggleSidebarCollapsed}
                title={t('nav.collapseSidebar') || 'Collapse sidebar'}
                aria-label={t('nav.collapseSidebar') || 'Collapse sidebar'}
                className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
              >
                <ChevronsLeft size={15} />
              </button>
            )}
            {/* Floating (auto-hide on mouse leave) needs a hovering pointer:
                not offered on touch screens (the effective mode is pinned). */}
            {canFloat && (
              <button
                onClick={toggleSidebarFloating}
                title={sidebarFloating ? (t('nav.pinSidebar') || 'Pin sidebar') : (t('nav.floatSidebar') || 'Float sidebar (auto-hide)')}
                aria-label={sidebarFloating ? (t('nav.pinSidebar') || 'Pin sidebar') : (t('nav.floatSidebar') || 'Float sidebar (auto-hide)')}
                className={cn(
                  'p-1.5 rounded transition-colors',
                  sidebarFloating
                    ? 'text-accent hover:text-accent hover:bg-accent/10'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                )}
              >
                {sidebarFloating ? <PinOff size={15} /> : <Pin size={15} />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Hosting section — collapsible, takes the flexible height. */}
      <div className="flex flex-col flex-1 min-h-0 px-2 pt-1">
        <button
          onClick={() => setNavMenuOpen(v => !v)}
          className="flex w-full items-center gap-2 px-1 py-1.5 text-text-muted hover:text-text-secondary transition-colors shrink-0 coarse:py-2.5"
          aria-expanded={navMenuOpen}
          title={navMenuOpen ? (t('nav.collapseNav') || 'Collapse navigation') : (t('nav.expandNav') || 'Expand navigation')}
        >
          <ChevronDown size={12} className={cn('transition-transform duration-200', !navMenuOpen && '-rotate-90')} />
          <span className="text-[10px] font-bold uppercase tracking-widest">{t('nav.hosting') || 'Hosting'}</span>
          <div className="flex-1 h-px bg-border" />
        </button>
        {navMenuOpen && (
          <nav className="py-1 flex-1 min-h-0 overflow-y-auto">
            {navItems.map((item, i) => (
              <div key={item.path}>
                {startsFamily(navItems, i) && <FamilySeparator />}
                <NavLink item={item} />
              </div>
            ))}
          </nav>
        )}
      </div>

      {/* Administration section — visible if at least one admin item
          resolved to an entry. */}
      {adminNavItems.length > 0 && (
        <>
          <button
            onClick={() => setAdminMenuOpen(v => !v)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-text-muted hover:text-text-secondary transition-colors coarse:py-2.5"
            aria-expanded={adminMenuOpen}
            title={adminMenuOpen ? (t('nav.collapseAdmin') || 'Collapse administration') : (t('nav.expandAdmin') || 'Expand administration')}
          >
            <div className="flex-1 h-px bg-border" />
            <ChevronDown size={12} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
            <span className="text-[10px] font-bold uppercase tracking-widest">{t('nav.administration') || 'Administration'}</span>
            <div className="flex-1 h-px bg-border" />
          </button>

          {adminMenuOpen && (
            <nav className="px-2 pb-1">
              {adminNavItems.map(item => <NavLink key={item.path} item={item} />)}
            </nav>
          )}
        </>
      )}

      {/* User section */}
      <div className="border-t border-border p-2">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors coarse:py-2.5',
            location.pathname === '/profile'
              ? 'bg-bg-active text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-[20px] h-[20px] rounded-full object-cover" />
          ) : (
            <UserCircle size={18} />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {displayName}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {strippedUsername ?? ''} · {user?.role ?? ''}
            </div>
          </div>
        </Link>

        <button
          onClick={() => { useAuthStore.getState().logout(); }}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:py-2.5"
        >
          <LogOut size={18} />
          {signOutLabel}
        </button>
      </div>
    </aside>
  );
}
