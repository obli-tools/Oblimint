import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, ScrollText, ShieldAlert } from 'lucide-react';
import type {
  MigrationCommandLogEntry, MigrationCommandPhase, MigrationCommandStatus, MigrationCommandTemplateInfo, MigrationSource,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { TableScroll } from '@/components/common/TableScroll';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Pager } from '@/components/mail/MailListParts';
import { Card, EmptyState, Pill, inputCls, selectCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, formatDateTime, formatDuration } from '../migrationFormat';
import { CommandStatusPill, LoadState, MonoExpand, commandStatusLabel, loadErrorOf, tdCls, useByteUnits, type LoadError } from '../migrationUi';

const PAGE = 50;
const STATUSES: MigrationCommandStatus[] = ['ok', 'error', 'refused', 'timeout'];

export function PhasePill({ phase }: { phase: MigrationCommandPhase }) {
  const { t } = useTranslation();
  return <Pill tone={phase === 'transfer' ? 'accent' : 'muted'}>{t(`migration.commands.phases.${phase}`, { defaultValue: phase })}</Pill>;
}

export function SensitivePill() {
  const { t } = useTranslation();
  return <Pill tone="amber" title={t('migration.commands.sensitiveHint') || 'Reads a secret (hash / private key): its output is never logged nor kept.'}><ShieldAlert size={10} />{t('migration.commands.sensitive') || 'sensitive'}</Pill>;
}

/** Template description: migration.templates.<id> (ids contain dots → nested keys). */
export function templateDescription(t: (k: string, o?: Record<string, unknown>) => string, id: string): string {
  return t(`migration.templates.${id}`, { defaultValue: '' });
}

