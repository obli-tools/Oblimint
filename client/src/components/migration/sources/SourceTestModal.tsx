import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, KeyRound, PlugZap, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import type { MigrationHostKey, MigrationSource, MigrationSourceTestResult } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CopyButton, InfoRow, Pill } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatDateTime } from '../migrationFormat';
import { InlineError, loadErrorOf, toastMigrationError, type LoadError } from '../migrationUi';

export function HostKeyLine({ hostKey, label }: { hostKey: MigrationHostKey; label?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-bg-primary px-2.5 py-1.5">
      <span className="font-mono text-[11px] text-text-muted">{hostKey.algorithm}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-text-primary">{hostKey.fingerprint}</code>
      <CopyButton text={hostKey.fingerprint} label={label} />
    </div>
  );
}

/**
 * Host key review (MG3): the presented key is shown with its algorithm and
 * SHA256 fingerprint, the admin compares it out of band (ssh-keyscan on a
 * trusted path) and pins it explicitly. A key different from the pinned one is
 * a danger: pinning it needs a typed confirmation.
 */
export function HostKeyPanel({ source, presented, mismatch, onChanged }: {
  source: MigrationSource;
  presented: MigrationHostKey | null;
  mismatch: boolean;
  onChanged: (s: MigrationSource) => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const pending = presented ?? source.pendingHostKey;
  const canPin = !!pending && pending.fingerprint !== source.hostKey?.fingerprint;

  const pin = async () => {
    if (!pending) return;
    const ok = await confirm(mismatch ? {
      title: t('migration.hostKey.pinMismatchTitle') || 'Replace the pinned host key',
      message: t('migration.hostKey.pinMismatchConfirm', { host: source.host, defaultValue: 'The server presents a key DIFFERENT from the pinned one. This is what a man-in-the-middle attack looks like. Only continue if you know the server was reinstalled or its key changed, and you checked the new fingerprint on the server itself. Type {{host}} to confirm.' }),
      confirmLabel: t('migration.hostKey.pin') || 'Pin this key',
      danger: true,
      requireText: source.host,
    } : {
      title: t('migration.hostKey.pinTitle') || 'Pin the host key',
      message: t('migration.hostKey.pinConfirm', { fingerprint: pending.fingerprint, defaultValue: 'Pin {{fingerprint}}? Compare it first with the output of ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub on the server. Every later connection is refused if the server presents another key.' }),
      confirmLabel: t('migration.hostKey.pin') || 'Pin this key',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const s = await migrationApi.pinHostKey(source.id, { fingerprint: pending.fingerprint });
      toast.success(t('migration.hostKey.pinned') || 'Host key pinned');
      onChanged(s);
    } catch (err) {
      toastMigrationError(t, err, t('migration.hostKey.pinFailed') || 'The key could not be pinned');
    } finally {
      setBusy(false);
    }
  };

  const unpin = async () => {
    if (!(await confirm({
      title: t('migration.hostKey.unpinTitle') || 'Unpin the host key',
      message: t('migration.hostKey.unpinConfirm') || 'Every connection to this source is refused until a key is pinned again.',
      confirmLabel: t('migration.hostKey.unpin') || 'Unpin',
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const s = await migrationApi.unpinHostKey(source.id);
      toast.success(t('migration.hostKey.unpinned') || 'Host key unpinned');
      onChanged(s);
    } catch (err) {
      toastMigrationError(t, err, t('migration.hostKey.unpinFailed') || 'The key could not be unpinned');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
          <ShieldCheck size={12} />{t('migration.hostKey.pinnedKey') || 'Pinned key'}
          {source.hostKeyPinnedAt && <span>· {formatDateTime(source.hostKeyPinnedAt, i18n.language)}</span>}
        </div>
        {source.hostKey ? <HostKeyLine hostKey={source.hostKey} /> : <p className="text-xs text-text-muted">{t('migration.hostKey.none') || 'No key pinned: every connection is refused (MG3).'}</p>}
      </div>
      {pending && canPin && (
        <div className={cn('space-y-2 rounded-lg p-3', mismatch ? 'bg-status-down/10 ring-1 ring-status-down/40' : 'bg-amber-400/5 ring-1 ring-amber-400/30')}>
          <div className={cn('flex items-center gap-2 text-sm font-medium', mismatch ? 'text-status-down' : 'text-amber-400')}>
            <ShieldAlert size={15} />
            {mismatch ? (t('migration.hostKey.mismatchTitle') || 'The server presents ANOTHER key') : (t('migration.hostKey.presentedTitle') || 'Key presented by the server (not pinned)')}
          </div>
          <HostKeyLine hostKey={pending} />
          <p className="text-xs text-text-secondary">
            {mismatch
              ? (t('migration.hostKey.mismatchHelp') || 'Connections are refused. Do not pin this key unless you have checked on the server itself that it changed (reinstallation, key rotation).')
              : (t('migration.hostKey.verifyHelp') || 'Check this fingerprint on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) or through a trusted path before pinning it.')}
          </p>
          <Button size="sm" variant={mismatch ? 'danger' : 'primary'} loading={busy} onClick={() => { void pin(); }}>
            <KeyRound size={13} className="mr-1.5" />{t('migration.hostKey.pin') || 'Pin this key'}
          </Button>
        </div>
      )}
      {source.hostKey && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void unpin(); }}>{t('migration.hostKey.unpin') || 'Unpin'}</Button>
      )}
    </div>
  );
}

/** Connection test of a source + host key review (POST /sources/:id/test). */
export function SourceTestModal({ source, autoRun, onClose, onChanged }: {
  source: MigrationSource | null;
  autoRun: boolean;
  onClose: () => void;
  onChanged: (s: MigrationSource) => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<MigrationSourceTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const sourceId = source?.id ?? null;

  const run = async (id: number) => {
    setTesting(true);
    setError(null);
    try {
      const r = await migrationApi.testSource(id);
      setResult(r);
      migrationApi.getSource(id).then(onChanged).catch(() => undefined);
    } catch (err) {
      setResult(null);
      setError(loadErrorOf(t, err, t('migration.test.failed') || 'The test could not run'));
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    setResult(null);
    setError(null);
    if (sourceId != null && autoRun) void run(sourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, autoRun]);

  if (!source) return null;
  const mismatch = result?.hostKeyState === 'mismatch'
    || (!result && !!source.hostKey && !!source.pendingHostKey && source.hostKey.fingerprint !== source.pendingHostKey.fingerprint);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<PlugZap className="h-4 w-4 text-accent" />}
      title={t('migration.test.title', { name: source.name, defaultValue: 'Test {{name}}' })}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.close') || 'Close'}</Button>
          <Button size="sm" loading={testing} onClick={() => { void run(source.id); }}><PlugZap size={13} className="mr-1.5" />{t('migration.test.run') || 'Test the connection'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="font-mono text-xs text-text-muted">{source.username}@{source.host}:{source.port}{source.useSudo ? ' (sudo -n)' : ''}</p>
        {testing && <div className="flex justify-center py-6"><LoadingSpinner /></div>}
        {error && <InlineError error={error} />}
        {result && !testing && (
          <div className={cn('space-y-3 rounded-lg p-3', result.ok ? 'bg-green-500/5' : 'bg-status-down/5')}>
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {result.ok ? <CheckCircle2 size={16} className="text-green-400" /> : <XCircle size={16} className="text-status-down" />}
              <span className={result.ok ? 'text-green-400' : 'text-status-down'}>{result.ok ? (t('migration.test.ok') || 'Connection OK') : (t('migration.test.ko') || 'Connection failed')}</span>
              {result.errorCode && <Pill tone="red">{result.errorCode}</Pill>}
            </div>
            {result.errorCode && (
              <p className="text-xs text-text-secondary">{t(`migration.errors.${result.errorCode}`, { defaultValue: result.error ?? result.errorCode })}</p>
            )}
            {result.error && result.errorCode && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-primary p-2 font-mono text-[11px] text-text-muted">{result.error}</pre>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label={t('migration.test.latency') || 'Latency'} mono>{result.latencyMs != null ? `${result.latencyMs} ms` : '—'}</InfoRow>
              <InfoRow label={t('migration.test.remoteUser') || 'Remote user'} mono>{result.remoteUser ?? '—'}</InfoRow>
              <InfoRow label={t('migration.sources.cwpVersion') || 'CWP version'} mono>{result.cwpVersion ?? '—'}</InfoRow>
              <InfoRow label={t('migration.sources.os') || 'OS'}>{result.osRelease ?? '—'}</InfoRow>
            </div>
            {result.remoteUser && result.remoteUser !== 'root' && !source.useSudo && (
              <p className="text-xs text-amber-400">{t('migration.test.notRoot') || 'The remote user is not root: enable sudo on the source (sudo -n must allow the read commands).'}</p>
            )}
          </div>
        )}
        <HostKeyPanel source={source} presented={result?.hostKey ?? null} mismatch={mismatch} onChanged={onChanged} />
      </div>
    </Modal>
  );
}
