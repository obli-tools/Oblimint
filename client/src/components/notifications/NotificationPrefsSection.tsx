import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { SlidersHorizontal } from 'lucide-react';
import type { NotificationFamily, UserNotificationChannelPref, UserNotificationSettings } from '@oblimint/shared';
import { LOCKED_IN_APP_NOTIFICATION_FAMILIES } from '@oblimint/shared';
import { inboxApi } from '@/api/inbox.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { SettingsBlock } from '@/components/settings/SettingsBlock';
import { familyHint, familyLabel } from './inboxUi';

/**
 * Preferences of the signed-in user: per event family, in the bell and / or
 * by e-mail (the platform's transactional sender, to the profile address).
 * Saved at once on each toggle.
 */
export function NotificationPrefsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<UserNotificationSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    inboxApi.preferences().then(setSettings).catch(() => {
      toast.error(t('inbox.prefsLoadFailed') || 'Failed to load the notification preferences');
    });
  }, [t]);

  const set = async (family: NotificationFamily, patch: Partial<UserNotificationChannelPref>) => {
    if (!settings) return;
    const k = `${family}:${Object.keys(patch)[0]}`;
    setBusy(k);
    const previous = settings;
    setSettings({ ...settings, prefs: { ...settings.prefs, [family]: { ...settings.prefs[family], ...patch } } });
    try {
      setSettings(await inboxApi.savePreferences({ prefs: { [family]: patch } }));
    } catch {
      setSettings(previous);
      toast.error(t('inbox.prefsSaveFailed') || 'Failed to save the notification preferences');
    } finally {
      setBusy(null);
    }
  };

  const emailOk = !!settings?.emailAvailable && !!settings?.emailAddress;
  const emailNote = !settings ? null
    : !settings.emailAvailable ? (t('inbox.emailUnavailable') || 'E-mails are not available: the platform has no e-mail sender configured yet.')
      : !settings.emailAddress ? (t('inbox.emailNoAddress') || 'Add an e-mail address to your profile to receive notifications by e-mail.')
        : t('inbox.emailTo', { email: settings.emailAddress, defaultValue: 'E-mails are sent to {{email}} (your profile).' });

  return (
    <SettingsBlock
      id="preferences"
      icon={<SlidersHorizontal />}
      title={t('inbox.preferences') || 'Notification preferences'}
      description={t('inbox.preferencesHint') || 'Choose, for each kind of event, whether it appears in the bell and whether it is also sent to you by e-mail.'}
    >
      {!settings ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : (
        <>
          {emailNote && <p className="text-xs text-text-muted">{emailNote}</p>}
          <div className="-mx-1 divide-y divide-white/[0.04]">
            <div className="hidden px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:flex">
              <span className="flex-1">{t('inbox.eventFamily') || 'Events'}</span>
              <span className="w-24 text-center">{t('inbox.channelApp') || 'In the panel'}</span>
              <span className="w-24 text-center">{t('inbox.channelEmail') || 'E-mail'}</span>
            </div>
            {settings.families.map((f) => (
              <div key={f} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-3 sm:flex-nowrap">
                <div className="min-w-0 flex-1 max-sm:basis-full">
                  <div className="text-sm font-medium text-text-primary">{familyLabel(t, f)}</div>
                  <div className="text-xs text-text-muted">{familyHint(t, f)}</div>
                </div>
                <div className="flex w-24 justify-center max-sm:w-auto max-sm:justify-start">
                  <ToggleSwitch
                    size="sm"
                    checked={LOCKED_IN_APP_NOTIFICATION_FAMILIES.includes(f) || settings.prefs[f].inApp}
                    disabled={LOCKED_IN_APP_NOTIFICATION_FAMILIES.includes(f) || busy === `${f}:inApp`}
                    onChange={(v) => { void set(f, { inApp: v }); }}
                    label={<span className="sm:hidden">{t('inbox.channelApp') || 'In the panel'}</span>}
                    ariaLabel={`${familyLabel(t, f)} — ${t('inbox.channelApp') || 'In the panel'}`}
                  />
                </div>
                <div className="flex w-24 justify-center max-sm:w-auto max-sm:justify-start">
                  <ToggleSwitch
                    size="sm"
                    checked={settings.prefs[f].email && emailOk}
                    disabled={!emailOk || busy === `${f}:email`}
                    onChange={(v) => { void set(f, { email: v }); }}
                    label={<span className="sm:hidden">{t('inbox.channelEmail') || 'E-mail'}</span>}
                    ariaLabel={`${familyLabel(t, f)} — ${t('inbox.channelEmail') || 'E-mail'}`}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SettingsBlock>
  );
}
