import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeartPulse, Plus } from 'lucide-react';
import type { Site, UptimeMonitor } from '@oblimint/shared';
import { uptimeApi } from '@/api/uptime.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card } from '@/components/hosting/hostingUi';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { UptimeStatusPill } from '@/components/apps/AppBadges';
import { MonitorModal } from '@/components/uptime/MonitorModal';

/** Host name of a monitor URL (null when it has none: tcp). */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Uptime monitors of a site (Site > Logs & observation, coherence plan 1.3):
 * the monitors of the account whose URL targets the primary domain of the
 * site, and « Create a monitor for this site » prefilled with it.
 */
export function SiteMonitorsCard({ site }: { site: Site }) {
  const { t } = useTranslation();
  const { can } = useP4bAccess();
  const [monitors, setMonitors] = useState<UptimeMonitor[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [creating, setCreating] = useState(false);
  const domain = site.primaryDomain?.toLowerCase() ?? null;

  const load = useCallback(async () => {
    try {
      const all = await uptimeApi.listMonitors({ accountId: site.accountId });
      setMonitors(domain ? all.filter((m) => { const h = hostOf(m.url) ?? m.host?.toLowerCase() ?? null; return h === domain || h === `www.${domain}`; }) : []);
      setUnavailable(false);
    } catch {
      setMonitors([]);
      setUnavailable(true);
    }
  }, [site.accountId, domain]);
  useEffect(() => { void load(); }, [load]);

  // A caller without read access to the monitors never sees the card.
  if (unavailable) return null;
  const canCreate = can('monitoring.manage', site.accountId) && domain != null;

  return (
    <Card
      title={t('objectPage.site.monitors') || 'Uptime'}
      icon={<HeartPulse size={14} className="text-accent" />}
      actions={canCreate ? (
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
          <Plus size={13} className="mr-1" />{t('objectPage.site.createMonitor') || 'Create a monitor for this site'}
        </Button>
      ) : undefined}
    >
      {monitors === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>
      ) : monitors.length === 0 ? (
        <p className="text-xs text-text-muted">
          {domain
            ? t('objectPage.site.noMonitor', { domain, defaultValue: 'No monitor checks {{domain}} yet.' })
            : (t('objectPage.site.noDomainMonitor') || 'The site has no domain yet: a monitor needs an address to check.')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {monitors.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
              <Link to={`/uptime/monitors/${m.id}`} className="min-w-[8rem] text-sm font-medium text-text-primary hover:text-accent">{m.name}</Link>
              <UptimeStatusPill status={m.status} />
              <span className="min-w-0 truncate font-mono text-text-muted">{m.url ?? `${m.host ?? '?'}:${m.port ?? '?'}`}</span>
              {m.uptime24h != null && <span className="ml-auto font-mono text-text-secondary">{m.uptime24h.toFixed(2)} % · 24 h</span>}
            </li>
          ))}
        </ul>
      )}
      {creating && domain && (
        <MonitorModal
          monitor={null}
          accountId={site.accountId}
          accounts={[]}
          preset={{ name: site.name, url: `https://${domain}${site.basePath && site.basePath !== '/' ? site.basePath : '/'}` }}
          onClose={() => setCreating(false)}
          onSaved={(m) => { setCreating(false); setMonitors((cur) => [...(cur ?? []), m]); }}
        />
      )}
    </Card>
  );
}
