import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Circle, Copy, ExternalLink, KeyRound, Loader2, MinusCircle, RotateCcw, Rocket, Trash2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { APP_INSTALL_IN_FLIGHT, type AppInstall, type AppInstallStatus, type AppInstallStepKey, type AppInstallStepStatus } from '@oblimint/shared';
import { appInstallsApi } from '@/api/appInstalls.api';
import { previewsApi } from '@/api/previews.api';
import { Button } from '@/components/common/Button';
import { confirmDialog } from '@/components/common/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { Pill, type Tone } from '@/components/common/Pill';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { siteErrorMessage } from './siteErrors';

const POLL_MS = 2000;

const STATUS_TONE: Record<AppInstallStatus, Tone> = {
  running: 'blue', preview_ready: 'accent', awaiting_approval: 'amber', succeeded: 'green', failed: 'red', cleaning: 'blue', cleaned: 'muted',
};

export function useAppInstallLabels() {
  const { t } = useTranslation();
  return {
    status: (s: AppInstallStatus) => ({
      running: t('sites.install.status.running') || 'Installing',
      preview_ready: t('sites.install.status.previewReady') || 'In preview',
      awaiting_approval: t('sites.install.status.awaitingApproval') || 'Awaiting approval',
      succeeded: t('sites.install.status.succeeded') || 'Installed',
      failed: t('sites.install.status.failed') || 'Failed',
      cleaning: t('sites.install.status.cleaning') || 'Cleaning up',
      cleaned: t('sites.install.status.cleaned') || 'Cleaned up',
    })[s],
    step: (k: AppInstallStepKey) => ({
      site: t('sites.install.step.site') || 'Site',
      database: t('sites.install.step.database') || 'Database server, database and user',
      variables: t('sites.install.step.variables') || 'Environment variables',
      download: t('sites.install.step.download') || 'Download and archive checksum',
      extract: t('sites.install.step.extract') || 'Code placed in the staging',
      config: t('sites.install.step.config') || 'wp-config.php reading the environment',
      verify: t('sites.install.step.verify') || 'Checksum of every core file',
      install: t('sites.install.step.install') || 'WordPress installation',
      preview: t('sites.install.step.preview') || 'Preview',
      publish: t('sites.install.step.publish') || 'Publication of release 1',
    })[k],
  };
}

export function AppInstallStatusPill({ status }: { status: AppInstallStatus }) {
  const labels = useAppInstallLabels();
  return <Pill tone={STATUS_TONE[status]}>{labels.status(status)}</Pill>;
}

function StepIcon({ status }: { status: AppInstallStepStatus }) {
  switch (status) {
    case 'done': return <CheckCircle2 size={15} className="shrink-0 text-green-400" />;
    case 'running': return <Loader2 size={15} className="shrink-0 animate-spin text-accent" />;
    case 'failed': return <XCircle size={15} className="shrink-0 text-red-400" />;
    case 'skipped': return <MinusCircle size={15} className="shrink-0 text-text-muted/50" />;
    default: return <Circle size={15} className="shrink-0 text-text-muted/50" />;
  }
}

function PasswordOnce({ user, password, acknowledged, onAcknowledged }: { user: string; password: string; acknowledged: boolean; onAcknowledged: (v: boolean) => void }) {
  const { t } = useTranslation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success(t('common.copied') || 'Copied');
    } catch {
      toast.error(t('common.copyFailed') || 'Copy failed');
    }
  };
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
        <KeyRound size={15} className="shrink-0" />
        {t('sites.install.passwordTitle') || 'WordPress administrator password: shown once'}
      </div>
      <p className="mt-1 text-xs text-text-secondary">{t('sites.install.passwordHint') || 'Note it now: it is kept nowhere and will never be shown again.'}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="text-text-muted">{t('sites.install.adminUser') || 'Administrator login'}</dt>
        <dd className="font-mono text-text-primary break-all">{user}</dd>
        <dt className="text-text-muted">{t('sites.install.password') || 'Password'}</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 font-mono text-text-primary break-all">{password}</code>
          <Button variant="ghost" size="sm" onClick={copy}><Copy size={13} /></Button>
        </dd>
      </dl>
      <div className="mt-2">
        <ToggleSwitch checked={acknowledged} onChange={onAcknowledged} size="sm" label={t('sites.install.passwordAck') || 'I have noted this password'} />
      </div>
    </div>
  );
}

export interface AppInstallProgressModalProps {
  installId: number;
  initial?: AppInstall | null;
  /** The answer of the starting call: the only time it exists on this side. */
  password?: { user: string; value: string } | null;
  onClose: (install: AppInstall | null) => void;
  onChanged?: () => void;
}

