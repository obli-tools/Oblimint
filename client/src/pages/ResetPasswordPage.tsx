import { useState, useEffect, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MIN_LENGTH } from '@oblimint/shared';
import { identityApi } from '@/api/identity.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Logo } from '@/components/common/Logo';

/**
 * Link of a password reset e-mail (Obliance ResetPasswordPage). The link is
 * checked first (not used up), then used once with the new password: every
 * session of the account ends, the second factor stays required.
 */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [validating, setValidating] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) { setValidating(false); setTokenValid(false); return; }
    identityApi.validateResetToken(token)
      .then((s) => setTokenValid(s.valid === true))
      .finally(() => setValidating(false));
  }, [token]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) { setError(t('identity.reset.mismatch') || 'The passwords do not match.'); return; }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(t('identity.reset.tooShort', { count: PASSWORD_MIN_LENGTH }) || `At least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setSubmitting(true);
    try {
      await identityApi.confirmPasswordReset(token, newPassword);
      setDone(true);
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
      if (code === 'invalidToken') setTokenValid(false);
      else setError(t('identity.reset.failed') || 'The password could not be changed.');
    } finally {
      setSubmitting(false);
    }
  };

  const icon = (ok: boolean) => (
    <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${ok ? 'bg-status-up-bg' : 'bg-status-down-bg'}`}>
      <svg className={`h-6 w-6 ${ok ? 'text-status-up' : 'text-status-down'}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d={ok ? 'M4.5 12.75l6 6 9-13.5' : 'M6 18L18 6M6 6l12 12'} />
      </svg>
    </div>
  );

  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary p-4 pt-[max(1rem,var(--safe-top))] pb-[max(1rem,var(--safe-bottom))]">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3" />
        </div>

        <div className="rounded-lg bg-bg-secondary p-6 space-y-5">
          {validating ? (
            <div className="flex justify-center py-4"><LoadingSpinner size="md" /></div>
          ) : !tokenValid ? (
            <div className="text-center space-y-4">
              {icon(false)}
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{t('identity.reset.title') || 'Choose a new password'}</h2>
                <p className="mt-1 text-sm text-status-down">{t('identity.reset.invalidToken') || 'This link is invalid, has expired or was already used.'}</p>
              </div>
              <Link to="/forgot-password" className="block text-sm text-accent hover:underline coarse:py-2.5">
                {t('identity.reset.askAgain') || 'Ask for a new link'}
              </Link>
              <Link to="/login" className="block text-sm text-text-muted hover:text-text-primary coarse:py-2.5">
                {t('identity.backToLogin') || 'Back to sign in'}
              </Link>
            </div>
          ) : done ? (
            <div className="text-center space-y-4">
              {icon(true)}
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{t('identity.reset.successTitle') || 'Password changed'}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t('identity.reset.successMessage') || 'Sign in with your new password. Every session that was open has been closed; two-factor authentication is still asked.'}
                </p>
              </div>
              <Link to="/login" className="block text-sm text-accent hover:underline coarse:py-2.5">
                {t('identity.backToLogin') || 'Back to sign in'}
              </Link>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{t('identity.reset.title') || 'Choose a new password'}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t('identity.reset.description', { count: PASSWORD_MIN_LENGTH }) || `At least ${PASSWORD_MIN_LENGTH} characters. Every open session of the account will be closed.`}
                </p>
              </div>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  label={t('identity.reset.newPassword') || 'New password'}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
                <Input
                  label={t('identity.reset.confirmPassword') || 'Confirm the new password'}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  enterKeyHint="go"
                  required
                />
                {error && (
                  <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                    <p className="text-sm text-status-down">{error}</p>
                  </div>
                )}
                <Button type="submit" className="w-full" loading={submitting}>
                  {t('identity.reset.submit') || 'Change the password'}
                </Button>
              </form>
              <Link to="/login" className="block text-center text-sm text-text-muted hover:text-text-primary coarse:py-2.5">
                {t('identity.backToLogin') || 'Back to sign in'}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
