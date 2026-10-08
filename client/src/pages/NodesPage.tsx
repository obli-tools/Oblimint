import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import type { PanelNode } from '@oblimint/shared';
import { nodesApi } from '@/api/dashboard.api';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

/** Read-only list of the hosting nodes (P0: the seeded local node only). */
export function NodesPage() {
  const { t, i18n } = useTranslation();
  const [nodes, setNodes] = useState<PanelNode[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('nodes.title') || 'Nodes'}
        </h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('nodes.count', { count: nodes.length, defaultValue: '{{count}} node(s)' })}
        </span>
        <div className="ml-auto">
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
                <th className="px-4 py-3 font-medium">{t('nodes.col.name') || 'Name'}</th>
                <th className="px-4 py-3 font-medium">{t('nodes.col.engine') || 'Engine'}</th>
                <th className="px-4 py-3 font-medium">{t('nodes.col.created') || 'Created'}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </PageContainer>
  );
}
