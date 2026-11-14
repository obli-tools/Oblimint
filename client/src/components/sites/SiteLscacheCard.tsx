import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { siteBaseDef, type Site } from '@oblimint/shared';
import { runtimeApi } from '@/api/runtime.api';
import { sitesApi } from '@/api/sites.api';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { toastSiteError } from './siteErrors';
import { cardCls } from './styles';

/** The site (or its blue/green preview) runs a base with the LSCache page cache. */
export function siteUsesLscache(site: Pick<Site, 'base' | 'previewBase'>): boolean {
  return siteBaseDef(site.base).lscache || (!!site.previewBase && siteBaseDef(site.previewBase).lscache);
}

/**
 * LSCache of a litespeed base (OpenLiteSpeed's page cache, driven by the
 * LSCache plugin of the CMS): on / off and « empty the cache ». The cache is
 * also emptied by every publication and every rollback.
 */
export function SiteLscacheCard({ site, canManage, onSiteChange }: {
  site: Site;
  canManage: boolean;
  onSiteChange: (site: Site) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'toggle' | 'purge' | null>(null);

  const toggle = async (next: boolean) => {
    setBusy('toggle');
    try {
      onSiteChange(await sitesApi.update(site.id, { lscacheEnabled: next }));
      toast.success(next
        ? (t('runtime.lscache.enabled') || 'Page cache enabled')
        : (t('runtime.lscache.disabled') || 'Page cache disabled'));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  const purge = async () => {
    if (!(await confirm({
      message: t('runtime.lscache.purgeConfirm') || 'Empty the page cache of the site? Pages are rebuilt by PHP on their next visit.',
      confirmLabel: t('runtime.lscache.purge') || 'Empty the cache',
    }))) return;
    setBusy('purge');
    try {
      await runtimeApi.purgeCache(site.id);
      toast.success(t('runtime.lscache.purged') || 'Page cache emptied');
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cardCls}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Zap className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">{t('runtime.lscache.title') || 'Page cache (LSCache)'}</h2>
        {canManage && (
          <div className="ml-auto">
            <Button size="sm" variant="secondary" onClick={() => void purge()} loading={busy === 'purge'} disabled={busy !== null || !site.lscacheEnabled}>
              <Eraser size={14} className="mr-1" />{t('runtime.lscache.purge') || 'Empty the cache'}
            </Button>
          </div>
        )}
      </div>
      <p className="mb-3 text-xs text-text-muted">
        {t('runtime.lscache.explain') || 'OpenLiteSpeed stores the pages the application marks as cacheable (LSCache plugin of WordPress, PrestaShop, Joomla…) and serves them without running PHP. Pages of logged-in visitors are never shared. The cache is emptied at every publication and rollback.'}
      </p>
      <ToggleSwitch
        checked={site.lscacheEnabled}
        onChange={(v) => void toggle(v)}
        disabled={!canManage || busy !== null}
        label={<span className="text-sm text-text-primary">{t('runtime.lscache.toggle') || 'Serve cached pages'}</span>}
        description={t('runtime.lscache.toggleHint') || 'Off: every request runs PHP (the plugin headers are ignored).'}
      />
    </div>
  );
}
