import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { identityApi } from '@/api/identity.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Logo } from '@/components/common/Logo';

/**
 * Link of an e-mail confirmation (new address, or the current one being
 * verified). Public: it may be opened in another browser than the panel's.
 * The link is used on an explicit click (a mail scanner that prefetches the
 * page does not use it up).
 */
export function ConfirmEmailPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [state, setState] = useState<'ready' | 'working' | 'done' | 'invalid' | 'taken' | 'failed'>(token ? 'ready' : 'invalid');
  const [email, setEmail] = useState('');
  const busy = useRef(false);

  useEffect(() => { if (!token) setState('invalid'); }, [token]);

  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setState('working');
    try {
      const r = await identityApi.confirmEmailChange(token);
      setEmail(r.email);
      setState('done');
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
      setState(code === 'invalidToken' ? 'invalid' : code === 'emailTaken' ? 'taken' : 'failed');
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary p-4 pt-[max(1rem,var(--safe-top))] pb-[max(1rem,var(--safe-bottom))]">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3" />
        </div>
        <div className="rounded-lg bg-bg-secondary p-6 space-y-5 text-center">
          <h2 className="text-lg font-semibold text-text-primary">{t('identity.confirmEmail.title') || 'Confirm your e-mail address'}</h2>
          {state === 'ready' && (
            <>
              <p className="text-sm text-text-muted">{t('identity.confirmEmail.description') || 'Confirm that this address belongs to you: the panel will send the e-mails of your account to it, password reset links included.'}</p>
              <Button className="w-full" onClick={confirm}>{t('identity.confirmEmail.submit') || 'Confirm this address'}</Button>
            </>
          )}
          {state === 'working' && <div className="flex justify-center py-4"><LoadingSpinner size="md" /></div>}
          {state === 'done' && (
            <p className="text-sm text-status-up">{t('identity.confirmEmail.done', { email }) || `Address confirmed: ${email}.`}</p>
          )}
          {state === 'invalid' && (
            <p className="text-sm text-status-down">{t('identity.confirmEmail.invalid') || 'This link is invalid, has expired or was already used. Ask for a new one from your profile.'}</p>
          )}
          {state === 'taken' && (
            <p className="text-sm text-status-down">{t('identity.confirmEmail.taken') || 'This address is now used by another account.'}</p>
          )}
          {state === 'failed' && (
            <p className="text-sm text-status-down">{t('identity.confirmEmail.failed') || 'The address could not be confirmed. Try again later.'}</p>
          )}
          <Link to="/profile" className="block text-sm text-text-muted hover:text-text-primary coarse:py-2.5">
            {t('identity.confirmEmail.toProfile') || 'Go to my profile'}
          </Link>
        </div>
      </div>
    </div>
  );
}
