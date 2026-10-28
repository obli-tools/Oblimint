import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Archive, Database, FolderOpen, Code2, Play, RotateCcw } from 'lucide-react';
import type { BackupObject, BackupRestoreItem, BackupRun } from '@oblimint/shared';
import { backupsApi } from '@/api/backups.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { RunRow } from '@/components/settings/BackupSettingsSections';
import { formatBytes } from '@/components/usage/usageFormat';
import { Card, EmptyState, toastHostingError } from './hostingUi';

// « Sauvegardes » of an account: the external backups made of it (daily
// schedule of the platform, or on demand), restore of a site's code / data or
// of a database from one of them.

export function AccountBackupsTab({ accountId, siteId, databaseIds, canRun, canManage, can }: {
  accountId: number;
  /**
   * Site page (Releases & restore): only the backups holding this site, and
   * only its code / data restorable (filtered here: the server lists the account).
   */
  siteId?: number;
  /**
   * Database instance page: only the backups holding one of these databases,
   * and only them restorable (filtered here too).
   */
  databaseIds?: number[];
  /** sites.manage: start a backup now. */
  canRun: boolean;
  /** accounts.manage (staff): exclude the account from the schedule. */
  canManage: boolean;
  can: { code: boolean; data: boolean; db: boolean };
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ runs: BackupRun[]; enabled: boolean; scheduled: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoring, setRestoring] = useState<BackupRun | null>(null);

  const load = useCallback(async () => {
    try { setState(await backupsApi.account(accountId)); } catch (err) {
      toastHostingError(t, err, t('backups.loadFailed') || 'The backups could not be loaded');
      setState({ runs: [], enabled: true, scheduled: false });
    }
  }, [accountId, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!state?.runs.some((r) => r.status === 'running')) return;
    const id = setInterval(() => { void backupsApi.account(accountId).then(setState).catch(() => {}); }, 4000);
    return () => clearInterval(id);
  }, [state, accountId]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');

  const runNow = async () => {
    setStarting(true);
    try {
      await backupsApi.runAccount(accountId);
      toast.success(t('backups.runStarted') || 'Backup started');
      await load();
    } catch (err) {
      if (!isStepUpHandled(err)) toastHostingError(t, err, t('backups.runFailed') || 'The backup could not start');
    } finally { setStarting(false); }
  };

  const toggle = async (enabled: boolean) => {
    try {
      await backupsApi.setAccountEnabled(accountId, enabled);
      setState((s) => (s ? { ...s, enabled } : s));
    } catch (err) { toastHostingError(t, err, t('backups.saveFailed') || 'The settings could not be saved'); }
  };

  if (!state) return <div className="flex justify-center p-8"><LoadingSpinner /></div>;
  // Scope of the page: the objects of this site / of these databases (the server lists the account).
  const inScope = (o: BackupObject) => (siteId != null ? o.siteId === siteId
    : databaseIds != null ? o.kind === 'db' && o.databaseId != null && databaseIds.includes(o.databaseId)
      : true);
  const scoped = siteId != null || databaseIds != null;
  const scopeCan = siteId != null ? { ...can, db: false } : databaseIds != null ? { code: false, data: false, db: can.db } : can;
  const canRestore = scopeCan.code || scopeCan.data || scopeCan.db;
  const runs = scoped ? state.runs.filter((r) => r.objects.some(inScope)) : state.runs;
  const title = siteId != null ? (t('backups.siteTitle') || 'Backups of the site')
    : databaseIds != null ? (t('backups.dbTitle') || 'Backups of the databases')
      : (t('backups.title') || 'Backups');

  return (
    <div className="space-y-4">
      <Card
        icon={<Archive size={14} className="text-accent" />}
        title={title}
        actions={canRun ? <Button size="sm" loading={starting} onClick={() => { void runNow(); }}><Play className="mr-1 h-3.5 w-3.5" />{scoped ? (t('backups.runAccountNow') || 'Back up the account now') : (t('backups.runNow') || 'Back up now')}</Button> : undefined}
      >
        {siteId != null && (
          <p className="mb-1.5 text-xs text-text-muted">{t('backups.siteHint') || 'The backups of the account that hold this site: its code (back into the staging folder) and its data can be restored from here; the databases from their instance page.'}</p>
        )}
        {databaseIds != null && (
          <p className="mb-1.5 text-xs text-text-muted">{t('backups.dbHint') || 'The backups of the account that hold a database of this instance: each one can be restored from here; the code and data of the sites from the site.'}</p>
        )}
        <p className="text-xs text-text-muted">
          {!state.scheduled
            ? (t('backups.accountNotScheduled') || 'The daily backups are not enabled on the platform (Settings > Backups).')
            : state.enabled
              ? (t('backups.accountScheduled') || 'This account is backed up every day off-site, encrypted: site code, site data and databases.')
              : (t('backups.accountExcluded') || 'This account is excluded from the daily backups.')}
        </p>
        {canManage && (
          <div className="mt-3">
            <ToggleSwitch size="sm" checked={state.enabled} onChange={(v) => { void toggle(v); }} label={t('backups.accountInclude') || 'Include this account in the daily backups'} />
          </div>
        )}
      </Card>

      {!runs.length ? <EmptyState icon={<Archive />} text={t('backups.noRuns') || 'No backup yet.'} /> : (
        <div className="divide-y divide-border rounded-xl bg-bg-secondary p-4">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} fmt={fmt}>
              {canRestore && !r.purgedAt && (r.status === 'ok' || r.status === 'partial') && (
                <Button size="sm" variant="secondary" onClick={() => setRestoring(r)}><RotateCcw className="mr-1 h-3.5 w-3.5" />{t('backups.restore') || 'Restore'}</Button>
              )}
            </RunRow>
          ))}
        </div>
      )}

      <RestoreModal accountId={accountId} inScope={inScope} run={restoring} can={scopeCan} fmt={fmt} onClose={() => setRestoring(null)} />
    </div>
  );
}