function CommandLog({ sourceId }: { sourceId: number }) {
  const { t, i18n } = useTranslation();
  const units = useByteUnits();
  const [items, setItems] = useState<MigrationCommandLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<MigrationCommandStatus | ''>('');
  const [phase, setPhase] = useState<MigrationCommandPhase | ''>('');
  const [scope, setScope] = useState<{ runId?: number; discoveryId?: number }>({});
  const [scopeText, setScopeText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);

  useEffect(() => { setOffset(0); }, [sourceId, status, scope]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await migrationApi.commands(sourceId, { limit: PAGE, offset, status: status || undefined, ...scope });
      if (n !== seq.current) return;
      setItems(r.items);
      setTotal(r.total);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setTotal(0);
      setError(loadErrorOf(t, err, t('migration.commands.loadFailed') || 'Failed to load the command log'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [sourceId, offset, status, scope, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  const applyScope = (v: string) => {
    setScopeText(v);
    const m = /^\s*(run|r|discovery|d)\s*#?\s*(\d+)\s*$/i.exec(v);
    if (!v.trim()) setScope({});
    else if (m) setScope(m[1].toLowerCase().startsWith('r') ? { runId: Number(m[2]) } : { discoveryId: Number(m[2]) });
  };

  // The route has no phase parameter: the phase filter applies to the current page only (the pager stays reachable).
  const shown = phase ? items.filter((c) => c.phase === phase) : items;
  const phaseHidesPage = !!phase && items.length > 0 && shown.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('migration.common.status') || 'Status'} value={status} onChange={(e) => setStatus(e.target.value as MigrationCommandStatus | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-40')}>
          <option value="">{t('migration.common.allStatuses') || 'Every status'}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{commandStatusLabel(t, s)}</option>)}
        </select>
        <select aria-label={t('migration.commands.phase') || 'Phase'} value={phase} onChange={(e) => setPhase(e.target.value as MigrationCommandPhase | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-40')}>
          <option value="">{t('migration.commands.allPhases') || 'Every phase'}</option>
          <option value="discovery">{t('migration.commands.phases.discovery') || 'discovery'}</option>
          <option value="transfer">{t('migration.commands.phases.transfer') || 'transfer'}</option>
        </select>
        <input
          aria-label={t('migration.commands.scope') || 'Run or discovery'}
          className={cn(inputCls, 'w-full bg-bg-secondary font-mono sm:w-48')}
          placeholder={t('migration.commands.scopePlaceholder') || 'run 12 / discovery 3'}
          value={scopeText}
          onChange={(e) => applyScope(e.target.value)}
        />
        <span className="ml-auto font-mono text-[11px] text-text-muted">{t('migration.commands.total', { count: total, defaultValue: '{{count}} command(s)' })}</span>
      </div>
      <LoadState loading={loading} error={error} empty={shown.length === 0} emptyIcon={<ScrollText />} emptyText={phaseHidesPage ? (t('migration.commands.phaseEmptyPage') || 'No command of this phase on this page: use the pager.') : (t('migration.commands.empty') || 'No command logged for this source.')}>
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[1000px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('migration.commands.date') || 'Date'}</th>
                <th className={thCls}>{t('migration.commands.template') || 'Template'}</th>
                <th className={thCls}>{t('migration.commands.command') || 'Rendered command'}</th>
                <th className={thCls}>{t('migration.common.status') || 'Status'}</th>
                <th className={thCls}>{t('migration.commands.exit') || 'Exit'}</th>
                <th className={thCls}>{t('migration.commands.bytes') || 'Output'}</th>
                <th className={thCls}>{t('migration.runs.duration') || 'Duration'}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className={cn('transition-colors hover:bg-bg-hover', c.status === 'refused' && 'bg-status-down/[0.05]')}>
                  <td className={`${tdCls} whitespace-nowrap font-mono text-[11px] text-text-muted`}>
                    {formatDateTime(c.createdAt, i18n.language)}
                    <div className="text-[10px]">{c.runId != null ? `run #${c.runId}` : c.discoveryId != null ? `disc. #${c.discoveryId}` : ''}</div>
                  </td>
                  <td className={tdCls}>
                    <code className="font-mono text-xs text-text-primary">{c.template}</code>
                    <div className="mt-1 flex flex-wrap gap-1"><PhasePill phase={c.phase} />{c.sensitive && <SensitivePill />}</div>
                  </td>
                  <td className={`${tdCls} max-w-[420px]`}><MonoExpand text={c.command} /></td>
                  <td className={tdCls}>
                    <CommandStatusPill status={c.status} />
                    {c.error && <div className={cn('mt-1 max-w-[260px] break-words text-[11px]', c.status === 'refused' ? 'text-status-down' : 'text-amber-400')}>{c.error}</div>}
                  </td>
                  <td className={`${tdCls} font-mono text-xs text-text-secondary`}>{c.exitCode ?? '—'}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatBytes(c.bytesOut, units)}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDuration(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </LoadState>
      {!loading && !error && total > PAGE && <Pager offset={offset} total={total} pageSize={PAGE} onOffset={setOffset} />}
    </div>
  );
}

function AllowList() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MigrationCommandTemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  useEffect(() => {
    let cancelled = false;
    migrationApi.allowlist()
      .then((l) => { if (!cancelled) { setItems(l); setError(null); } })
      .catch((err) => { if (!cancelled) setError(loadErrorOf(t, err, t('migration.commands.allowlistFailed') || 'Failed to load the allow-list')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t]);
  return (
    <Card title={t('migration.commands.allowlist') || 'Allow-list of the read-only executor'} icon={<ListChecks size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">{t('migration.commands.allowlistIntro') || 'The only commands the panel can run on a source. Arguments are validated (read roots, deny list, SQL guard, no symlink under /home or /var/vmail) and quoted; anything else is refused and logged.'}</p>
      <LoadState loading={loading} error={error} empty={items.length === 0} emptyIcon={<ListChecks />} emptyText={t('migration.commands.allowlistEmpty') || 'Empty allow-list.'}>
        <TableScroll>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('migration.commands.template') || 'Template'}</th>
                <th className={thCls}>{t('migration.commands.descriptionCol') || 'What it does'}</th>
                <th className={thCls}>{t('migration.commands.phases.title') || 'Phases'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tpl) => (
                <tr key={tpl.id} className="border-t border-white/[0.04]">
                  <td className={tdCls}><code className="font-mono text-xs text-text-primary">{tpl.id}</code></td>
                  <td className={`${tdCls} text-xs text-text-secondary`}>{templateDescription(t, tpl.id) || tpl.description}</td>
                  <td className={tdCls}><div className="flex flex-wrap gap-1">{tpl.phases.map((p) => <PhasePill key={p} phase={p} />)}{tpl.sensitive && <SensitivePill />}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </LoadState>
    </Card>
  );
}

/** Commands tab: command log of a source (paginated, filters) + the allow-list as a reference. */
export function CommandsTab({ sources, sourceId, onSourceId }: {
  sources: MigrationSource[];
  sourceId: number | null;
  onSourceId: (id: number | null) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'log' | 'allowlist'>('log');
  const effective = sourceId ?? (sources.length === 1 ? sources[0].id : null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs<'log' | 'allowlist'>
          size="sm"
          fill={false}
          tabs={[
            { id: 'log', label: t('migration.commands.log') || 'Command log', icon: <ScrollText size={14} /> },
            { id: 'allowlist', label: t('migration.commands.allowlistShort') || 'Allow-list', icon: <ListChecks size={14} /> },
          ]}
          value={view}
          onChange={setView}
          ariaLabel={t('migration.tabs.commands') || 'Commands'}
        />
        {view === 'log' && sources.length > 0 && (
          <select aria-label={t('migration.common.source') || 'Source'} value={effective ?? ''} onChange={(e) => onSourceId(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-64')}>
            <option value="">{t('migration.commands.pickSource') || 'Choose a source…'}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>
      {view === 'allowlist'
        ? <AllowList />
        : effective != null
          ? <CommandLog key={effective} sourceId={effective} />
          : <EmptyState icon={<ScrollText />} text={t('migration.commands.pickSourceHint') || 'Choose a source to see the commands run on it (refused ones included).'} />}
    </div>
  );
}
