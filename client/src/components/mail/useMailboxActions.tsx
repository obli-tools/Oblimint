import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { Mailbox } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { MailPasswordModal, PasswordRevealModal } from './MailPasswordModals';
import { mailErrorCode, toastMailError } from './mailErrors';

type Box = Pick<Mailbox, 'id' | 'address'>;

/**
 * Row / page actions of a mailbox: open the webmail (SSO ticket in a new tab
 * opened synchronously on the click, opener cut), change the password (generated one shown once), delete with the
 * address typed as confirmation. Render `modals` once in the caller.
 */
export function useMailboxActions({ staff, onChanged, onDeleted }: {
  staff: boolean;
  onChanged?: () => void;
  onDeleted?: (box: Box) => void;
}): {
  busy: string | null;
  openWebmail: (box: Box) => Promise<void>;
  changePassword: (box: Box) => void;
  remove: (box: Box) => Promise<void>;
  modals: ReactNode;
} {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<Box | null>(null);
  // Generated password: kept only while the reveal dialog is open (MA4).
  const [revealed, setRevealed] = useState<{ address: string; password: string } | null>(null);

  const openWebmail = async (box: Box) => {
    // Open the tab synchronously, while the click's user activation is still
    // valid: after the await, popup blockers (Safari/iOS always, others past the
    // activation window) silently drop window.open and the single-use 60 s
    // ticket would be wasted. 'noopener' is not passed because window.open then
    // always returns null (a blocked popup would be undetectable): the opener
    // is cut by hand instead, before the tab leaves about:blank.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    setBusy(`webmail-${box.id}`);
    try {
      const ticket = await mailApi.openWebmail(box.id);
      if (w && !w.closed) {
        // The URL carries a single-use 60 s ticket, never the mailbox password.
        w.location.href = ticket.url;
        toast(t('mail.webmail.opened') || 'The webmail opens in a new tab.', { duration: 4000 });
      } else {
        // Popup blocked: offer the link (the user's own click opens it).
        toast((tt) => (
          <span className="text-sm">
            {t('mail.webmail.popupBlocked') || 'Your browser blocked the new tab.'}{' '}
            <a href={ticket.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline" onClick={() => toast.dismiss(tt.id)}>
              {t('mail.webmail.openLink') || 'Open the webmail'}
            </a>
          </span>
        ), { duration: 30_000 });
      }
    } catch (err) {
      if (w && !w.closed) w.close();
      if (mailErrorCode(err) === 'webmailUnavailable') {
        toast.error(t('mail.webmail.unavailableHint') || 'The webmail is not available: a platform administrator must choose and deploy it (Settings → Mail service).', { duration: 8000 });
      } else {
        toastMailError(t, err, t('mail.webmail.failed') || 'Failed to open the webmail');
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (box: Box) => {
    if (!(await confirm({
      title: t('mail.mailboxes.deleteTitle') || 'Delete the mailbox',
      message: t('mail.mailboxes.deleteConfirm', {
        address: box.address,
        defaultValue: 'Delete {{address}}? Logins stop at once and its messages are purged after 7 days. Type the address to confirm.',
      }),
      danger: true,
      requireText: box.address,
    }))) return;
    setBusy(`delete-${box.id}`);
    try {
      await mailApi.deleteMailbox(box.id, box.address);
      toast.success(t('mail.mailboxes.deleted') || 'Mailbox deleted');
      onDeleted?.(box);
      onChanged?.();
    } catch (err) {
      toastMailError(t, err, t('mail.mailboxes.deleteFailed') || 'Failed to delete the mailbox');
    } finally {
      setBusy(null);
    }
  };

  const modals = (
    <>
      <MailPasswordModal
        open={pwFor !== null}
        mailboxId={pwFor?.id ?? 0}
        address={pwFor?.address ?? ''}
        staff={staff}
        onClose={() => setPwFor(null)}
        onDone={(generated) => {
          const address = pwFor?.address ?? '';
          setPwFor(null);
          toast.success(t('mail.password.changed') || 'Password changed');
          if (generated) setRevealed({ address, password: generated });
          onChanged?.();
        }}
      />
      <PasswordRevealModal password={revealed?.password ?? null} address={revealed?.address ?? ''} onClose={() => setRevealed(null)} />
    </>
  );

  return { busy, openWebmail, changePassword: setPwFor, remove, modals };
}
