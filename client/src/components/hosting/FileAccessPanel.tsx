import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, FolderOpen, HardDrive, KeyRound, Plus, Power, RefreshCw, Server, Terminal, Timer, Trash2, Upload,
} from 'lucide-react';
import type { AccountSshKey, FileAccessInfo, FileServerMode, FileServerStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/utils/cn';
import {
  Card, CopyButton, EmptyState, InfoRow, Pill, inputCls, labelCls, payloadNumber, hostingErrorMessage,
  toastHostingError, useHostingEvents,
} from './hostingUi';
import { formatCountdown, layoutMatchesSlug, looksLikeSshPublicKey, sftpCommand, sshKeyComment } from './hostingFormat';

// Consumed by ui-sites (Site detail → "File access" tab) and by the account
// detail page. Shows the SFTP access of an account (host, port, username,
// password reset shown once, SSH keys, mode always / on-demand / off,
// on-demand activation timer) and, when siteSlug is given, highlights
// /staging/<slug>/ and /data/<slug>/ of that site.
export interface FileAccessPanelProps {
  accountId: number;
  /** Highlight the folders of this site. */
  siteSlug?: string;
}

/** On-demand activation durations offered (minutes; server accepts 15–1440). */
const DURATIONS = [30, 120, 480, 1440] as const;

function mergeStatus(info: FileAccessInfo, s: FileServerStatus): FileAccessInfo {
  return { ...info, mode: s.mode, running: s.running, activeUntil: s.activeUntil, port: s.port ?? info.port };
}

export function FileAccessPanel({ accountId, siteSlug }: FileAccessPanelProps) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const manage = can('files.manage', accountId);

  const [info, setInfo] = useState<FileAccessInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [password, setPassword] = useState<string | null>(null);
  const [keyModal, setKeyModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const [access, status] = await Promise.allSettled([accountsApi.fileAccess(accountId), accountsApi.fileServer(accountId)]);
      if (access.status === 'rejected') throw access.reason;
      setInfo(status.status === 'fulfilled' ? mergeStatus(access.value, status.value) : access.value);
      setUnavailable(null);
    } catch (err) {
      setInfo(null);
      // No toast: the panel itself shows why (stubbed endpoint, no access…).
      setUnavailable(hostingErrorMessage(t, err, t('fileAccess.loadFailed') || 'Failed to load the file access'));
    } finally {
      setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  useHostingEvents(
    [HostingSocketEvents.FILESRV_UPDATED, HostingSocketEvents.HOSTING_CHANGED],
    () => { void load(); },
    (_ev, p) => payloadNumber(p, 'accountId') === accountId || (payloadNumber(p, 'id') === accountId && (p as { entity?: string }).entity === 'account'),
  );

  // Countdown of an on-demand activation; refetch once it has elapsed.
  const until = info?.running && info.activeUntil ? Date.parse(info.activeUntil) : NaN;
  useEffect(() => {
    if (!Number.isFinite(until)) return;
    const id = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until + 2000) { window.clearInterval(id); void load(); }
    }, 1000);
    return () => window.clearInterval(id);
  }, [until, load]);

  const run = async (key: string, fn: () => Promise<void>, failKey: string, failFallback: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toastHostingError(t, err, t(failKey) || failFallback);
    } finally {
      setBusy(null);
    }
  };

  const setMode = (mode: FileServerMode) => run('mode', async () => {
    setInfo(await accountsApi.updateFileAccess(accountId, { mode }));
    toast.success(t('fileAccess.modeSaved') || 'File server mode saved');
  }, 'fileAccess.modeFailed', 'Failed to change the mode');

  const activate = (minutes: number) => run(`act-${minutes}`, async () => {
    const s = await accountsApi.activateFileServer(accountId, minutes);
    setInfo((cur) => (cur ? mergeStatus(cur, s) : cur));
    toast.success(t('fileAccess.activated') || 'SFTP access opened');
  }, 'fileAccess.activateFailed', 'Failed to open the SFTP access');

  const deactivate = () => run('deact', async () => {
    const s = await accountsApi.deactivateFileServer(accountId);
    setInfo((cur) => (cur ? mergeStatus(cur, s) : cur));
    toast.success(t('fileAccess.deactivated') || 'SFTP access closed');
  }, 'fileAccess.deactivateFailed', 'Failed to close the SFTP access');

  const resetPassword = async () => {
    if (info?.hasPassword && !(await confirm({
      title: t('fileAccess.password.resetTitle') || 'New SFTP password',
      message: t('fileAccess.password.resetConfirm') || 'Generate a new SFTP password? The current one stops working immediately.',
      confirmLabel: t('fileAccess.password.reset') || 'Generate',
    }))) return;
    await run('pwd', async () => {
      const res = await accountsApi.resetFilePassword(accountId);
      setPassword(res.password);
      setInfo((cur) => (cur ? { ...cur, hasPassword: true } : cur));
    }, 'fileAccess.password.resetFailed', 'Failed to generate a password');
  };

  const disablePassword = async () => {
    if (!(await confirm({
      message: t('fileAccess.password.disableConfirm') || 'Disable password login? Only the SSH keys will be accepted.',
      danger: true,
      confirmLabel: t('common.disable') || 'Disable',
    }))) return;
    await run('pwd-off', async () => {
      setInfo(await accountsApi.disableFilePassword(accountId));
      toast.success(t('fileAccess.password.disabled') || 'Password login disabled');
    }, 'fileAccess.password.disableFailed', 'Failed to disable the password');
  };

  const deleteKey = async (key: AccountSshKey) => {
    if (!(await confirm({
      message: t('fileAccess.keys.deleteConfirm', { name: key.name, defaultValue: 'Delete the SSH key "{{name}}"?' }),
      danger: true,
    }))) return;
    await run(`key-${key.id}`, async () => {
      await accountsApi.deleteSshKey(accountId, key.id);
      setInfo((cur) => (cur ? { ...cur, sshKeys: cur.sshKeys.filter((k) => k.id !== key.id) } : cur));
      toast.success(t('fileAccess.keys.deleted') || 'SSH key deleted');
    }, 'fileAccess.keys.deleteFailed', 'Failed to delete the SSH key');
  };

  if (loading) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (!info) {
    return (
      <EmptyState
        icon={<FolderOpen />}
        text={unavailable ?? (t('fileAccess.loadFailed') || 'Failed to load the file access')}
        action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={14} className="mr-1.5" />{t('common.refresh') || 'Refresh'}</Button>}
      />
    );
  }

  const durationLabel = (m: number) => (m < 60
    ? t('fileAccess.duration.minutes', { count: m, defaultValue: '{{count}} min' })
    : t('fileAccess.duration.hours', { count: m / 60, defaultValue: '{{count}} h' }));
  const countdown = Number.isFinite(until)
    ? formatCountdown(until - now, { h: t('fileAccess.duration.h') || 'h', min: t('fileAccess.duration.min') || 'min', s: t('fileAccess.duration.s') || 's' })
    : null;
  const command = sftpCommand(info.username, info.host, info.port);

  const modeTabs: SegmentedTab<FileServerMode>[] = [
    { id: 'on-demand', label: t('fileAccess.mode.onDemand') || 'On demand' },
    { id: 'always', label: t('fileAccess.mode.always') || 'Always on' },
    { id: 'off', label: t('fileAccess.mode.off') || 'Off' },
  ];
  const modeHint = {
    'on-demand': t('fileAccess.mode.onDemandHint') || 'The SFTP server only runs when opened, for a limited time.',
    always: t('fileAccess.mode.alwaysHint') || 'The SFTP server runs permanently.',
    off: t('fileAccess.mode.offHint') || 'No SFTP access: the server never starts.',
  }[info.mode];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Connection ── */}
      <Card title={t('fileAccess.connection.title') || 'SFTP connection'} icon={<Terminal size={14} className="text-accent" />}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InfoRow label={t('fileAccess.connection.host') || 'Host'} mono>
            <span className="inline-flex items-center gap-1">
              {info.host ?? <span className="text-text-muted">{t('fileAccess.connection.noHost') || 'not configured'}</span>}
              {info.host && <CopyButton text={info.host} />}
            </span>
          </InfoRow>
          <InfoRow label={t('fileAccess.connection.port') || 'Port'} mono>
            <span className="inline-flex items-center gap-1">
              {info.port ?? '—'}
              {info.port != null && <CopyButton text={String(info.port)} />}
            </span>
          </InfoRow>
          <InfoRow label={t('fileAccess.connection.username') || 'Username'} mono>
            <span className="inline-flex items-center gap-1">{info.username}<CopyButton text={info.username} /></span>
          </InfoRow>
          <InfoRow label={t('fileAccess.connection.protocol') || 'Protocol'}>SFTP</InfoRow>
        </div>
        <div className="mt-3">
          <div className={labelCls}>{t('fileAccess.connection.example') || 'Example'}</div>
          <div className="flex items-center gap-2 rounded-md bg-bg-primary px-3 py-2 font-mono text-xs text-text-secondary">
            <span className="min-w-0 flex-1 break-all">{command}</span>
            <CopyButton text={command} />
          </div>
          {!info.host && (
            <p className="mt-2 text-xs text-text-muted">{t('fileAccess.connection.noHostHint') || 'Set the panel host name or the public IPv4 in the settings to show the host to connect to.'}</p>
          )}
        </div>
      </Card>

      {/* ── File server state + mode ── */}
      <Card
        title={t('fileAccess.server.title') || 'File server'}
        icon={<Server size={14} className="text-accent" />}
        actions={info.running
          ? <Pill tone="green">{t('fileAccess.server.running') || 'running'}</Pill>
          : <Pill tone="muted">{t('fileAccess.server.stopped') || 'stopped'}</Pill>}
      >
        {manage ? (
          <SegmentedTabs tabs={modeTabs} value={info.mode} onChange={(m) => { if (m !== info.mode && busy !== 'mode') void setMode(m); }} size="sm" ariaLabel={t('fileAccess.mode.label') || 'Mode'} />
        ) : (
          <div className="text-sm text-text-primary">{modeTabs.find((m) => m.id === info.mode)?.label}</div>
        )}
        <p className="mt-2 text-xs text-text-muted">{modeHint}</p>

        {info.mode === 'on-demand' && (
          <div className="mt-4 space-y-3">
            {info.running && countdown && (
              <div className="flex items-center gap-2 text-sm text-text-primary">
                <Timer size={14} className="text-accent" />
                {t('fileAccess.server.closesIn', { time: countdown, defaultValue: 'Closes in {{time}}' })}
                <span className="font-mono text-[11px] text-text-muted">
                  ({new Date(until).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })})
                </span>
              </div>
            )}
            {manage && (
              <>
                <div className={labelCls}>{info.running ? (t('fileAccess.server.extend') || 'Extend for') : (t('fileAccess.server.open') || 'Open for')}</div>
                <div className="flex flex-wrap gap-2">
                  {DURATIONS.map((m) => (
                    <Button key={m} size="sm" variant="secondary" loading={busy === `act-${m}`} disabled={busy !== null} onClick={() => { void activate(m); }}>
                      <Power size={13} className="mr-1.5" />{durationLabel(m)}
                    </Button>
                  ))}
                  {info.running && (
                    <Button size="sm" variant="ghost" loading={busy === 'deact'} disabled={busy !== null} onClick={() => { void deactivate(); }}>
                      {t('fileAccess.server.close') || 'Close now'}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {info.mode === 'off' && (
          <p className="mt-3 flex items-start gap-2 text-xs text-amber-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('fileAccess.server.offWarning') || 'Nobody can upload files to this account while the mode is off.'}</p>
        )}
      </Card>

      {/* ── Password ── */}
      <Card title={t('fileAccess.password.title') || 'Password'} icon={<KeyRound size={14} className="text-accent" />}>
        <div className="flex flex-wrap items-center gap-2">
          {info.hasPassword
            ? <Pill tone="green">{t('fileAccess.password.set') || 'set'}</Pill>
            : <Pill tone="muted">{t('fileAccess.password.none') || 'none'}</Pill>}
          <span className="text-xs text-text-muted">
            {info.hasPassword
              ? (t('fileAccess.password.setHint') || 'The password is stored hashed and can never be shown again.')
              : (t('fileAccess.password.noneHint') || 'No password: only SSH keys can log in.')}
          </span>
        </div>
        {manage && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={busy === 'pwd'} disabled={busy !== null} onClick={() => { void resetPassword(); }}>
              <RefreshCw size={13} className="mr-1.5" />
              {info.hasPassword ? (t('fileAccess.password.regenerate') || 'Generate a new password') : (t('fileAccess.password.generate') || 'Generate a password')}
            </Button>
            {info.hasPassword && (
              <Button size="sm" variant="ghost" loading={busy === 'pwd-off'} disabled={busy !== null} onClick={() => { void disablePassword(); }}>
                {t('fileAccess.password.disable') || 'Disable password login'}
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* ── SSH keys ── */}
      <Card
        title={t('fileAccess.keys.title') || 'SSH keys'}
        icon={<KeyRound size={14} className="text-accent" />}
        actions={manage ? (
          <Button size="sm" variant="secondary" onClick={() => setKeyModal(true)}>
            <Plus size={13} className="mr-1" />{t('fileAccess.keys.add') || 'Add a key'}
          </Button>
        ) : undefined}
      >
        {info.sshKeys.length === 0 ? (
          <p className="text-xs text-text-muted">{t('fileAccess.keys.empty') || 'No SSH key. Add a public key to log in without a password.'}</p>
        ) : (
          <ul className="divide-y divide-border">
            {info.sshKeys.map((k) => (
              <li key={k.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{k.name}</span>
                    <Pill tone="muted">{k.algorithm}</Pill>
                  </div>
                  <div className="truncate font-mono text-[11px] text-text-muted">{k.fingerprint}</div>
                  <div className="font-mono text-[10px] text-text-muted">{new Date(k.createdAt).toLocaleDateString(i18n.language)}</div>
                </div>
                {manage && (
                  <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={13} />} variant="danger" size="sm" disabled={busy !== null} onClick={() => { void deleteKey(k); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Layout ── */}
      <Card title={t('fileAccess.layout.title') || 'Folders'} icon={<FolderOpen size={14} className="text-accent" />} className="lg:col-span-2">
        <div className="mb-3 grid grid-cols-1 gap-3 text-xs text-text-secondary md:grid-cols-2">
          <div className="flex items-start gap-2 rounded-lg bg-bg-primary p-3">
            <Upload size={14} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="font-mono text-text-primary">/staging/&lt;site&gt;/</div>
              <p className="mt-1">{t('fileAccess.layout.stagingHint') || 'The code of the site. What you upload here is published as a new release (automatically or on request); the live site always runs from a read-only copy.'}</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-bg-primary p-3">
            <HardDrive size={14} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="font-mono text-text-primary">/data/&lt;site&gt;/</div>
              <p className="mt-1">{t('fileAccess.layout.dataHint') || 'The data paths of the site (uploads, cache…): the only folders the application can write to. PHP is never executed there.'}</p>
            </div>
          </div>
        </div>
        <p className="mb-3 text-xs text-text-muted">{t('fileAccess.layout.immutable') || 'PHP can never modify the code of the site: a hacked plugin cannot plant a backdoor in the published release.'}</p>
        {info.layout.length === 0 ? (
          <p className="text-xs text-text-muted">{t('fileAccess.layout.empty') || 'No site yet: the folders appear when a site is created.'}</p>
        ) : (
          <ul className="space-y-1.5">
            {info.layout.map((l) => {
              const hl = layoutMatchesSlug(l, siteSlug);
              return (
                <li key={l.siteId} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-2 text-xs', hl ? 'bg-accent/10 ring-1 ring-accent/30' : 'bg-bg-primary')}>
                  <span className={cn('min-w-[8rem] font-medium', hl ? 'text-accent' : 'text-text-primary')}>{l.siteName}</span>
                  <span className="inline-flex items-center gap-1 font-mono text-text-secondary">{l.stagingPath}<CopyButton text={l.stagingPath} /></span>
                  <span className="inline-flex items-center gap-1 font-mono text-text-secondary">{l.dataPath}<CopyButton text={l.dataPath} /></span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <PasswordOnceModal password={password} onClose={() => setPassword(null)} />
      <AddKeyModal
        open={keyModal}
        accountId={accountId}
        onClose={() => setKeyModal(false)}
        onAdded={(k) => { setKeyModal(false); setInfo((cur) => (cur ? { ...cur, sshKeys: [...cur.sshKeys, k] } : cur)); }}
      />
    </div>
  );
}

/** The generated SFTP password, shown ONCE. */
function PasswordOnceModal({ password, onClose }: { password: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={password !== null}
      onClose={onClose}
      title={t('fileAccess.password.onceTitle') || 'New SFTP password'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      closeOnBackdrop={false}
      footer={<Button size="sm" onClick={onClose}>{t('fileAccess.password.copiedClose') || 'I saved it'}</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-md bg-bg-primary px-3 py-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-text-primary select-all">{password}</code>
          {password && <CopyButton text={password} />}
        </div>
        <p className="flex items-start gap-2 text-xs text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {t('fileAccess.password.onceWarning') || 'Copy it now: it is shown only once and cannot be retrieved later. Generate a new one if it is lost.'}
        </p>
      </div>
    </Modal>
  );
}

function AddKeyModal({ open, accountId, onClose, onAdded }: {
  open: boolean; accountId: number; onClose: () => void; onAdded: (k: AccountSshKey) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setName(''); setKey(''); } }, [open]);

  const line = key.trim();
  const multiple = line.split(/\r?\n/).filter((l) => l.trim()).length > 1;
  const valid = !multiple && looksLikeSshPublicKey(line);

  const submit = async () => {
    if (!valid || !name.trim()) return;
    setSaving(true);
    try {
      const k = await accountsApi.addSshKey(accountId, { name: name.trim(), publicKey: line });
      toast.success(t('fileAccess.keys.added') || 'SSH key added');
      onAdded(k);
    } catch (err) {
      toastHostingError(t, err, t('fileAccess.keys.addFailed') || 'Failed to add the SSH key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('fileAccess.keys.addTitle') || 'Add an SSH key'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid || !name.trim()} onClick={() => { void submit(); }}>{t('fileAccess.keys.add') || 'Add a key'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="ssh-key-line">{t('fileAccess.keys.publicKey') || 'Public key'}</label>
          <textarea
            id="ssh-key-line"
            value={key}
            rows={4}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="ssh-ed25519 AAAAC3Nza… user@laptop"
            onChange={(e) => {
              setKey(e.target.value);
              if (!name.trim()) setName(sshKeyComment(e.target.value));
            }}
            className={cn(inputCls, 'resize-y font-mono text-xs')}
          />
          {line && !valid && (
            <p className="mt-1 text-xs text-status-down">
              {multiple
                ? (t('fileAccess.keys.oneLine') || 'Paste a single key line.')
                : (t('fileAccess.keys.invalid') || 'This does not look like an OpenSSH public key (ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa ≥ 3072 bits).')}
            </p>
          )}
          <p className="mt-1 text-xs text-text-muted">{t('fileAccess.keys.hint') || 'The content of your ~/.ssh/id_ed25519.pub file. Never paste a private key.'}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="ssh-key-name">{t('fileAccess.keys.name') || 'Name'}</label>
          <input id="ssh-key-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder={t('fileAccess.keys.namePlaceholder') || 'My laptop'} />
        </div>
      </div>
    </Modal>
  );
}
