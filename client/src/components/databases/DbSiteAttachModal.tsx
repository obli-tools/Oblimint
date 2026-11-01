import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { Crown, Link2, Share2, Unlink } from 'lucide-react';
import type { DbAttachmentResult, DbDatabaseListItem, DbPrivilegeLevel, DbSiteRef, DbSiteRole, DbUser, Site } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { sitesApi } from '@/api/sites.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { inputCls, isStepUpHandled, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DbAccountWideBadge, DbSiteChip } from './DbSiteBadges';
import { dbErrorMessage, engineLabel, privilegeLabel, toastDbError } from './dbFormat';
import { networkSummary } from './dbSites';

/** A database as the attachment dialog needs it. */
export interface AttachDbRef {
  id: number;
  name: string;
  instanceId: number;
  accountId: number;
  instanceRunning: boolean;
  ownerSite: DbSiteRef | null;
  sharedSites: DbSiteRef[];
}

export function attachRefOf(d: DbDatabaseListItem): AttachDbRef {
  return {
    id: d.id, name: d.name, instanceId: d.instanceId, accountId: d.accountId, instanceRunning: d.instanceStatus === 'running',
    ownerSite: d.ownerSite ?? null, sharedSites: d.sharedSites ?? [],
  };
}

/** What the dialog starts from: one database (pick a site) or one site (pick a database of its account). */
export type AttachTarget =
  | { kind: 'database'; database: AttachDbRef; /** Site preselected (e.g. attaching an account-wide database from a site). */ siteId?: number }
  | { kind: 'site'; site: { id: number; name: string; accountId: number } };

/** Toast of an attachment change, with what it did to the default network access (segmented accounts). */
export function toastAttachment(t: TFunction, message: string, r: DbAttachmentResult): void {
  const { opened, closed } = networkSummary(r.network);
  const net = [
    opened ? t('databases.sites.netOpened', { count: opened, defaultValue: 'network access opened for {{count}} site(s)' }) : null,
    closed ? t('databases.sites.netClosed', { count: closed, defaultValue: 'default network access closed for {{count}} site(s)' }) : null,
  ].filter(Boolean).join(' · ');
  const granted = r.grantedUser ? t('databases.sites.granted', { user: r.grantedUser.username, defaultValue: 'rights granted to {{user}}' }) : null;
  toast.success([message, granted, net].filter(Boolean).join('\n'), { duration: net ? 6000 : 4000 });
}

/**
 * Detach a database from a site (owner or shared), confirmed. The SQL rights
 * stay as they are; a database left without owner is shared across the account.
 */
export function useDbDetach() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return async (d: Pick<AttachDbRef, 'id' | 'name' | 'instanceId' | 'ownerSite'>, site: DbSiteRef): Promise<boolean> => {
    const owner = d.ownerSite?.id === site.id;
    if (!(await confirm({
      title: t('databases.sites.detachTitle') || 'Detach from the site',
      message: owner
        ? t('databases.sites.detachOwnerConfirm', { db: d.name, site: site.name, defaultValue: 'Detach {{db}} from {{site}}? It no longer has an owner site: it becomes shared across the account, and every site of the account gets its default network access to its server back (segmented accounts). The SQL rights stay as they are.' })
        : t('databases.sites.detachSharedConfirm', { db: d.name, site: site.name, defaultValue: 'Stop sharing {{db}} with {{site}}? The SQL rights stay as they are; the site may lose its default network access to the database server (segmented accounts).' }),
      confirmLabel: t('databases.sites.detach') || 'Detach',
    }))) return false;
    try {
      const r = await databasesApi.detach(d.instanceId, d.id, site.id);
      toastAttachment(t, t('databases.sites.detached', { db: d.name, site: site.name, defaultValue: '{{db}} detached from {{site}}' }), r);
      return true;
    } catch (err) {
      if (!isStepUpHandled(err)) toastDbError(t, err, t('databases.sites.detachFailed') || 'Failed to detach the database');
      return false;
    }
  };
}

/**
 * Make a site the owner of a database (the previous owner stays attached as
 * shared), always confirmed: from another owner (it moves), or from the
 * account (it is no longer shared across the account: the other sites may lose
 * their default network access to its server).
 */
