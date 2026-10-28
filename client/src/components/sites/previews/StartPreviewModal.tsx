import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { PREVIEW_TTL_MINUTES, type Release, type Site, type SitePreview } from '@oblimint/shared';
import { previewsApi } from '@/api/previews.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { siteErrorMessage } from '../siteErrors';
import { fieldCls, labelCls } from '../styles';

/**
 * Feature B — start a preview of a release or of the staging. Fixed
 * explanation of the limits; TTL bounded (the server applies the platform
 * maximum); the options that weaken the isolation only for site managers
 * (blocked code: platform staff, checked by the server).
 */
export function StartPreviewModal({ site, release, current, onClose, onStarted }: {
  site: Site;
  /** null = the staging. */
  release: Pick<Release, 'id' | 'number'> | null;
  /** The running preview of the site (it gets replaced). */
  current: SitePreview | null;
  onClose: () => void;
  onStarted: (p: SitePreview) => void;
}) {
  const { t } = useTranslation();
  const { can, me } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const isStaff = (me as { kind?: string } | null)?.kind === 'staff';
  const [ttl, setTtl] = useState<number>(PREVIEW_TTL_MINUTES.default);
  const [envAll, setEnvAll] = useState(false);
  const [allowBlocked, setAllowBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const replaces = !!current && ['building', 'starting', 'running'].includes(current.status);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await previewsApi.start(site.id, {
        target: release ? 'release' : 'staging',
        releaseId: release?.id ?? null,
        ttlMinutes: ttl,
        ...(envAll || allowBlocked ? { options: { ...(envAll ? { env: 'all' as const } : {}), ...(allowBlocked ? { allowBlockedScan: true } : {}) } } : {}),
      });
      toast.success(t('previews.starting') || 'Preview starting…');
      onStarted(r.preview);
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const title = release
    ? t('previews.startRelease', { number: release.number, defaultValue: 'Preview release #{{number}}' })
    : (t('previews.startStaging') || 'Preview the staging');

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title={title}
      icon={<Eye className="h-4 w-4 text-amber-400" />}
      dismissible={!busy}
      footer={
        <>
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" onClick={() => void start()} loading={busy}>
            <Eye size={14} className="mr-1" />{t('previews.start') || 'Preview'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t('previews.explain') || 'Runs the code of a release (or a scanned snapshot of the staging) in a temporary, isolated container on a private URL. Nothing goes live.'}
        </p>
        <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('previews.limits') || 'Data read-only (uploads, caches and file sessions fail), no database, no mail, Internet like the site, secret environment variables hidden. Staging snapshots are scanned first.'}</span>
        </p>
        {replaces && <p className="text-xs text-amber-400">{t('previews.replaces') || 'Replaces the running preview of this site.'}</p>}
        <div>
          <label className={labelCls} htmlFor="preview-ttl">{t('previews.ttl') || 'Duration (minutes)'}</label>
          <input
            id="preview-ttl" type="number" min={PREVIEW_TTL_MINUTES.min} max={PREVIEW_TTL_MINUTES.max} value={ttl}
            onChange={(e) => setTtl(Math.max(PREVIEW_TTL_MINUTES.min, Math.min(PREVIEW_TTL_MINUTES.max, Number(e.target.value) || PREVIEW_TTL_MINUTES.default)))}
            className={`${fieldCls} w-32`}
          />
          <p className="mt-1 text-[11px] text-text-muted">
            {t('previews.ttlHint', { min: PREVIEW_TTL_MINUTES.min, max: PREVIEW_TTL_MINUTES.max, defaultValue: 'Between {{min}} and {{max}} minutes.' })}
          </p>
        </div>
        {canManage && (
          <details className="rounded-lg bg-bg-tertiary/60 px-3 py-2 text-sm">
            <summary className="cursor-pointer text-xs text-text-secondary">{t('previews.advanced') || 'Advanced (site managers)'}</summary>
            <label className="mt-2 flex items-start gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={envAll} onChange={(e) => setEnvAll(e.target.checked)} className="mt-0.5" />
              <span>
                {t('previews.envAll') || 'Pass every environment variable, secrets included'}
                <span className="block text-text-muted">{t('previews.envAllHint') || 'Real side effects possible (payments, external APIs).'}</span>
              </span>
            </label>
            {isStaff && (
              <label className="mt-2 flex items-start gap-2 text-xs text-text-secondary">
                <input type="checkbox" checked={allowBlocked} onChange={(e) => setAllowBlocked(e.target.checked)} className="mt-0.5" />
                <span>{t('previews.allowBlockedScan') || 'Run code blocked by the analysis (staff, audited)'}</span>
              </label>
            )}
          </details>
        )}
      </div>
    </Modal>
  );
}
