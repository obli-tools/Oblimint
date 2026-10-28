import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Globe2, Plug, Settings2, ShieldAlert } from 'lucide-react';
import { DB_PROFILE_MEMORY_MB, DB_SOCKET_PATHS, type DbCatalog, type DbInstance, type DbInstanceDetail, type DbTuningProfile } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { CopyField } from '@/components/dns/DomainOwnershipCard';
import { cn } from '@/utils/cn';
import { accountAccessHref } from '@/utils/links';
import { DB_INSTANCE_NAME_RE, DB_PROFILES, toastDbError } from './dbFormat';

/** How the sites (and external clients) reach the instance. */
export function DbConnectionCard({ instance }: { instance: DbInstanceDetail }) {
  const { t } = useTranslation();
  const c = instance.connection;
  const pg = instance.family === 'postgresql';
  return (
    <Card title={t('databases.connection.title') || 'Connection'} icon={<Plug size={14} className="text-accent" />}>
      <div className="space-y-3">
        {instance.isDefault ? (
          <div className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-text-secondary">
            <p className="mb-1.5">{pg
              ? (t('databases.connection.defaultHintPg') || 'Default PostgreSQL instance of the account: in every site, connect through the socket directory')
              : (t('databases.connection.defaultHint') || 'Default instance of the account: in every site, connect with')}</p>
            <CopyField label={t('databases.connection.envHint') || 'Site configuration'} value={pg ? `DB_HOST=${DB_SOCKET_PATHS.postgresqlDir}` : 'DB_HOST=localhost'} />
          </div>
        ) : (
          <p className="text-xs text-text-muted">
            {t('databases.connection.notDefaultHint') || 'Not the default instance: the sites reach it through its own socket or its internal host name.'}
          </p>
        )}
        <CopyField label={t('databases.connection.socket') || 'Socket (in the sites)'} value={c.socketPath} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
          <CopyField label={t('databases.connection.internalHost') || 'Internal host (account network)'} value={c.internalHost} />
          <CopyField label={t('databases.connection.port') || 'Port'} value={String(c.internalPort)} />
        </div>
        {c.externalHost && c.externalPort != null && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
            <CopyField label={t('databases.connection.externalHost') || 'External host'} value={c.externalHost} />
            <CopyField label={t('databases.connection.externalPort') || 'External port'} value={String(c.externalPort)} />
          </div>
        )}
      </div>
    </Card>
  );
}

