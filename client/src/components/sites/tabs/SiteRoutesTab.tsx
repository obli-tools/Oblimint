import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useHostingMe } from '@/store/hostingStore';
import { RouteEditor } from '@/components/hosting/RouteEditor';
import { accountHref } from '@/utils/links';
import type { SiteTabProps } from './types';

/** Routes & domains of a site: the common route editor (coherence plan D3), domain chosen per route. */
export function SiteRoutesTab({ site, reloadSite }: SiteTabProps) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('domains.manage', site.accountId);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-bg-secondary px-4 py-3 text-xs text-text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p>
          {t('siteRoutes.basePathNote', { basePath: site.basePath, defaultValue: 'A sub-site must know where it lives: the base path of this site is {{basePath}} (Overview tab).' })}{' '}
          <Link to={accountHref(site.accountId, 'domains')} className="text-accent hover:underline">{t('siteRoutes.manageDomains') || 'Manage domains'}</Link>
        </p>
      </div>
      <RouteEditor site={site} manage={canManage} onChanged={() => { void reloadSite(); }} />
    </div>
  );
}
