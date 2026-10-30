import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { identityApi } from '@/api/identity.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Logo } from '@/components/common/Logo';

/**
 * Forgotten password (Obliance ForgotPasswordPage): the server answers the same
 * thing whatever the address, so the page always shows the same confirmation.
 * Local accounts only: an Obligate (SSO) account resets its password there.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('identity.forgot.invalidEmail') || 'Enter a valid e-mail address.');
      return;
    }
    setSending(true);
    try {
      await identityApi.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 429) setError(t('identity.forgot.tooMany') || 'Too many requests. Try again in a few minutes.');
      else setSent(true); // never tell whether the address exists
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary p-4 pt-[max(1rem,var(--safe-top))] pb-[max(1rem,var(--safe-bottom))]">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3" />
        </div>

        <div className="rounded-lg bg-bg-secondary p-6 space-y-5">
          {sent ? (
            <div className="text-center space-y-4">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-up-bg">
                <svg className="h-6 w-6 text-status-up" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{t('identity.forgot.successTitle') || 'Check your inbox'}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t('identity.forgot.successMessage') || 'If this address belongs to an account of this panel and was confirmed, a link to choose a new password has just been sent to it. It is valid for 30 minutes.'}
                </p>
              </div>
              <Link to="/login" className="block text-sm text-accent hover:underline coarse:py-2.5">
                {t('identity.backToLogin') || 'Back to sign in'}
              </Link>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{t('identity.forgot.title') || 'Forgot your password?'}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t('identity.forgot.description') || 'Enter the e-mail address of your account: we send you a link to choose a new password.'}
                </p>
              </div>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  label={t('identity.forgot.emailLabel') || 'E-mail address'}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('identity.forgot.emailPlaceholder') || 'you@example.com'}
                  autoComplete="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  autoFocus
                  required
                />
                {error && (
                  <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                    <p className="text-sm text-status-down">{error}</p>
                  </div>
                )}
                <Button type="submit" className="w-full" loading={sending}>
                  {t('identity.forgot.submit') || 'Send the link'}
                </Button>
              </form>
              <p className="text-xs text-text-muted">
                {t('identity.forgot.ssoHint') || 'Accounts that sign in through Obligate (SSO) change their password in Obligate.'}
              </p>
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
