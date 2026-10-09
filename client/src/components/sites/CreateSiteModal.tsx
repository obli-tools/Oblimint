import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  APP_PROFILES, SITE_BASES, appProfileDef, normalizePathPrefix, normalizeRelPath,
  type AppProfileId, type HostingAccount, type PublishMode, type Site, type SiteBaseId,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { InfoTip } from '@/components/common/Tip';
import { BasePicker } from './BasePicker';
import { isBaseAllowed, pickAllowedBase } from './allowedBases';
import { Pill, PolicyBadge } from './SiteBadges';
import { PublishModeField } from './PublishModeField';
import { deriveSlug, SITE_SLUG_RE } from './siteForm';
import { siteErrorMessage } from './siteErrors';
import { fieldCls, labelCls, sectionLabelCls } from './styles';

/** Accounts a site can be created in (suspended / deleting ones are listed but disabled). */
function isSelectable(a: HostingAccount): boolean {
  return a.status !== 'suspended' && a.status !== 'deleting';
}

export interface CreateSiteModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (site: Site) => void;
  /** Account preselected (e.g. `/sites?create=1&accountId=12` from the account page). */
  initialAccountId?: number | null;
}

export function CreateSiteModal({ open, onClose, onCreated, initialAccountId }: CreateSiteModalProps) {
  if (!open) return null;
  return <CreateSiteForm onClose={onClose} onCreated={onCreated} initialAccountId={initialAccountId} />;
}

