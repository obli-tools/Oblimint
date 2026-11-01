import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import type { DbFamily } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { apiErrorCode } from '@/components/hosting/hostingUi';
import { toastDbError } from './dbFormat';

/** « Open in phpMyAdmin » (MySQL family) / « Open in Adminer » (PostgreSQL). */
export function dbAdminLabel(t: TFunction, family: DbFamily): string {
  return family === 'postgresql' ? (t('databases.admin.openAdminer') || 'Open in Adminer') : (t('databases.admin.openPma') || 'Open in phpMyAdmin');
}

/**
 * Opens the admin UI (single sign-on) of an instance, optionally on one
 * database. Call it straight from the click: the tab is opened synchronously,
 * while the user activation is still valid (after the await, popup blockers
 * would silently drop window.open and the single-use 60 s token be wasted).
 */
export async function openDbAdmin(t: TFunction, instanceId: number, databaseId?: number | null): Promise<void> {
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  try {
    const s = await databasesApi.openAdminSession(instanceId, databaseId ?? null);
    if (w && !w.closed) {
      w.location.href = s.url;
    } else {
      // Popup blocked: offer the link (the user's own click opens it).
      toast((tt) => (
        <span className="text-sm">
          {t('databases.admin.popupBlocked') || 'Your browser blocked the new tab.'}{' '}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline" onClick={() => toast.dismiss(tt.id)}>
            {t('databases.admin.openLink') || 'Open the admin UI'}
          </a>
        </span>
      ), { duration: 30_000 });
    }
  } catch (err) {
    if (w && !w.closed) w.close();
    if (apiErrorCode(err) === 'dbAdminUnavailable') {
      toast.error(t('databases.admin.unavailableHint') || 'The database admin UI is not available: a platform administrator must set its host name (Settings → DB admin) and start it.', { duration: 8000 });
    } else {
      toastDbError(t, err, t('databases.admin.failed') || 'Failed to open the admin UI');
    }
  }
}
