import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type { NotificationFamily, UserNotification, UserNotificationSeverity } from '@oblimint/shared';
import { cn } from '@/utils/cn';
import { eventLabel } from './notificationsUi';

/** Severity look of a notification row (Obliance NotificationCenter). */
export const SEVERITY_STYLES: Record<UserNotificationSeverity, { bar: string; dot: string; title: string }> = {
  info: { bar: 'border-l-blue-500', dot: 'bg-blue-500', title: 'text-text-primary' },
  warning: { bar: 'border-l-amber-500', dot: 'bg-amber-500', title: 'text-amber-400' },
  critical: { bar: 'border-l-red-600', dot: 'bg-red-600', title: 'text-red-500' },
};

/** Invisible 40×40 tap area on touch screens (layout unchanged). */
export const TOUCH_HIT =
  "relative coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:h-10 coarse:after:w-10 coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']";

export function timeAgo(iso: string, t: TFunction): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return t('notificationCenter.agoSeconds', { count: diff, defaultValue: '{{count}}s ago' });
  if (diff < 3600) return t('notificationCenter.agoMinutes', { count: Math.floor(diff / 60), defaultValue: '{{count}}m ago' });
  if (diff < 86400) return t('notificationCenter.agoHours', { count: Math.floor(diff / 3600), defaultValue: '{{count}}h ago' });
  return t('notificationCenter.agoDays', { count: Math.floor(diff / 86400), defaultValue: '{{count}}d ago' });
}

export function familyLabel(t: TFunction, f: NotificationFamily): string {
  const fallback: Record<NotificationFamily, string> = {
    releases: 'Releases and changes',
    certificates: 'Certificates',
    domains: 'Domains and DNS',
    quota: 'Quotas',
    mail: 'Mail',
    apps: 'Applications and databases',
    monitoring: 'Monitoring and cron jobs',
    security: 'Security',
    platform: 'Platform',
    account: 'My account',
  };
  return t(`inbox.family.${f}`) || fallback[f];
}

export function familyHint(t: TFunction, f: NotificationFamily): string {
  const fallback: Record<NotificationFamily, string> = {
    releases: 'Releases awaiting approval, approved or rejected, windows to review, scanner findings, CMS updates.',
    certificates: 'Certificates issued, failing or expiring soon.',
    domains: 'Domain ownership verified or taken back, DNS synchronisation failures.',
    quota: 'Quota thresholds reached, uploads blocked, account suspended.',
    mail: 'Mailboxes almost full, outbound mail suspended, mail service failures.',
    apps: 'Application deployments and updates, database instances.',
    monitoring: 'Monitors down / recovered, failing cron jobs and workflows.',
    security: 'Banned addresses, refused or rolled back proxy configurations.',
    platform: 'Platform updates.',
    account: 'Sign-ins with a recovery code, password reset, e-mail address changed. Always shown.',
  };
  return t(`inbox.familyHint.${f}`) || fallback[f];
}

/** One notification (bell dropdown and full page share it). */
export function NotificationRow({ n, onOpen, onRead, onRemove, showEvent = false, className }: {
  n: UserNotification;
  onOpen: (n: UserNotification) => void;
  onRead?: (n: UserNotification) => void;
  onRemove: (n: UserNotification) => void;
  showEvent?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const styles = SEVERITY_STYLES[n.severity] ?? SEVERITY_STYLES.info;
  return (
    <div
      role={n.link ? 'link' : undefined}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n); }}
      className={cn(
        'group relative flex items-start gap-3 border-l-4 px-4 py-3 transition-colors',
        styles.bar,
        n.readAt ? 'opacity-50' : 'opacity-100',
        'cursor-pointer hover:bg-bg-hover',
        className,
      )}
      onClick={() => onOpen(n)}
    >
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn('truncate text-sm font-semibold', styles.title)}>{n.title}</p>
          {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </div>
        <p className={cn('mt-0.5 text-xs text-text-muted', showEvent ? 'whitespace-pre-line break-words' : 'truncate')}>{n.message}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <p className="text-xs text-text-muted/60" title={new Date(n.createdAt).toLocaleString(i18n.language)}>{timeAgo(n.createdAt, t)}</p>
          {showEvent && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-muted">{eventLabel(t, n.event)}</span>
          )}
        </div>
      </div>
      {onRead && !n.readAt && (
        <button
          className={cn('mt-0.5 shrink-0 text-text-muted transition-colors hover:text-accent', TOUCH_HIT)}
          onClick={(e) => { e.stopPropagation(); onRead(n); }}
          title={t('notificationCenter.markRead') || 'Mark as read'}
          aria-label={t('notificationCenter.markRead') || 'Mark as read'}
        >
          <Check size={12} />
        </button>
      )}
      <button
        className={cn('mt-0.5 shrink-0 text-text-muted transition-colors hover:text-text-primary', TOUCH_HIT)}
        onClick={(e) => { e.stopPropagation(); onRemove(n); }}
        title={t('notificationCenter.dismiss') || 'Dismiss'}
        aria-label={t('notificationCenter.dismiss') || 'Dismiss'}
      >
        <X size={12} />
      </button>
    </div>
  );
}