export function useDbSetOwner() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return async (d: Pick<AttachDbRef, 'id' | 'name' | 'instanceId' | 'ownerSite'>, site: DbSiteRef): Promise<boolean> => {
    if (d.ownerSite?.id !== site.id && !(await confirm({
      title: t('databases.sites.makeOwner') || 'Make this site the owner',
      message: d.ownerSite
        ? t('databases.sites.moveOwnerConfirm', { db: d.name, site: site.name, previous: d.ownerSite.name, defaultValue: '{{site}} becomes the owner of {{db}}; {{previous}} stays attached as a shared site.' })
        : t('databases.sites.takeFromAccountConfirm', { db: d.name, site: site.name, defaultValue: '{{site}} becomes the owner of {{db}}. It is no longer shared across the account: the sites that neither own nor share a database of this server may lose their default network access to it (segmented accounts). Their SQL rights are kept.' }),
      confirmLabel: t('databases.sites.makeOwner') || 'Make this site the owner',
    }))) return false;
    try {
      const r = await databasesApi.setOwner(d.instanceId, d.id, { siteId: site.id });
      toastAttachment(t, t('databases.sites.ownerSet', { db: d.name, site: site.name, defaultValue: '{{site}} now owns {{db}}' }), r);
      return true;
    } catch (err) {
      if (!isStepUpHandled(err)) toastDbError(t, err, t('databases.sites.attachFailed') || 'Failed to attach the database');
      return false;
    }
  };
}

/**
 * « Attach / share with a site… »: from a database (pick a site of its
 * account) or from a site (pick a database of its account). Owner = the
 * database belongs to the site (the previous owner stays as shared); shared =
 * the site uses it too. Optionally grants an EXISTING user of the same
 * instance on it (nothing is ever revoked). The current attachments of a
 * database are listed with their detach button.
 *
 * A failure re-reads the database: the grant runs AFTER the attachment is
 * written, so a failed grant leaves it attached (shown as such, the parent
 * refreshed through onChanged; a retry only grants again).
 */
