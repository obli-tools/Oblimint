import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { AppStackDetail } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { apiErrorCode, inputCls, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { appsErrorMessage } from '../appsErrors';

/** Delete an application: confirm = its name, optional volume removal, forced when proxy hosts target it (409 stackInUse). */
export function DeleteStackModal({ stack, onClose, onDeleted }: { stack: AppStackDetail; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');
  const [removeVolumes, setRemoveVolumes] = useState(false);
  // Never pre-checked: forcing past the 409 stackInUse guard is an explicit choice.
  const [force, setForce] = useState(false);
  const [inUse, setInUse] = useState(stack.proxyHosts.length > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (confirmText !== stack.name) return;
    setSaving(true);
    setError('');
    try {
      await appsApi.deleteStack(stack.id, { confirm: confirmText, removeVolumes }, force);
      toast.success(t('apps.delete.done') || 'Application deleted');
      onDeleted();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      if (apiErrorCode(err) === 'stackInUse') setInUse(true);
      setError(appsErrorMessage(t, err, t('apps.delete.failed') || 'Failed to delete the application'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      phoneLayout="sheet"
      icon={<Trash2 className="h-4 w-4 text-status-down" />}
      title={t('apps.delete.title', { name: stack.displayName, defaultValue: 'Delete {{name}}' })}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" variant="danger" loading={saving} disabled={confirmText !== stack.name || (inUse && !force)} onClick={() => { void submit(); }}>{t('common.delete') || 'Delete'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-sm text-text-secondary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
          {t('apps.delete.message') || 'The containers, private networks and the configuration of the application are removed. The volumes are kept 7 days unless you remove them now.'}
        </p>
        <ToggleSwitch
          checked={removeVolumes}
          onChange={setRemoveVolumes}
          label={t('apps.delete.removeVolumes') || 'Also delete the data (volumes) now'}
          description={t('apps.delete.removeVolumesHint') || 'Irreversible: no grace period.'}
        />
        {inUse && (
          <div className="rounded-lg bg-amber-400/10 p-3">
            <p className="mb-2 text-xs text-amber-400">
              {t('apps.delete.inUse', { count: stack.proxyHosts.length, defaultValue: '{{count}} proxy host(s) target this application.' })}
              {stack.proxyHosts.length > 0 && <span className="font-mono"> {stack.proxyHosts.map((h) => h.name).join(', ')}</span>}
            </p>
            <ToggleSwitch size="sm" checked={force} onChange={setForce} label={<span className="text-xs">{t('apps.delete.force') || 'Delete anyway (the proxy hosts lose their target)'}</span>} />
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="del-confirm">{t('apps.delete.typeName', { name: stack.name, defaultValue: 'Type "{{name}}" to confirm' })}</label>
          <input id="del-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
