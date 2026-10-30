import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, Settings2, X } from 'lucide-react';
import type { UserNotification } from '@oblimint/shared';
import { Drawer } from '@/components/common/Drawer';
import { NotificationRow } from '@/components/notifications/inboxUi';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useNativeBack } from '@/hooks/useNativeBack';
import { useLayoutMode } from '@/hooks/useMediaQuery';
import { useInboxLive, useInboxStore } from '@/store/inboxStore';
import { cn } from '@/utils/cn';

/**
 * Notification Center — Obliance's bell, dropdown and phone sheet, fed by the
 * per-user notification center of the server (current tenant, live on the
 * socket). Opening a notification marks it read and follows its link; the
 * full list and the preferences are on /notifications.
 */
export function NotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isPhone = useLayoutMode() === 'phone';
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useInboxLive();
  const items = useInboxStore((s) => s.items);
  const unread = useInboxStore((s) => s.unreadCount);
  const markRead = useInboxStore((s) => s.markRead);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const remove = useInboxStore((s) => s.remove);

  const dropdownOpen = open && !isPhone;
  useClickOutside([panelRef, buttonRef], () => setOpen(false), dropdownOpen);
  useNativeBack(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, dropdownOpen, { escape: true });

  const openOne = (n: UserNotification) => {
    if (!n.readAt) void markRead([n.id]);
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };
  const goToPage = (hash = '') => {
    setOpen(false);
    navigate(`/notifications${hash}`);
  };

  const title = t('notifications.title') || 'Notifications';
  const bellLabel = t('notificationCenter.title') || 'Notification Center';
  const iconBtn = 'text-text-muted hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center';

  const headerActions = (
    <div className="flex items-center gap-2 coarse:gap-1">
      {unread > 0 && (
        <button
          onClick={() => { void markAllRead(); }}
          title={t('notificationCenter.markAllRead') || 'Mark all as read'}
          aria-label={t('notificationCenter.markAllRead') || 'Mark all as read'}
          className={iconBtn}
        >
          <CheckCheck size={14} />
        </button>
      )}
      <button
        onClick={() => goToPage('#preferences')}
        title={t('inbox.preferences') || 'Notification preferences'}
        aria-label={t('inbox.preferences') || 'Notification preferences'}
        className={iconBtn}
      >
        <Settings2 size={14} />
      </button>
    </div>
  );

  const list = items.length === 0 ? (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-text-muted">
      <Bell size={24} className="opacity-30" />
      <p className="text-sm">{t('notificationCenter.empty') || 'No notifications'}</p>
    </div>
  ) : (
    items.map((n) => (
      <NotificationRow key={n.id} n={n} onOpen={openOne} onRemove={(x) => { void remove([x.id]); }} />
    ))
  );

  const footer = (
    <div className="px-4 py-2 text-center">
      <button onClick={() => goToPage()} className="text-xs font-medium text-accent hover:underline coarse:min-h-10">
        {t('inbox.seeAll') || 'See all notifications'}
      </button>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={bellLabel}
        aria-label={unread > 0 ? `${bellLabel} (${unread})` : bellLabel}
        aria-expanded={open}
        aria-haspopup={isPhone ? 'dialog' : 'true'}
        className="relative flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10 coarse:justify-center"
      >
        <Bell size={14} className={cn(unread > 0 ? 'text-accent' : 'text-text-muted', 'coarse:h-[18px] coarse:w-[18px]')} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white coarse:top-0.5 coarse:right-0.5">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {dropdownOpen && (
        <div
          ref={panelRef}
          className="absolute right-0 top-8 z-50 flex max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-bg-secondary shadow-2xl coarse:top-11"
        >
          <div className="shrink-0 space-y-2 px-4 py-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
              <div className="flex items-center gap-2 coarse:gap-1">
                {headerActions}
                <button onClick={() => setOpen(false)} aria-label={t('common.close') || 'Close'} className={iconBtn}>
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
          <div className="min-h-0 max-h-96 divide-y divide-border/50 overflow-y-auto overscroll-contain">{list}</div>
          {footer}
        </div>
      )}

      <Drawer
        open={open && isPhone}
        onClose={() => setOpen(false)}
        side="bottom"
        size="lg"
        title={title}
        icon={<Bell className="h-4 w-4 text-accent" />}
        headerExtra={headerActions}
        bodyClassName="p-0"
        footer={footer}
        footerClassName="justify-center p-0"
      >
        <div className="divide-y divide-border/50">{list}</div>
      </Drawer>
    </div>
  );
}
