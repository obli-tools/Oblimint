import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import {
  DB_PROFILE_MEMORY_MB, type DbCatalog, type DbEngine, type DbInstance, type DbTuningProfile, type HostingAccount,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { DB_INSTANCE_NAME_RE, DB_PROFILES, dbErrorMessage, engineLabel } from './dbFormat';

/** Plan limits of the catalog, one line. */
export function DbPlanLimits({ catalog, instanceCount }: { catalog: DbCatalog; instanceCount?: number }) {
  const { t } = useTranslation();
  const unlimited = t('hostingCommon.unlimited') || 'unlimited';
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const instances = catalog.maxInstances == null ? unlimited : String(catalog.maxInstances);
  return (
    <p className="text-xs text-text-muted">
      {t('databases.limits.line', {
        instances: instanceCount != null ? `${instanceCount} / ${instances}` : instances,
        databases: catalog.maxDatabases == null ? unlimited : catalog.maxDatabases,
        size: catalog.dbMaxSizeMb == null ? unlimited : formatMb(catalog.dbMaxSizeMb, units),
        engines: catalog.allowedEngines.map(engineLabel).join(', ') || '—',
        defaultValue: 'Plan: {{instances}} instance(s) · {{databases}} database(s) · {{size}} per database · engines: {{engines}}',
      })}
      {' · '}
      {catalog.externalAccessAllowed
        ? (t('databases.limits.externalOn') || 'external access allowed')
        : (t('databases.limits.externalOff') || 'no external access')}
    </p>
  );
}

/** Create a database instance (account, engine / version of the plan, name, profile). */
export function DbInstanceCreateModal({ open, onClose, onCreated, accountId: fixedAccountId }: {
  open: boolean;
  onClose: () => void;
  onCreated: (i: DbInstance) => void;
  accountId?: number;
}) {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [version, setVersion] = useState(''); // "<engine>:<version>"
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<DbTuningProfile | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setVersion(''); setProfile(''); setError(null); setCatalog(null); setCatalogError(null);
    setAccountId(fixedAccountId ?? '');
    if (fixedAccountId == null) {
      accountsApi.list()
        .then((list) => {
          const allowed = list.filter((a) => can('databases.manage', a.id));
          setAccounts(allowed);
          if (allowed.length === 1) setAccountId(allowed[0].id);
        })
        .catch(() => setAccounts([]));
    }
  }, [open, fixedAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || accountId === '') { setCatalog(null); return; }
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    databasesApi.catalog(accountId)
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        const first = c.versions.find((v) => c.allowedEngines.includes(v.engine) && !v.eol) ?? c.versions.find((v) => c.allowedEngines.includes(v.engine));
        setVersion(first ? `${first.engine}:${first.version}` : '');
        setProfile(c.defaultProfile);
      })
      .catch((err) => { if (!cancelled) setCatalogError(dbErrorMessage(t, err, t('databases.catalogFailed') || 'Failed to load the catalog')); });
    return () => { cancelled = true; };
  }, [open, accountId, t]);

  const allowedVersions = useMemo(() => (catalog ? catalog.versions.filter((v) => catalog.allowedEngines.includes(v.engine)) : []), [catalog]);
  const engines = useMemo(() => [...new Set(allowedVersions.map((v) => v.engine))] as DbEngine[], [allowedVersions]);
  // A client may not exceed the plan's profile; staff may (server: staff only).
  const maxProfileIdx = me?.kind === 'staff' ? DB_PROFILES.length - 1 : DB_PROFILES.indexOf(catalog?.defaultProfile ?? 'S');

  const nameValid = DB_INSTANCE_NAME_RE.test(name);
  const [engine, ver] = version.split(':') as [DbEngine | '', string | undefined];
  const canSubmit = !saving && accountId !== '' && !!catalog && nameValid && !!engine && !!ver;

  const submit = async () => {
    if (!canSubmit || typeof accountId !== 'number' || !engine || !ver) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await databasesApi.createInstance({ accountId, name, engine, version: ver, ...(profile ? { profile } : {}) }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dbErrorMessage(t, err, t('databases.createFailed') || 'Failed to create the instance'));
    } finally {
      setSaving(false);
    }
  };

  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('databases.createTitle') || 'New database instance'}
      icon={<Database className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {fixedAccountId == null && (
          <div>
            <label className={labelCls} htmlFor="dbi-account">{t('domains.form.account') || 'Hosting account'}</label>
            <select id="dbi-account" value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('domains.form.chooseAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          </div>
        )}
        {accountId !== '' && !catalog && !catalogError && <div className="flex justify-center py-3"><LoadingSpinner size="sm" /></div>}
        {catalogError && <p className="whitespace-pre-line text-xs text-status-down">{catalogError}</p>}
        {catalog && (
          <>
            <DbPlanLimits catalog={catalog} />
            <div>
              <label className={labelCls} htmlFor="dbi-version">{t('databases.engine') || 'Engine'}</label>
              <select id="dbi-version" value={version} onChange={(e) => setVersion(e.target.value)} className={selectCls}>
                {allowedVersions.length === 0 && <option value="">{t('databases.noEngine') || 'The plan allows no engine'}</option>}
                {engines.map((e) => (
                  <optgroup key={e} label={engineLabel(e)}>
                    {allowedVersions.filter((v) => v.engine === e).map((v) => (
                      <option key={`${v.engine}:${v.version}`} value={`${v.engine}:${v.version}`}>
                        {engineLabel(v.engine)} {v.version}{v.eol ? ` — ${t('databases.eol') || 'unmaintained'}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="dbi-name">{t('databases.name') || 'Name'}</label>
                <input
                  id="dbi-name"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="main"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                  className={cn(inputCls, 'font-mono', name && !nameValid && 'ring-2 ring-status-down')}
                />
                {name && !nameValid && <p className="mt-1 text-xs text-status-down">{t('databases.nameInvalid') || 'Lower-case letters, digits and dashes (1–32), starting with a letter or a digit.'}</p>}
              </div>
              <div>
                <label className={labelCls} htmlFor="dbi-profile">{t('databases.profile') || 'Profile'}</label>
                <select id="dbi-profile" value={profile} onChange={(e) => setProfile(e.target.value as DbTuningProfile)} className={selectCls}>
                  {DB_PROFILES.map((p, i) => (
                    <option key={p} value={p} disabled={i > maxProfileIdx}>
                      {p} — {formatMb(DB_PROFILE_MEMORY_MB[p], units)}{p === catalog.defaultProfile ? ` (${t('databases.planProfile') || 'plan'})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              {t('databases.createHint') || 'The first instance of a family (MySQL / MariaDB, or PostgreSQL) becomes the account default: the sites reach it with DB_HOST=localhost.'}
            </p>
          </>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
