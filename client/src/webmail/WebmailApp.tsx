import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WEBMAIL_SSO_FRAGMENT } from '@oblimint/shared';
import { Logo } from '@/components/common/Logo';
import { ApiError, setUnauthenticatedHandler, wmApi } from './api';
import { LoginScreen } from './components/LoginScreen';
import { MailShell } from './components/MailShell';
import { LanguageThemeBar } from './components/Preferences';
import { PillButton, Spinner } from './components/ui';
import { Toasts } from './components/Toasts';
import i18n from './i18n';
import { rememberPanelLink } from './panelLink';
import { useWebmail } from './store';

// Root of the webmail SPA: session check, panel single sign-on (token in the
// URL fragment, removed at once), new-mail refresh (event stream relayed by
// the proxy, else polling).
// SSO is ALWAYS confirmed: the page first asks the server which mailbox the
// token opens (without using it) and shows that address; only "Open" redeems
// it. A link someone minted for THEIR mailbox and sent to a victim therefore
// never logs the victim silently into the attacker's mailbox (login CSRF:
// drafts and sent mail would land there).

const POLL_MS = 60_000;

/** Token of a panel SSO link (https://<host>/#sso=<token>), removed from the address bar. */
function takeSsoToken(): string | null {
  const m = new RegExp(`(?:^#|&)${WEBMAIL_SSO_FRAGMENT}=([A-Za-z0-9_-]{20,100})(?:&|$)`).exec(window.location.hash);
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m ? m[1] : null;
}

const ssoInvalidText = () => i18n.t('wm.sso.invalid') || 'This link has expired or was already used: open the webmail again from the panel.';

async function redeem(token: string): Promise<void> {
  const s = useWebmail.getState();
  try {
    const session = await wmApi.sso(token);
    rememberPanelLink(session);
    s.reset();
    s.setSession(session);
    s.setPhase('ready');
  } catch (err) {
    // The open session (if any) is kept by the server when the token is refused.
    s.setPhase(s.session?.authenticated ? 'ready' : 'login');
    s.toast('error', err instanceof ApiError && err.code === 'ssoInvalid' ? ssoInvalidText() : (i18n.t('wm.errors.network') || 'The server could not be reached.'));
  }
}

function SsoConfirm() {
  const { t } = useTranslation();
  const session = useWebmail((s) => s.session);
  const token = useWebmail((s) => s.ssoToken);
  const target = useWebmail((s) => s.ssoAddress) ?? '';
  const { setSso, setPhase } = useWebmail.getState();
  const [busy, setBusy] = useState(false);
  const current = session?.authenticated ? session.address ?? '' : '';
  const cancel = () => { setSso(null, null); setPhase(current ? 'ready' : 'login'); };
  return (
    <div className="wm-app flex h-full flex-col items-center justify-center overflow-y-auto bg-bg-primary px-4 py-8">
      <div className="wm-card w-full max-w-md space-y-4 rounded-[14px] bg-bg-secondary p-6">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7" />
          <span className="flex items-center gap-1.5 rounded-[7px] bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent"><span className="h-1.5 w-1.5 rounded-full bg-obli-mint" />{t('wm.title') || 'Webmail'}</span>
        </div>
        <h1 className="text-[19px] font-semibold text-text-primary">{t('wm.sso.openTitle') || 'Open this mailbox?'}</h1>
        <p className="break-all rounded-[10px] bg-bg-tertiary px-3 py-2.5 font-mono text-[13px] text-text-primary">{target}</p>
        {current ? (
          <p className="text-sm text-text-secondary">
            {t('wm.sso.text', { address: current }) || `A webmail session is already open in this browser (${current}). Continuing closes it and opens the mailbox requested from the Oblimint panel.`}
          </p>
        ) : (
          <p className="text-sm text-text-secondary">{t('wm.sso.openText') || 'This link opens the mailbox above, requested from the Oblimint panel.'}</p>
        )}
        <p className="text-sm text-text-muted">{t('wm.sso.warningAddress') || 'Continue only if this is YOUR mailbox and you opened this link yourself from the panel: what you write or send would go to this mailbox.'}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <PillButton variant="ghost" onClick={cancel}>{current ? (t('wm.sso.keep') || 'Keep my session') : (t('wm.common.cancel') || 'Cancel')}</PillButton>
          <PillButton variant="primary" loading={busy} onClick={() => { setBusy(true); const tk = token; setSso(null, null); if (tk) void redeem(tk); }}>{t('wm.sso.open') || 'Open this mailbox'}</PillButton>
        </div>
      </div>
      <LanguageThemeBar className="mt-6" />
    </div>
  );
}

