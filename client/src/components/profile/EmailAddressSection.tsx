import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Pencil, Send, X } from 'lucide-react';
import toast from 'react-hot-toast';
import type { EmailState } from '@oblimint/shared';
import { identityApi } from '@/api/identity.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { Pill } from '@/components/common/Pill';

/**
 * E-mail address of a LOCAL account (profile): shown read-only with its state
 * (confirmed / not confirmed / change waiting for its link). A change asks the
 * current password or a TOTP code (api client prompt), then a link sent to the
 * new address confirms it; the old address is told.
 */
export function EmailAddressSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<EmailState | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { identityApi.emailState().then(setState).catch(() => {}); }, []);

  const errorOf = (err: unknown): string | null => {
    if (isStepUpHandled(err)) return null;
    const code = (err as { response?: { data?: { code?: string; error?: string } } } | null)?.response?.data?.code;
    if (code === 'emailTaken') return t('identity.email.taken') || 'This e-mail address is already used by another account.';
    if (code === 'mailFailed') return t('identity.email.mailFailed') || 'The confirmation e-mail could not be sent. Try again later.';
    if (code === 'tooSoon') return t('identity.email.tooSoon') || 'A link was just sent: wait a moment before asking again.';
    return (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error || (t('identity.email.failed') || 'The address could not be changed.');
  };

  const resend = async () => {
    setBusy(true);
    try {
      const r = await identityApi.verifyEmail();
      setState(r.state);
      toast.success(t('identity.email.linkSent', { email: r.state.pending?.email ?? r.state.email }) || 'Confirmation link sent');
    } catch (err) {
      const msg = errorOf(err);
      if (msg) toast.error(msg);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try { setState(await identityApi.cancelEmailChange()); } catch { toast.error(t('identity.email.failed') || 'The address could not be changed.'); } finally { setBusy(false); }
  };

  const pendingIsChange = !!state?.pending && state.pending.email !== (state.email ?? '').toLowerCase();

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-text-secondary">{t('profile.emailLabel') || 'E-mail'}</label>
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg-tertiary px-3 py-2">
        <Mail size={14} className="text-text-muted shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{state?.email || <span className="text-text-muted">{t('identity.email.none') || 'No address'}</span>}</span>
        {state?.email && (state.verified
          ? <Pill tone="green">{t('identity.email.verified') || 'confirmed'}</Pill>
          : <Pill tone="amber" title={t('identity.email.unverifiedHint') || 'No password reset link is sent to an unconfirmed address.'}>{t('identity.email.unverified') || 'not confirmed'}</Pill>)}
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={!state}>
          <Pencil size={14} className="mr-1" />{t('identity.email.change') || 'Change'}
        </Button>
      </div>
      {state?.pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
          <span className="min-w-0 flex-1">
            {pendingIsChange
              ? (t('identity.email.pendingChange', { email: state.pending.email }) || `Waiting for the confirmation of ${state.pending.email}: open the link sent to it.`)
              : (t('identity.email.pendingVerify') || 'Open the link sent to this address to confirm it.')}
          </span>
          <button type="button" className="inline-flex items-center gap-1 hover:text-text-primary coarse:min-h-10" onClick={cancel} disabled={busy}>
            <X size={12} />{t('identity.email.cancelPending') || 'Cancel'}
          </button>
        </div>
      )}
      {state?.email && !state.verified && !state.pending && state.mailAvailable && (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-accent hover:underline coarse:min-h-10" onClick={resend} disabled={busy}>
          <Send size={12} />{t('identity.email.sendConfirmation') || 'Send a confirmation link'}
        </button>
      )}
      <p className="mt-1 text-xs text-text-muted">{t('identity.email.hint') || 'Used for notifications and password recovery (once confirmed).'}</p>
      {editing && state && (
        <EmailChangeModal
          current={state.email}
          mailAvailable={state.mailAvailable}
          errorOf={errorOf}
          onClose={() => setEditing(false)}
          onDone={(next, pending) => {
            setState(next);
            setEditing(false);
            toast.success(pending
              ? (t('identity.email.linkSent', { email: next.pending?.email }) || 'Confirmation link sent')
              : (t('identity.email.changed') || 'E-mail address updated'));
          }}
        />
      )}
    </div>
  );
}

function EmailChangeModal({ current, mailAvailable, errorOf, onClose, onDone }: {
  current: string | null;
  mailAvailable: boolean;
  errorOf: (err: unknown) => string | null;
  onClose: () => void;
  onDone: (state: EmailState, pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (value: string | null) => {
    setError('');
    if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(t('identity.forgot.invalidEmail') || 'Enter a valid e-mail address.');
      return;
    }
    setBusy(true);
    try {
      const r = await identityApi.changeEmail(value);
      onDone(r.state, r.status === 'pending');
    } catch (err) {
      const msg = errorOf(err);
      if (msg) setError(msg);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('identity.email.modalTitle') || 'Change the e-mail address'}
      icon={<Mail className="w-4 h-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      bodyClassName="py-4 space-y-3"
      footer={
        <>
          {current && (
            <Button type="button" variant="ghost" onClick={() => submit(null)} disabled={busy} className="mr-auto">
              {t('identity.email.remove') || 'Remove the address'}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel') || 'Cancel'}</Button>
          <Button type="submit" form="email-change-form" loading={busy} disabled={!email.trim()}>{t('identity.email.submit') || 'Continue'}</Button>
        </>
      }
    >
      <form id="email-change-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(email.trim()); }} className="space-y-3">
        <p className="text-xs text-text-muted">
          {mailAvailable
            ? (t('identity.email.modalHint') || 'A link is sent to the new address: the change takes effect once it is opened. Your current address is told. Your password or a code of your authenticator is asked first.')
            : (t('identity.email.modalHintNoMail') || 'The platform cannot send e-mails yet: the new address is saved but stays unconfirmed (no password reset link is sent to it).')}
        </p>
        <Input
          label={t('identity.email.newLabel') || 'New address'}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          required
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
