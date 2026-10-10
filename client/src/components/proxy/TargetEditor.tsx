import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Globe2, Server } from 'lucide-react';
import { SITE_CONTAINER_PORT, type AppStack, type AppStackDetail, type ProxyTarget, type ProxyTargetKind, type Site } from '@oblimint/shared';
import { proxyAppsLookup } from '@/api/proxy.api';
import { sitesApi } from '@/api/sites.api';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { NumberInput } from './proxyUi';
import { EMPTY_TARGET, intIn, isValidHostOrIp, targetComplete } from './proxyFormat';

export { EMPTY_TARGET, targetComplete };

/**
 * Target of a proxy host / sub-route / stream: an exposed port of an app
 * service of the SAME account, a site of the account (its primary container,
 * port 8080), or an external host (plan + tenant policy; private addresses
 * only by the platform staff). docs/P4b-PLAN.md §8.8.
 */
export function TargetEditor({ idPrefix, accountId, value, onChange, kinds = ['app', 'site', 'external'], protocol = 'tcp', platformStaff, disabled }: {
  idPrefix: string;
  accountId: number | null;
  value: ProxyTarget;
  onChange: (next: ProxyTarget) => void;
  kinds?: ProxyTargetKind[];
  /** Exposed ports offered for an app target (streams may be udp). */
  protocol?: 'tcp' | 'udp' | 'any';
  platformStaff: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [stacks, setStacks] = useState<AppStack[]>([]);
  const [stack, setStack] = useState<AppStackDetail | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [portText, setPortText] = useState(value.port ? String(value.port) : '');

  useEffect(() => { setPortText(value.port ? String(value.port) : ''); }, [value.port, value.kind]);

  useEffect(() => {
    if (accountId == null || !kinds.includes('app')) { setStacks([]); return; }
    let cancelled = false;
    proxyAppsLookup.stacks({ accountId }).then((l) => { if (!cancelled) setStacks(l); }).catch(() => { if (!cancelled) setStacks([]); });
    return () => { cancelled = true; };
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (accountId == null || !kinds.includes('site')) { setSites([]); return; }
    let cancelled = false;
    sitesApi.list({ accountId }).then((l) => { if (!cancelled) setSites(l); }).catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (value.kind !== 'app' || value.stackId == null) { setStack(null); return; }
    let cancelled = false;
    proxyAppsLookup.stack(value.stackId).then((s) => { if (!cancelled) setStack(s); }).catch(() => { if (!cancelled) setStack(null); });
    return () => { cancelled = true; };
  }, [value.kind, value.stackId]);

  const services = useMemo(() => (stack?.services ?? []).filter((s) => s.exposedPorts.some((p) => protocol === 'any' || p.protocol === protocol)), [stack, protocol]);
  const ports = useMemo(() => (services.find((s) => s.name === value.service)?.exposedPorts ?? []).filter((p) => protocol === 'any' || p.protocol === protocol), [services, value.service, protocol]);

  const setKind = (kind: ProxyTargetKind) => {
    if (kind === value.kind) return;
    if (kind === 'app') onChange({ kind, stackId: null, service: null, port: 0, scheme: 'http' });
    else if (kind === 'site') onChange({ kind, siteId: null, port: SITE_CONTAINER_PORT, scheme: 'http' });
    else onChange({ kind, host: '', port: 80, scheme: 'http', allowPrivate: false });
  };

  const kindTabs = [
    { id: 'app' as const, label: t('proxy.target.app') || 'Application', icon: <AppWindow size={14} /> },
    { id: 'site' as const, label: t('proxy.target.site') || 'Site', icon: <Server size={14} /> },
    { id: 'external' as const, label: t('proxy.target.external') || 'External', icon: <Globe2 size={14} /> },
  ].filter((k) => kinds.includes(k.id));

  const hostOk = value.kind !== 'external' || !value.host || isValidHostOrIp(value.host);
  const portOk = value.kind !== 'external' || intIn(portText, 1, 65535) !== null;

  return (
    <div className={cn('space-y-3', disabled && 'pointer-events-none opacity-60')}>
      {kindTabs.length > 1 && <SegmentedTabs size="sm" fill={false} tabs={kindTabs} value={value.kind} onChange={setKind} ariaLabel={t('proxy.target.kind') || 'Target kind'} />}

      {value.kind === 'app' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-stack`}>{t('proxy.target.stack') || 'Application'}</label>
            <select id={`${idPrefix}-stack`} value={value.stackId ?? ''} onChange={(e) => onChange({ ...value, stackId: e.target.value ? Number(e.target.value) : null, service: null, port: 0 })} className={selectCls}>
              <option value="">{stacks.length ? (t('proxy.target.chooseStack') || 'Choose…') : (t('proxy.target.noStack') || 'No application')}</option>
              {stacks.map((s) => <option key={s.id} value={s.id}>{s.displayName || s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-svc`}>{t('proxy.target.service') || 'Service'}</label>
            <select
              id={`${idPrefix}-svc`}
              value={value.service ?? ''}
              disabled={value.stackId == null}
              onChange={(e) => {
                const svc = services.find((s) => s.name === e.target.value);
                const first = svc?.exposedPorts.find((p) => protocol === 'any' || p.protocol === protocol);
                onChange({ ...value, service: e.target.value || null, port: first?.port ?? 0 });
              }}
              className={selectCls}
            >
              <option value="">{t('proxy.target.chooseService') || 'Choose…'}</option>
              {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              {value.service && !services.some((s) => s.name === value.service) && <option value={value.service}>{value.service}</option>}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-port`}>{t('proxy.target.port') || 'Port'}</label>
            <select id={`${idPrefix}-port`} value={value.port || ''} disabled={!value.service} onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })} className={cn(selectCls, 'font-mono')}>
              <option value="">—</option>
              {ports.map((p) => <option key={`${p.port}/${p.protocol}`} value={p.port}>{p.port}/{p.protocol}</option>)}
              {value.port > 0 && !ports.some((p) => p.port === value.port) && <option value={value.port}>{value.port}</option>}
            </select>
          </div>
          {stack && services.length === 0 && (
            <p className="text-xs text-amber-400 sm:col-span-3">{t('proxy.target.noExposed') || 'No service of this application exposes a port (compose `ports` / `expose`).'}</p>
          )}
          <div className="sm:col-span-3">
            <label className={labelCls} htmlFor={`${idPrefix}-scheme`}>{t('proxy.target.scheme') || 'Scheme'}</label>
            <select id={`${idPrefix}-scheme`} value={value.scheme} onChange={(e) => onChange({ ...value, scheme: e.target.value as ProxyTarget['scheme'] })} className={cn(selectCls, 'sm:w-40')}>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
        </div>
      )}

      {value.kind === 'site' && (
        <div>
          <label className={labelCls} htmlFor={`${idPrefix}-site`}>{t('proxy.target.site') || 'Site'}</label>
          <select id={`${idPrefix}-site`} value={value.siteId ?? ''} onChange={(e) => onChange({ ...value, siteId: e.target.value ? Number(e.target.value) : null, port: SITE_CONTAINER_PORT, scheme: 'http' })} className={selectCls}>
            <option value="">{sites.length ? (t('proxy.target.chooseSite') || 'Choose a site…') : (t('proxy.target.noSite') || 'No site')}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p className="mt-1 text-[11px] text-text-muted">{t('proxy.target.siteHint') || 'The primary container of the site (port 8080), as its own routes would.'}</p>
        </div>
      )}

      {value.kind === 'external' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_1fr_7rem]">
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-xscheme`}>{t('proxy.target.scheme') || 'Scheme'}</label>
            <select id={`${idPrefix}-xscheme`} value={value.scheme} onChange={(e) => onChange({ ...value, scheme: e.target.value as ProxyTarget['scheme'] })} className={selectCls}>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-host`}>{t('proxy.target.host') || 'Host (public name or IP)'}</label>
            <input
              id={`${idPrefix}-host`}
              value={value.host ?? ''}
              onChange={(e) => onChange({ ...value, host: e.target.value.trim().toLowerCase() })}
              placeholder="backend.example.net"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className={cn(inputCls, 'font-mono', !hostOk && 'ring-2 ring-status-down/50')}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor={`${idPrefix}-xport`}>{t('proxy.target.port') || 'Port'}</label>
            <NumberInput id={`${idPrefix}-xport`} value={portText} min={1} max={65535} invalid={!portOk} onChange={(v) => { setPortText(v); onChange({ ...value, port: intIn(v, 1, 65535) ?? 0 }); }} />
          </div>
          {platformStaff && (
            <label className="flex items-start gap-2 text-xs text-text-secondary sm:col-span-3">
              <input type="checkbox" className="mt-0.5 accent-accent" checked={!!value.allowPrivate} onChange={(e) => onChange({ ...value, allowPrivate: e.target.checked })} />
              <span>
                {t('proxy.target.allowPrivate') || 'Allow a private address (RFC 1918, CGNAT, ULA)'}
                <span className="block text-[11px] text-text-muted">{t('proxy.target.allowPrivateHint') || 'Platform staff only. The Docker / panel ranges, 127.0.0.0/8 and 169.254.0.0/16 stay refused.'}</span>
              </span>
            </label>
          )}
          <p className="text-[11px] text-text-muted sm:col-span-3">{t('proxy.target.externalHint') || 'External targets need the plan option and the workspace policy.'}</p>
        </div>
      )}
    </div>
  );
}
