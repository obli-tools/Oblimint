import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, KeyRound, Plus, Smartphone, Trash2 } from 'lucide-react';
import {
  MANUAL_APP_PASSWORD_DAYS, MANUAL_APP_PASSWORD_DEFAULT_DAYS,
  type MailboxDetail, type MailDevice, type MailDeviceCreated, type MailDeviceList, type MailDeviceProtocolSet,
} from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, CopyButton, InfoRow, Pill, inputCls, labelCls, selectCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { mailErrorMessage, mailLoadError, toastMailError } from './mailErrors';

/**
 * « Appareils et mots de passe d'application » of /mail/mailboxes/:id
 * (« Se connecter à Mint », E4 — mail.manage only: the list shows the last
 * check-in address of each device). Live device passwords (MailForge and
 * manual), revoke one / all (ConfirmDialog), create a manual app password
 * (label, lifetime, protocols) whose secret is shown ONCE (copy, then gone:
 * the panel keeps only hashes). OWNED BY MODULE `ui-mail`.
 */
export function MailboxDevicesCard({ box }: { box: MailboxDetail }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [list, setList] = useState<MailDeviceList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<MailDeviceCreated | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await mailApi.listDevices(box.id));
      setError('');
    } catch (err) {
      setError(mailLoadError(t, err, t('mailClient.devices.loadFailed') || 'Failed to load the devices'));
    }
  }, [box.id, t]);
  useEffect(() => { void load(); }, [load]);

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(i18n.language) : null);

  const revoke = async (d: MailDevice) => {
    if (!(await confirm({
      title: t('mailClient.devices.revoke') || 'Revoke',
      message: t('mailClient.devices.revokeConfirm', { name: d.label, defaultValue: 'Revoke “{{name}}”? The device can no longer read or send mail with this mailbox.' }),
      confirmLabel: t('mailClient.devices.revoke') || 'Revoke',
      danger: true,
    }))) return;
    setBusy(d.id);
    try {
      await mailApi.revokeDevices(box.id, { id: d.id });
      toast.success(t('mailClient.devices.revoked') || 'Device revoked');
      await load();
    } catch (err) {
      toastMailError(t, err, t('mailClient.devices.revokeFailed') || 'Failed to revoke the device');
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    const count = list?.items.length ?? 0;
    if (!(await confirm({
      title: t('mailClient.devices.revokeAll') || 'Revoke all',
      message: t('mailClient.devices.revokeAllConfirm', { count, address: box.address, defaultValue: 'Revoke the {{count}} devices of {{address}}?' }),
      confirmLabel: t('mailClient.devices.revokeAll') || 'Revoke all',
      danger: true,
    }))) return;
    setBusy('*');
    try {
      await mailApi.revokeDevices(box.id, { all: true });
      toast.success(t('mailClient.devices.revoked') || 'Device revoked');
      await load();
    } catch (err) {
      toastMailError(t, err, t('mailClient.devices.revokeFailed') || 'Failed to revoke the device');
    } finally {
      setBusy(null);
    }
  };

  const items = list?.items ?? [];
  const full = list ? items.length >= list.max : false;

  return (
    <Card
      title={t('mailClient.devices.title') || 'Devices and app passwords'}
      icon={<Smartphone size={14} className="text-accent" />}
      actions={list ? (
        <>
          <Pill tone={full ? 'amber' : 'muted'}>{t('mailClient.devices.count', { count: items.length, max: list.max, defaultValue: '{{count}} / {{max}}' })}</Pill>
          <Button size="sm" variant="secondary" disabled={full || busy !== null} onClick={() => setCreating(true)}>
            <Plus size={13} className="mr-1.5" />{t('mailClient.devices.create') || 'Create an app password'}
          </Button>
        </>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">{t('mailClient.devices.hint') || 'Each device gets its own password, revocable on its own: the mailbox password does not change.'}</p>
      {error ? (
        <p className="flex items-start gap-2 text-xs text-text-muted"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}</p>
      ) : list === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : items.length === 0 ? (
        <p className="py-2 text-xs text-text-muted">{t('mailClient.devices.empty') || 'No device has its own password for this mailbox.'}</p>
      ) : (
        <div className="space-y-2">
          <TableScroll className="rounded-lg bg-bg-primary">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('mailClient.devices.colName') || 'Device'}</th>
                  <th className={thCls}>{t('mailClient.devices.colFor') || 'For'}</th>
                  <th className={thCls}>{t('mailClient.devices.colCreated') || 'Created'}</th>
                  <th className={thCls}>{t('mailClient.devices.colLastSeen') || 'Last seen'}</th>
                  <th className={thCls}>{t('mailClient.devices.colExpires') || 'Expires'}</th>
                  <th className={thCls}>{t('mailClient.devices.colProtocols') || 'Protocols'}</th>
                  <th className={`${thCls} w-12`}><span className="sr-only">{t('mail.actions') || 'Actions'}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} className="transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-text-primary">{d.label}</span>
                        <Pill tone={d.client === 'mailforge' ? 'accent' : 'muted'}>
                          {d.client === 'mailforge' ? (t('mailClient.devices.typeMailforge') || 'MailForge') : (t('mailClient.devices.typeManual') || 'Manual')}
                        </Pill>
                      </div>
                      <div className="font-mono text-[11px] text-text-muted">{d.id}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">{d.createdFor?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{date(d.createdAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">
                      {d.lastSeenAt ? (
                        <>
                          {date(d.lastSeenAt)}
                          {d.lastSeenIp && <div className="text-[11px] text-text-muted">{d.lastSeenIp}</div>}
                        </>
                      ) : (t('mailClient.devices.neverSeen') || 'Never')}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{date(d.expiresAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs uppercase text-text-secondary">{d.protocols.join(' · ')}</td>
                    <td className="px-4 py-2.5 text-right">
                      <IconButton label={t('mailClient.devices.revoke') || 'Revoke'} icon={<Trash2 size={13} />} disabled={busy !== null} onClick={() => { void revoke(d); }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {items.length > 1 && (
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" loading={busy === '*'} disabled={busy !== null} onClick={() => { void revokeAll(); }}>
                {t('mailClient.devices.revokeAll') || 'Revoke all'}
              </Button>
            </div>
          )}
        </div>
      )}

      {list && (
        <DeviceCreateModal
          open={creating}
          box={box}
          manualMaxDays={list.manualMaxDays}
          pop3AlwaysOpen={list.pop3AlwaysOpen}
          onClose={() => setCreating(false)}
          onCreated={(c) => { setCreating(false); setCreated(c); void load(); }}
        />
      )}
      <DeviceSecretModal created={created} onClose={() => setCreated(null)} />
    </Card>
  );
}

function DeviceCreateModal({ open, box, manualMaxDays, pop3AlwaysOpen, onClose, onCreated }: {
  open: boolean;
  box: MailboxDetail;
  manualMaxDays: number;
  pop3AlwaysOpen: boolean;
  onClose: () => void;
  onCreated: (c: MailDeviceCreated) => void;
}) {
  const { t } = useTranslation();
  const durations = MANUAL_APP_PASSWORD_DAYS.filter((d) => d <= manualMaxDays);
  const defaultDays = durations.includes(MANUAL_APP_PASSWORD_DEFAULT_DAYS) ? MANUAL_APP_PASSWORD_DEFAULT_DAYS : (durations[durations.length - 1] ?? MANUAL_APP_PASSWORD_DAYS[0]);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(defaultDays);
  const [protocols, setProtocols] = useState<MailDeviceProtocolSet>('imapSmtp');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setLabel(''); setDays(defaultDays); setProtocols('imapSmtp'); setError(''); } }, [open, defaultDays]);

  const durationLabel = (d: number) => (d === 90 ? (t('mailClient.devices.duration90') || '90 days')
    : d === 365 ? (t('mailClient.devices.duration365') || '1 year')
      : d === 1095 ? (t('mailClient.devices.duration1095') || '3 years') : `${d}`);
  const valid = label.trim().length > 0 && label.trim().length <= 64 && durations.includes(days);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      onCreated(await mailApi.createDevice(box.id, { label: label.trim(), days, protocols }));
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mailClient.devices.createFailed') || 'Failed to create the app password'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mailClient.devices.create') || 'Create an app password'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>{t('mailClient.devices.createSubmit') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="mbdev-label">{t('mailClient.devices.createLabel') || 'Device name'}</label>
          <input id="mbdev-label" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} placeholder={t('mailClient.devices.createLabelPlaceholder') || 'Phone of Claire'} className={inputCls} autoComplete="off" />
        </div>
        <div>
          <label className={labelCls} htmlFor="mbdev-days">{t('mailClient.devices.createDuration') || 'Lifetime'}</label>
          <select id="mbdev-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls}>
            {durations.map((d) => <option key={d} value={d}>{durationLabel(d)}</option>)}
          </select>
        </div>
        <div>
          <span className={labelCls}>{t('mailClient.devices.createProtocols') || 'Protocols'}</span>
          <SegmentedTabs<MailDeviceProtocolSet>
            size="sm"
            value={protocols}
            onChange={setProtocols}
            tabs={[
              { id: 'imapSmtp', label: t('mailClient.devices.protocolsImapSmtp') || 'IMAP and SMTP' },
              { id: 'all', label: t('mailClient.devices.protocolsAll') || 'IMAP, POP3 and SMTP' },
            ]}
          />
          {pop3AlwaysOpen && protocols === 'imapSmtp' && (
            <p className="mt-1 text-xs text-text-muted">{t('mailClient.devices.pop3Stalwart') || 'On this server, POP3 is always open.'}</p>
          )}
        </div>
        <p className="text-xs text-text-muted">{t('mailClient.devices.createHint', { address: box.address, defaultValue: 'Login: {{address}}. The password is generated by the server and shown once.' })}</p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/** Shows the new secret ONCE (MA4): the parent drops it in onClose — never stored elsewhere. */
function DeviceSecretModal({ created, onClose }: { created: MailDeviceCreated | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={created !== null}
      onClose={onClose}
      title={t('mailClient.devices.createdTitle') || 'App password created'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="sm"
      phoneLayout="sheet"
      closeOnBackdrop={false}
      footer={<Button size="sm" onClick={onClose}>{t('mail.password.revealDone') || 'I have saved it'}</Button>}
    >
      {created && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{created.device.label}</p>
          <div className="rounded-lg bg-bg-primary p-2.5">
            <InfoRow label={t('mailClient.devices.usernameLabel') || 'Username'} mono>
              <span className="inline-flex items-center gap-1 break-all">{created.username}<CopyButton text={created.username} /></span>
            </InfoRow>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-bg-primary px-3 py-2">
            <code className={cn('min-w-0 flex-1 break-all font-mono text-sm text-text-primary')}>{created.password}</code>
            <CopyButton text={created.password} />
          </div>
          <p className="flex items-start gap-2 rounded-md bg-amber-400/5 p-2 text-xs text-amber-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t('mailClient.devices.shownOnce') || 'Copy it now: it will never be shown again.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
