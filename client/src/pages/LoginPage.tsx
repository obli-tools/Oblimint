import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { twoFactorApi } from '@/api/twoFactor.api';
import { authApi } from '@/api/auth.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Logo } from '@/components/common/Logo';

type Step = 'credentials' | '2fa';

/** Anti-loop marker: last automatic redirect to Obligate (ms epoch). */
const SSO_REDIRECT_TS_KEY = '_sso_redirect_ts';
const SSO_LOOP_WINDOW_MS = 15_000;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login, isLoading, checkSession } = useAuthStore();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const errorParam = searchParams.get('error');
  // The account belongs to no tenant: the server opens no session for it
  // (403 noTenantAccess, or ?error=no_tenant after an Obligate sign-in).
  const noTenantMessage = t('login.noTenantAccess', 'Your account has no access to any workspace on this server. Ask an administrator to grant it access.');
  const [error, setError] = useState(
    errorParam === 'sso_failed' ? t('login.ssoFailed', 'SSO authentication failed. Please try local login.')
    // SSO worked but the linked local account is disabled here.
    : errorParam === 'account_disabled' ? t('login.accountDisabled', 'Your account is disabled on this server. Ask an administrator to re-enable it.')
    : errorParam === 'no_tenant' ? noTenantMessage
    // SSO attempted on the client space (clients are local accounts).
    : errorParam === 'wrong_panel_host' ? t('login.wrongPanelHost.ssoOnClientSpace', 'Single sign-on is not available on the client space.')
    : errorParam ? t('login.ssoFailed', 'SSO authentication failed. Please try local login.')
    : '',
  );
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  // The account is an SSO (Obligate) account without a local TOTP: it can
  // only sign in through Obligate (server answer 403 ssoLoginRequired).
  const [ssoLoginRequired, setSsoLoginRequired] = useState(false);
  // Client space (server setting client_panel_hostname): which address this
  // is, and where a refused user must sign in instead (403 wrongPanelHost).
  const [panelRole, setPanelRole] = useState<'admin' | 'client' | null>(null);
  const [clientPanelUrl, setClientPanelUrl] = useState<string | null>(null);
  const [wrongHost, setWrongHost] = useState<{ url: string | null; expected: 'admin' | 'client' | null } | null>(null);
  const isClientSpace = panelRole === 'client';

  // If we arrived here with ?error=…, don't auto-redirect to Obligate again.
  const ssoFailed = !!errorParam;
  // Break-glass: ?local=1 forces the local username/password form and skips
  // the automatic SSO redirect — the escape hatch when SSO is misconfigured
  // so a local admin can never be fully locked out.
  const forceLocal = searchParams.get('local') === '1' || searchParams.get('local') === 'true';

  const [step, setStep] = useState<Step>('credentials');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // SSO state: 'checking' = initial check, 'redirecting' = going to Obligate,
  // 'unavailable' = Obligate down (show local login + warning), 'local' = no Obligate configured
  const [ssoState, setSsoState] = useState<'checking' | 'redirecting' | 'unavailable' | 'local'>(ssoFailed ? 'unavailable' : forceLocal ? 'local' : 'checking');

  const checkSso = () => {
    return authApi.ssoConfig()
      .then((cfg) => {
        if (cfg.obligateEnabled && cfg.obligateUrl) {
          if (cfg.obligateReachable !== false) {
            // Anti-loop: if we redirected to SSO less than 15 s ago and ended up back here, Obligate is broken
            const lastRedirect = sessionStorage.getItem(SSO_REDIRECT_TS_KEY);
            if (lastRedirect && Date.now() - parseInt(lastRedirect, 10) < SSO_LOOP_WINDOW_MS) {
              setSsoState('unavailable');
              return 'unavailable';
            }
            sessionStorage.setItem(SSO_REDIRECT_TS_KEY, String(Date.now()));
            setSsoState('redirecting');
            window.location.href = '/auth/sso-redirect';
            return 'redirected';
          }
          setSsoState('unavailable');
          return 'unavailable';
        }
        setSsoState('local');
        return 'local';
      })
      .catch(() => { setSsoState('unavailable'); return 'unavailable'; });
  };

  useEffect(() => {
    authApi.ssoConfig()
      .then((cfg) => { setPanelRole(cfg.panelRole ?? null); setClientPanelUrl(cfg.clientPanelUrl ?? null); })
      .catch(() => {});
    fetch('/health')
      .then((r) => r.json())
      .then((data: { version?: string }) => setServerVersion(data.version ?? null))
      .catch(() => {});

    // Check existing session first
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success?: boolean }) => {
        if (d.success) { navigate('/', { replace: true }); return; }
        // No session — check Obligate unless we just failed or local was forced
        if (forceLocal) setSsoState('local');
        else if (!ssoFailed) checkSso();
        else setSsoState('unavailable');
      })
      .catch(() => { if (forceLocal) setSsoState('local'); else if (!ssoFailed) checkSso(); else setSsoState('unavailable'); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll Obligate every 60s when unavailable — redirect as soon as it comes back
  useEffect(() => {
    if (ssoState !== 'unavailable') return;
    const interval = setInterval(() => {
      checkSso();
    }, 60_000);
    return () => clearInterval(interval);
  }, [ssoState]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSsoLoginRequired(false);
    setWrongHost(null);
    try {
      const result = await login(username, password);
      if (result.requires2fa) {
        setMfaCode('');
        setStep('2fa');
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ssoLoginRequired') {
        setPassword('');
        setSsoLoginRequired(true);
        return;
      }
      if (code === 'wrongPanelHost') {
        const e = err as { url?: string | null; expected?: 'admin' | 'client' | null };
        setPassword('');
        setWrongHost({ url: e.url ?? null, expected: e.expected ?? null });
        return;
      }
      if (code === 'noTenantAccess') {
        setPassword('');
        setError(noTenantMessage);
        return;
      }
      if (code === 'invalidCredentials') { setError(t('login.invalidCredentials', 'Invalid username or password')); return; }
      if (code === 'tooManyAttempts') { setError(t('login.tooManyAttempts', 'Too many login attempts, please try again later')); return; }
      if (code === 'network') { setError(t('login.serverUnreachable', 'Unable to connect to the server')); return; }
      setError(err instanceof Error ? err.message : t('login.loginFailed', 'Login failed'));
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMfaLoading(true);
    try {
      await twoFactorApi.verify(mfaCode);
      await checkSession();
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; code?: string } } };
      const status = axiosErr?.response?.status;
      const serverMsg = axiosErr?.response?.data?.error ?? '';
      if (status === 400 && serverMsg.toLowerCase().includes('pending')) {
        // Session was lost between login and 2FA verify (e.g. server restart)
        setError(t('login.twoFactor.sessionExpired', 'Your sign-in session expired. Please sign in again.'));
        setStep('credentials');
      } else if (status === 403 && axiosErr?.response?.data?.code === 'noTenantAccess') {
        setError(noTenantMessage);
        setPassword('');
        setStep('credentials');
      } else {
        setError(t('login.twoFactor.invalidCode', 'Invalid code. Please try again.'));
      }
    } finally {
      setMfaLoading(false);
    }
  };

  // While checking or redirecting, show a minimal loading screen — never flash the local login form
  if (ssoState === 'checking' || ssoState === 'redirecting') {
    return (
      <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3 animate-pulse" />
          <p className="text-sm text-text-secondary">
            {ssoState === 'redirecting' ? t('login.ssoRedirecting', 'Redirecting to login...') : t('login.ssoChecking', 'Checking authentication...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary p-4 pt-[max(1rem,var(--safe-top))] pb-[max(1rem,var(--safe-bottom))] max-lg:flex-col coarse:flex-col">
      <div className="w-full max-w-sm space-y-8 relative">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3" />
          {isClientSpace && <h1 className="text-lg font-semibold text-text-primary">{t('login.clientSpace.title', 'Client space')}</h1>}
          <p className="mt-2 text-sm text-text-secondary">{t('login.title', 'Sign in to your account')}</p>
        </div>

        {ssoState === 'unavailable' && !isClientSpace && (
          <div className="bg-status-pending-bg border border-status-pending/30 rounded-lg p-3 text-sm text-status-pending">
            {t('login.ssoUnavailable', 'Centralized login (Obligate) is unavailable. Using local authentication.')}
          </div>
        )}

        {step === 'credentials' ? (
          <form onSubmit={handleSubmit} className="space-y-6 rounded-lg bg-bg-secondary p-6">
            <Input
              label={t('login.username', 'Username')}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.usernamePlaceholder', 'Enter your username')}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              autoFocus
              required
            />
            <Input
              label={t('login.password', 'Password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder', 'Enter your password')}
              autoComplete="current-password"
              enterKeyHint="go"
              required
            />
            {error && (
              <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                <p className="text-sm text-status-down">{error}</p>
              </div>
            )}
            {wrongHost && (
              <div role="alert" className="rounded-md bg-status-pending-bg border border-status-pending/30 p-3 space-y-3">
                <p className="text-sm text-text-primary">
                  {wrongHost.expected === 'client'
                    ? t('login.wrongPanelHost.client', 'Client accounts sign in on the client space.')
                    : t('login.wrongPanelHost.admin', 'This address is the client space: administrators sign in on the panel.')}
                </p>
                {wrongHost.url && (
                  <Button type="button" variant="secondary" className="w-full" onClick={() => { window.location.href = `${wrongHost.url}/login`; }}>
                    {wrongHost.expected === 'client'
                      ? t('login.wrongPanelHost.goClient', 'Go to the client space')
                      : t('login.wrongPanelHost.goAdmin', 'Go to the panel')}
                  </Button>
                )}
              </div>
            )}
            {ssoLoginRequired && (
              <div role="alert" className="rounded-md bg-status-pending-bg border border-status-pending/30 p-3 space-y-3">
                <p className="text-sm font-medium text-text-primary">
                  {t('login.ssoLoginRequired.title', 'This account signs in through Obligate')}
                </p>
                <p className="text-xs text-text-secondary">
                  {t('login.ssoLoginRequired.body', 'Its password and two-factor authentication are managed in Obligate. Local sign-in is only possible with an authenticator app set up on this server.')}
                </p>
                <Button type="button" variant="secondary" className="w-full" onClick={() => { window.location.href = '/auth/sso-redirect'; }}>
                  {t('login.ssoLoginRequired.button', 'Sign in with Obligate')}
                </Button>
              </div>
            )}
            <Button type="submit" className="w-full" loading={isLoading}>
              {t('login.signIn', 'Sign in')}
            </Button>
            {panelRole === 'admin' && clientPanelUrl && (
              <p className="text-center text-xs text-text-muted">
                <a href={`${clientPanelUrl}/login`} className="hover:text-text-primary underline-offset-2 hover:underline">
                  {t('login.clientSpace.link', 'Customer? Sign in on the client space')}
                </a>
              </p>
            )}
          </form>
        ) : (
          <form onSubmit={handleMfaSubmit} className="space-y-5 rounded-lg bg-bg-secondary p-6">
            <div>
              <p className="text-sm font-medium text-text-primary mb-1">{t('login.twoFactor.title', 'Two-factor authentication')}</p>
              <p className="text-xs text-text-muted">{t('login.twoFactor.description', 'Enter the 6-digit code from your authenticator app.')}</p>
            </div>

            <Input
              label={t('login.twoFactor.totpLabel', 'Authenticator code')}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              enterKeyHint="go"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('login.twoFactor.codePlaceholder', '000000')}
              autoFocus
              required
            />

            {error && (
              <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                <p className="text-sm text-status-down">{error}</p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full" loading={mfaLoading}>{t('login.twoFactor.verify', 'Verify')}</Button>
              <button type="button" onClick={() => { setStep('credentials'); setError(''); }} className="text-xs text-text-muted hover:text-text-primary text-center coarse:min-h-10">
                {t('login.twoFactor.backToLogin', 'Back to login')}
              </button>
            </div>
          </form>
        )}
      </div>

      <p className="fixed bottom-3 left-0 right-0 text-center text-xs text-text-secondary/50 select-none max-lg:static max-lg:mt-8 coarse:static coarse:mt-8">
        {t('login.clientVersion', { version: __APP_VERSION__, defaultValue: 'Client v{{version}}' })}
        {serverVersion && ` · ${t('login.serverVersion', { version: serverVersion, defaultValue: 'Server v{{version}}' })}`}
      </p>
    </div>
  );
}
