import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileStack } from 'lucide-react';
import type { MigrationDiscovery, MigrationPlan } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { inputCls, labelCls } from '@/components/hosting/hostingUi';
import { toastMigrationError } from '../migrationUi';

/** Create a plan from a finished discovery (POST /plans { discoveryId, name }). */
export function CreatePlanModal({ discovery, onClose, onCreated }: {
  discovery: MigrationDiscovery | null;
  onClose: () => void;
  onCreated: (p: MigrationPlan) => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (discovery) setName(t('migration.plans.defaultName', { date: new Date().toLocaleDateString(i18n.language), defaultValue: 'CWP migration {{date}}' }));
  }, [discovery, t, i18n.language]);

  const submit = async () => {
    if (!discovery || !name.trim()) return;
    setSaving(true);
    try {
      const p = await migrationApi.createPlan({ discoveryId: discovery.id, name: name.trim() });
      toast.success(t('migration.plans.created') || 'Plan created: the dry-run is computed');
      onCreated(p);
    } catch (err) {
      toastMigrationError(t, err, t('migration.plans.createFailed') || 'The plan could not be created');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={discovery != null}
      onClose={onClose}
      size="md"
      icon={<FileStack className="h-4 w-4 text-accent" />}
      title={t('migration.plans.createTitle') || 'New migration plan'}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!name.trim()} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-xs text-text-muted">{t('migration.plans.createIntro', { id: discovery?.id ?? '', defaultValue: 'From discovery #{{id}}. Every choice starts at its default (Default workspace, MariaDB 10.11, CWP packages → new plans, PHP base from the real version); nothing runs before you start it.' })}</p>
        <div>
          <label htmlFor="plan-name" className={labelCls}>{t('migration.plans.name') || 'Name'}</label>
          <input id="plan-name" className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </div>
      </form>
    </Modal>
  );
}
