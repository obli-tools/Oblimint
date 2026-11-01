import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Building2, Crown, Database, Link2, Plus, Share2, Unlink } from 'lucide-react';
import {
  HostingSocketEvents, type DbDatabaseListItem, type DbFamily, type DbInstance, type SiteDatabase,
} from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { Card, EmptyState, Pill, inputCls, isStepUpHandled, labelCls, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { DbDefaultBadge } from '@/components/databases/DbBadges';
import { DbAccountWideBadge, DbSharedSitesBadge, DbSiteChip, DbSiteRoleBadge } from '@/components/databases/DbSiteBadges';
import { DbSiteAttachModal, attachRefOf, useDbDetach, useDbSetOwner, type AttachTarget } from '@/components/databases/DbSiteAttachModal';
import { dbToolMenuItems } from '@/components/databases/dbAdmin';
import { DB_NAME_RE, dbErrorMessage, dbStatusLabel, engineLabel, formatBytes, isReservedDbName } from '@/components/databases/dbFormat';
import { accountHref } from '@/utils/links';
import { cn } from '@/utils/cn';
import type { SiteTabProps } from './types';

/** New database owned by the site, on the account's default server of the chosen family. */
function SiteDbCreateModal({ open, site, onClose, onCreated }: {
  open: boolean;
  site: SiteTabProps['site'];
  onClose: () => void;
  onCreated: (d: SiteDatabase) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<DbInstance[] | null>(null);
  const [family, setFamily] = useState<DbFamily>('mysql');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setError(null); setInstances(null);
    let live = true;
    databasesApi.listInstances({ accountId: site.accountId })
      .then((l) => {
        if (!live) return;
        setInstances(l);
        const defs = l.filter((i) => i.isDefault && i.status !== 'deleting');
        if (defs.length && !defs.some((i) => i.family === 'mysql')) setFamily(defs[0].family);
        else setFamily('mysql');
      })
      .catch(() => { if (live) setInstances([]); });
    return () => { live = false; };
  }, [open, site.accountId]);

  // The default server of each family: where the database lands.
  const defaults = useMemo(() => {
    const m = new Map<DbFamily, DbInstance>();
    for (const i of instances ?? []) if (i.isDefault && i.status !== 'deleting' && !m.has(i.family)) m.set(i.family, i);
    return m;
  }, [instances]);
  const target = defaults.get(family) ?? null;
  const pg = family === 'postgresql';
  const effective = pg ? name.toLowerCase() : name;
  const valid = !!target && DB_NAME_RE.test(effective) && !isReservedDbName(effective);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await databasesApi.createSiteDatabase(site.id, { name: effective, family }));
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
      title={t('databases.sites.createForSite', { site: site.name, defaultValue: 'New database for {{site}}' })}
      icon={<Database className="h-4 w-4 text-accent" />}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      {instances === null ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : defaults.size === 0 ? (
        <div className="space-y-2 text-sm text-text-secondary">
          <p>{t('databases.sites.noServer') || 'The account has no database server yet: create an instance first.'}</p>
          <Link to={accountHref(site.accountId, 'databases')} className="text-accent hover:underline">{t('databases.create') || 'New instance'}</Link>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="sdb-family">{t('databases.engine') || 'Engine'}</label>
            <select id="sdb-family" value={family} onChange={(e) => setFamily(e.target.value as DbFamily)} className={inputCls}>
              {(['mysql', 'postgresql'] as const).map((f) => {
                const i = defaults.get(f);
                return (
                  <option key={f} value={f} disabled={!i}>
                    {f === 'postgresql' ? 'PostgreSQL' : 'MySQL / MariaDB'}{i ? ` — ${i.name} (${engineLabel(i.engine)} ${i.version})` : ` — ${t('databases.sites.noDefault') || 'no server'}`}
                  </option>
                );
              })}
            </select>
            <p className="mt-1 text-[11px] text-text-muted">{t('databases.sites.createHint') || 'Created on the account\'s shared server of this engine, owned by the site.'}</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="sdb-name">{t('databases.name') || 'Name'}</label>
            <input
              id="sdb-name"
              value={name}
              maxLength={64}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={`${site.slug.replace(/-/g, '_')}`}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              className={cn(inputCls, 'font-mono', name && !(DB_NAME_RE.test(effective) && !isReservedDbName(effective)) && 'ring-2 ring-status-down')}
            />
            {name && !(DB_NAME_RE.test(effective) && !isReservedDbName(effective)) && (
              <p className="mt-1 text-xs text-status-down">
                {isReservedDbName(effective) ? (t('databases.errors.reservedName') || 'This name is reserved.') : (t('databases.db.nameInvalid') || 'Letters, digits and _ only (1–64).')}
              </p>
            )}
            {pg && name && name !== effective && <p className="mt-1 font-mono text-xs text-text-muted">{t('domains.form.normalized', { name: effective, defaultValue: 'Stored as {{name}}' })}</p>}
          </div>
          {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/**
 * « Databases » tab of a site (migration 030): the databases it owns, then
 * the ones shared with it, each with its role, engine, server and size; below,
 * the account-wide databases (no owner: every site of the account reaches
 * them), attachable in one click.
 */
export function SiteDatabasesTab({ site, reloadSite }: SiteTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const detach = useDbDetach();
  const setOwner = useDbSetOwner();
  const manage = can('databases.manage', site.accountId);

  const [list, setList] = useState<SiteDatabase[] | null>(site.databases ?? null);
  const [accountDbs, setAccountDbs] = useState<DbDatabaseListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState<AttachTarget | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const s = ++seq.current;
    try {
      const [mine, all] = await Promise.all([
        databasesApi.siteDatabases(site.id),
        databasesApi.listDatabases({ accountId: site.accountId }).catch(() => null),
      ]);
      if (s !== seq.current) return;
      setList(mine);
      setAccountDbs(all);
      setLoadError(null);
    } catch (err) {
      if (s !== seq.current) return;
      setLoadError(dbErrorMessage(t, err, t('databases.sites.loadFailed') || 'Failed to load the databases of the site'));
    }
  }, [site.id, site.accountId, t]);
  useEffect(() => { void load(); }, [load]);
  // After an action: the list, and the site (its overview counts its databases).
  const refresh = () => { void load(); void reloadSite(); };
  // An attachment change, a database created / deleted: the instance of the account is signalled
  // (list and site: the overview tile counts site.databases).
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { refresh(); }, (e, p) => (
    e === HostingSocketEvents.DB_INSTANCE_UPDATED
      ? payloadNumber(p, 'accountId') === site.accountId
      : (p as { entity?: string } | null)?.entity === 'dbInstance' && payloadNumber(p, 'accountId') === site.accountId
  ));

  // Account-wide databases this site does not have attached (reachable by every site of the account).
  const accountWide = useMemo(() => {
    const mine = new Set((list ?? []).map((d) => d.id));
    return (accountDbs ?? []).filter((d) => !d.ownerSite && !mine.has(d.id));
  }, [accountDbs, list]);

  const siteRef = { id: site.id, name: site.name, slug: site.slug };
  const owned = (list ?? []).filter((d) => d.role === 'owner').length;
  const shared = (list ?? []).length - owned;

  const actions = (d: SiteDatabase) => {
    const running = d.instanceStatus === 'running';
    return (
      <ActionMenu
        triggerSize="sm"
        items={[
          ...dbToolMenuItems(t, { instanceId: d.instanceId, databaseId: d.id, family: d.family, manage, running, adminUiAvailable: !!d.adminUiAvailable, navigate }),
          { key: 'instance', icon: <Database className="h-4 w-4" />, label: t('databases.sites.openInstance') || 'Open the database server', onClick: () => navigate(`/databases/${d.instanceId}`) },
          { key: 'share', icon: <Share2 className="h-4 w-4" />, label: t('databases.sites.attachAction') || 'Attach / share with a site…', onClick: () => setAttaching({ kind: 'database', database: attachRefOf(d) }), hidden: !manage, separator: true },
          { key: 'owner', icon: <Crown className="h-4 w-4" />, label: t('databases.sites.makeOwner') || 'Make this site the owner', onClick: () => { void setOwner(attachRefOf(d), siteRef).then((ok) => { if (ok) refresh(); }); }, hidden: !manage || d.role === 'owner' },
          { key: 'detach', icon: <Unlink className="h-4 w-4" />, label: d.role === 'owner' ? (t('databases.sites.detachFromSite') || 'Detach from this site') : (t('databases.sites.unshare') || 'Stop sharing with this site'), onClick: () => { void detach(attachRefOf(d), siteRef).then((ok) => { if (ok) refresh(); }); }, hidden: !manage, danger: true, separator: true },
        ]}
      />
    );
  };

  /** Owner = the other sites it is shared with; shared = whose database it is. */
  const others = (d: SiteDatabase) => (d.role === 'owner'
    ? (d.sharedSites.length ? <DbSharedSitesBadge sites={d.sharedSites} plus={false} /> : <span className="text-text-muted">—</span>)
    : d.ownerSite ? <DbSiteChip site={d.ownerSite} /> : <DbAccountWideBadge short />);

  const nameCell = (d: SiteDatabase) => (manage && d.instanceStatus === 'running'
    ? <Link to={`/databases/${d.instanceId}/explorer/${d.id}`} className="font-mono text-text-primary hover:text-accent hover:underline" title={t('dbx.open') || 'Explore (tables, data, SQL)'}>{d.name}</Link>
    : <span className="font-mono text-text-primary">{d.name}</span>);
  const serverCell = (d: SiteDatabase) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={d.family === 'postgresql' ? 'blue' : 'accent'}>{engineLabel(d.engine)}</Pill>
      <Link to={`/databases/${d.instanceId}`} className="font-mono text-xs text-text-secondary hover:text-accent">{d.instanceName}</Link>
      {d.instanceIsDefault && <DbDefaultBadge />}
      {d.instanceStatus !== 'running' && <Pill tone="amber">{dbStatusLabel(t, d.instanceStatus)}</Pill>}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t('databases.sites.tabTitle') || 'Databases of the site'}
        icon={<Database size={14} className="text-accent" />}
        actions={manage ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setAttaching({ kind: 'site', site: { id: site.id, name: site.name, accountId: site.accountId } })}>
              <Link2 size={13} className="mr-1" />{t('databases.sites.attachExisting') || 'Attach an existing database'}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={13} className="mr-1" />{t('databases.sites.createButton') || 'New database for this site'}
            </Button>
          </>
        ) : undefined}
      >
        {list && list.length > 0 && (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <DbSiteRoleBadge role="owner" /><span>{t('databases.sites.ownedCount', { count: owned, defaultValue: '{{count}} owned' })}</span>
            <DbSiteRoleBadge role="shared" /><span>{t('databases.sites.sharedCountSite', { count: shared, defaultValue: '{{count}} shared with the site' })}</span>
          </p>
        )}
        {loadError && <p className="mb-2 whitespace-pre-line text-xs text-status-down">{loadError}</p>}
        {list === null ? (
          !loadError && <div className="flex justify-center py-8"><LoadingSpinner /></div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Database />}
            text={t('databases.sites.siteEmpty') || 'No database is attached to this site yet.'}
          />
        ) : (
          <GroupedTable<SiteDatabase>
            singleGroupFlat
            className="bg-bg-primary"
            minWidth={820}
            defaultSort={{ column: 'role' }}
            groups={[{ key: 'site-databases', label: '', sortLabel: '', nodes: flatNodes(list, (d) => d.id) }]}
            renderCard={(d) => (
              <div className={cn('flex items-start gap-2 rounded-lg border-l-2 bg-bg-primary p-2.5', d.role === 'owner' ? 'border-l-accent' : 'border-l-blue-400/60')}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm">{nameCell(d)}</span>
                    <DbSiteRoleBadge role={d.role} />
                  </div>
                  <div className="mt-1.5">{serverCell(d)}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                    <span>{formatBytes(t, d.sizeBytes)}</span>
                    {others(d)}
                  </div>
                </div>
                {actions(d)}
              </div>
            )}
            columns={[
              { id: 'name', header: t('databases.name') || 'Name', sort: (d) => d.name, cell: nameCell },
              { id: 'role', header: t('databases.sites.role') || 'Attachment', sort: (d) => `${d.role === 'owner' ? 0 : 1}${d.name}`, cell: (d) => <DbSiteRoleBadge role={d.role} /> },
              { id: 'server', header: t('databases.sites.server') || 'Engine · server', sort: (d) => `${d.engine} ${d.instanceName}`, cell: serverCell },
              { id: 'others', header: t('databases.sites.otherSites') || 'Other sites', cell: others },
              { id: 'size', header: t('databases.col.size') || 'Size', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (d) => d.sizeBytes ?? null, cell: (d) => formatBytes(t, d.sizeBytes) },
              { id: 'actions', header: <span className="sr-only">{t('ui.moreActions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'text-right', cell: actions },
            ]}
          />
        )}
      </Card>

      {/* Reachable by every site of the account: shown so nothing the site may use is hidden. */}
      {accountWide.length > 0 && (
        <Card title={t('databases.sites.accountWideTitle') || 'Shared across the account'} icon={<Building2 size={14} className="text-text-muted" />}>
          <p className="mb-2 text-xs text-text-muted">{t('databases.sites.accountWideIntro') || 'Databases without owner site: every site of the account, this one included, reaches their server. Attach one to make it this site\'s.'}</p>
          <ul className="divide-y divide-white/[0.04]">
            {accountWide.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-mono text-sm text-text-primary">{d.name}</span>
                <DbAccountWideBadge short />
                {(d.sharedSites ?? []).length > 0 && <DbSharedSitesBadge sites={d.sharedSites} />}
                <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                  {engineLabel(d.engine)} · <Link to={`/databases/${d.instanceId}`} className="font-mono hover:text-accent">{d.instanceName}</Link> · {formatBytes(t, d.sizeBytes)}
                </span>
                {manage && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAttaching({ kind: 'database', database: attachRefOf(d), siteId: site.id })}>
                    <Link2 size={13} className="mr-1" />{t('databases.sites.attach') || 'Attach…'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SiteDbCreateModal
        open={creating}
        site={site}
        onClose={() => setCreating(false)}
        onCreated={(d) => {
          setCreating(false);
          toast.success(t('databases.sites.createdForSite', { name: d.name, site: site.name, defaultValue: 'Database {{name}} created for {{site}}' }));
          refresh();
        }}
      />
      <DbSiteAttachModal
        open={!!attaching}
        target={attaching}
        onClose={() => setAttaching(null)}
        onDone={() => { setAttaching(null); refresh(); }}
        onChanged={refresh}
      />
    </div>
  );
}
