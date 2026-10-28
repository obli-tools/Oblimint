import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bell, Loader2, Pencil, Plus, TestTube2, Trash2 } from 'lucide-react';
import type { NotificationChannel } from '@oblimint/shared';
import { notificationsApi } from '@/api/usage.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, apiErrorCode } from '@/components/hosting/hostingUi';
import { apiErrorDetails, opsErrorMessage, toastOpsError } from '@/components/usage/opsErrors';
import { SettingsBlock } from '@/components/settings/SettingsBlock';
import { NotificationChannelModal } from './NotificationChannelModal';
import { channelTypeLabel, eventLabel } from './notificationsUi';

/**
 * Notification channels of the current workspace (quota alerts, failures,
 * bans…) — Obliance's notification page layout: list with inline test / edit
 * / delete (a « ⋯ » menu on phones) and a form per channel type.
 */
export function NotificationChannelsSection() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setChannels(await notificationsApi.list());
      setError(null);
    } catch (err) {
      setChannels([]);
      setError(opsErrorMessage(t, err, 'notifications', t('notifications.loadFailed') || 'Failed to load the notification channels'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const replace = (ch: NotificationChannel) => setChannels((cur) => {
    const list = cur ?? [];
    return list.some((c) => c.id === ch.id) ? list.map((c) => (c.id === ch.id ? ch : c)) : [...list, ch];
  });

  const test = async (ch: NotificationChannel) => {
    setTesting(ch.id);
    try {
      const r = await notificationsApi.test(ch.id);
      if (r.ok) toast.success(t('notifications.testSent') || 'Test notification sent');
      else toast.error(t('notifications.testFailedWith', { error: r.error ?? '?', defaultValue: 'The test failed: {{error}}' }), { duration: 8000 });
      void load();
    } catch (err) {
      // A failed delivery is a 502 notificationFailed carrying the result: show its cause.
      const cause = apiErrorCode(err) === 'notificationFailed' ? apiErrorDetails(err).error : undefined;
      if (typeof cause === 'string' && cause) {
        toast.error(t('notifications.testFailedWith', { error: cause, defaultValue: 'The test failed: {{error}}' }), { duration: 8000 });
      } else {
        toastOpsError(t, err, 'notifications', t('notifications.testFailed') || 'The test failed');
      }
      void load(); // lastError / lastSentAt changed server side
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (ch: NotificationChannel, enabled: boolean) => {
    setBusy(ch.id);
    try {
      replace(await notificationsApi.update(ch.id, { enabled }));
    } catch (err) {
      toastOpsError(t, err, 'notifications', t('notifications.saveFailed') || 'Failed to save the channel');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (ch: NotificationChannel) => {
    if (!(await confirm({
      title: t('notifications.deleteTitle') || 'Delete the channel',
      message: t('notifications.deleteConfirm', { name: ch.name, defaultValue: 'Delete the channel « {{name}} »? Its events are no longer sent anywhere.' }),
      confirmLabel: t('common.delete') || 'Delete',
      danger: true,
    }))) return;
    setBusy(ch.id);
    try {
      await notificationsApi.delete(ch.id);
      setChannels((cur) => (cur ?? []).filter((c) => c.id !== ch.id));
      toast.success(t('notifications.deleted') || 'Channel deleted');
    } catch (err) {
      toastOpsError(t, err, 'notifications', t('notifications.deleteFailed') || 'Failed to delete the channel');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsBlock
      id="settings-notifications"
      icon={<Bell />}
      title={t('notifications.sectionTitle') || 'Notifications'}
      description={t('notifications.sectionDescription') || 'Where quota alerts, failures and bans of this workspace are sent.'}
      headerExtra={<Button size="sm" onClick={() => setEditing('new')}><Plus size={14} className="mr-1.5" />{t('notifications.newChannel') || 'New channel'}</Button>}
    >
      {channels === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : channels.length === 0 ? (
        <div className="py-8 text-center">
          <Bell size={28} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">{error ?? (t('notifications.empty') || 'No notification channel yet.')}</p>
          {!error && <p className="mt-1 text-sm text-text-muted">{t('notifications.emptyHint') || 'Add an e-mail, webhook, Discord or Telegram channel to be told when an account reaches its quota.'}</p>}
        </div>
      ) : (
        <div className="-mx-1 divide-y divide-white/[0.04]">
          {channels.map((ch) => (
            <div key={ch.id} className="group px-1 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
                <div className="min-w-0 flex-1 max-sm:basis-full">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{ch.name}</span>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">{channelTypeLabel(t, ch.type)}</span>
                    {!ch.enabled && <Pill tone="muted">{t('notifications.disabled') || 'disabled'}</Pill>}
                    {ch.lastError && <Pill tone="amber" title={ch.lastError}>{t('notifications.lastFailed') || 'last send failed'}</Pill>}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-text-muted" title={ch.events.map((e) => eventLabel(t, e)).join(', ')}>
                    {ch.events.map((e) => eventLabel(t, e)).join(' · ')}
                  </div>
                  {ch.lastSentAt && <div className="font-mono text-[11px] text-text-muted">{t('notifications.lastSent', { date: new Date(ch.lastSentAt).toLocaleString(i18n.language), defaultValue: 'last sent {{date}}' })}</div>}
                </div>
                <ToggleSwitch size="sm" checked={ch.enabled} disabled={busy === ch.id} onChange={(v) => { void toggle(ch, v); }} ariaLabel={t('notifications.form.enabled') || 'Enabled'} />
                <IconButton
                  label={t('notifications.sendTest') || 'Send a test'}
                  icon={testing === ch.id ? <Loader2 size={14} className="animate-spin" /> : <TestTube2 size={14} />}
                  variant="plain"
                  onClick={() => { if (testing !== ch.id) void test(ch); }}
                  aria-disabled={testing === ch.id}
                  className="hidden shrink-0 transition-opacity hover:text-accent md:inline-flex can-hover:opacity-0 can-hover:group-hover:opacity-100"
                />
                <IconButton
                  label={t('common.edit') || 'Edit'}
                  icon={<Pencil size={14} />}
                  variant="plain"
                  onClick={() => setEditing(ch)}
                  className="hidden shrink-0 transition-opacity md:inline-flex can-hover:opacity-0 can-hover:group-hover:opacity-100"
                />
                <IconButton
                  label={t('common.delete') || 'Delete'}
                  icon={<Trash2 size={14} />}
                  variant="plain"
                  disabled={busy === ch.id}
                  onClick={() => { void remove(ch); }}
                  className="hidden shrink-0 transition-opacity hover:text-status-down md:inline-flex can-hover:opacity-0 can-hover:group-hover:opacity-100"
                />
                <ActionMenu
                  sheetTitle={ch.name}
                  triggerClassName="md:hidden shrink-0 ml-auto"
                  items={[
                    { key: 'test', icon: <TestTube2 size={16} />, label: t('notifications.sendTest') || 'Send a test', onClick: () => { void test(ch); }, disabled: testing === ch.id },
                    { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(ch) },
                    { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(ch); }, danger: true, separator: true },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <NotificationChannelModal
        open={editing !== null}
        channel={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(ch) => {
          const created = editing === 'new';
          setEditing(null);
          replace(ch);
          toast.success(created ? (t('notifications.created') || 'Channel created') : (t('notifications.updated') || 'Channel saved'));
        }}
      />
    </SettingsBlock>
  );
}
