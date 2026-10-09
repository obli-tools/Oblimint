import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ExternalLink, Info, Plus, Route as RouteIcon, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  HostingSocketEvents, normalizePathPrefix,
  type Domain, type HostingChangedPayload, type SiteRoute, type SiteRuntime,
} from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { BaseBadge, Pill } from '../SiteBadges';
import { siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import { cardCls, fieldCls, labelCls, tdCls, thCls } from '../styles';
import type { SiteTabProps } from './types';

export function SiteRoutesTab({ site, reloadSite }: SiteTabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canManage = can('domains.manage', site.accountId);

  const [routes, setRoutes] = useState<SiteRoute[]>([]);
  const [runtimes, setRuntimes] = useState<SiteRuntime[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [domainId, setDomainId] = useState<number | ''>('');
  const [prefix, setPrefix] = useState('/');
  const [runtimeId, setRuntimeId] = useState<number | ''>('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, rt] = await Promise.all([sitesApi.routes(site.id), sitesApi.runtimes(site.id)]);
      setRoutes(r);
      setRuntimes(rt);
      setError('');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canManage) return;
    domainsApi.list({ accountId: site.accountId }).then(setDomains).catch(() => setDomains([]));
  }, [site.accountId, canManage]);
  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (p.entity === 'domain' || (p.entity === 'site' && p.id === site.id)) void load();
  });

  const prefixNorm = normalizePathPrefix(prefix);

  const add = async () => {
    setAddError('');
    if (!domainId) { setAddError(t('siteRoutes.pickDomain') || 'Choose a domain.'); return; }
    if (prefixNorm === null) { setAddError(t('siteRoutes.prefixInvalid') || 'Invalid prefix: "/" or a path such as /shop/.'); return; }
    setAdding(true);
    try {
      await domainsApi.addRoute(domainId, { pathPrefix: prefixNorm, siteId: site.id, runtimeId: runtimeId || null });
      toast.success(t('siteRoutes.added') || 'Route added');
      setPrefix('/');
      setRuntimeId('');
      await Promise.all([load(), reloadSite()]);
    } catch (err) {
      setAddError(siteErrorMessage(err, t));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (r: SiteRoute) => {
    if (!(await confirm({
      message: t('siteRoutes.deleteConfirm', { route: `${r.domainName}${r.pathPrefix}`, defaultValue: 'Remove the route {{route}}? This address will no longer serve the site.' }),
      danger: true,
    }))) return;
    try {
      await domainsApi.deleteRoute(r.domainId, r.id);
      toast.success(t('siteRoutes.deleted') || 'Route removed');
      await Promise.all([load(), reloadSite()]);
    } catch (err) {
      toastSiteError(err, t);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-bg-secondary px-4 py-3 text-xs text-text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="space-y-1">
          <p>{t('siteRoutes.explain') || 'A route sends a domain + path prefix to this site. When several prefixes match a request, the longest one wins.'}</p>
          <p>
            {t('siteRoutes.basePathNote', { basePath: site.basePath, defaultValue: 'A sub-site must know where it lives: the base path of this site is {{basePath}} (Overview tab).' })}{' '}
            <Link to="/domains" className="text-accent hover:underline">{t('siteRoutes.manageDomains') || 'Manage domains'}</Link>
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : error ? (
        <div className="rounded-xl bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">{error}</div>
      ) : routes.length === 0 ? (
        <div className="rounded-xl bg-bg-secondary px-6 py-10 text-center">
          <RouteIcon className="mx-auto mb-3 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">{t('siteRoutes.empty') || 'No domain points to this site yet.'}</p>
        </div>
      ) : (
        <TableScroll className="bg-bg-secondary rounded-xl">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr>
                <th className={thCls}>{t('siteRoutes.fields.address') || 'Address'}</th>
                <th className={thCls}>{t('siteRoutes.fields.prefix') || 'Prefix'}</th>
                <th className={thCls}>{t('siteRoutes.fields.runtime') || 'Runtime'}</th>
                <th className={thCls}><span className="sr-only">{t('releases.fields.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-bg-tertiary">
                  <td className={tdCls}>
                    <a href={`https://${r.domainName}${r.pathPrefix}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-text-primary hover:text-accent">
                      {r.domainName}{r.pathPrefix}<ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                  <td className={`${tdCls} font-mono text-xs text-text-secondary`}>{r.pathPrefix}</td>
                  <td className={tdCls}>
                    {r.runtimeId == null
                      ? <Pill tone="accent" className="text-[10px] uppercase">{t('siteRoutes.primary') || 'primary'}</Pill>
                      : r.runtimeBase ? <BaseBadge base={r.runtimeBase} compact /> : <Pill tone="muted">#{r.runtimeId}</Pill>}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    {canManage && (
                      <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-3.5 w-3.5" />} variant="danger" size="sm" onClick={() => void remove(r)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {canManage && (
        <div className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('siteRoutes.addTitle') || 'Add a route'}</h2>
          {domains.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t('siteRoutes.noDomain') || 'This account has no domain yet.'}{' '}
              <Link to="/domains" className="text-accent hover:underline">{t('siteRoutes.manageDomains') || 'Manage domains'}</Link>
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
              <div>
                <label className={labelCls} htmlFor="route-domain">{t('siteRoutes.fields.domain') || 'Domain'}</label>
                <select id="route-domain" value={domainId} onChange={(e) => setDomainId(e.target.value ? Number(e.target.value) : '')} className={fieldCls}>
                  <option value="">{t('siteRoutes.pickDomain') || 'Choose a domain.'}</option>
                  {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="route-prefix">{t('siteRoutes.fields.prefix') || 'Prefix'}</label>
                <input
                  id="route-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  onBlur={() => { if (prefixNorm) setPrefix(prefixNorm); }}
                  className={`${fieldCls} font-mono ${prefixNorm === null ? 'ring-2 ring-red-400/60' : ''}`}
                  placeholder="/"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="route-runtime">{t('siteRoutes.fields.runtime') || 'Runtime'}</label>
                <select id="route-runtime" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value ? Number(e.target.value) : '')} className={fieldCls}>
                  <option value="">{t('siteRoutes.primaryOption', { base: site.base, defaultValue: 'Primary ({{base}})' })}</option>
                  {runtimes.map((rt) => <option key={rt.id} value={rt.id}>{t('siteRoutes.secondaryOption', { base: rt.base, defaultValue: 'Secondary ({{base}})' })}</option>)}
                </select>
              </div>
              <Button size="sm" onClick={() => void add()} loading={adding} className="coarse:min-h-10 sm:mb-px">
                <Plus size={14} className="mr-1" />{t('siteRoutes.add') || 'Add'}
              </Button>
              {(addError || (prefixNorm && prefixNorm !== prefix.trim())) && (
                <div className="sm:col-span-4">
                  {addError
                    ? <p className="text-xs text-red-400">{addError}</p>
                    : <p className="font-mono text-[11px] text-text-muted">→ {prefixNorm}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
