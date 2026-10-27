import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowLeft, Database, ExternalLink, Play, RefreshCw, RotateCw, Square, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type DbCatalog, type DbInstance, type DbInstanceDetail } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { apiErrorCode, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { DbDefaultBadge, DbEngineBadge, DbStatusBadge } from '@/components/databases/DbBadges';
import { DbConnectionCard, DbExternalCard, DbSettingsCard } from '@/components/databases/DbInstanceCards';
import { DbDatabasesCard } from '@/components/databases/DbDatabasesCard';
import { DbUsersCard } from '@/components/databases/DbUsersCard';
import { dbErrorMessage, formatBytes, toastDbError } from '@/components/databases/dbFormat';
import { apiErrorStatus } from '@/components/dns/dnsErrors';
import { accountHref } from '@/utils/links';

/** /databases/:id — connection, databases, users and lifecycle of an instance. */
export function DbInstancePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const instanceId = Number(id);
  const { can } = useHostingMe();

  const [inst, setInst] = useState<DbInstanceDetail | null>(null);
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const reqSeq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!Number.isInteger(instanceId) || instanceId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const next = await databasesApi.getInstance(instanceId);
      if (seq !== reqSeq.current) return;
      setInst(next);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (apiErrorStatus(err) === 404) setNotFound(true);
      else if (!quiet) setLoadError(dbErrorMessage(t, err, t('databases.instance.loadFailed') || 'Failed to load the instance'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [instanceId, t]);

  useEffect(() => { setInst(null); void load(); }, [load]);
  const accountId = inst?.accountId ?? null;
  useEffect(() => {
    if (accountId == null) return;
    let cancelled = false;
    databasesApi.catalog(accountId).then((c) => { if (!cancelled) setCatalog(c); }).catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, [accountId]);
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(true); }, (e, p) => {
    if (e === HostingSocketEvents.DB_INSTANCE_UPDATED) return payloadNumber(p, 'instanceId') === instanceId;
    const payload = p as { entity?: string; action?: string } | null;
    if (payload?.entity !== 'dbInstance' || payloadNumber(p, 'id') !== instanceId) return false;
    if (payload.action === 'deleted') { navigate('/databases', { replace: true }); return false; }
    return true;
  });

  /** Summary fields from an action answer (DbInstance) merged into the detail. */
  const mergeInstance = (next: DbInstance) => setInst((cur) => (cur && cur.id === next.id ? { ...cur, ...next } : cur));

  if (loading && !inst) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;
  if (notFound || !inst) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Database className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('databases.instance.notFound') || 'This instance does not exist or is not visible to you.') : loadError}</p>
        <Link to="/databases" className="text-sm text-accent hover:underline">{t('databases.backToList') || 'Back to the databases'}</Link>
      </PageContainer>
    );
  }

  const manage = can('databases.manage', inst.accountId);
  const running = inst.status === 'running';
  // A provisioning instance may stay there for good (engine / image unreachable,
  // retried by the reconciler): it must stay deletable. Only 'deleting' locks the menu.
  const provisioning = inst.status === 'provisioning';
  const deleting = inst.status === 'deleting';
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };

  const act = async (action: 'start' | 'stop' | 'restart') => {
    if (action !== 'start' && !(await confirm({
      title: action === 'stop' ? (t('databases.actions.stop') || 'Stop') : (t('databases.actions.restart') || 'Restart'),
      message: action === 'stop'
        ? t('databases.actions.stopConfirm', { name: inst.name, defaultValue: 'Stop {{name}}? The sites using it lose their database until it is started again.' })
        : t('databases.actions.restartConfirm', { name: inst.name, defaultValue: 'Restart {{name}}? Open connections are cut for a few seconds.' }),
      confirmLabel: action === 'stop' ? (t('databases.actions.stop') || 'Stop') : (t('databases.actions.restart') || 'Restart'),
    }))) return;
    setBusy(action);
    try {
      mergeInstance(await databasesApi.action(inst.id, action));
      toast.success(t(`databases.actions.${action}Done`) || 'Done');
    } catch (err) {
      toastDbError(t, err, t('databases.actions.failed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  const openAdmin = async (databaseId?: number) => {
    // Open the tab synchronously, while the click's user activation is still
    // valid: after the await, popup blockers would silently drop window.open
    // (and the single-use 60 s token would be wasted).
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    setBusy('admin');
    try {
      const s = await databasesApi.openAdminSession(inst.id, databaseId ?? null);
      if (w && !w.closed) {
        w.location.href = s.url;
      } else {
        // Popup blocked: offer the link (the user's own click opens it).
        toast((tt) => (
          <span className="text-sm">
            {t('databases.admin.popupBlocked') || 'Your browser blocked the new tab.'}{' '}
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline" onClick={() => toast.dismiss(tt.id)}>
              {t('databases.admin.openLink') || 'Open the admin UI'}
            </a>
          </span>
        ), { duration: 30_000 });
      }
    } catch (err) {
      if (w && !w.closed) w.close();
      if (apiErrorCode(err) === 'dbAdminUnavailable') {
        toast.error(t('databases.admin.unavailableHint') || 'The database admin UI is not available: a platform administrator must set its host name (Settings → DB admin) and start it.', { duration: 8000 });
      } else {
        toastDbError(t, err, t('databases.admin.failed') || 'Failed to open the admin UI');
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await confirm({
      title: t('databases.instance.deleteTitle') || 'Delete the instance',
      message: t('databases.instance.deleteConfirm', {
        name: inst.name, count: inst.databaseCount,
        defaultValue: 'Delete the instance {{name}}, its {{count}} database(s), its users and all its data? This cannot be undone.',
      }),
      danger: true,
      requireText: inst.name,
    }))) return;
    setBusy('delete');
    try {
      await databasesApi.deleteInstance(inst.id, inst.name);
      toast.success(t('databases.instance.deleted') || 'Instance deleted');
      navigate('/databases', { replace: true });
    } catch (err) {
      toastDbError(t, err, t('databases.instance.deleteFailed') || 'Failed to delete the instance');
      setBusy(null);
    }
  };

  const adminLabel = inst.adminUi === 'phpmyadmin' ? (t('databases.admin.openPma') || 'Open phpMyAdmin') : (t('databases.admin.openAdminer') || 'Open Adminer');
  const adminButton = (
    <Button size="sm" variant="secondary" loading={busy === 'admin'} disabled={!running || !inst.adminUiAvailable || busy !== null} onClick={() => { void openAdmin(); }} className="coarse:min-h-10">
      <ExternalLink size={14} className="mr-1" />{adminLabel}
    </Button>
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton
          onClick={() => { if (window.history.length > 1) navigate(-1); else navigate(accountHref(inst.accountId, 'databases')); }}
          size="lg"
          variant="plain"
          className="mt-0.5 rounded-lg hover:bg-bg-secondary"
          label={t('common.back') || 'Back'}
          icon={<ArrowLeft className="h-4 w-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
            <h1 className="min-w-0 break-all font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{inst.name}</h1>
            <DbStatusBadge status={inst.status} message={inst.statusMessage} />
            <DbEngineBadge engine={inst.engine} version={inst.version} />
            {inst.isDefault && <DbDefaultBadge />}
            <TenantBadge tenantId={inst.tenantId} size="md" />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <Link to={accountHref(inst.accountId, 'databases')} className="font-mono hover:text-accent">{inst.accountUsername}</Link>
            <span>·</span>
            <span className="font-mono">{inst.profile} · {formatMb(inst.memoryLimitMb, units)}</span>
            <span>·</span>
            <span>{t('databases.instance.size', { size: formatBytes(t, inst.sizeBytes), defaultValue: '{{size}} of data' })}</span>
            {inst.sizeCheckedAt && <span className="text-[11px]">({new Date(inst.sizeCheckedAt).toLocaleString(i18n.language)})</span>}
          </p>
          {inst.status === 'error' && inst.statusMessage && (
            <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{inst.statusMessage}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:order-last max-lg:w-full">
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => { void load(true); }} size="lg" variant="solid" className="rounded-lg" />
          {manage && (inst.adminUiAvailable ? adminButton : (
            <Tip content={t('databases.admin.unavailableHint') || 'The database admin UI is not available: a platform administrator must set its host name (Settings → DB admin) and start it.'}>
              <span>{adminButton}</span>
            </Tip>
          ))}
          {manage && (
            <ActionMenu
              triggerSize="lg"
              triggerVariant="solid"
              triggerClassName="rounded-lg"
              disabled={busy !== null || deleting}
              items={[
                { key: 'start', icon: <Play className="h-4 w-4" />, label: t('databases.actions.start') || 'Start', onClick: () => { void act('start'); }, hidden: running, disabled: provisioning },
                { key: 'restart', icon: <RotateCw className="h-4 w-4" />, label: t('databases.actions.restart') || 'Restart', onClick: () => { void act('restart'); }, hidden: !running, disabled: provisioning },
                { key: 'stop', icon: <Square className="h-4 w-4" />, label: t('databases.actions.stop') || 'Stop', onClick: () => { void act('stop'); }, hidden: !running, disabled: provisioning },
                { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('databases.instance.delete') || 'Delete the instance', onClick: () => { void remove(); }, danger: true, separator: true },
              ]}
            />
          )}
        </div>
      </div>

      {inst.status === 'provisioning' && (
        <p className="flex items-center gap-2 rounded-lg bg-sky-400/5 px-3 py-2 text-xs text-sky-300">
          <LoadingSpinner size="sm" />{t('databases.instance.provisioning') || 'The instance is being created: this page refreshes by itself.'}
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DbConnectionCard instance={inst} />
        <div className="flex flex-col gap-5">
          <DbExternalCard instance={inst} catalog={catalog} manage={manage} onChanged={(n) => { mergeInstance(n); void load(true); }} />
          <DbSettingsCard instance={inst} catalog={catalog} manage={manage} onChanged={(n) => { mergeInstance(n); void load(true); }} />
        </div>
      </div>
      <DbDatabasesCard instance={inst} manage={manage} onChanged={() => { void load(true); }} onOpenAdmin={(dbId) => { void openAdmin(dbId); }} />
      <DbUsersCard instance={inst} manage={manage} onChanged={() => { void load(true); }} />
    </PageContainer>
  );
}
