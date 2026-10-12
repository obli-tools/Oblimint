import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Database, Download, ExternalLink, Plus, Table2, Trash2, Upload } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { DbDatabase, DbInstanceDetail } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, inputCls, isStepUpHandled, labelCls } from '@/components/hosting/hostingUi';
import { downloadUrl, saveBlob } from '@/utils/download';
import { canUseNative } from '@/native/bridge';
import { cn } from '@/utils/cn';
import { DB_NAME_RE, DB_RESTORE_MAX_BYTES, dbErrorMessage, formatBytes, isReservedDbName, toastDbError } from './dbFormat';

const MYSQL_CHARSETS = ['utf8mb4', 'utf8mb3', 'latin1', 'ascii'];
const MYSQL_COLLATIONS = ['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_520_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_bin'];
const PG_CHARSETS = ['UTF8', 'LATIN1', 'SQL_ASCII'];
const PG_COLLATIONS = ['C', 'C.UTF-8', 'en_US.UTF-8', 'fr_FR.UTF-8'];

function DbCreateModal({ open, instance, onClose, onCreated }: {
  open: boolean;
  instance: DbInstanceDetail;
  onClose: () => void;
  onCreated: (d: DbDatabase) => void;
}) {
  const { t } = useTranslation();
  const pg = instance.family === 'postgresql';
  const [name, setName] = useState('');
  const [charset, setCharset] = useState('');
  const [collation, setCollation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(''); setCharset(''); setCollation(''); setError(null); } }, [open]);

  // PostgreSQL folds unquoted names to lower case: the server stores them lower-cased.
  const effective = pg ? name.toLowerCase() : name;
  const valid = DB_NAME_RE.test(effective) && !isReservedDbName(effective);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await databasesApi.createDatabase(instance.id, { name: effective, charset: charset.trim() || null, collation: collation.trim() || null }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dbErrorMessage(t, err, t('databases.db.createFailed') || 'Failed to create the database'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('databases.db.createTitle') || 'New database'}
      icon={<Database className="h-4 w-4 text-accent" />}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="db-name">{t('databases.name') || 'Name'}</label>
          <input
            id="db-name"
            value={name}
            maxLength={64}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={`${instance.accountUsername.replace(/-/g, '_')}_app`}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            className={cn(inputCls, 'font-mono', name && !valid && 'ring-2 ring-status-down')}
          />
          {name && !valid && (
            <p className="mt-1 text-xs text-status-down">
              {isReservedDbName(effective) ? (t('databases.errors.reservedName') || 'This name is reserved.') : (t('databases.db.nameInvalid') || 'Letters, digits and _ only (1–64).')}
            </p>
          )}
          {pg && name && name !== effective && <p className="mt-1 font-mono text-xs text-text-muted">{t('domains.form.normalized', { name: effective, defaultValue: 'Stored as {{name}}' })}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="db-charset">{t('databases.db.charset') || 'Character set'}</label>
            <input id="db-charset" value={charset} list="db-charsets" onChange={(e) => setCharset(e.target.value)} placeholder={pg ? 'UTF8' : 'utf8mb4'} className={cn(inputCls, 'font-mono')} />
            <datalist id="db-charsets">{(pg ? PG_CHARSETS : MYSQL_CHARSETS).map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div>
            <label className={labelCls} htmlFor="db-collation">{t('databases.db.collation') || 'Collation'}</label>
            <input id="db-collation" value={collation} list="db-collations" onChange={(e) => setCollation(e.target.value)} placeholder={t('databases.db.defaultPlaceholder') || 'default'} className={cn(inputCls, 'font-mono')} />
            <datalist id="db-collations">{(pg ? PG_COLLATIONS : MYSQL_COLLATIONS).map((c) => <option key={c} value={c} />)}</datalist>
          </div>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/** Blocking upload dialog of a restore (progress, then the server import). */
function RestoreModal({ job, onClose }: { job: { db: DbDatabase; file: File; pct: number; phase: 'upload' | 'import' | 'done' | 'error'; error: string | null } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const running = !!job && (job.phase === 'upload' || job.phase === 'import');
  return (
    <Modal
      open={!!job}
      onClose={onClose}
      dismissible={!running}
      title={t('databases.restore.title') || 'Restore a dump'}
      icon={<Upload className="h-4 w-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      footer={running ? undefined : <Button size="sm" onClick={onClose}>{t('common.close') || 'Close'}</Button>}
    >
      {job && (
        <div className="space-y-3">
          <p className="break-all text-sm text-text-secondary">
            <span className="font-mono text-text-primary">{job.file.name}</span> → <span className="font-mono text-text-primary">{job.db.name}</span>
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded bg-bg-tertiary">
            <div className={cn('h-full rounded transition-all', job.phase === 'error' ? 'bg-status-down' : 'bg-accent', job.phase === 'import' && 'animate-pulse')} style={{ width: `${job.phase === 'upload' ? job.pct : 100}%` }} />
          </div>
          <p className="text-xs text-text-muted">
            {job.phase === 'upload' && t('databases.restore.uploading', { pct: job.pct, defaultValue: 'Uploading… {{pct}} %' })}
            {job.phase === 'import' && (t('databases.restore.importing') || 'Importing into the database… (keep this page open)')}
            {job.phase === 'done' && (t('databases.restore.done') || 'Restore complete.')}
          </p>
          {job.error && <p className="whitespace-pre-line text-xs text-status-down">{job.error}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Databases of the instance: create, delete (typed confirmation), dump, restore, open in the admin UI. */
export function DbDatabasesCard({ instance, manage, onChanged, onOpenAdmin }: {
  instance: DbInstanceDetail;
  manage: boolean;
  onChanged: () => void;
  onOpenAdmin?: (databaseId: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<{ db: DbDatabase; file: File; pct: number; phase: 'upload' | 'import' | 'done' | 'error'; error: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreTarget = useRef<DbDatabase | null>(null);
  const running = instance.status === 'running';

  const remove = async (d: DbDatabase) => {
    if (!(await confirm({
      title: t('databases.db.deleteTitle') || 'Delete the database',
      message: t('databases.db.deleteConfirm', { name: d.name, defaultValue: 'Delete the database {{name}} and all its data? This cannot be undone: download a dump first if needed.' }),
      danger: true,
      requireText: d.name,
    }))) return;
    try {
      await databasesApi.deleteDatabase(instance.id, d.id, d.name);
      toast.success(t('databases.db.deleted') || 'Database deleted');
      onChanged();
    } catch (err) {
      toastDbError(t, err, t('databases.db.deleteFailed') || 'Failed to delete the database');
    }
  };

  const [dumping, setDumping] = useState<number | null>(null);
  const dump = async (d: DbDatabase) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const filename = `${d.name}-${stamp}.sql.gz`;
    if (canUseNative('downloadUrl')) {
      // Android shell: DownloadManager streams the route with the session cookie.
      if (!(await downloadUrl(databasesApi.dumpUrl(instance.id, d.id), filename))) {
        toast.error(t('databases.db.dumpFailed') || 'Download failed');
      }
      return;
    }
    // Browser: fetch first, so an error answer (429, 409 busy / not running,
    // 403) is shown instead of being saved as a corrupt .sql.gz.
    setDumping(d.id);
    const tid = toast.loading(t('databases.db.dumpPreparing', { name: d.name, defaultValue: 'Preparing the dump of {{name}}…' }));
    try {
      const blob = await databasesApi.dumpBlob(instance.id, d.id);
      toast.dismiss(tid);
      if (!(await saveBlob(blob, filename, 'application/gzip'))) toast.error(t('databases.db.dumpFailed') || 'Download failed');
    } catch (err) {
      toast.dismiss(tid);
      toastDbError(t, err, t('databases.db.dumpFailed') || 'Download failed');
    } finally {
      setDumping(null);
    }
  };

  const pickRestore = (d: DbDatabase) => {
    restoreTarget.current = d;
    if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); }
  };

  const restore = async (file: File) => {
    const d = restoreTarget.current;
    if (!d) return;
    if (!/\.(sql|sql\.gz|gz)$/i.test(file.name)) {
      toast.error(t('databases.restore.badType') || 'Choose a .sql or .sql.gz file');
      return;
    }
    if (file.size > DB_RESTORE_MAX_BYTES) {
      toast.error(t('databases.restore.tooLarge') || 'The file exceeds 2 GiB');
      return;
    }
    if (!(await confirm({
      title: t('databases.restore.title') || 'Restore a dump',
      message: t('databases.restore.confirm', {
        file: file.name, name: d.name, size: formatBytes(t, file.size),
        defaultValue: 'Run {{file}} ({{size}}) in the database {{name}}? Existing tables of the same name are replaced by those of the dump.',
      }),
      confirmLabel: t('databases.restore.start') || 'Restore',
      danger: true,
    }))) return;
    setJob({ db: d, file, pct: 0, phase: 'upload', error: null });
    try {
      await databasesApi.restore(instance.id, d.id, file, (pct) => {
        setJob((j) => (j ? { ...j, pct, phase: pct >= 100 ? 'import' : 'upload' } : j));
      });
      setJob((j) => (j ? { ...j, phase: 'done', pct: 100 } : j));
      toast.success(t('databases.restore.done') || 'Restore complete.');
      onChanged();
    } catch (err) {
      if (isStepUpHandled(err)) { setJob(null); return; }
      setJob((j) => (j ? { ...j, phase: 'error', error: dbErrorMessage(t, err, t('databases.errors.restoreFailed') || 'The restore failed') } : j));
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
  const actions = (d: DbDatabase) => (
    <ActionMenu
      triggerSize="sm"
      items={[
        { key: 'explore', icon: <Table2 className="h-4 w-4" />, label: t('dbx.open') || 'Explore (tables, data, SQL)', onClick: () => navigate(`/databases/${instance.id}/explorer/${d.id}`), hidden: !manage, disabled: !running },
        { key: 'admin', icon: <ExternalLink className="h-4 w-4" />, label: instance.adminUi === 'phpmyadmin' ? (t('databases.admin.openPma') || 'Open in phpMyAdmin') : (t('databases.admin.openAdminer') || 'Open in Adminer'), onClick: () => onOpenAdmin?.(d.id), hidden: !manage || !onOpenAdmin || !instance.adminUiAvailable || !running },
        { key: 'dump', icon: <Download className="h-4 w-4" />, label: t('databases.db.dump') || 'Download a dump', onClick: () => { void dump(d); }, hidden: !manage, disabled: !running || dumping !== null },
        { key: 'restore', icon: <Upload className="h-4 w-4" />, label: t('databases.restore.title') || 'Restore a dump', onClick: () => pickRestore(d), hidden: !manage, disabled: !running },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('databases.db.delete') || 'Delete the database', onClick: () => { void remove(d); }, danger: true, separator: true, hidden: !manage },
      ]}
    />
  );

  return (
    <Card
      title={t('databases.db.title') || 'Databases'}
      icon={<Database size={14} className="text-accent" />}
      actions={manage ? (
        <Button size="sm" variant="secondary" disabled={!running} onClick={() => setCreating(true)}>
          <Plus size={13} className="mr-1" />{t('databases.db.create') || 'New database'}
        </Button>
      ) : undefined}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".sql,.gz,application/sql,application/gzip"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }}
      />
      {!running && <p className="mb-2 text-xs text-amber-400">{t('databases.notRunningHint') || 'The instance is not running: start it to manage its databases.'}</p>}
      {instance.databases.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('databases.db.empty') || 'No database yet.'}</p>
      ) : (
        <GroupedTable<DbDatabase>
          singleGroupFlat
          className="bg-bg-primary"
          minWidth={640}
          defaultSort={{ column: 'name' }}
          groups={[{ key: 'databases', label: '', sortLabel: '', nodes: flatNodes(instance.databases, (d) => d.id) }]}
          renderCard={(d) => (
            <div className="flex items-center gap-2 rounded-lg bg-bg-primary p-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm text-text-primary">{manage && running ? <Link to={`/databases/${instance.id}/explorer/${d.id}`} className="hover:text-accent">{d.name}</Link> : d.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-text-muted">
                  <span>{formatBytes(t, d.sizeBytes)}</span>
                  {d.charset && <span className="font-mono">{d.charset}</span>}
                  {d.collation && <span className="font-mono">{d.collation}</span>}
                </div>
              </div>
              {actions(d)}
            </div>
          )}
          columns={[
            { id: 'name', header: t('databases.name') || 'Name', tdClassName: 'font-mono text-text-primary', sort: (d) => d.name, cell: (d) => (manage && running
              ? <Link to={`/databases/${instance.id}/explorer/${d.id}`} className="hover:text-accent hover:underline" title={t('dbx.open') || 'Explore (tables, data, SQL)'}>{d.name}</Link>
              : d.name) },
            { id: 'charset', header: t('databases.db.charset') || 'Character set', tdClassName: 'font-mono text-xs text-text-secondary', sort: (d) => d.charset ?? '', cell: (d) => d.charset ?? '—' },
            { id: 'collation', header: t('databases.db.collation') || 'Collation', tdClassName: 'font-mono text-xs text-text-secondary', sort: (d) => d.collation ?? '', cell: (d) => d.collation ?? '—' },
            { id: 'size', header: t('databases.col.size') || 'Size', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (d) => d.sizeBytes ?? null, cell: (d) => formatBytes(t, d.sizeBytes) },
            { id: 'created', header: t('databases.db.createdAt') || 'Created', tdClassName: 'font-mono text-xs text-text-muted', sort: (d) => d.createdAt ?? '', cell: (d) => fmtDate(d.createdAt) },
            { id: 'actions', header: <span className="sr-only">{t('ui.moreActions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'text-right', cell: (d) => actions(d) },
          ]}
        />
      )}
      <DbCreateModal
        open={creating}
        instance={instance}
        onClose={() => setCreating(false)}
        onCreated={(d) => {
          setCreating(false);
          toast.success(t('databases.db.created', { name: d.name, defaultValue: 'Database {{name}} created' }));
          onChanged();
        }}
      />
      <RestoreModal job={job} onClose={() => setJob(null)} />
    </Card>
  );
}
