import { Fragment, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { accountHref, type AccountTab } from '@/utils/links';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// The header of an object page (coherence plan C2), as the site page (Obliance
// DeviceDetailPage): back IconButton (history, else the fallback — the tab of
// the owning account, never a bare global list), title + badges, a subtitle
// line of facts separated by dots (the account first, as an AccountLink), the
// error message of the object, then refresh (icon) and the actions.
// ─────────────────────────────────────────────────────────────────────────────

export function DetailHeader({
  backTo, onBack, leading, title, badges, subtitle, children, message, onRefresh, refreshing = false, actions,
}: {
  /** Where the back button goes without history (deep link of the parent object). */
  backTo: string;
  /** Replaces the back behaviour (e.g. a wizard step back); return true when handled. */
  onBack?: () => boolean;
  /** Before the title block (e.g. an application icon). */
  leading?: ReactNode;
  title: ReactNode;
  /** Status / kind badges next to the title. */
  badges?: ReactNode;
  /** Facts under the title: a list is separated by dots (falsy items skipped), a node is shown as is. */
  subtitle?: ReactNode[] | ReactNode;
  /** Extra lines under the subtitle (description, hints). */
  children?: ReactNode;
  /** Error message of the object (red banner). */
  message?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Buttons / ActionMenu on the right (trigger lg solid rounded-lg). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const facts = Array.isArray(subtitle)
    ? subtitle.filter((x) => x !== null && x !== undefined && x !== false && x !== '')
    : subtitle != null && subtitle !== false ? [subtitle] : [];
  const back = () => {
    if (onBack?.()) return;
    if (window.history.length > 1) navigate(-1); else navigate(backTo);
  };

  return (
    <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
      <IconButton
        onClick={back}
        size="lg"
        variant="plain"
        className="mt-0.5 rounded-lg hover:bg-bg-secondary"
        label={t('common.back') || 'Back'}
        icon={<ArrowLeft className="h-4 w-4" />}
      />
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
          <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{title}</h1>
          {badges}
        </div>
        {facts.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            {facts.map((f, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden>·</span>}
                {f}
              </Fragment>
            ))}
          </div>
        )}
        {children}
        {message && (
          <p className="mt-2 whitespace-pre-line break-words rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{message}</p>
        )}
      </div>
      {(onRefresh || actions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:order-last max-lg:w-full">
          {onRefresh && (
            <IconButton
              label={t('common.refresh') || 'Refresh'}
              icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
              onClick={onRefresh}
              disabled={refreshing}
              size="lg"
              variant="solid"
              className="rounded-lg"
            />
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Link to the account of an object (coherence plan C3): its primary domain
 * (else its user name), the user name after it when both are known; it opens
 * the tab of the object on the account page.
 */
export function AccountLink({ accountId, username, primaryDomain, tab, extra, to, className }: {
  accountId: number;
  username: string | null | undefined;
  primaryDomain?: string | null;
  tab?: AccountTab;
  extra?: Record<string, string | number | null | undefined>;
  /** Other destination while the account page has no tab for the object (e.g. /mail?account=). */
  to?: string;
  className?: string;
}) {
  const user = username || `#${accountId}`;
  const label = primaryDomain || user;
  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)}>
      <Link to={to ?? accountHref(accountId, tab, extra)} className="font-mono hover:text-accent">{label}</Link>
      {label !== user && <span className="font-mono text-[11px] text-text-muted">{user}</span>}
    </span>
  );
}
