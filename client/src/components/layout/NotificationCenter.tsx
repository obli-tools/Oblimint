import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, X } from 'lucide-react';
import { Drawer } from '@/components/common/Drawer';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useNativeBack } from '@/hooks/useNativeBack';
import { useLayoutMode } from '@/hooks/useMediaQuery';
import { cn } from '@/utils/cn';

/**
 * Notification Center — P0 stub ported from Obliance (same bell, dropdown
 * and phone sheet). Oblimint has no live alerts yet, so the list is always
 * the empty state; the alert store / socket wiring arrives with P1 events.
 */
export function NotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isPhone = useLayoutMode() === 'phone';
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const dropdownOpen = open && !isPhone;
  useClickOutside([panelRef, buttonRef], () => setOpen(false), dropdownOpen);
  useNativeBack(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, dropdownOpen, { escape: true });

  const title = t('notifications.title') || 'Notifications';
  const bellLabel = t('notificationCenter.title') || 'Notification Center';

  const list = (
    <div className="flex flex-col items-center justify-center py-10 text-text-muted gap-2">
      <Bell size={24} className="opacity-30" />
      <p className="text-sm">{t('notificationCenter.empty') || 'No notifications'}</p>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={bellLabel}
        aria-label={bellLabel}
        aria-expanded={open}
        aria-haspopup={isPhone ? 'dialog' : 'true'}
        className="relative flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10 coarse:justify-center"
      >
        <Bell size={14} className={cn('text-text-muted', 'coarse:h-[18px] coarse:w-[18px]')} />
      </button>

      {dropdownOpen && (
        <div
          ref={panelRef}
          className="absolute right-0 top-8 z-50 flex max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-2rem)] flex-col rounded-xl bg-bg-secondary shadow-2xl overflow-hidden coarse:top-11"
        >
          <div className="px-4 py-3 space-y-2 shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
              <button
                onClick={() => setOpen(false)}
                aria-label={t('common.close') || 'Close'}
                className="text-text-muted hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10 coarse:inline-flex coarse:items-center coarse:justify-center"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="min-h-0 max-h-96 overflow-y-auto overscroll-contain">{list}</div>
        </div>
      )}

      <Drawer
        open={open && isPhone}
        onClose={() => setOpen(false)}
        side="bottom"
        size="lg"
        title={title}
        icon={<Bell className="h-4 w-4 text-accent" />}
        bodyClassName="p-0"
      >
        {list}
      </Drawer>
    </div>
  );
}
