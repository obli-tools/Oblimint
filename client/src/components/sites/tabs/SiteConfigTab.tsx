import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Database, Plus } from 'lucide-react';
import { HostingSocketEvents, type DbInstance } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card, CopyButton, Pill, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { DbInstanceCreateModal } from '@/components/databases/DbInstanceCreateModal';
import { RelaysCard } from '@/components/mail/MailOutboundPanel';
import { accountHref } from '@/utils/links';
import { SiteSettingsCard } from '../SiteSettingsCard';
import { LeakGuardCard } from '../LeakGuard';
import { sectionLabelCls } from '../styles';
import { SiteDataPathsTab } from './SiteDataPathsTab';
import { SiteEnvTab } from './SiteEnvTab';
import type { SiteTabProps } from './types';

/** Sections of the Configuration tab reachable with `&section=` (aliases `data` / `env`). */
type Section = 'general' | 'leaks' | 'data' | 'env' | 'db' | 'mail';

/**
 * Configuration of a site (coherence plan 1.3): general settings and
 * publication, data paths, variables, the databases the site can reach and
 * its PHP mail() relay. The old tabs « Data paths » (?tab=data) and
 * « Variables » (?tab=env) open on their section here.
 */
export function SiteConfigTab(props: SiteTabProps) {
  const { site } = props;
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [params] = useSearchParams();
  const section = params.get('section') as Section | null;

  // Deep link to a section (alias of an old tab): scroll to it once.
  useEffect(() => {
    if (!section || section === 'general') return;
    const id = window.setTimeout(() => document.getElementById(`site-config-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => window.clearTimeout(id);
  }, [section]);

  return (
    <div className="space-y-6">
      <section id="site-config-general" className="scroll-mt-4">
        <SiteSettingsCard site={site} onSiteChange={props.onSiteChange} part="general" />
      </section>
      <section id="site-config-leaks" className="scroll-mt-4">
        <LeakGuardCard site={site} onSiteChange={props.onSiteChange} />
      </section>
      <section id="site-config-data" className="scroll-mt-4">
        <div className={sectionLabelCls}>{t('sites.tabs.data') || 'Data paths'}</div>
        <SiteDataPathsTab {...props} />
      </section>
      <section id="site-config-env" className="scroll-mt-4">
        <div className={sectionLabelCls}>{t('siteEnv.tab') || 'Variables'}</div>
        <SiteEnvTab {...props} />
      </section>
      <section id="site-config-db" className="scroll-mt-4">
        <SiteDatabaseCard accountId={site.accountId} />
      </section>
      {can('mail.manage', site.accountId) && (
        <section id="site-config-mail" className="scroll-mt-4">
          <RelaysCard accountId={site.accountId} siteId={site.id} />
        </section>
      )}
    </div>
  );
}

/**
 * The database instances of the account, as the site reaches them (socket in
 * its containers, host:port on the account network). Created in place.
 */
function SiteDatabaseCard({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const manage = can('databases.manage', accountId);
  const [instances, setInstances] = useState<DbInstance[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstances(await databasesApi.listInstances({ accountId }));
      setError(false);
    } catch {
      setInstances([]);
      setError(true);
    }
  }, [accountId]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED], () => { void load(); }, (_e, p) => payloadNumber(p, 'accountId') === accountId);

  return (
    <Card
      title={t('objectPage.site.dbTitle') || 'Database'}
      icon={<Database size={14} className="text-accent" />}
      actions={manage ? (
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Plus size={13} className="mr-1" />{t('databases.create') || 'New instance'}</Button>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('objectPage.site.dbIntro') || 'The database instances of the account are shared by its sites: the default one of each family answers on the standard socket inside the site (no host to configure).'}{' '}
        <Link to={accountHref(accountId, 'databases')} className="text-accent hover:underline">{t('objectPage.site.dbAccount') || 'Databases of the account'}</Link>
      </p>
      {instances === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>
      ) : error ? (
        <p className="text-xs text-text-muted">{t('objectPage.notReadable') || 'Not available.'}</p>
      ) : instances.length === 0 ? (
        <p className="text-xs text-text-muted">{t('databases.account.empty') || 'No database instance on this account.'}</p>
      ) : (
        <ul className="divide-y divide-border">
          {instances.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-xs">
              <Link to={`/databases/${i.id}`} className="min-w-[8rem] text-sm font-medium text-text-primary hover:text-accent">{i.name}</Link>
              <span className="font-mono text-text-muted">{i.engine} {i.version}</span>
              {i.isDefault && <Pill tone="accent">{t('objectPage.site.dbDefault') || 'default'}</Pill>}
              <span className="inline-flex items-center gap-1 font-mono text-text-secondary">{i.socketPath}<CopyButton text={i.socketPath} /></span>
              <span className="inline-flex items-center gap-1 font-mono text-text-secondary">{`${i.internalHost}:${i.internalPort}`}<CopyButton text={`${i.internalHost}:${i.internalPort}`} /></span>
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <DbInstanceCreateModal
          open={creating}
          accountId={accountId}
          onClose={() => setCreating(false)}
          onCreated={(i) => {
            setCreating(false);
            toast.success(t('databases.created', { name: i.name, defaultValue: 'Instance {{name}} created' }));
            setInstances((cur) => [...(cur ?? []).filter((x) => x.id !== i.id), i]);
          }}
        />
      )}
    </Card>
  );
}
