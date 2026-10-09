import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ShieldAlert } from 'lucide-react';
import type { MaintenanceWindowDetail, WindowValidateRequest } from '@oblimint/shared';
import { windowsApi } from '@/api/maintenance.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { inputCls, isStepUpHandled, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { apiErrorCode, conflictPaths, maintenanceErrorMessage } from '../maintenanceErrors';

const MESSAGE_MAX = 2000;

/**
 * Validate a reviewed window: commit message, `force` when the staging
 * changed since the base release, staff override of a blocked analysis
 * (danger confirmation, audited server side).
 */
export function ValidateWindowModal({ open, siteId, w, canOverride, onClose, onDone }: {
  open: boolean;
  siteId: number;
  w: MaintenanceWindowDetail;
  /** Staff with releases.approve. */
  canOverride: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [force, setForce] = useState(false);
  const [override, setOverride] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>(w.stagingConflicts);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const blocked = !!w.analysis?.blocked;
  const conflictKey = w.stagingConflicts.join('\n');

  useEffect(() => {
    if (!open) return;
    setMessage('');
    setForce(false);
    setOverride(false);
    setConflicts(w.stagingConflicts);
    setError('');
  }, [open, conflictKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (blocked && override && !(await confirm({
      title: t('windowReview.validate.overrideTitle') || 'Override the blocked analysis',
      message: t('windowReview.validate.overrideConfirm', {
        score: w.risk?.score ?? '?',
        defaultValue: 'The analysis blocked this window (risk {{score}}). Publish it anyway? Your name and this decision are recorded in the audit log.',
      }),
      confirmLabel: t('windowReview.validate.overrideConfirmLabel') || 'Override and validate',
      danger: true,
    }))) return;
    const body: WindowValidateRequest = { message: message.trim() || null };
    if (force) body.force = true;
    if (blocked && override) body.override = true;
    setSaving(true);
    setError('');
    try {
      await windowsApi.validate(siteId, w.id, body);
      onDone();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      if (apiErrorCode(err) === 'stagingConflict') {
        const paths = conflictPaths(err);
        if (paths.length) setConflicts(paths);
      }
      setError(maintenanceErrorMessage(err, t, t('windowReview.validate.failed') || 'Validation failed'));
    } finally {
      setSaving(false);
    }
  };

  const needForce = conflicts.length > 0 && !force;
  const needOverride = blocked && !override;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('windowReview.validate.title', { number: w.number, defaultValue: 'Validate window #{{number}}' })}
      icon={<Check className="h-4 w-4 text-accent" />}
      size="lg"
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" variant={blocked ? 'danger' : 'primary'} loading={saving} disabled={needForce || needOverride} onClick={() => { void submit(); }}>
            <Check size={14} className="mr-1" />{t('windowReview.validate.submit') || 'Validate and publish'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          {t('windowReview.validate.explain') || 'The changes become a new release through the normal pipeline (scan recorded, health check, automatic rollback), then are copied back into the staging folder.'}
        </p>
        <div>
          <label className={labelCls} htmlFor="val-message">{t('windowReview.validate.message') || 'Release message (optional)'}</label>
          <textarea id="val-message" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MESSAGE_MAX} placeholder={t('windowReview.validate.messagePlaceholder', { number: w.number, defaultValue: 'Window #{{number}}' })} className={cn(inputCls, 'resize-y')} />
        </div>

        {conflicts.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
            <p className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {t('windowReview.validate.conflicts', { count: conflicts.length, defaultValue: '{{count}} file(s) changed in the staging folder since the base release; validating overwrites them with the window content:' })}
            </p>
            <ul className="max-h-32 overflow-auto font-mono text-[11px] text-text-secondary">
              {conflicts.slice(0, 50).map((p) => <li key={p} className="break-all">{p}</li>)}
              {conflicts.length > 50 && <li className="text-text-muted">… (+{conflicts.length - 50})</li>}
            </ul>
            <label className="flex items-center gap-2 text-sm text-text-secondary coarse:min-h-10">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={force} onChange={(e) => setForce(e.target.checked)} />
              {t('windowReview.validate.force') || 'Overwrite these staging files'}
            </label>
          </div>
        )}

        {blocked && (
          <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3">
            <p className="flex items-start gap-2 text-xs text-red-400">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              {canOverride
                ? (t('windowReview.validate.blockedStaff') || 'The analysis blocked this window (risk at or above the block threshold, or a ClamAV detection). Only an audited staff override can publish it.')
                : (t('windowReview.validate.blockedClient') || 'The analysis blocked this window: it cannot be published. Reject it, or contact the support to review it.')}
            </p>
            {canOverride && (
              <label className="flex items-center gap-2 text-sm text-red-400 coarse:min-h-10">
                <input type="checkbox" className="h-4 w-4 accent-red-500" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                {t('windowReview.validate.override') || 'Override the analysis (staff, audited)'}
              </label>
            )}
          </div>
        )}

        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
