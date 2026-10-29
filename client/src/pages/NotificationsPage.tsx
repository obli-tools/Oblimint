import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import type { NotificationFamily, UserNotification } from '@oblimint/shared';
import { NOTIFICATION_FAMILIES } from '@oblimint/shared';
import { inboxApi } from '@/api/inbox.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { settingsInputCls } from '@/components/settings/SettingsBlock';
import { NotificationPrefsSection } from '@/components/notifications/NotificationPrefsSection';
import { NotificationRow, familyLabel } from '@/components/notifications/inboxUi';
import { useInboxStore } from '@/store/inboxStore';
import { cn } from '@/utils/cn';

const PAGE = 30;

/**
 * Full notification center of the signed-in user (current workspace): every
 * notification kept (90 days), unread / all, per family, load more; then the
 * preferences (in-app / e-mail per family). Live: the bell's store version
 * triggers a refetch of the first page.
 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [family, setFamily] = useState<NotificationFamily | ''>('');
  const [items, setItems] = useState<UserNotification[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [unread, setUnread] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const version = useInboxStore((s) => s.version);
  const refreshBell = useInboxStore((s) => s.refresh);

  const load = useCallback(async () => {
    try {
      const page = await inboxApi.list({ unread: tab === 'unread', family: family || null, limit: PAGE });
      setItems(page.items);
      setHasMore(page.hasMore);
      setUnread(page.unreadCount);
    } catch {
      setItems([]);
      toast.error(t('inbox.loadFailed') || 'Failed to load the notifications');
    }
  }, [tab, family, t]);
  useEffect(() => { void load(); }, [load, version]);

  useEffect(() => {
    if (location.hash === '#preferences') {
      window.setTimeout(() => document.getElementById('preferences')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }
  }, [location.hash]);

  const more = async () => {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const page = await inboxApi.list({ unread: tab === 'unread', family: family || null, limit: PAGE, before: items[items.length - 1].id });
      setItems([...items, ...page.items.filter((n) => !items.some((x) => x.id === n.id))]);
      setHasMore(page.hasMore);
    } catch {
      toast.error(t('inbox.loadFailed') || 'Failed to load the notifications');
    } finally {
      setLoadingMore(false);
    }
  };

  const after = async (p: Promise<unknown>) => {
    try { await p; } catch { toast.error(t('inbox.actionFailed') || 'The action failed'); }
    await refreshBell();
  };
  const read = (n: UserNotification) => after(inboxApi.markRead([n.id]));
  const remove = (n: UserNotification) => {
    setItems((cur) => (cur ?? []).filter((x) => x.id !== n.id));
    void after(inboxApi.remove([n.id]));
  };
  const open = (n: UserNotification) => {
    if (!n.readAt) void read(n);
    if (n.link) navigate(n.link);
  };

  return (
    <PageContainer className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bell className="h-6 w-6 text-accent" />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('notifications.title') || 'Notifications'}</h1>
            <p className="text-xs font-mono tracking-wider text-text-muted">
              {t('inbox.subtitle') || 'What happened on your sites, domains and accounts. Kept 90 days.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && (
            <Button size="sm" variant="secondary" onClick={() => { void after(inboxApi.markAllRead()); }}>
              <CheckCheck size={14} className="mr-1.5" />{t('notificationCenter.markAllRead') || 'Mark all as read'}
            </Button>
          )}
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} variant="plain" onClick={() => { void load(); }} />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedTabs
            fill={false}
            size="sm"
            value={tab}
            onChange={setTab}
            ariaLabel={t('notifications.title') || 'Notifications'}
            tabs={[
              { id: 'all', label: t('inbox.all') || 'All' },
              { id: 'unread', label: t('inbox.unread') || 'Unread', badge: unread > 0 ? <span className="ml-1 opacity-80">({unread})</span> : undefined },
            ]}
          />
          <select
            value={family}
            onChange={(e) => setFamily(e.target.value as NotificationFamily | '')}
            aria-label={t('inbox.eventFamily') || 'Events'}
            className={cn(settingsInputCls, 'w-auto max-w-full bg-bg-secondary')}
          >
            <option value="">{t('inbox.allFamilies') || 'All events'}</option>
            {NOTIFICATION_FAMILIES.map((f) => <option key={f} value={f}>{familyLabel(t, f)}</option>)}
          </select>
        </div>

        {items === null ? (
          <div className="flex justify-center py-10"><LoadingSpinner /></div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            text={tab === 'unread' ? (t('inbox.emptyUnread') || 'Nothing unread.') : (t('notificationCenter.empty') || 'No notifications')}
          />
        ) : (
          <div className="overflow-hidden rounded-xl bg-bg-secondary">
            <div className="divide-y divide-border/50">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} showEvent onOpen={open} onRead={(x) => { void read(x); }} onRemove={remove} />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center p-3">
                <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => { void more(); }}>{t('inbox.loadMore') || 'Load more'}</Button>
              </div>
            )}
          </div>
        )}
      </div>

      <NotificationPrefsSection />
    </PageContainer>
  );
}
