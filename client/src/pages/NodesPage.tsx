import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Server, RefreshCw, PackageCheck, Boxes } from 'lucide-react';
import toast from 'react-hot-toast';
import type { PanelNode, PlatformUpdatesSummary } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { platformUpdatesApi } from '@/api/platformUpdates.api';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { PlatformUpdatesPanel } from '@/components/hosting/PlatformUpdatesPanel';
import { Pill, useHostingEvents } from '@/components/hosting/hostingUi';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { nodesApi } from '@/api/dashboard.api';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InfraCards } from '@/components/hosting/InfraCards';
import { HostResources, useHostMetrics } from '@/components/usage/HostResources';

/**
 * Hosting nodes (P0: the seeded local node only) + the platform infrastructure
 * of the local node (P1: edge, hostd, disk quota mode, reconcile, ACME).
 */
export function NodesPage() {
  const { t, i18n } = useTranslation();
  const [nodes, setNodes] = useState<PanelNode[]>([]);
  const [loading, setLoading] = useState(true);
  // Platform updates: platform administrator on the master tenant only.
  const masterAdmin = useIsMasterTenant();
  const host = useHostMetrics(masterAdmin);
  const [params, setParams] = useSearchParams();
  const tab = masterAdmin && params.get('tab') === 'updates' ? 'updates' : 'infra';
  const [summary, setSummary] = useState<PlatformUpdatesSummary | null>(null);
  const loadSummary = () => {
    if (!masterAdmin) return;
    platformUpdatesApi.summary().then(setSummary).catch(() => setSummary(null));
  };
  useEffect(loadSummary, [masterAdmin]); // eslint-disable-line react-hooks/exhaustive-deps
  useHostingEvents([HostingSocketEvents.PLATFORM_UPDATES], loadSummary, undefined, 1000);

  const load = async () => {
    setLoading(true);
    try {
      setNodes(await nodesApi.list());
    } catch {
      toast.error(t('nodes.loadFailed') || 'Failed to load nodes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const engineLabel = (e: PanelNode['engineType']) =>
    e === 'local' ? (t('nodes.engine.local') || 'Local (Docker socket)')
      : e === 'ssh' ? (t('nodes.engine.ssh') || 'Remote (SSH)')
      : (t('nodes.engine.tls') || 'Remote (TLS)');

  const { sorted, sort } = useTableSort(nodes, { name: (n) => n.name, engine: (n) => n.engineType, created: (n) => n.createdAt });
  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('nodes.title') || 'Nodes'}
        </h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('nodes.count', { count: nodes.length, defaultValue: '{{count}} node(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {masterAdmin && (
            <button
              onClick={() => setParams({ tab: 'updates' })}
              className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-accent/12 hover:bg-accent/20 text-[13px] font-medium text-accent transition-colors whitespace-nowrap coarse:h-10"
            >
              <PackageCheck size={14} />
              {t('platformUpdates.openButton') || 'Update Oblimint'}
              {summary && summary.available + summary.failed > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">{summary.available + summary.failed}</span>}
            </button>
          )}
          <button
            onClick={() => { void load(); }}
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-bg-hover hover:bg-bg-active text-[13px] font-medium text-text-primary transition-colors whitespace-nowrap coarse:h-10"
          >
            <RefreshCw size={14} />
            {t('common.refresh') || 'Refresh'}
          </button>
        </div>
      </div>

      <p className="text-sm text-text-muted">
        {t('nodes.description') || 'Servers that run the hosted sites. This version manages a single local node; remote nodes will come later.'}
      </p>

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : nodes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-bg-secondary py-12 text-text-muted">
          <Server size={24} className="opacity-40" />
          <p className="text-sm">{t('nodes.empty') || 'No node registered.'}</p>
        </div>
      ) : (
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
                <SortTh k="name" sort={sort} className="px-4 py-3 font-medium">{t('nodes.col.name') || 'Name'}</SortTh>
                <SortTh k="engine" sort={sort} className="px-4 py-3 font-medium">{t('nodes.col.engine') || 'Engine'}</SortTh>
                <SortTh k="created" sort={sort} className="px-4 py-3 font-medium">{t('nodes.col.created') || 'Created'}</SortTh>
                {masterAdmin && <th className="px-4 py-3 font-medium">{t('platformUpdates.col.updates') || 'Updates'}</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((n) => (
                <tr key={n.id} className="hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Server size={15} className="text-text-muted shrink-0" />
                      <span className="font-medium text-text-primary">{n.name}</span>
                      {n.isLocal && (
                        <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-accent">
                          {t('nodes.local') || 'Local'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{engineLabel(n.engineType)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted whitespace-nowrap">
                    {new Date(n.createdAt).toLocaleString(i18n.language)}
                  </td>
                  {masterAdmin && (
                    <td className="px-4 py-3">
                      {summary && summary.nodeId === n.id ? (
                        <button type="button" onClick={() => setParams({ tab: 'updates' })} className="rounded-full">
                          {summary.updating ? <Pill tone="blue">{t('platformUpdates.status.updating') || 'Updating'}</Pill>
                            : summary.failed > 0 ? <Pill tone="red">{t('platformUpdates.status.failed') || 'Failed'}</Pill>
                            : summary.available > 0 ? <Pill tone="amber">{t('platformUpdates.availableCount', { count: summary.available, defaultValue: '{{count}} to apply' })}</Pill>
                            : summary.checkedAt ? <Pill tone="green">{t('platformUpdates.status.upToDate') || 'Up to date'}</Pill>
                            : <Pill>{t('platformUpdates.status.unchecked') || 'Not checked'}</Pill>}
                        </button>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {/* Resources of the local node (the only one in this version). */}
      {masterAdmin && !loading && nodes.some((x) => x.isLocal) && (
        <HostResources metrics={host} />
      )}

      {masterAdmin && (
        <SegmentedTabs
          className="mt-2 self-start"
          value={tab}
          onChange={(id) => setParams(id === 'updates' ? { tab: 'updates' } : {})}
          tabs={[
            { id: 'infra', label: t('infra.sectionTitle') || 'Platform services', icon: <Boxes size={14} /> },
            {
              id: 'updates', label: t('platformUpdates.tab') || 'Updates', icon: <PackageCheck size={14} />,
              badge: summary && summary.available + summary.failed > 0 ? summary.available + summary.failed : undefined,
            },
          ]}
        />
      )}
      {tab === 'updates' ? <PlatformUpdatesPanel /> : (
        <>
          <h2 className="mt-2 font-display text-lg font-semibold tracking-wide text-text-primary">
            {t('infra.sectionTitle') || 'Platform services'}
          </h2>
          <InfraCards />
        </>
      )}
    </PageContainer>
  );
}
