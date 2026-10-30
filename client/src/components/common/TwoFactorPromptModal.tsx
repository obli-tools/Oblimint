import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { useIsCoarsePointer } from '@/hooks/useMediaQuery';

// Modal shown when a server response says `twoFactorRequired: true` on a
// sensitive action (ported from Obliance, TOTP only). The caller provides
// the action label and an `onSubmit(code)` that re-sends the original
// request with the code in the body.
//
// Built on the shared Modal (portal, focus trap, scroll lock, Escape and
// Android back = cancel). On a touch screen a stray backdrop tap does NOT
// cancel the pending request.

// Built-in step-ups: shown with a readable label and a neutral sentence
// instead of the raw key.
const BUILTIN_ACTIONS: Record<string, [key: string, fallback: string]> = {
  'profile.totp_manage': ['twoFactorPrompt.actions.totpManage', 'Change your authenticator app'],
  'profile.recovery_codes': ['identity.prompt.recoveryCodes', 'Generate new recovery codes'],
  'profile.email_change': ['identity.prompt.emailChange', 'Change your e-mail address'],
  'pending_action.confirm': ['approvals.prompt.confirm', 'Confirm the requested action'],
  'pending_action.approve': ['approvals.prompt.approve', 'Approve the request (your own code)'],
};

/** Readable label of a protected action of the matrix (restrictions.actions.*), or the raw key. */
function restrictedActionLabel(t: (k: string, o?: Record<string, unknown>) => string, key: string): string {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(key)) return key;
  return t(`restrictions.actions.${key.replace(/\./g, '_')}`, { defaultValue: key });
}

export function TwoFactorPromptModal({
  actionLabel,
  currentIp,
  trustIpAllowed = true,
  codeMustBeNew = false,
  mode = 'code',
  onClose,
  onSubmit,
}: {
  actionLabel: string;
  /** IP the server sees the user coming from — shown next to the trust checkbox. */
  currentIp?: string;
  /** `false`: the server neither honours nor grants an IP trust for this action. */
  trustIpAllowed?: boolean;
  /** A code already used (e.g. at sign-in) is refused. */
  codeMustBeNew?: boolean;
  /** 'password': the CURRENT PASSWORD is asked; submitted as the `code` argument. */
  mode?: 'code' | 'password';
  onClose: () => void;
  onSubmit: (code: string, opts: { trustIp: boolean }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const [code, setCode] = useState('');
  const [trustIp, setTrustIp] = useState(false); // explicit opt-in
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPassword = mode === 'password';
  useEffect(() => { inputRef.current?.focus(); }, []);

  const builtin = BUILTIN_ACTIONS[actionLabel];
  const label = builtin ? t(builtin[0], builtin[1]) : restrictedActionLabel(t as never, actionLabel);
  const ready = isPassword ? code.length > 0 : code.length === 6;
  const showTrust = trustIpAllowed && !isPassword;

  const submit = async () => {
    setError(null);
    if (!isPassword && !/^\d{6}$/.test(code)) {
      setError(t('twoFactorPrompt.invalidFormat', 'Enter a 6-digit TOTP code from your authenticator app.'));
      return;
    }
    if (isPassword && !code) return;
    setBusy(true);
    try {
      await onSubmit(code, { trustIp: showTrust && trustIp });
      onClose();
    } catch (err: any) {
      const serverError = err?.response?.data?.error;
      setError(serverError || err?.message || t('twoFactorPrompt.failed', 'Verification failed'));
      setCode('');
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isPassword ? t('twoFactorPrompt.passwordTitle', 'Confirm your password') : t('twoFactorPrompt.title', 'Sensitive action')}
      icon={<ShieldCheck className="w-4 h-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      closeOnBackdrop={!coarse}
      overlayClassName="z-[300] bg-black/70"
      className="max-w-sm sm:max-w-sm"
      bodyClassName="py-4 space-y-3"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded text-text-muted hover:text-text-primary disabled:opacity-50 coarse:min-h-10 coarse:px-4"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !ready}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5 coarse:min-h-10 coarse:px-4"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {isPassword ? t('twoFactorPrompt.confirm', 'Confirm') : t('twoFactorPrompt.verify', 'Verify & execute')}
          </button>
        </>
      }
    >
      {isPassword ? (
        <p className="text-xs text-text-muted">
          <strong className="text-text-primary">{label}</strong>{' — '}
          {t('twoFactorPrompt.passwordDescription', 'Enter your current password to confirm this change.')}
        </p>
      ) : builtin ? (
        <p className="text-xs text-text-muted">
          <strong className="text-text-primary">{label}</strong>{' — '}
          {t('twoFactorPrompt.builtinDescription', 'Enter your current 6-digit code to confirm.')}
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          <strong className="text-text-primary">{label}</strong>{' '}
          {t('twoFactorPrompt.description', 'is marked sensitive. Enter your current 6-digit TOTP code to confirm.')}
        </p>
      )}
      {!isPassword && codeMustBeNew && (
        <p className="text-[11px] text-text-muted">
          {t('twoFactorPrompt.codeMustBeNew', 'Enter a new code: a code already used (for example to sign in) is refused. If needed, wait for the next one.')}
        </p>
      )}
      {isPassword ? (
        <input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          aria-label={t('twoFactorPrompt.passwordLabel', 'Current password')}
          value={code}
          onChange={(e) => setCode(e.target.value.slice(0, 1024))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          className="w-full px-3 py-2 text-sm bg-bg-tertiary rounded text-text-primary focus:outline-none focus:border-accent"
        />
      ) : (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          maxLength={6}
          pattern="\d{6}"
          autoComplete="one-time-code"
          enterKeyHint="go"
          aria-label={t('twoFactorPrompt.codeLabel', 'TOTP code')}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="123456"
          className="w-full px-3 py-2 text-center text-lg font-mono tracking-[0.5em] bg-bg-tertiary rounded text-text-primary focus:outline-none focus:border-accent"
        />
      )}
      {/* Explicit opt-in: skip the prompt for 24h for THIS user + THIS IP only. */}
      {showTrust && (
        <label className="flex items-start gap-2 cursor-pointer select-none coarse:py-1">
          <input
            type="checkbox"
            checked={trustIp}
            onChange={(e) => setTrustIp(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span className="text-[11px] text-text-muted">
            {t('twoFactorPrompt.trustIp', 'Trust this IP for 24h')}
            {currentIp && (
              <span className="block font-mono text-[10px] text-text-primary/80 mt-0.5">{currentIp}</span>
            )}
            <span className="block text-[10px] text-text-muted/70 mt-0.5">
              {t('twoFactorPrompt.trustIpHint', 'Skips the TOTP prompt for sensitive actions from this IP only. Revocable any time from your profile.')}
            </span>
          </span>
        </label>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Modal>
  );
}
