import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileStack, Play, Radar, RefreshCw, ScrollText, Server } from 'lucide-react';
import { HostingSocketEvents, type MigrationSource, type MigrationUpdatedPayload } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { patchSearchParams } from '@/components/migration/migrationFormat';
import { loadErrorOf, type LoadError } from '@/components/migration/migrationUi';
import { SourcesTab } from '@/components/migration/sources/SourcesTab';
import { DiscoveriesTab } from '@/components/migration/discoveries/DiscoveriesTab';
import { PlansTab } from '@/components/migration/plans/PlansTab';
import { RunsTab } from '@/components/migration/runs/RunsTab';
import { CommandsTab } from '@/components/migration/commands/CommandsTab';

type Tab = 'sources' | 'discoveries' | 'plans' | 'runs' | 'commands';
const TABS: readonly Tab[] = ['sources', 'discoveries', 'plans', 'runs', 'commands'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /manage/migration — sources (SSH connection, host key, test, command log),
 * discoveries, plans, runs (tabs ?tab=sources|discoveries|plans|runs|commands,
 * filters ?source= / ?plan=). Platform admin on the master tenant
 * (docs/P5-PLAN.md §11). OWNED BY MODULE `ui-migration`.
 */
export function MigrationPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'sources';
  const sourceParam = Number(params.get('source')) || null;
  const planParam = Number(params.get('plan')) || null;
  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => patchSearchParams(prev, patch), { replace: true });
  }, [setParams]);

  const [sources, setSources] = useState<MigrationSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [plansKey, setPlansKey] = useState(0);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await migrationApi.listSources();
      if (n !== seq.current) return;
      setSources(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setSources([]);
      setError(loadErrorOf(t, err, t('migration.sources.loadFailed') || 'Failed to load the sources'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => (p as MigrationUpdatedPayload | null)?.entity === 'source', 800);

  const upsert = (s: MigrationSource) => setSources((cur) => (cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s]));

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'sources', label: t('migration.tabs.sources') || 'Sources', icon: <Server size={16} />, badge: sources.length ? <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{sources.length}</span> : null },
    { id: 'discoveries', label: t('migration.tabs.discoveries') || 'Discoveries', icon: <Radar size={16} /> },
    { id: 'plans', label: t('migration.tabs.plans') || 'Plans', icon: <FileStack size={16} /> },
    { id: 'runs', label: t('migration.tabs.runs') || 'Runs', icon: <Play size={16} /> },
    { id: 'commands', label: t('migration.tabs.commands') || 'Commands', icon: <ScrollText size={16} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('migration.title') || 'CWP migration'}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => { setLoading(true); void load(); setPlansKey((n) => n + 1); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('migration.description') || 'Migrate a CentOS Web Panel server account by account, read-only on the source: discovery, plan (dry-run), resumable runs, resync and DNS cutover.'}
      </p>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={(next) => update({ tab: next === 'sources' ? null : next })} ariaLabel={t('migration.title') || 'CWP migration'} fill={false} />

      {tab === 'sources' && (
        <SourcesTab
          sources={sources}
          loading={loading}
          error={error}
          onChanged={upsert}
          onReload={() => { void load(); }}
          onShowCommands={(id) => update({ tab: 'commands', source: String(id) })}
        />
      )}
      {tab === 'discoveries' && (
        <DiscoveriesTab
          sources={sources}
          sourceFilter={sourceParam}
          onSourceFilter={(id) => update({ source: id == null ? null : String(id) })}
          onPlanCreated={() => setPlansKey((n) => n + 1)}
        />
      )}
      {tab === 'plans' && (
        <PlansTab sources={sources} sourceFilter={sourceParam} onSourceFilter={(id) => update({ source: id == null ? null : String(id) })} reloadKey={plansKey} />
      )}
      {tab === 'runs' && <RunsTab planFilter={planParam} onPlanFilter={(id) => update({ plan: id == null ? null : String(id) })} />}
      {tab === 'commands' && <CommandsTab sources={sources} sourceId={sourceParam} onSourceId={(id) => update({ source: id == null ? null : String(id) })} />}
    </PageContainer>
  );
}
