import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { ExternalLink, Table2 } from 'lucide-react';
import type { DbAdminSession, DbFamily } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import type { ActionMenuItem } from '@/components/common/ActionMenu';
import { apiErrorCode, isStepUpHandled } from '@/components/hosting/hostingUi';
import { toastDbError } from './dbFormat';

/** « Open phpMyAdmin » (MySQL family) / « Open Adminer » (PostgreSQL). */
export function dbAdminLabel(t: TFunction, family: DbFamily): string {
  return family === 'postgresql' ? (t('databases.admin.openAdminer') || 'Open Adminer') : (t('databases.admin.openPma') || 'Open phpMyAdmin');
}

/** Admin UI of an instance (DbInstanceDetail.adminUi) → its family, for dbAdminLabel. */
export function adminUiFamily(adminUi: 'phpmyadmin' | 'adminer'): DbFamily {
  return adminUi === 'adminer' ? 'postgresql' : 'mysql';
}

/** URL of the integrated explorer on a database. */
export function dbExplorerPath(instanceId: number, databaseId: number): string {
  return `/databases/${instanceId}/explorer/${databaseId}`;
}

/**
 * The tool entries of a database, IDENTICAL on every page that lists
 * databases (instance, databases list, site, account): the integrated
 * explorer FIRST, then phpMyAdmin / Adminer — both shown to whoever holds
 * databases.manage, disabled while the instance is not running; the admin UI
 * hidden when it is not available (host name unset, container stopped).
 */
export function dbToolMenuItems(t: TFunction, o: {
  instanceId: number;
  databaseId: number;
  family: DbFamily;
  manage: boolean;
  running: boolean;
  adminUiAvailable: boolean;
  navigate: (to: string) => void;
  /** Default: openDbAdmin (the instance page passes its own, to show its busy state). */
  onOpenAdmin?: (databaseId: number) => void;
}): ActionMenuItem[] {
  return [
    {
      key: 'explore', icon: <Table2 className="h-4 w-4" />, label: t('dbx.open') || 'Explore (tables, data, SQL)',
      onClick: () => o.navigate(dbExplorerPath(o.instanceId, o.databaseId)), hidden: !o.manage, disabled: !o.running,
    },
    {
      key: 'admin', icon: <ExternalLink className="h-4 w-4" />, label: dbAdminLabel(t, o.family),
      onClick: () => { if (o.onOpenAdmin) o.onOpenAdmin(o.databaseId); else void openDbAdmin(t, o.instanceId, o.databaseId); },
      hidden: !o.manage || !o.adminUiAvailable, disabled: !o.running,
    },
  ];
}

/** The URL in a new tab; blocked by the browser → a toast whose link the user's own click opens. */
function openInNewTab(t: TFunction, url: string): void {
  const w = window.open('', '_blank');
  if (w) {
    w.opener = null;
    w.location.href = url;
    return;
  }
  toast((tt) => (
    <span className="text-sm">
      {t('databases.admin.popupBlocked') || 'Your browser blocked the new tab.'}{' '}
      <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline" onClick={() => toast.dismiss(tt.id)}>
        {t('databases.admin.openLink') || 'Open the admin UI'}
      </a>
    </span>
  ), { duration: 30_000 });
}

/**
 * Opens the admin UI (single sign-on) of an instance, optionally on one
 * database. Call it straight from the click: a blank tab is opened
 * synchronously, while the user activation is still valid (the session takes
 * docker exec / network round trips; after them popup blockers would drop
 * window.open), and receives the URL. The opening is the protectable action
 * db.admin_open: when the API client must first ask a 2FA code or wait for an
 * approval, `onStepUp` closes that tab so the panel's prompt is not hidden
 * behind it, and the URL opens afterwards from the prompt's own click. When
 * the browser blocks the tab anyway, a toast offers the single-use link (60 s).
 */
export async function openDbAdmin(t: TFunction, instanceId: number, databaseId?: number | null): Promise<void> {
  let w: Window | null = window.open('', '_blank');
  if (w) w.opener = null;
  const closeTab = () => {
    if (w && !w.closed) w.close();
    w = null;
  };
  let s: DbAdminSession;
  try {
    s = await databasesApi.openAdminSession(instanceId, databaseId ?? null, { onStepUp: closeTab });
  } catch (err) {
    closeTab();
    // Cancelled prompt, request filed for approval, gate refusal: already told by the API client.
    if (isStepUpHandled(err)) return;
    if (apiErrorCode(err) === 'dbAdminUnavailable') {
      toast.error(t('databases.admin.unavailableHint') || 'The database admin UI is not available: a platform administrator must set its host name (Settings → DB admin) and start it.', { duration: 8000 });
    } else {
      toastDbError(t, err, t('databases.admin.failed') || 'Failed to open the admin UI');
    }
    return;
  }
  const tab = w as Window | null;
  if (tab && !tab.closed) tab.location.href = s.url;
  else openInNewTab(t, s.url);
}
