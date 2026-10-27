import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Plug, ShieldCheck } from 'lucide-react';
import type { ApiKeyScope, OAuthAuthorizeInfo } from '@oblimint/shared';
import { oauthApi } from '@/api/apiKeys.api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Logo } from '@/components/common/Logo';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SCOPE_FALLBACK } from '@/components/hosting/AccountApiKeysTab';
import { clearOAuthReturn, rememberOAuthReturn } from '@/utils/oauthReturn';

// /oauth/authorize — consent page of a « Connecteur Claude » (server:
// services/apiKeys/oauth.ts). Claude sends the user here from « Connect »;
// signed out → login, then back here (utils/oauthReturn). Approving lends the
// signed-in user's rights, within the connector's scopes and sites.

const ERRORS: Record<string, string> = {
  oauthInvalidClient: 'This connector does not exist any more, has expired or its account is being deleted.',
  oauthInvalidRedirect: 'This application is not allowed to use an Oblimint connector.',
  oauthInvalidRequest: 'The authorization request is incomplete (PKCE missing).',
  oauthNoAccess: 'Your account has no access to the hosting account of this connector: sign in with an account that has.',
};

export function OAuthAuthorizePage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, isInitialized } = useAuthStore();
  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(location.search)), [location.search]);

  useEffect(() => {
    if (!user) return;
    clearOAuthReturn();
    oauthApi.info(location.search)
      .then(setInfo)
      .catch((err: { response?: { data?: { code?: string; error?: string } } }) => {
        const code = err.response?.data?.code ?? '';
        setError(t(`oauth.errors.${code}`) || ERRORS[code] || err.response?.data?.error || (t('oauth.loadFailed') || 'The authorization request could not be read.'));
      });
  }, [user, location.search, t]);

  if (!isInitialized) {
    return <div className="flex min-h-dvh items-center justify-center bg-bg-primary"><LoadingSpinner size="lg" /></div>;
  }
  if (!user) {
    rememberOAuthReturn(`${location.pathname}${location.search}`);
    return <Navigate to="/login" replace />;
  }

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    try {
      window.location.assign(await oauthApi.decide(params, approve));
    } catch (err) {
      const e = err as { response?: { data?: { code?: string; error?: string } } };
      const code = e.response?.data?.code ?? '';
      setError(t(`oauth.errors.${code}`) || ERRORS[code] || e.response?.data?.error || (t('oauth.failed') || 'The authorization failed.'));
      setBusy(null);
    }
  };
  const scopeLabel = (s: ApiKeyScope) => t(`apiKeys.scopes.${s}.label`) || SCOPE_FALLBACK[s][0];

  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Logo className="mx-auto mb-3 h-16 w-16" />
          <h1 className="text-lg font-semibold text-text-primary">{t('oauth.title') || 'Connect an application'}</h1>
        </div>
        <div className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5">
          {error ? (
            <p className="flex items-start gap-2 text-sm text-red-400"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>
          ) : !info ? (
            <div className="flex justify-center p-6"><LoadingSpinner /></div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <Plug className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <p className="text-sm text-text-primary">
                  {t('oauth.request', {
                    client: info.redirectHost, name: info.connector.name, account: info.connector.primaryDomain || info.connector.accountUsername,
                    defaultValue: '{{client}} asks to use the connector « {{name}} » on the hosting account {{account}}.',
                  })}
                </p>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('oauth.rights') || 'It will be able to'}</div>
                {info.scopes.length ? (
                  <ul className="space-y-1">
                    {info.scopes.map((s) => <li key={s} className="flex items-center gap-2 text-sm text-text-secondary"><Check className="h-3.5 w-3.5 text-status-up" />{scopeLabel(s)}</li>)}
                  </ul>
                ) : <p className="text-sm text-text-secondary">{t('oauth.readOnly') || 'Only read the sites (no right of the connector is held by your account).'}</p>}
                {info.missingScopes.length > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {t('oauth.missing', { list: info.missingScopes.map(scopeLabel).join(', '), defaultValue: 'Left out, your account does not hold them: {{list}}.' })}
                  </p>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('oauth.sites') || 'On'}</div>
                <p className="text-sm text-text-secondary">
                  {info.siteScope === 'all'
                    ? (t('apiKeys.allSites') || 'Every site of the account')
                    : info.sites.length ? info.sites.map((s) => s.name).join(', ') : (t('apiKeys.noSiteYet') || 'No site yet (only the ones it will create)')}
                </p>
              </div>
              <p className="flex items-start gap-2 rounded-lg bg-accent/5 p-2.5 text-[11px] text-text-secondary">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                {t('oauth.asUser', { user: user.displayName || user.username, defaultValue: 'It acts as you ({{user}}), never beyond your own rights; every action is in the audit log. End it at any time from Access keys.' })}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" loading={busy === 'deny'} disabled={busy !== null} onClick={() => void decide(false)}>{t('oauth.deny') || 'Deny'}</Button>
                <Button loading={busy === 'approve'} disabled={busy !== null} onClick={() => void decide(true)}>{t('oauth.approve') || 'Authorize'}</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