export function WebmailApp() {
  const phase = useWebmail((s) => s.phase);
  const session = useWebmail((s) => s.session);

  // Boot: SSO token first (fragment), then the session.
  useEffect(() => {
    const s = useWebmail.getState();
    setUnauthenticatedHandler(() => {
      const st = useWebmail.getState();
      if (st.phase !== 'ready') return;
      st.reset();
      st.setPhase('login');
      st.toast('error', i18n.t('wm.errors.sessionEnded') || 'Your session has ended: sign in again.');
    });
    const token = takeSsoToken();
    void (async () => {
      try {
        const info = await wmApi.session();
        if (token) {
          // Which mailbox does it open? (the token is not used by this question)
          const target = await wmApi.ssoTarget(token).catch((err: unknown) => {
            s.toast('error', err instanceof ApiError && err.code === 'ssoInvalid' ? ssoInvalidText() : (i18n.t('wm.errors.network') || 'The server could not be reached.'));
            return null;
          });
          if (target) {
            if (info.authenticated) s.setSession(info);
            s.setSso(token, target.address);
            s.setPhase('ssoConfirm');
            return;
          }
        }
        if (info.authenticated) {
          s.setSession(info);
          s.setPhase('ready');
        } else {
          s.setPhase('login');
        }
      } catch {
        s.setPhase('login');
        s.toast('error', i18n.t('wm.errors.network') || 'The server could not be reached.');
      }
    })();
  }, []);

  // Ready: folders + list, then new-mail refresh.
  useEffect(() => {
    if (phase !== 'ready' || !session?.authenticated) return;
    const st = useWebmail.getState();
    let stopped = false;
    void st.refreshMailboxes().then(() => st.reloadList()).catch((err) => st.toast('error', (err as Error).message));
    const refresh = () => {
      const s = useWebmail.getState();
      if (s.phase !== 'ready') return;
      void s.refreshMailboxes(true).then(() => s.reloadList(true)).catch(() => undefined);
    };
    let poll: number | null = null;
    let es: EventSource | null = null;
    let failures = 0;
    let debounce: number | null = null;
    const startPolling = () => { if (!poll) poll = window.setInterval(refresh, POLL_MS); };
    const connect = () => {
      if (stopped) return;
      es = wmApi.events();
      es.addEventListener('state', () => {
        failures = 0;
        if (debounce) window.clearTimeout(debounce);
        debounce = window.setTimeout(refresh, 500);
      });
      es.onerror = () => {
        es?.close();
        es = null;
        failures++;
        if (failures >= 3) { startPolling(); return; }
        window.setTimeout(connect, 5000 * failures);
      };
    };
    if (typeof EventSource !== 'undefined') connect(); else startPolling();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      es?.close();
      if (poll) window.clearInterval(poll);
      if (debounce) window.clearTimeout(debounce);
      window.removeEventListener('focus', onFocus);
    };
  }, [phase, session?.authenticated, session?.address]);

  return (
    <>
      {phase === 'loading' && (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg-primary">
          <Logo className="h-7 opacity-90" />
          <Spinner className="h-5 w-5 text-accent" />
        </div>
      )}
      {phase === 'login' && <LoginScreen />}
      {phase === 'ssoConfirm' && <SsoConfirm />}
      {phase === 'ready' && <MailShell />}
      <Toasts />
    </>
  );
}
