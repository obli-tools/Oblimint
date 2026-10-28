import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Info, Plus } from 'lucide-react';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { RouteEditor } from '@/components/hosting/RouteEditor';
import { DomainCreateModal } from '@/components/hosting/DomainCreateModal';
import { useDomainDrawer } from '@/components/hosting/DomainDrawer';
import type { SiteTabProps } from './types';

/**
 * Domains of a site (?tab=domains, old id `routes`): the common route editor
 * (coherence plan D3), the badges of each domain, its drawer opened in place
 * (?domain=) and « Add a domain » routed to this site (D2) — `&add=1` opens it.
 */
export function SiteRoutesTab({ site, reloadSite }: SiteTabProps) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('domains.manage', site.accountId);
  const drawer = useDomainDrawer();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(() => canManage && params.get('add') === '1');
  // Bumped after a creation: the route editor reloads its domains and routes.
  const [tick, setTick] = useState(0);

  const closeCreate = () => {
    setCreating(false);
    if (params.has('add')) setParams((prev) => { const next = new URLSearchParams(prev); next.delete('add'); return next; }, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-bg-secondary px-4 py-3 text-xs text-text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p>
          {t('siteRoutes.basePathNote', { basePath: site.basePath, defaultValue: 'A sub-site must know where it lives: the base path of this site is {{basePath}} (Configuration tab).' })}{' '}
          {t('siteRoutes.drawerHint') || 'Click a domain to open its ownership, certificate and settings.'}
        </p>
      </div>
      <RouteEditor
        key={tick}
        site={site}
        manage={canManage}
        onChanged={() => { void reloadSite(); }}
        onOpenDomain={drawer.open}
        actions={canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={13} className="mr-1" />{t('domains.create') || 'Add a domain'}
          </Button>
        ) : undefined}
      />
      {canManage && (
        <DomainCreateModal
          open={creating}
          accountId={site.accountId}
          siteId={site.id}
          onClose={closeCreate}
          onCreated={(d) => {
            closeCreate();
            toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
            setTick((n) => n + 1);
            void reloadSite();
            // Next step of a new domain: its ownership proof, in its drawer.
            drawer.open(d.id);
          }}
        />
      )}
    </div>
  );
}
