import type { TFunction } from 'i18next';
import type { NotificationChannelType, NotificationEvent } from '@oblimint/shared';

export function channelTypeLabel(t: TFunction, type: NotificationChannelType): string {
  const fallback: Record<NotificationChannelType, string> = { smtp: 'E-mail (SMTP)', webhook: 'Webhook', discord: 'Discord', telegram: 'Telegram' };
  return t(`notifications.type.${type}`) || fallback[type];
}

/** i18n key of an event ('quota.warning' → 'quotaWarning'). */
function eventKey(e: NotificationEvent): string {
  return e.replace(/\.(\w)/, (_, c: string) => c.toUpperCase());
}

export function eventLabel(t: TFunction, e: NotificationEvent): string {
  const fallback: Record<NotificationEvent, string> = {
    'quota.warning': 'Quota threshold reached (80 %)',
    'quota.exceeded': 'Quota exceeded (100 %)',
    'quota.action': 'Uploads blocked / account suspended',
    'certificate.failed': 'Certificate failure',
    'dns.syncFailed': 'DNS synchronisation failure',
    'db.instanceFailed': 'Database instance failure',
    'cron.failed': 'Cron job failing',
    'security.banned': 'Address banned',
  };
  return t(`notifications.event.${eventKey(e)}`) || fallback[e];
}
