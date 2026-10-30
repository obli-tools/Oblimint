import { useCallback, useEffect, useRef, useState } from 'react';
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
 * triggers a merge of the first page (sync), never a reset of what is loaded.
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

  // Answers of an older filter (tab / family changed meanwhile) are dropped.
  const filterKey = `${tab}|${family}`;
  const filterRef = useRef(filterKey);
  filterRef.current = filterKey;
  const itemsRef = useRef<UserNotification[] | null>(null);
  itemsRef.current = items;
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;

  /** Full (re)load: first page only (filter change, refresh button). */
  const load = useCallback(async () => {
    const k = `${tab}|${family}`;
    try {
      const page = await inboxApi.list({ unread: tab === 'unread', family: family || null, limit: PAGE });
      if (filterRef.current !== k) return;
      setItems(page.items);
      setHasMore(page.hasMore);
      setUnread(page.unreadCount);
    } catch {
      if (filterRef.current !== k) return;
      setItems([]);
      toast.error(t('inbox.loadFailed') || 'Failed to load the notifications');
    }
  }, [tab, family, t]);
  useEffect(() => { void load(); }, [load]);

  /**
   * Live change (bell store version: a new notification, a read elsewhere, this
   * page's own actions): the first page is fetched again and MERGED — new
   * items on top, the window it covers updated (read state, removed ones),
   * the older pages already loaded kept as they are (no collapse to 30 items,
   * the scroll position stays).
   */
  const sync = useCallback(async () => {
    const k = `${tab}|${family}`;
    try {
      const page = await inboxApi.list({ unread: tab === 'unread', family: family || null, limit: PAGE });
      if (filterRef.current !== k) return;
      setUnread(page.unreadCount);
      const cur = itemsRef.current;
      if (cur === null) {
        setItems(page.items);
        setHasMore(page.hasMore);
        return;
      }
      // Window of the fresh page: every id down to its last one (everything when it is the whole list).
      const floor = page.hasMore && page.items.length ? page.items[page.items.length - 1].id : 0;
      const older = cur.filter((n) => n.id < floor);
      // More new items than one page: the gap could never be loaded by « load more » — start over.
      if (older.length > 0 && cur.length > 0 && !cur.some((n) => n.id >= floor)) {
        setItems(page.items);
        setHasMore(page.hasMore);
        return;
      }
      setItems([...page.items, ...older]);
      setHasMore(older.length > 0 ? hasMoreRef.current : page.hasMore);
    } catch {
      /* the next change or the refresh button retries */
    }
  }, [tab, family]);
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current) return; // the mount's load() covers it
    void sync();
  }, [version, sync]);

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

  // Actions: the list is updated here at once; the bell refresh that follows
  // bumps the store version, whose sync() merges (never a reload from scratch).
  const after = async (p: Promise<unknown>) => {
    try { await p; } catch { toast.error(t('inbox.actionFailed') || 'The action failed'); }
    await refreshBell();
  };
  const read = (n: UserNotification) => {
    if (!n.readAt) {
      const now = new Date().toISOString();
      setItems((cur) => (cur ?? []).map((x) => (x.id === n.id ? { ...x, readAt: now } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    return after(inboxApi.markRead([n.id]));
  };
  const remove = (n: UserNotification) => {
    setItems((cur) => (cur ?? []).filter((x) => x.id !== n.id));
    if (!n.readAt) setUnread((u) => Math.max(0, u - 1));
    void after(inboxApi.remove([n.id]));
  };
  const readAll = () => {
    const now = new Date().toISOString();
    setItems((cur) => (cur ?? []).map((x) => (x.readAt ? x : { ...x, readAt: now })));
    setUnread(0);
    void after(inboxApi.markAllRead());
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
            <Button size="sm" variant="secondary" onClick={readAll}>
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