export function DbSiteAttachModal({ open, target, onClose, onDone, onChanged }: {
  open: boolean;
  target: AttachTarget | null;
  onClose: () => void;
  onDone: () => void;
  /** The attachments changed while the dialog stays open (partial failure): refresh the parent. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const detach = useDbDetach();
  const accountId = target ? (target.kind === 'database' ? target.database.accountId : target.site.accountId) : null;
  // The database of the target, as re-read after a failure (fresh) when it was.
  const [fresh, setFresh] = useState<AttachDbRef | null>(null);
  const targetDb = target?.kind === 'database' ? target.database : null;
  const fixedDb = targetDb && fresh?.id === targetDb.id ? fresh : targetDb;
  const fixedSite = target?.kind === 'site' ? target.site : null;

  const [sites, setSites] = useState<Site[] | null>(null);
  const [dbs, setDbs] = useState<DbDatabaseListItem[] | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [dbId, setDbId] = useState<number | null>(null);
  const [role, setRole] = useState<DbSiteRole>('shared');
  const [grantOn, setGrantOn] = useState(false);
  const [users, setUsers] = useState<DbUser[] | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [level, setLevel] = useState<DbPrivilegeLevel>('readonly');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Reset on every opening.
  useEffect(() => {
    if (!open || !target || accountId == null) return;
    setSiteId(target.kind === 'database' ? target.siteId ?? null : null); setDbId(null); setFresh(null); setGrantOn(false); setUsers(null); setUserId(null); setLevel('readonly'); setError(null); setLoadError(null);
    // From a database without owner, « owner » is the likely intent; else sharing.
    setRole(target.kind === 'database' && !target.database.ownerSite ? 'owner' : 'shared');
    let live = true;
    if (target.kind === 'database') {
      setSites(null);
      sitesApi.list({ accountId }).then((l) => { if (live) setSites(l); })
        .catch((err) => { if (live) { setSites([]); setLoadError(dbErrorMessage(t, err, t('sites.loadFailed') || 'Failed to load the sites')); } });
    } else {
      setDbs(null);
      databasesApi.listDatabases({ accountId }).then((l) => { if (live) setDbs(l); })
        .catch((err) => { if (live) { setDbs([]); setLoadError(dbErrorMessage(t, err, t('databases.loadFailed') || 'Failed to load the databases')); } });
    }
    return () => { live = false; };
  }, [open, target, accountId, t]);

  // The database the change is about (fixed, or picked from the site side).
  const pickedDb = useMemo<AttachDbRef | null>(() => {
    if (fixedDb) return fixedDb;
    const d = dbs?.find((x) => x.id === dbId);
    return d ? attachRefOf(d) : null;
  }, [fixedDb, dbs, dbId]);
  const pickedSite = useMemo<DbSiteRef | null>(() => {
    if (fixedSite) return { id: fixedSite.id, name: fixedSite.name, slug: '' };
    const s = sites?.find((x) => x.id === siteId);
    return s ? { id: s.id, name: s.name, slug: s.slug } : null;
  }, [fixedSite, sites, siteId]);

  // Users of the instance, for the optional grant (loaded once the box is ticked).
  const instanceId = pickedDb?.instanceId ?? null;
  useEffect(() => {
    if (!open || !grantOn || instanceId == null) return;
    let live = true;
    setUsers(null); setUserId(null);
    databasesApi.getInstance(instanceId).then((i) => { if (live) setUsers(i.users); }).catch(() => { if (live) setUsers([]); });
    return () => { live = false; };
  }, [open, grantOn, instanceId]);

  // Databases of the account not attached to the site yet (site side); the picked one stays
  // listed once attached (a failed grant: retried from here).
  const dbChoices = useMemo(() => (dbs ?? []).filter((d) => fixedSite && (d.id === dbId
    || (d.ownerSite?.id !== fixedSite.id && !(d.sharedSites ?? []).some((s) => s.id === fixedSite.id)))), [dbs, fixedSite, dbId]);

  const isOwner = !!pickedDb && !!pickedSite && pickedDb.ownerSite?.id === pickedSite.id;
  const isShared = !!pickedDb && !!pickedSite && pickedDb.sharedSites.some((s) => s.id === pickedSite.id);
  const already = role === 'owner' ? isOwner : (isOwner || isShared);
  const grantReady = !grantOn || userId != null;
  // Already attached: only a grant is left to do (the server keeps the attachment and grants).
  const valid = !!pickedDb && !!pickedSite && (!already || grantOn) && grantReady;

  /** After a failure: the database as it is now (attached despite a failed grant?), the parent refreshed. */
  const reread = async (databaseId: number): Promise<DbDatabaseListItem | null> => {
    if (accountId == null) return null;
    try {
      const list = await databasesApi.listDatabases({ accountId });
      if (target?.kind === 'site') setDbs(list);
      const d = list.find((x) => x.id === databaseId) ?? null;
      if (d && target?.kind === 'database') setFresh(attachRefOf(d));
      return d;
    } catch {
      return null;
    } finally {
      onChanged?.();
    }
  };

  const submit = async () => {
    if (!valid || !pickedDb || !pickedSite) return;
    setSaving(true);
    setError(null);
    const grantUser = grantOn && userId != null ? { userId, level } : null;
    try {
      const r = role === 'owner'
        ? await databasesApi.setOwner(pickedDb.instanceId, pickedDb.id, { siteId: pickedSite.id, grantUser })
        : await databasesApi.share(pickedDb.instanceId, pickedDb.id, { siteId: pickedSite.id, grantUser });
      toastAttachment(t, role === 'owner'
        ? t('databases.sites.ownerSet', { db: pickedDb.name, site: pickedSite.name, defaultValue: '{{site}} now owns {{db}}' })
        : t('databases.sites.sharedDone', { db: pickedDb.name, site: pickedSite.name, defaultValue: '{{db}} shared with {{site}}' }), r);
      onDone();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      const message = dbErrorMessage(t, err, t('databases.sites.attachFailed') || 'Failed to attach the database');
      const now = await reread(pickedDb.id);
      const attached = !!now && (now.ownerSite?.id === pickedSite.id || (role === 'shared' && now.sharedSites.some((s) => s.id === pickedSite.id)));
      setError(grantUser && attached
        ? t('databases.sites.attachedGrantFailed', { error: message, defaultValue: 'The database is attached, but granting the user failed: {{error}}\nRetry to grant the user again (the attachment stays).' })
        : message);
    } finally {
      setSaving(false);
    }
  };

  const removeFrom = async (s: DbSiteRef) => {
    if (!fixedDb) return;
    if (await detach(fixedDb, s)) onDone();
  };

  const loading = target?.kind === 'database' ? sites === null : dbs === null;
  const roleBtn = (r: DbSiteRole, icon: JSX.Element, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => setRole(r)}
      aria-pressed={role === r}
      className={cn(
        'flex flex-1 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors coarse:min-h-10',
        role === r ? (r === 'owner' ? 'border-accent/50 bg-accent/10' : 'border-blue-400/50 bg-blue-500/10') : 'border-border bg-bg-tertiary/40 hover:bg-bg-tertiary',
      )}
    >
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', role === r ? (r === 'owner' ? 'text-accent' : 'text-blue-400') : 'text-text-primary')}>{icon}{label}</span>
      <span className="text-[11px] leading-snug text-text-muted">{hint}</span>
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fixedDb
        ? t('databases.sites.attachTitleDb', { db: fixedDb.name, defaultValue: 'Attach / share {{db}} with a site' })
        : t('databases.sites.attachTitleSite', { site: fixedSite?.name ?? '', defaultValue: 'Attach an existing database to {{site}}' })}
      icon={<Link2 className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>
            {already
              ? (t('databases.sites.grantOnly') || 'Grant the user')
              : role === 'owner' ? (t('databases.sites.attachOwner') || 'Attach as owner') : (t('databases.sites.share') || 'Share')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-4">
          {loadError && <p className="whitespace-pre-line text-xs text-status-down">{loadError}</p>}

          {/* Current attachments of the database, each detachable. */}
          {fixedDb && (
            <div>
              <p className={labelCls}>{t('databases.sites.current') || 'Currently'}</p>
              <ul className="space-y-1.5 rounded-lg bg-bg-tertiary/40 p-2">
                {!fixedDb.ownerSite && (
                  <li className="flex items-center gap-2"><DbAccountWideBadge /></li>
                )}
                {[...(fixedDb.ownerSite ? [{ s: fixedDb.ownerSite, r: 'owner' as const }] : []), ...fixedDb.sharedSites.map((s) => ({ s, r: 'shared' as const }))].map(({ s, r }) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <DbSiteChip site={s} role={r} />
                    <span className="text-[11px] text-text-muted">{r === 'owner' ? (t('databases.sites.roleOwner') || 'Owner') : (t('databases.sites.roleShared') || 'Shared')}</span>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { void removeFrom(s); }}>
                      <Unlink size={13} className="mr-1" />{t('databases.sites.detach') || 'Detach'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fixedDb ? (
            <div>
              <label className={labelCls} htmlFor="attach-site">{t('databases.sites.site') || 'Site'}</label>
              <select id="attach-site" value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)} className={inputCls}>
                <option value="">{t('databases.sites.pickSite') || 'Choose a site…'}</option>
                {(sites ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}{fixedDb.ownerSite?.id === s.id ? ` — ${t('databases.sites.roleOwner') || 'Owner'}` : fixedDb.sharedSites.some((x) => x.id === s.id) ? ` — ${t('databases.sites.roleShared') || 'Shared'}` : ''}
                  </option>
                ))}
              </select>
              {sites && sites.length === 0 && !loadError && <p className="mt-1 text-xs text-text-muted">{t('databases.sites.noSite') || 'This account has no site yet.'}</p>}
            </div>
          ) : (
            <div>
              <label className={labelCls} htmlFor="attach-db">{t('databases.sites.database') || 'Database'}</label>
              <select id="attach-db" value={dbId ?? ''} onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                setDbId(id);
                setGrantOn(false);
                const d = dbs?.find((x) => x.id === id);
                // An account-wide database is most likely being given to the site.
                if (d) setRole(d.ownerSite ? 'shared' : 'owner');
              }} className={cn(inputCls, 'font-mono')}>
                <option value="">{t('databases.sites.pickDatabase') || 'Choose a database…'}</option>
                {dbChoices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.instanceName} ({engineLabel(d.engine)}) — {d.ownerSite ? d.ownerSite.name : (t('databases.sites.accountShort') || 'Account')}
                  </option>
                ))}
              </select>
              {dbs && dbChoices.length === 0 && !loadError && <p className="mt-1 text-xs text-text-muted">{t('databases.sites.noDatabase') || 'No other database on this account: create one for the site instead.'}</p>}
              {pickedDb && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
                  {pickedDb.ownerSite ? <DbSiteChip site={pickedDb.ownerSite} /> : <DbAccountWideBadge />}
                  {pickedDb.sharedSites.map((s) => <DbSiteChip key={s.id} site={s} role="shared" />)}
                </div>
              )}
            </div>
          )}

          <div>
            <p className={labelCls}>{t('databases.sites.role') || 'Attachment'}</p>
            <div className="flex gap-2 max-sm:flex-col">
              {roleBtn('owner', <Crown size={14} />, t('databases.sites.roleOwner') || 'Owner', t('databases.sites.roleOwnerChoice') || 'The database belongs to this site.')}
              {roleBtn('shared', <Share2 size={14} />, t('databases.sites.roleShared') || 'Shared', t('databases.sites.roleSharedChoice') || 'The site uses it too; the owner does not change.')}
            </div>
            {already && pickedSite && pickedDb && (
              <p className="mt-1.5 text-xs text-amber-400">
                {isOwner
                  ? t('databases.sites.alreadyOwner', { site: pickedSite.name, defaultValue: '{{site}} already owns this database.' })
                  : t('databases.sites.alreadyShared', { site: pickedSite.name, defaultValue: 'This database is already shared with {{site}}.' })}
              </p>
            )}
            {!already && role === 'owner' && pickedDb?.ownerSite && pickedSite && (
              <p className="mt-1.5 text-xs text-text-muted">
                {t('databases.sites.ownerMoves', { previous: pickedDb.ownerSite.name, defaultValue: '{{previous}} stays attached as a shared site.' })}
              </p>
            )}
            {!already && role === 'owner' && pickedDb && !pickedDb.ownerSite && (
              <p className="mt-1.5 text-xs text-amber-400">
                {t('databases.sites.leavesAccountHint') || 'It is no longer shared across the account: the sites that neither own nor share a database of this server may lose their default network access to it (segmented accounts). Their SQL rights are kept.'}
              </p>
            )}
          </div>

          {/* Optional: grant an existing user of the same instance (nothing is revoked). */}
          <div className="rounded-lg bg-bg-tertiary/40 p-3">
            <label className={cn('flex items-start gap-2 text-sm text-text-primary', !pickedDb?.instanceRunning && 'opacity-60')}>
              <input type="checkbox" className="mt-0.5" checked={grantOn} disabled={!pickedDb || !pickedDb.instanceRunning} onChange={(e) => setGrantOn(e.target.checked)} />
              <span>
                {t('databases.sites.grantUser') || 'Also grant an existing database user on it'}
                <span className="block text-[11px] text-text-muted">
                  {pickedDb && !pickedDb.instanceRunning
                    ? (t('databases.notRunningHint') || 'The instance is not running: start it to manage its databases.')
                    : (t('databases.sites.grantHint') || 'Attaching never revokes a right: users keep the grants they have.')}
                </span>
              </span>
            </label>
            {grantOn && (
              users === null ? (
                <div className="flex justify-center py-3"><LoadingSpinner size="sm" /></div>
              ) : users.length === 0 ? (
                <p className="mt-2 text-xs text-text-muted">{t('databases.sites.noUser') || 'This instance has no user yet.'}</p>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <select aria-label={t('databases.sites.user') || 'User'} value={userId ?? ''} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)} className={cn(inputCls, 'font-mono')}>
                    <option value="">{t('databases.sites.pickUser') || 'Choose a user…'}</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                  </select>
                  <select aria-label={t('databases.sites.level') || 'Rights'} value={level} onChange={(e) => setLevel(e.target.value as DbPrivilegeLevel)} className={inputCls}>
                    <option value="readonly">{privilegeLabel(t, 'readonly')}</option>
                    <option value="all">{privilegeLabel(t, 'all')}</option>
                  </select>
                </div>
              )
            )}
          </div>

          {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
