import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Mail } from 'lucide-react';
import { Logo } from '@/components/common/Logo';
import { ApiError, wmApi } from '../api';
import { useWebmail } from '../store';
import { LanguageThemeBar } from './Preferences';
import { PillButton } from './ui';

/** Address + password login (mailbox owners without panel access). */
export function LoginScreen({ notice }: { notice?: string | null }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice ?? null);
  const setSession = useWebmail((s) => s.setSession);
  const setPhase = useWebmail((s) => s.setPhase);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      // Fresh pre-login CSRF token (the cookie may have expired while the form was open).
      await wmApi.session();
      const s = await wmApi.login(address.trim(), password);
      setPassword('');
      setSession(s);
      setPhase('ready');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      setError(
        code === 'invalidCredentials' ? (t('wm.login.invalid') || 'Wrong address or password.')
          : code === 'tooManyAttempts' ? (t('wm.login.tooMany') || 'Too many failed attempts. Try again later.')
            : code === 'unavailable' ? (t('wm.login.unavailable') || 'The webmail is not available right now.')
              : (t('wm.errors.network') || 'The server could not be reached.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wm-app flex h-full flex-col items-center justify-center overflow-y-auto bg-bg-primary px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Logo className="h-9" />
          <div className="flex items-center gap-1.5 rounded-[7px] bg-accent/15 px-2.5 py-1 text-[12px] font-semibold text-accent">
            <span className="h-2 w-2 rounded-full bg-obli-mint shadow-[0_0_8px_#98E8C8]" />
            {t('wm.title') || 'Webmail'}
          </div>
        </div>
        <form onSubmit={(e) => { void submit(e); }} className="wm-card space-y-4 rounded-[14px] bg-bg-secondary p-6">
          <h1 className="text-[20px] font-semibold text-text-primary">{t('wm.login.title') || 'Sign in to your mailbox'}</h1>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-text-secondary">{t('wm.login.address') || 'Email address'}</span>
            <div className="relative">
              <Mail size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="email" autoComplete="username" required autoFocus value={address} onChange={(e) => setAddress(e.target.value)}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="w-full rounded-[7px] bg-bg-tertiary py-2.5 pl-9 pr-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60 coarse:min-h-10"
                placeholder="name@example.org"
              />
            </div>
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-text-secondary">{t('wm.login.password') || 'Password'}</span>
            <div className="relative">
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-[7px] bg-bg-tertiary py-2.5 pl-9 pr-3 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60 coarse:min-h-10"
              />
            </div>
          </label>
          {error && <p role="alert" className="wm-warn-bg wm-warn-rail rounded-[7px] px-3 py-2 text-[13px] text-text-primary">{error}</p>}
          <PillButton type="submit" variant="primary" className="h-10 w-full" loading={busy}>{t('wm.login.submit') || 'Sign in'}</PillButton>
        </form>
        <div className="mt-6 flex justify-center"><LanguageThemeBar /></div>
      </div>
    </div>
  );
}
