import { useState, useEffect, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Save, KeyRound, CheckCircle2, AlertTriangle, QrCode, Palette, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { profileApi } from '@/api/profile.api';
import { authApi } from '@/api/auth.api';
import { twoFactorApi, type TwoFactorStatus } from '@/api/twoFactor.api';
import { isStepUpHandled } from '@/api/client';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { ThemePicker } from '@/components/ThemePicker';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { applyTheme, loadSavedTheme, type AppTheme } from '@/utils/theme';
import { SUPPORTED_LANGUAGES, setLanguage } from '@/i18n';

// A cancelled 2FA / password prompt, or a failure the api client already
// reported, needs no extra toast.
const isQuietStepUpError = (err: unknown): boolean => isStepUpHandled(err);

export function ProfilePage() {
  const { t } = useTranslation();
  const { user: sessionUser, requires2faSetup } = useAuthStore();
  // SSO (Obligate) account: profile, password and 2FA live in Obligate.
  const isSso = sessionUser?.foreignSource === 'obligate';
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);
  const [ssoChecked, setSsoChecked] = useState(!isSso);

  useEffect(() => {
    if (!isSso) return;
    authApi.ssoConfig()
      .then((cfg) => setObligateUrl(cfg.obligateUrl ?? sessionUser?.foreignSourceUrl ?? null))
      .catch(() => setObligateUrl(sessionUser?.foreignSourceUrl ?? null))
      .finally(() => setSsoChecked(true));
  }, [isSso, sessionUser?.foreignSourceUrl]);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Theme state — initialise from localStorage so the picker shows the active theme immediately
  const [preferredTheme, setPreferredTheme] = useState<AppTheme>(loadSavedTheme);

  // 2FA state
  const [tfaStatus, setTfaStatus] = useState<TwoFactorStatus | null>(null);
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpSaving, setTotpSaving] = useState(false);

  useEffect(() => {
    profileApi.get().then((profile) => {
      setDisplayName(profile.displayName || '');
      setEmail(profile.email || '');
      setPreferredLanguage(profile.preferredLanguage || '');
      if (profile.preferences?.preferredTheme) {
        setPreferredTheme(profile.preferences.preferredTheme);
        applyTheme(profile.preferences.preferredTheme);
      }
    }).catch(() => {});
    twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
  }, []);

  const handleProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await profileApi.update({
        displayName: displayName || null,
        ...(isSso ? {} : { email: email || null }),
        preferredLanguage: preferredLanguage || undefined,
      });
      toast.success(t('profile.profileUpdated') || 'Profile updated');
    } catch {
      toast.error(t('profile.failedProfile') || 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error(t('profile.password.mismatch') || 'Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      toast.error(t('profile.password.tooShort') || 'Password must be at least 8 characters');
      return;
    }
    setSavingPassword(true);
    try {
      await profileApi.changePassword(currentPassword, newPassword);
      toast.success(t('profile.password.changed') || 'Password changed');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      if (isStepUpHandled(err)) return;
      const msg = err?.response?.data?.error || t('profile.password.failed') || 'Failed to change password';
      toast.error(msg);
    } finally {
      setSavingPassword(false);
    }
  };

  const handleThemeChange = async (theme: AppTheme) => {
    setPreferredTheme(theme);
    applyTheme(theme); // apply immediately for live preview
    try {
      await profileApi.update({ preferences: { preferredTheme: theme } });
      toast.success(t('profile.appearance.saved') || 'Theme saved');
    } catch {
      toast.error(t('profile.appearance.failed') || 'Failed to save theme');
    }
  };

  const handleLanguageChange = async (code: string) => {
    setPreferredLanguage(code);
    setLanguage(code);
    try {
      await profileApi.update({ preferredLanguage: code });
    } catch {
      // non-critical, ignore
    }
  };

  // ── SSO account: everything is managed in Obligate ─────────────────────
  if (isSso) {
    if (!ssoChecked) {
      return <div className="flex justify-center py-16"><LoadingSpinner /></div>;
    }
    const accountUrl = obligateUrl ? `${obligateUrl.replace(/\/+$/, '')}/account` : null;
    return (
      <div className="p-3 sm:p-4 lg:p-6 max-w-2xl mx-auto">
        <div className="bg-bg-secondary rounded-lg p-4 sm:p-6 text-center">
          <h2 className="text-lg font-medium text-text-primary mb-2">{t('profile.sso.title') || 'Profile managed by Obligate'}</h2>
          <p className="text-sm text-text-secondary mb-4">
            {t('profile.sso.body') || 'Your profile, password, and preferences are managed centrally through Obligate SSO.'}
          </p>
          {accountUrl && (
            <a
              href={accountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 coarse:py-3 bg-accent hover:bg-accent-hover text-white rounded-md font-medium text-sm transition-colors"
            >
              <ExternalLink size={14} />
              {t('profile.sso.open') || 'Open Obligate Profile'}
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <PageContainer>
      <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary mb-6">{t('profile.title') || 'Profile'}</h1>

      {/* Profile section */}
      <form onSubmit={handleProfileSubmit} className="mb-8">
        <div className="rounded-lg bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <User size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.sectionProfile') || 'Profile'}
            </h2>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">{t('profile.usernameLabel') || 'Username'}</label>
            <p className="text-sm text-text-primary font-mono bg-bg-tertiary rounded-md px-3 py-2">
              {sessionUser?.username}
            </p>
          </div>

          <Input
            label={t('profile.displayNameLabel') || 'Display name'}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder') || 'Your name'}
          />

          <div>
            <Input
              label={t('profile.emailLabel') || 'E-mail'}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('profile.emailPlaceholder') || 'you@example.com'}
            />
            <p className="mt-1 text-xs text-text-muted">{t('profile.emailHint') || 'Used for notifications and password recovery.'}</p>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">{t('profile.preferredLanguage') || 'Language'}</label>
            <select
              value={preferredLanguage}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName} ({lang.name})
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" loading={savingProfile}>
            <Save size={16} className="mr-1.5" />
            {t('profile.saveProfile') || 'Save profile'}
          </Button>
        </div>
      </form>

      {/* Password section */}
      <form onSubmit={handlePasswordSubmit} className="mb-8">
        <div className="rounded-lg bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.password.title') || 'Change password'}
            </h2>
          </div>
          <Input
            label={t('profile.password.current') || 'Current password'}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder={t('profile.password.currentPlaceholder') || 'Enter current password'}
            required
          />
          <Input
            label={t('profile.password.new') || 'New password'}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('profile.password.newPlaceholder') || 'Enter new password'}
            required
          />
          <Input
            label={t('profile.password.confirm') || 'Confirm new password'}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('profile.password.confirmPlaceholder') || 'Confirm new password'}
            required
          />
          <Button type="submit" loading={savingPassword}>
            <KeyRound size={16} className="mr-1.5" />
            {t('profile.password.change') || 'Change password'}
          </Button>
        </div>
      </form>

      {/* Appearance section */}
      <div className="mb-8">
        <div className="rounded-lg bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Palette size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.appearance.title') || 'Appearance'}
            </h2>
          </div>
          <p className="text-xs text-text-muted -mt-2">{t('profile.appearance.subtitle') || 'Choose the theme of the interface.'}</p>
          <ThemePicker value={preferredTheme} onChange={handleThemeChange} />
        </div>
      </div>

      {/* Security / 2FA section (TOTP only) */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">{t('profile.security.title') || 'Two-factor authentication'}</h2>

        {requires2faSetup && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
            <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-300">
              {t('profile.security.force2faWarning') || 'Your administrator requires two-factor authentication. Please set it up now.'}
            </p>
          </div>
        )}

        <div className="rounded-lg bg-bg-secondary">
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <QrCode size={16} className="text-text-muted" />
                <p className="text-sm font-medium text-text-primary">{t('profile.security.totp') || 'Authenticator app (TOTP)'}</p>
                {tfaStatus?.totpEnabled && <CheckCircle2 size={14} className="text-green-400" />}
              </div>
              {tfaStatus?.totpEnabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await twoFactorApi.totpDisable();
                      setTfaStatus((s) => s ? { ...s, totpEnabled: false } : s);
                      toast.success(t('profile.security.totpDisabled') || 'Authenticator app disabled');
                    } catch (err) { if (!isQuietStepUpError(err)) toast.error(t('profile.security.failedDisableTotp') || 'Failed to disable the authenticator app'); }
                  }}
                >
                  {t('common.disable') || 'Disable'}
                </Button>
              ) : !totpSetupData ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      const data = await twoFactorApi.totpSetup();
                      setTotpSetupData(data);
                      setTotpCode('');
                    } catch (err) { if (!isQuietStepUpError(err)) toast.error(t('profile.security.failedStartTotp') || 'Failed to start the setup'); }
                  }}
                >
                  {t('common.enable') || 'Enable'}
                </Button>
              ) : null}
            </div>

            {!tfaStatus?.totpEnabled && totpSetupData && (
              <div className="space-y-3">
                <p className="text-xs text-text-muted">{t('profile.security.totpScanDesc') || 'Scan this QR code with your authenticator app, then enter the 6-digit code it shows.'}</p>
                <img src={totpSetupData.qrDataUrl} alt={t('profile.security.qrAlt') || 'TOTP QR code'} className="w-40 h-40 rounded-lg bg-white p-1" />
                <p className="text-xs text-text-muted font-mono break-all">{t('profile.security.totpSecret', { secret: totpSetupData.secret, defaultValue: 'Secret: {{secret}}' })}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[8rem]">
                    <Input
                      label={t('profile.security.verificationCode') || 'Verification code'}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                    />
                  </div>
                  <Button
                    disabled={totpCode.length !== 6 || totpSaving}
                    loading={totpSaving}
                    onClick={async () => {
                      setTotpSaving(true);
                      try {
                        await twoFactorApi.totpEnable(totpCode);
                        setTfaStatus((s) => ({ ...(s ?? { totpEnabled: false }), totpEnabled: true }));
                        setTotpSetupData(null);
                        setTotpCode('');
                        toast.success(t('profile.security.totpEnabled') || 'Authenticator app enabled');
                      } catch (err) {
                        if ((err as { response?: { status?: number } } | null)?.response?.status === 409) {
                          toast.error(t('profile.security.totpChangedRestart') || 'Two-factor authentication was enabled in the meantime. Start again.');
                          setTotpSetupData(null);
                          setTotpCode('');
                          twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
                        } else {
                          toast.error(t('profile.security.invalidCode') || 'Invalid code');
                        }
                      } finally { setTotpSaving(false); }
                    }}
                  >
                    {t('common.confirm') || 'Confirm'}
                  </Button>
                  <Button variant="ghost" onClick={() => { setTotpSetupData(null); setTotpCode(''); }}>{t('common.cancel') || 'Cancel'}</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
