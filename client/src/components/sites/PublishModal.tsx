import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Release, Site } from '@oblimint/shared';
import { releasesApi } from '@/api/releases.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { siteErrorMessage } from './siteErrors';
import { fieldCls, labelCls } from './styles';

export interface PublishModalProps {
  site: Site;
  open: boolean;
  onClose: () => void;
  onPublished: (release: Release) => void;
}

/** "Publish" — commits the staging folder as a new release (optional message). */
export function PublishModal({ site, open, onClose, onPublished }: PublishModalProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const close = () => {
    if (saving) return;
    setError('');
    onClose();
  };

  const submit = async () => {
    // Ctrl+Enter while the request is in flight (ref: state may not have re-rendered yet).
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const release = await releasesApi.publish(site.id, { message: message.trim() || null });
      toast.success(t('releases.publish.queued', { number: release.number, defaultValue: 'Release #{{number}} queued' }));
      setMessage('');
      onPublished(release);
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      phoneLayout="sheet"
      title={t('releases.publish.title', { name: site.name, defaultValue: 'Publish {{name}}' })}
      icon={<Rocket className="h-4 w-4 text-accent" />}
      dismissible={!saving}
      footer={
        <>
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          <Button variant="ghost" size="sm" onClick={close} disabled={saving}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" onClick={submit} loading={saving}>
            <Rocket size={14} className="mr-1" />
            {t('releases.publish.button') || 'Publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('releases.publish.explain', { slug: site.slug, defaultValue: 'The current content of /staging/{{slug}}/ becomes a new immutable release, then goes live once its health check passes.' })}
        </p>
        {site.publishMode === 'approval' && (
          <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
            {t('releases.publish.needsApproval') || 'This site publishes with approval: the release will wait for an approval before going live.'}
          </p>
        )}
        <div>
          <label className={labelCls} htmlFor="publish-message">{t('releases.publish.message') || 'Message (optional)'}</label>
          <textarea
            id="publish-message"
            rows={3}
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
            placeholder={t('releases.publish.messagePlaceholder') || 'What changes in this release?'}
            className={`${fieldCls} resize-y`}
            autoFocus
          />
        </div>
      </div>
    </Modal>
  );
}