function itemOf(o: BackupObject): BackupRestoreItem | null {
  if ((o.kind === 'code' || o.kind === 'data') && o.siteId) return { kind: o.kind, siteId: o.siteId };
  if (o.kind === 'db' && o.databaseId) return { kind: 'db', databaseId: o.databaseId };
  return null;
}

function RestoreModal({ accountId, inScope, run, can, fmt, onClose }: {
  accountId: number; inScope: (o: BackupObject) => boolean; run: BackupRun | null; can: { code: boolean; data: boolean; db: boolean }; fmt: (iso: string | null) => string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Array<BackupRestoreItem & { ok: boolean; error?: string; files?: number }> | null>(null);
  useEffect(() => { setPicked(new Set()); setResult(null); }, [run]);
  if (!run) return null;

  const objects = run.objects.filter((o) => itemOf(o) && can[o.kind as 'code' | 'data' | 'db'] && inScope(o));
  const keyOf = (o: BackupObject) => o.key;
  const word = t('backups.restoreWord') || 'RESTORE';

  const submit = async () => {
    const chosen = objects.filter((o) => picked.has(keyOf(o)));
    // Shared type-to-confirm dialog: what is replaced, then the word.
    if (!(await confirm({
      title: t('backups.restoreTitle', { date: fmt(run.startedAt), defaultValue: 'Restore the backup of {{date}}' }),
      message: (
        <>
          {t('backups.restoreConfirmMessage', { count: chosen.length, defaultValue: 'These {{count}} element(s) are REPLACED by their backed-up state:' })}
          <ul className="mt-1.5 list-disc pl-5">{chosen.map((o) => <li key={o.key}>{label(o)}</li>)}</ul>
        </>
      ),
      confirmLabel: t('backups.restore') || 'Restore',
      danger: true,
      requireText: word,
    }))) return;
    setBusy(true);
    try {
      const items = chosen.map((o) => itemOf(o)!);
      const r = await backupsApi.restore(accountId, run.id, items);
      setResult(r.restored);
      const failed = r.restored.filter((x) => !x.ok).length;
      if (failed) toast.error(t('backups.restorePartial', { n: failed, defaultValue: '{{n}} item(s) could not be restored' }));
      else toast.success(t('backups.restored') || 'Restored');
    } catch (err) {
      if (!isStepUpHandled(err)) toastHostingError(t, err, t('backups.restoreFailed') || 'The restore failed');
    } finally { setBusy(false); }
  };

  const icon = (o: BackupObject) => (o.kind === 'db' ? <Database size={14} /> : o.kind === 'code' ? <Code2 size={14} /> : <FolderOpen size={14} />);
  const label = (o: BackupObject) => (o.kind === 'db'
    ? t('backups.objDb', { name: o.databaseName, defaultValue: 'Database {{name}}' })
    : o.kind === 'code'
      ? t('backups.objCode', { site: o.siteSlug, defaultValue: 'Code of the site {{site}}' })
      : t('backups.objData', { site: o.siteSlug, defaultValue: 'Data of the site {{site}} (uploads…)' }));

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      size="lg"
      icon={<RotateCcw size={16} />}
      title={t('backups.restoreTitle', { date: fmt(run.startedAt), defaultValue: 'Restore the backup of {{date}}' })}
      footer={result ? <Button onClick={onClose}>{t('common.close') || 'Close'}</Button> : <>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
        <Button variant="danger" loading={busy} disabled={!picked.size} onClick={() => { void submit(); }}>{t('backups.restore') || 'Restore'}</Button>
      </>}
    >
      {result ? (
        <ul className="space-y-1.5 text-sm">
          {result.map((r, i) => {
            const o = objects.find((x) => JSON.stringify(itemOf(x)) === JSON.stringify({ kind: r.kind, ...(r.kind === 'db' ? { databaseId: r.databaseId } : { siteId: r.siteId }) }));
            return (
              <li key={i} className={r.ok ? 'text-text-primary' : 'text-status-down'}>
                {r.ok ? '✓' : '✗'} {o ? label(o) : r.kind}{r.error ? ` — ${r.error}` : ''}
              </li>
            );
          })}
          {result.some((r) => r.ok && r.kind === 'code') && <p className="pt-2 text-xs text-text-muted">{t('backups.restoreCodeHint') || 'The code went back into the staging folder: it goes live with the next release (automatic or to publish, depending on the site).'}</p>}
        </ul>
      ) : (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-3 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            {t('backups.restoreWarning') || 'Each element chosen is REPLACED by its backed-up state: the current files of the folder (or the current content of the database) are deleted first.'}
          </p>
          {!objects.length ? <p className="text-sm text-text-muted">{t('backups.nothingToRestore') || 'Nothing in this backup that you may restore.'}</p> : (
            <div className="space-y-1">
              {objects.map((o) => (
                <label key={o.key} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-bg-tertiary">
                  <input
                    type="checkbox"
                    checked={picked.has(keyOf(o))}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(keyOf(o)); else n.delete(keyOf(o)); return n; })}
                  />
                  <span className="text-text-muted">{icon(o)}</span>
                  <span className="flex-1 text-sm text-text-primary">{label(o)}</span>
                  <span className="font-mono text-xs text-text-muted">{formatBytes(o.bytes)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