/** External access (published port protected by the account allow-list). */
export function DbExternalCard({ instance, catalog, manage, onChanged }: {
  instance: DbInstance;
  catalog: DbCatalog | null;
  manage: boolean;
  onChanged: (i: DbInstance) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const allowed = catalog?.externalAccessAllowed ?? false;

  const toggle = async (enabled: boolean) => {
    if (enabled && !(await confirm({
      title: t('databases.external.enableTitle') || 'Open external access',
      message: t('databases.external.enableConfirm') || 'The instance gets a public port. Only the addresses allowed by the account access list can reach it: check Access & security > SFTP / SQL firewall on the account. Continue?',
      confirmLabel: t('common.enable') || 'Enable',
    }))) return;
    setBusy(true);
    try {
      onChanged(await databasesApi.setExternal(instance.id, enabled));
      toast.success(enabled ? (t('databases.external.enabled') || 'External access opened') : (t('databases.external.disabled') || 'External access closed'));
    } catch (err) {
      toastDbError(t, err, t('databases.external.failed') || 'Failed to change the external access');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('databases.external.title') || 'External access'} icon={<Globe2 size={14} className="text-accent" />}>
      {!allowed && !instance.externalEnabled ? (
        <p className="text-xs text-text-muted">{t('databases.external.notAllowed') || 'The plan of the account does not allow external access to the databases.'}</p>
      ) : (
        <div className="space-y-3">
          <ToggleSwitch
            checked={instance.externalEnabled}
            disabled={!manage || busy || (!allowed && !instance.externalEnabled)}
            onChange={(v) => { void toggle(v); }}
            label={t('databases.external.toggle') || 'Reachable from outside'}
            description={instance.externalEnabled && instance.externalPort != null
              ? t('databases.external.port', { port: instance.externalPort, defaultValue: 'Public port {{port}}' })
              : (t('databases.external.off') || 'Only the sites of the account can connect.')}
          />
          <p className="flex items-start gap-2 text-xs text-amber-400">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              {t('databases.external.allowListHint') || 'The account access list (allow-list, bans) filters this port.'}{' '}
              <Link to={accountAccessHref(instance.accountId, 'firewall')} className="underline hover:text-accent">
                {t('databases.external.securityLink') || 'Firewall of the account'}
              </Link>
            </span>
          </p>
        </div>
      )}
    </Card>
  );
}

/** Name, profile (memory) and default flag. */
export function DbSettingsCard({ instance, catalog, manage, onChanged }: {
  instance: DbInstance;
  catalog: DbCatalog | null;
  manage: boolean;
  onChanged: (i: DbInstance) => void;
}) {
  const { t } = useTranslation();
  const { me } = useHostingMe();
  const confirm = useConfirm();
  const [name, setName] = useState(instance.name);
  const [profile, setProfile] = useState<DbTuningProfile>(instance.profile);
  const [busy, setBusy] = useState<'save' | 'default' | null>(null);
  useEffect(() => { setName(instance.name); setProfile(instance.profile); }, [instance.name, instance.profile]);

  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const planIdx = DB_PROFILES.indexOf(catalog?.defaultProfile ?? instance.profile);
  // A client may not go above the plan's profile (nor above the current one if staff raised it).
  const maxIdx = me?.kind === 'staff' ? DB_PROFILES.length - 1 : Math.max(planIdx, DB_PROFILES.indexOf(instance.profile));
  const nameValid = DB_INSTANCE_NAME_RE.test(name);
  const dirty = name !== instance.name || profile !== instance.profile;

  const save = async () => {
    // A new profile restarts the instance (connections of every site cut).
    if (profile !== instance.profile && !(await confirm({
      title: t('databases.settings.profileConfirmTitle') || 'Change the profile',
      message: t('databases.settings.profileConfirm', {
        name: instance.name, profile, memory: formatMb(DB_PROFILE_MEMORY_MB[profile], units),
        defaultValue: 'Switch {{name}} to the {{profile}} profile ({{memory}})? The instance restarts: open connections of the sites are cut for a few seconds.',
      }),
      confirmLabel: t('databases.settings.profileConfirmLabel') || 'Change and restart',
    }))) return;
    setBusy('save');
    try {
      onChanged(await databasesApi.updateInstance(instance.id, {
        ...(name !== instance.name ? { name } : {}),
        ...(profile !== instance.profile ? { profile } : {}),
      }));
      toast.success(profile !== instance.profile
        ? (t('databases.settings.savedRestart') || 'Saved: the instance restarts with the new profile')
        : (t('databases.settings.saved') || 'Instance saved'));
    } catch (err) {
      toastDbError(t, err, t('databases.settings.saveFailed') || 'Failed to save the instance');
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async () => {
    if (!(await confirm({
      title: t('databases.settings.makeDefaultTitle') || 'Change the default instance',
      message: t('databases.settings.makeDefaultConfirm', {
        name: instance.name,
        defaultValue: 'Make {{name}} the default instance? Every site of the account that connects to localhost (standard socket) is immediately re-pointed to {{name}} and no longer sees the databases of the current default instance.',
      }),
      confirmLabel: t('databases.settings.makeDefaultLabel') || 'Make default',
      danger: true,
    }))) return;
    setBusy('default');
    try {
      onChanged(await databasesApi.updateInstance(instance.id, { isDefault: true }));
      toast.success(t('databases.settings.defaultSet') || 'Default instance changed');
    } catch (err) {
      toastDbError(t, err, t('databases.settings.saveFailed') || 'Failed to save the instance');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('databases.settings.title') || 'Settings'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dbs-name">{t('databases.name') || 'Name'}</label>
            <input
              id="dbs-name"
              value={name}
              disabled={!manage}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className={cn(inputCls, 'font-mono', !nameValid && 'ring-2 ring-status-down')}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="dbs-profile">{t('databases.profile') || 'Profile'}</label>
            <select id="dbs-profile" value={profile} disabled={!manage} onChange={(e) => setProfile(e.target.value as DbTuningProfile)} className={selectCls}>
              {DB_PROFILES.map((p, i) => (
                <option key={p} value={p} disabled={i > maxIdx}>{p} — {formatMb(DB_PROFILE_MEMORY_MB[p], units)}</option>
              ))}
            </select>
          </div>
        </div>
        <ToggleSwitch
          checked={instance.isDefault}
          disabled={!manage || instance.isDefault || busy !== null}
          onChange={() => { void makeDefault(); }}
          label={t('databases.settings.default') || 'Default instance of the account'}
          description={instance.isDefault
            ? (t('databases.settings.isDefaultHint') || 'Its socket is at the standard path in every site. Make another instance of the same family the default to change it.')
            : (t('databases.settings.makeDefaultHint') || 'Mount its socket at the standard path in every site (DB_HOST=localhost).')}
        />
        {manage && (
          <div className="flex justify-end">
            <Button size="sm" loading={busy === 'save'} disabled={!dirty || !nameValid || busy !== null} onClick={() => { void save(); }}>
              {t('common.save') || 'Save'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