function CreateSiteForm({ onClose, onCreated, initialAccountId }: Omit<CreateSiteModalProps, 'open'>) {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  const [allAccounts, setAllAccounts] = useState<HostingAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountId, setAccountId] = useState<number | null>(initialAccountId ?? null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [profile, setProfile] = useState<AppProfileId | ''>('');
  const [base, setBase] = useState<SiteBaseId>('apache-php8.3');
  const [docroot, setDocroot] = useState('');
  const [basePath, setBasePath] = useState('/');
  const [publishMode, setPublishMode] = useState<PublishMode>('auto');
  const [debounce, setDebounce] = useState('30');
  const [applyDataPaths, setApplyDataPaths] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    accountsApi.list()
      .then((list) => { if (!cancelled) setAllAccounts(list); })
      .catch(() => { if (!cancelled) setAllAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Only the accounts where the caller may create sites (/hosting/me may
  // arrive after the list: derived at render time).
  const accounts = useMemo(
    () => allAccounts.filter((a) => can('sites.manage', a.id)),
    [allAccounts, me], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selectable = useMemo(() => accounts.filter(isSelectable), [accounts]);
  // A preselected account (?accountId=) the caller may not use, or that is
  // suspended / being deleted, must not stay as hidden state: reset it once
  // both the list and /hosting/me are known. A single usable account is preselected.
  useEffect(() => {
    if (accountsLoading || !me) return;
    setAccountId((cur) => {
      if (cur !== null && selectable.some((a) => a.id === cur)) return cur;
      return selectable.length === 1 ? selectable[0].id : null;
    });
  }, [accountsLoading, me, selectable]);

  const profileDef = profile ? appProfileDef(profile) : null;
  const account = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId]);
  // Bases of the selected account's plan (null = the whole catalog). The
  // server refuses the others (409 baseNotAllowed): never preselect one.
  const allowedBases = account?.allowedBases ?? null;
  const allowedKey = allowedBases ? allowedBases.join(',') : '*';
  useEffect(() => {
    setBase((cur) => pickAllowedBase(allowedBases, cur, SITE_BASES));
  }, [allowedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickProfile = (id: AppProfileId | '') => {
    setProfile(id);
    if (id) {
      const def = appProfileDef(id);
      setBase(pickAllowedBase(allowedBases, def.recommendedBase, SITE_BASES));
      setDocroot(def.docroot);
    }
  };

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugEdited) setSlug(deriveSlug(v));
  };

  const slugValid = SITE_SLUG_RE.test(slug);
  const docrootNorm = normalizeRelPath(docroot, true);
  const basePathNorm = normalizePathPrefix(basePath);
  const debounceNum = Number(debounce);
  const debounceValid = publishMode !== 'auto' || (Number.isInteger(debounceNum) && debounceNum >= 5 && debounceNum <= 3600);

  const submit = async () => {
    setError('');
    if (!accountId || !name.trim() || !slug) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (!slugValid) { setError(t('sites.create.slugInvalid') || 'Invalid identifier: lower-case letters, digits and dashes, 40 characters max.'); return; }
    if (docrootNorm === null) { setError(t('sites.form.docrootInvalid') || 'Invalid document root.'); return; }
    if (basePathNorm === null) { setError(t('sites.form.basePathInvalid') || 'Invalid base path.'); return; }
    if (!debounceValid) { setError(t('sites.form.debounceInvalid') || 'The delay must be between 5 and 3600 seconds.'); return; }
    if (!isBaseAllowed(allowedBases, base)) { setError(t('runtime.notInPlanError') || 'This base is not allowed by the plan of the account.'); return; }
    setSaving(true);
    try {
      const site = await sitesApi.create({
        accountId,
        name: name.trim(),
        slug,
        base,
        appProfile: profile || null,
        docroot: docrootNorm,
        basePath: basePathNorm,
        publishMode,
        ...(publishMode === 'auto' ? { publishDebounceSec: debounceNum } : {}),
        applyProfileDataPaths: !!profileDef && applyDataPaths,
      });
      toast.success(t('sites.create.created', { name: site.name, defaultValue: 'Site "{{name}}" created' }));
      onCreated(site);
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      title={t('sites.create.title') || 'New site'}
      icon={<Globe className="h-4 w-4 text-accent" />}
      dismissible={!saving}
      footer={
        <>
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" onClick={submit} loading={saving}>
            <Plus size={14} className="mr-1" />
            {t('common.create') || 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Identity */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="site-account">{t('sites.fields.account') || 'Hosting account'}</label>
            <select
              id="site-account"
              value={accountId ?? ''}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
              className={fieldCls}
              disabled={accountsLoading}
            >
              <option value="">{accountsLoading ? (t('common.loading') || 'Loading...') : (t('sites.create.pickAccount') || 'Choose an account…')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={!isSelectable(a)}>
                  {a.username}{a.displayName ? ` — ${a.displayName}` : ''}{a.status === 'suspended' ? ` (${t('sites.create.suspended') || 'suspended'})` : ''}
                </option>
              ))}
            </select>
            {!accountsLoading && accounts.length === 0 && (
              <p className="mt-1 text-xs text-text-muted">{t('sites.create.noAccount') || 'No hosting account where you may create a site.'}</p>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="site-name">{t('sites.fields.name') || 'Name'}</label>
            <input
              id="site-name"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className={fieldCls}
              placeholder={t('sites.create.namePlaceholder') || 'My shop'}
              autoFocus
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="site-slug">
              {t('sites.fields.slug') || 'Identifier'}
              <InfoTip className="ml-1 align-middle" content={t('sites.create.slugHint') || 'Name of the SFTP folder of the site (/staging/<identifier>/ and /data/<identifier>/). It can never be changed.'} />
            </label>
            <input
              id="site-slug"
              value={slug}
              onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugEdited(true); }}
              className={`${fieldCls} font-mono ${slug && !slugValid ? 'ring-2 ring-red-400/60' : ''}`}
              placeholder="my-shop"
              maxLength={40}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="mt-1 font-mono text-[11px] text-text-muted break-all">
              /staging/{slug || '…'}/ · /data/{slug || '…'}/
              {account && <span className="text-text-muted/70"> — {account.username}</span>}
            </p>
          </div>
        </div>

        {/* Application profile */}
        <div>
          <div className={sectionLabelCls}>{t('sites.fields.appProfile') || 'Application'}</div>
          <div className="flex flex-wrap gap-1.5">
            <ProfileChip active={profile === ''} onClick={() => pickProfile('')} label={t('sites.profile.none') || 'Other / none'} />
            {APP_PROFILES.map((p) => (
              <ProfileChip key={p.id} active={profile === p.id} onClick={() => pickProfile(p.id)} label={p.id === 'static' ? (t('sites.profile.static') || 'Static site') : p.label} />
            ))}
          </div>
          {profileDef && (
            <div className="mt-3 rounded-lg bg-bg-tertiary/60 p-3">
              <ToggleSwitch
                checked={applyDataPaths}
                onChange={setApplyDataPaths}
                size="sm"
                label={t('sites.create.applyDataPaths') || 'Create the data paths of this profile'}
                description={t('sites.create.applyDataPathsHint') || 'Writable folders kept outside the immutable code (uploads, caches…).'}
              />
              {profileDef.dataPaths.length === 0 ? (
                <p className="mt-2 text-xs text-text-muted">{t('sites.create.noDataPaths') || 'This profile needs no data path.'}</p>
              ) : (
                <ul className={`mt-2 space-y-1 ${applyDataPaths ? '' : 'opacity-50'}`}>
                  {profileDef.dataPaths.map((d) => (
                    <li key={d.path} className="flex flex-wrap items-center gap-2 text-xs">
                      <code className="font-mono text-text-primary">{d.path}/</code>
                      <PolicyBadge policy={d.policy} />
                      {d.allowedExtensions && (
                        <span className="font-mono text-[10px] text-text-muted">{d.allowedExtensions.join(' ')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Base */}
        <div>
          <div className={sectionLabelCls}>{t('sites.fields.baseFull') || 'Base (engine + PHP)'}</div>
          <BasePicker
            value={base}
            onSelect={setBase}
            compact
            isDisabled={(b) => !isBaseAllowed(allowedBases, b)}
            markers={(b) => (
              <>
                {profileDef?.recommendedBase === b && <Pill tone="accent" className="text-[10px]">{t('sites.create.recommended') || 'recommended'}</Pill>}
                {!isBaseAllowed(allowedBases, b) && <Pill tone="muted" className="text-[10px]">{t('runtime.notInPlan') || 'not in plan'}</Pill>}
              </>
            )}
          />
        </div>

        {/* Paths */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="site-docroot">
              {t('sites.fields.docroot') || 'Document root'}
              <InfoTip className="ml-1 align-middle" content={t('sites.form.docrootHint') || 'Folder of the release served by the web server, relative to its root (empty = the root; "public" for Laravel).'} />
            </label>
            <input id="site-docroot" value={docroot} onChange={(e) => setDocroot(e.target.value)} className={`${fieldCls} font-mono`} placeholder={t('sites.form.rootPlaceholder') || '(root)'} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {docrootNorm === null && <p className="mt-1 text-xs text-red-400">{t('sites.form.docrootInvalid') || 'Invalid document root.'}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="site-basepath">
              {t('sites.fields.basePath') || 'Base path'}
              <InfoTip className="ml-1 align-middle" content={t('sites.form.basePathHint') || 'For a sub-site served under a prefix (e.g. /blog/): the path the application expects. "/" otherwise.'} />
            </label>
            <input id="site-basepath" value={basePath} onChange={(e) => setBasePath(e.target.value)} className={`${fieldCls} font-mono`} placeholder="/" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {basePathNorm === null
              ? <p className="mt-1 text-xs text-red-400">{t('sites.form.basePathInvalid') || 'Invalid base path.'}</p>
              : basePathNorm !== basePath.trim() && <p className="mt-1 font-mono text-[11px] text-text-muted">→ {basePathNorm}</p>}
          </div>
        </div>

        {/* Publication */}
        <PublishModeField mode={publishMode} onModeChange={setPublishMode} debounce={debounce} onDebounceChange={setDebounce} />
      </div>
    </Modal>
  );
}

function ProfileChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors coarse:min-h-9 ${active ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
    >
      {label}
    </button>
  );
}
