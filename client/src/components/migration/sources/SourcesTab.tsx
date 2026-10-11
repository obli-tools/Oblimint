import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { KeyRound, Pencil, PlugZap, Plus, Radar, ScrollText, Server, ShieldAlert, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import type { MigrationSource } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '../migrationFormat';
import { LoadState, SourceStatusPill, tdCls, toastMigrationError, type LoadError } from '../migrationUi';
import { SourceFormModal } from './SourceFormModal';
import { SourceTestModal } from './SourceTestModal';

export function HostKeyBadge({ source }: { source: MigrationSource }) {
  const { t } = useTranslation();
  const mismatch = !!source.hostKey && !!source.pendingHostKey && source.hostKey.fingerprint !== source.pendingHostKey.fingerprint;
  if (mismatch) return <Pill tone="red"><ShieldAlert size={10} />{t('migration.hostKey.mismatch') || 'Key mismatch'}</Pill>;
  if (source.hostKey) {
    return (
      <Tip content={<span className="font-mono text-[11px]">{source.hostKey.algorithm} {source.hostKey.fingerprint}</span>}>
        <span className="inline-flex cursor-help items-center gap-1.5">
          <Pill tone="green"><ShieldCheck size={10} />{t('migration.hostKey.pinnedShort') || 'pinned'}</Pill>
          <code className="hidden font-mono text-[10px] text-text-muted xl:inline">{source.hostKey.fingerprint.slice(0, 22)}…</code>
        </span>
      </Tip>
    );
  }
  if (source.pendingHostKey) return <Pill tone="amber"><KeyRound size={10} />{t('migration.hostKey.toReview') || 'Key to review'}</Pill>;
  return <Pill tone="muted"><ShieldOff size={10} />{t('migration.hostKey.notPinned') || 'Not pinned'}</Pill>;
}

/** Sources tab: SSH sources of CWP servers, connection test, host key pinning (docs/P5-PLAN.md §5.1, §11). */
export function SourcesTab({ sources, loading, error, onChanged, onReload, onShowCommands }: {
  sources: MigrationSource[];
  loading: boolean;
  error: LoadError | null;
  onChanged: (s: MigrationSource) => void;
  onReload: () => void;
  onShowCommands: (sourceId: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<MigrationSource | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [testing, setTesting] = useState<{ id: number; autoRun: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const testSource = testing ? sources.find((s) => s.id === testing.id) ?? null : null;
  const { sorted: sortedSources, sort } = useTableSort(sources, {
    name: (s) => s.name, connection: (s) => `${s.host}:${s.port}`, status: (s) => s.status, system: (s) => s.cwpVersion ?? '',
    hostKey: (s) => s.hostKey?.fingerprint ?? '', lastCheck: (s) => s.lastCheckedAt ?? '',
  });

  const remove = async (s: MigrationSource) => {
    if (!(await confirm({
      title: t('migration.sources.deleteTitle') || 'Delete the source',
      message: t('migration.sources.deleteConfirm', { name: s.name, defaultValue: 'Delete {{name}}? Its sealed credentials and its command log are removed. A source used by a discovery or a plan cannot be deleted (sourceInUse).' }),
      danger: true,
    }))) return;
    setBusy(s.id);
    try {
      await migrationApi.deleteSource(s.id);
      toast.success(t('migration.sources.deleted') || 'Source deleted');
      onReload();
    } catch (err) {
      toastMigrationError(t, err, t('migration.sources.deleteFailed') || 'The source could not be deleted');
    } finally {
      setBusy(null);
    }
  };

  const discover = async (s: MigrationSource) => {
    if (!s.hostKey) {
      toast.error(t('migration.errors.hostKeyUnpinned') || 'Pin the host key of the source first (test it, check the fingerprint, pin it).');
      setTesting({ id: s.id, autoRun: false });
      return;
    }
    setBusy(s.id);
    try {
      const d = await migrationApi.startDiscovery(s.id);
      toast.success(t('migration.discoveries.started') || 'Discovery started');
      navigate(`/manage/migration/discoveries/${d.id}`);
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.startFailed') || 'The discovery could not start');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('migration.sources.description') || 'SSH access to the CWP servers to migrate. The panel only runs a closed list of read-only commands there; every command is logged.'}</p>
        <button type="button" className={headerAccentBtnCls} onClick={() => { setEditing(null); setFormOpen(true); }}><Plus size={14} />{t('migration.sources.add') || 'Add a source'}</button>
      </div>
      <LoadState
        loading={loading}
        error={error}
        empty={sources.length === 0}
        emptyIcon={<Server />}
        emptyText={t('migration.sources.empty') || 'No source yet: declare the SSH access of the CWP server to migrate.'}
      >
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <SortTh k="name" sort={sort} className={thCls}>{t('migration.sources.name') || 'Source'}</SortTh>
                <SortTh k="connection" sort={sort} className={thCls}>{t('migration.sources.connection') || 'Connection'}</SortTh>
                <SortTh k="status" sort={sort} className={thCls}>{t('migration.sources.status') || 'Status'}</SortTh>
                <SortTh k="system" sort={sort} className={thCls}>{t('migration.sources.system') || 'CWP / OS'}</SortTh>
                <SortTh k="hostKey" sort={sort} className={thCls}>{t('migration.hostKey.title') || 'Host fingerprint'}</SortTh>
                <SortTh k="lastCheck" sort={sort} className={thCls}>{t('migration.sources.lastCheck') || 'Last check'}</SortTh>
                <th className={`${thCls} w-40`}><span className="sr-only">{t('migration.common.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {sortedSources.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-bg-hover">
                  <td className={tdCls}>
                    <div className="font-medium text-text-primary">{s.name}</div>
                    <div className="text-[11px] text-text-muted">#{s.id}</div>
                  </td>
                  <td className={tdCls}>
                    <div className="font-mono text-xs text-text-secondary">{s.username}@{s.host}:{s.port}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Pill tone="muted">{s.authMethod === 'key' ? (t('migration.sources.auth.key') || 'Private key') : (t('migration.sources.auth.password') || 'Password')}</Pill>
                      {s.useSudo && <Pill tone="blue">sudo -n</Pill>}
                      {!s.hasSecret && <Pill tone="red">{t('migration.sources.noSecret') || 'no secret'}</Pill>}
                    </div>
                  </td>
                  <td className={tdCls}>
                    <SourceStatusPill status={s.status} error={s.lastError} />
                    {s.lastError && <div className="mt-1 max-w-[220px] truncate text-[11px] text-status-down" title={s.lastError}>{s.lastError}</div>}
                  </td>
                  <td className={tdCls}>
                    <div className="font-mono text-xs text-text-secondary">{s.cwpVersion ?? '—'}</div>
                    <div className="max-w-[200px] truncate text-[11px] text-text-muted" title={s.osRelease ?? undefined}>{s.osRelease ?? ''}</div>
                  </td>
                  <td className={tdCls}><HostKeyBadge source={s} /></td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDateTime(s.lastCheckedAt, i18n.language)}</td>
                  <td className={`${tdCls} text-right`}>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="secondary" disabled={busy === s.id} onClick={() => setTesting({ id: s.id, autoRun: true })}>
                        <PlugZap size={13} className="mr-1.5" />{t('migration.sources.test') || 'Test'}
                      </Button>
                      <ActionMenu
                        label={t('migration.common.actions') || 'Actions'}
                        items={[
                          { key: 'discover', icon: <Radar size={14} />, label: t('migration.sources.discover') || 'Start a discovery', onClick: () => { void discover(s); }, disabled: busy === s.id },
                          { key: 'hostkey', icon: <KeyRound size={14} />, label: t('migration.hostKey.review') || 'Host key…', onClick: () => setTesting({ id: s.id, autoRun: false }) },
                          { key: 'commands', icon: <ScrollText size={14} />, label: t('migration.sources.commandLog') || 'Command log', onClick: () => onShowCommands(s.id) },
                          { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => { setEditing(s); setFormOpen(true); }, separator: true },
                          { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(s); }, danger: true },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </LoadState>

      <SourceFormModal
        open={formOpen}
        source={editing}
        onClose={() => setFormOpen(false)}
        onSaved={(s) => {
          setFormOpen(false);
          onChanged(s);
          if (!editing) setTesting({ id: s.id, autoRun: true });
        }}
      />
      {testing && (
        <SourceTestModal
          source={testSource}
          autoRun={testing.autoRun}
          onClose={() => setTesting(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