export function AppInstallProgressModal({ installId, initial, password: givenPassword, onClose, onChanged }: AppInstallProgressModalProps) {
  const { t } = useTranslation();
  const labels = useAppInstallLabels();
  const [install, setInstall] = useState<AppInstall | null>(initial ?? null);
  const [password, setPassword] = useState(givenPassword ?? null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const status = install?.status ?? null;
  const inFlight = status === null || APP_INSTALL_IN_FLIGHT.includes(status);

  useEffect(() => {
    if (!inFlight) return undefined;
    let cancelled = false;
    const tick = () => {
      appInstallsApi.get(installId)
        .then((i) => { if (!cancelled) setInstall(i); })
        .catch((err) => { if (!cancelled) setError(siteErrorMessage(err, t)); });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [installId, inFlight, t]);

  const act = async (fn: () => Promise<AppInstall>) => {
    setBusy(true);
    setError('');
    try {
      setInstall(await fn());
      onChanged?.();
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const retry = () => act(async () => {
    const r = await appInstallsApi.retry(installId);
    if (r.adminPassword && install) {
      setPassword({ user: install.adminUser, value: r.adminPassword });
      setAcknowledged(false);
    }
    return r.install;
  });

  const cleanup = async () => {
    const ok = await confirmDialog({
      title: t('sites.install.cleanupTitle') || 'Clean up this installation?',
      message: t('sites.install.cleanupMessage') || 'The site, the database and the user made by this operation are deleted. Nothing that existed before is touched.',
      confirmLabel: t('sites.install.cleanup') || 'Clean up',
      danger: true,
    });
    if (ok) await act(() => appInstallsApi.cleanup(installId));
  };

  // Never lost by a stray click: the modal stays until the password is acknowledged.
  const canClose = !password || acknowledged;

  return (
    <Modal
      open
      onClose={() => { if (canClose) onClose(install); }}
      size="xl"
      dismissible={canClose}
      title={t('sites.install.progressTitle', { name: install?.siteName ?? '', defaultValue: 'Installing {{name}}' })}
      icon={<Rocket className="h-4 w-4 text-accent" />}
      footer={
        <>
          {error && <p className="mr-auto whitespace-pre-line text-xs text-red-400">{error}</p>}
          {status === 'failed' && (
            <>
              <Button variant="ghost" size="sm" onClick={cleanup} disabled={busy}><Trash2 size={14} className="mr-1" />{t('sites.install.cleanup') || 'Clean up'}</Button>
              <Button size="sm" onClick={retry} loading={busy}><RotateCcw size={14} className="mr-1" />{t('sites.install.retry') || 'Resume'}</Button>
            </>
          )}
          {status === 'preview_ready' && install?.siteId && (
            <>
              <Button variant="ghost" size="sm" onClick={cleanup} disabled={busy}><Trash2 size={14} className="mr-1" />{t('sites.install.cleanup') || 'Clean up'}</Button>
              <Button variant="secondary" size="sm" onClick={() => window.open(previewsApi.openUrl(install.siteId!), '_blank', 'noopener')}><ExternalLink size={14} className="mr-1" />{t('sites.install.openPreview') || 'Open the preview'}</Button>
              <Button size="sm" onClick={() => act(() => appInstallsApi.publish(installId))} loading={busy}><Rocket size={14} className="mr-1" />{t('sites.install.publish') || 'Publish release 1'}</Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => onClose(install)} disabled={!canClose}>{t('common.close') || 'Close'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {password && <PasswordOnce user={password.user} password={password.value} acknowledged={acknowledged} onAcknowledged={setAcknowledged} />}

        {install && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <AppInstallStatusPill status={install.status} />
              <span className="font-mono">{install.siteSlug}</span>
              {install.version && <span>WordPress {install.version} · {install.locale}</span>}
              {install.releaseNumber !== null && <span>{t('sites.install.release', { n: install.releaseNumber, defaultValue: 'Release {{n}}' })}</span>}
            </div>

            <ol className="space-y-1.5">
              {install.steps.filter((s) => s.status !== 'skipped').map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-sm">
                  <StepIcon status={s.status} />
                  <span className={s.status === 'pending' ? 'text-text-muted' : 'text-text-primary'}>{labels.step(s.key)}</span>
                </li>
              ))}
            </ol>

            {install.status === 'failed' && install.error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{install.error}</span>
              </div>
            )}
            {install.status === 'preview_ready' && (
              <p className="text-xs text-text-secondary">{t('sites.install.previewHint') || 'WordPress runs in a preview with a disposable copy of the database: what you change there is not kept. Publish to put release 1 online.'}</p>
            )}
            {install.status === 'awaiting_approval' && (
              <p className="text-xs text-text-secondary">{t('sites.install.approvalHint') || 'Release 1 waits for an approver in the Releases tab of the site.'}</p>
            )}
            {install.status === 'succeeded' && (
              <p className="text-xs text-text-secondary">{t('sites.install.doneHint') || 'The code is read-only: an extension or a theme goes through the staging and a release, not through the WordPress screens. Attach a domain to the site: WordPress follows it.'}</p>
            )}
            {install.status === 'cleaned' && (
              <p className="text-xs text-text-secondary">{t('sites.install.cleanedHint') || 'What the operation had created was removed.'}</p>
            )}
          </>
        )}
      </div>

    </Modal>
  );
}
