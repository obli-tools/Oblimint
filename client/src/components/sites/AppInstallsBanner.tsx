import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket } from 'lucide-react';
import type { AppInstall } from '@oblimint/shared';
import { appInstallsApi } from '@/api/appInstalls.api';
import { Button } from '@/components/common/Button';
import { AppInstallProgressModal, AppInstallStatusPill } from './AppInstallProgressModal';

/** Installations that still need something: followed, resumed, published or cleaned from here. */
export function AppInstallsBanner({ accountId }: { accountId?: number | null }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AppInstall[]>([]);
  const [open, setOpen] = useState<AppInstall | null>(null);

  const load = useCallback(() => {
    appInstallsApi.list({ ...(accountId ? { accountId } : {}), status: ['running', 'failed', 'preview_ready', 'cleaning'] })
      .then(setItems)
      .catch(() => setItems([]));
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  if (items.length === 0 && !open) return null;
  return (
    <>
      {items.length > 0 && (
        <div className="space-y-1.5 rounded-lg bg-bg-secondary p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Rocket size={15} className="text-accent" />
            {t('sites.install.bannerTitle') || 'Application installations'}
          </div>
          {items.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
              <AppInstallStatusPill status={i.status} />
              <span className="font-medium text-text-primary">{i.siteName}</span>
              <span className="font-mono text-text-muted">{i.siteSlug}</span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(i)}>{t('sites.install.follow') || 'Open'}</Button>
            </div>
          ))}
        </div>
      )}
      {open && <AppInstallProgressModal installId={open.id} initial={open} onChanged={load} onClose={() => { setOpen(null); load(); }} />}
    </>
  );
}
