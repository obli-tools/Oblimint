import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Globe, Share2 } from 'lucide-react';
import type { AppStackDetail, PortBinding } from '@oblimint/shared';
import { Card, EmptyState, Pill, headerBtnCls } from '@/components/hosting/hostingUi';
import { publicPortsApi } from '@/api/publicPorts.api';
import { BindingsCard } from '@/components/network/AccountNetworkTab';

/**
 * Proxy hosts targeting the stack (module proxy-hosts) and the exposed ports
 * of its services, each with an "Expose" quick setup link to the proxy host
 * editor (/proxy/hosts/new?stack=&service=&port=, owned by ui-proxy).
 */
export function AppProxyTab({ stack, canManage }: { stack: AppStackDetail; canManage: boolean }) {
  const { t } = useTranslation();
  const exposed = stack.services.flatMap((s) => s.exposedPorts.filter((p) => p.protocol === 'tcp').map((p) => ({ service: s.name, port: p.port })));
  const isUsed = (service: string, port: number) => stack.proxyHosts.some((h) => h.service === service && h.port === port);
  // Migration 032: public ports of the stack (ports: "<public>:<container>" honoured inside the account's blocks).
  const [bindings, setBindings] = useState<PortBinding[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    publicPortsApi.stackBindings(stack.id).then((b) => { if (!cancelled) setBindings(b); }).catch(() => { if (!cancelled) setBindings([]); });
    return () => { cancelled = true; };
  }, [stack.id, stack.updatedAt]);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
      <Card title={t('apps.proxy.hosts') || 'Proxy hosts'}>
        {stack.proxyHosts.length === 0 ? (
          <EmptyState icon={<Globe />} text={t('apps.proxy.none') || 'No proxy host targets this application: it is not reachable from the Internet.'} />
        ) : (
          <ul className="divide-y divide-border/40">
            {stack.proxyHosts.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Link to={`/proxy/hosts/${h.id}`} className="inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-accent">
                  {h.name}<ExternalLink size={12} className="text-text-muted" />
                </Link>
                <Pill tone="muted">{h.service}:{h.port}</Pill>
                <div className="w-full font-mono text-xs text-text-secondary">
                  {h.domains.map((d) => (
                    <a key={d} href={`https://${d}`} target="_blank" rel="noopener noreferrer" className="mr-3 hover:text-accent">{d}</a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('apps.proxy.exposedPorts') || 'Exposed ports'}>
        {exposed.length === 0 ? (
          <p className="text-sm text-text-muted">{t('apps.proxy.noPorts') || 'No service exposes a TCP port (ports: or expose: in the compose file).'}</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {exposed.map((p) => (
              <li key={`${p.service}-${p.port}`} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-mono text-[13px] text-text-primary">{p.service}</span>
                <span className="font-mono text-xs text-text-muted">:{p.port}</span>
                {isUsed(p.service, p.port) && <Pill tone="green">{t('apps.proxy.exposed') || 'exposed'}</Pill>}
                {canManage && (
                  <Link
                    to={`/proxy/hosts/new?stack=${stack.id}&service=${encodeURIComponent(p.service)}&port=${p.port}`}
                    className={`${headerBtnCls} ml-auto`}
                  >
                    <Share2 size={13} />{t('apps.proxy.expose') || 'Expose'}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-text-muted">{t('apps.proxy.hintPublic') || 'A proxy host (HTTPS, domain of the account) is the way in for the web; raw TCP / UDP ports are published only inside the public ports of the account (Account → Network).'}</p>
      </Card>
      {bindings && bindings.length > 0 && (
        <div className="xl:col-span-2"><BindingsCard bindings={bindings} title={t('apps.proxy.publishedPorts') || 'Published ports'} /></div>
      )}
    </div>
  );
}
