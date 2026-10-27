import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { Flag, Globe } from 'lucide-react';
import type { DnsZoneKind, Domain, DomainClaim, DomainKind, HostingAccount, Site, TlsMode } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { domainOwnershipApi, domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ClaimInstructions } from '@/components/dns/DomainClaims';
import { apiErrorDetails, ownershipErrorMessage } from '@/components/dns/dnsErrors';
import { cn } from '@/utils/cn';
import { apiErrorCode, inputCls, isStepUpHandled, labelCls, selectCls } from './hostingUi';
import { normalizeDomainName } from './hostingFormat';

export const DOMAIN_KINDS: DomainKind[] = ['primary', 'addon', 'alias', 'subdomain'];

export function domainKindLabel(t: TFunction, k: DomainKind): string {
  const fallback: Record<DomainKind, string> = { primary: 'Primary', addon: 'Add-on', alias: 'Alias', subdomain: 'Subdomain' };
  return t(`domains.kind.${k}`) || fallback[k];
}

export function tlsModeLabel(t: TFunction, m: TlsMode): string {
  return m === 'letsencrypt' ? (t('domains.tls.letsencrypt') || "Let's Encrypt") : (t('domains.tls.none') || 'None (HTTP only)');
}

/** DNS zone choice of the create form ('auto' = the server default policy). */
type DnsZoneChoice = 'auto' | DnsZoneKind | 'none';

/**
 * Create a domain (optionally routed at '/' to a site of the account). A name
 * held by another account (409 domainTaken with details.claimable) offers to
 * start a claim (TXT proof) instead.
 */
export function DomainCreateModal({ open, onClose, onCreated, onClaimCreated, accountId: fixedAccountId }: {
  open: boolean;
  onClose: () => void;
  onCreated: (d: Domain) => void;
  /** A claim was started from the « name taken » answer. */
  onClaimCreated?: (c: DomainClaim) => void;
  /** Fixed account (account detail page); otherwise an account select is shown. */
  accountId?: number;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DomainKind>('primary');
  const [includeWww, setIncludeWww] = useState(true);
  const [tlsMode, setTlsMode] = useState<TlsMode>('letsencrypt');
  const [forceHttps, setForceHttps] = useState(true);
  const [siteId, setSiteId] = useState<number | ''>('');
  const [wildcard, setWildcard] = useState(false);
  const [dnsZone, setDnsZone] = useState<DnsZoneChoice>('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Name held by another account, that may be reclaimed. */
  const [claimable, setClaimable] = useState<string | null>(null);
  const [claim, setClaim] = useState<DomainClaim | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setKind('primary'); setIncludeWww(true); setTlsMode('letsencrypt'); setForceHttps(true);
    setSiteId(''); setError(null); setSites([]); setWildcard(false); setDnsZone('auto'); setClaimable(null); setClaim(null);
    setAccountId(fixedAccountId ?? '');
    if (fixedAccountId == null) {
      accountsApi.list()
        .then((list) => {
          const allowed = list.filter((a) => can('domains.manage', a.id));
          setAccounts(allowed);
          if (allowed.length === 1) setAccountId(allowed[0].id);
        })
        .catch(() => setAccounts([]));
    }
  }, [open, fixedAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || accountId === '') { setSites([]); return; }
    let cancelled = false;
    sitesApi.list({ accountId })
      .then((list) => { if (!cancelled) setSites(list); })
      .catch(() => { if (!cancelled) setSites([]); });
    setSiteId('');
    return () => { cancelled = true; };
  }, [open, accountId]);

  const normalized = normalizeDomainName(name);
  // A wildcard certificate goes through DNS-01: it needs a zone hosted here.
  const wildcardBlocked = dnsZone === 'external' || dnsZone === 'none';
  const canSubmit = normalized !== null && accountId !== '' && !saving;

  // Another name or account: the « taken » answer no longer applies.
  useEffect(() => { setClaimable(null); }, [normalized, accountId]);
  useEffect(() => { if (wildcardBlocked) setWildcard(false); }, [wildcardBlocked]);

  const submit = async () => {
    if (!canSubmit || typeof accountId !== 'number' || !normalized) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await domainsApi.create({
        accountId,
        name: normalized,
        kind,
        includeWww: kind === 'subdomain' ? false : includeWww,
        tlsMode,
        forceHttps: tlsMode === 'none' ? false : forceHttps,
        siteId: siteId === '' ? null : siteId,
        wildcard: wildcardBlocked ? false : wildcard,
        ...(dnsZone === 'auto' ? {} : { dnsZone }),
      }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      if (apiErrorCode(err) === 'domainTaken' && apiErrorDetails(err)?.claimable === true) {
        setClaimable(normalized);
        return;
      }
      setError(ownershipErrorMessage(t, err, t('domains.createFailed') || 'Failed to add the domain'));
    } finally {
      setSaving(false);
    }
  };

  const startClaim = async () => {
    if (!claimable || typeof accountId !== 'number') return;
    setSaving(true);
    setError(null);
    try {
      const created = await domainOwnershipApi.createClaim({ accountId, name: claimable });
      setClaim(created);
      onClaimCreated?.(created);
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(ownershipErrorMessage(t, err, t('domainOwnership.claims.createFailed') || 'Failed to start the claim'));
    } finally {
      setSaving(false);
    }
  };

  if (claim) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t('domainOwnership.claims.createdTitle') || 'Claim started'}
        icon={<Flag className="h-4 w-4 text-accent" />}
        size="md"
        footer={<Button size="sm" onClick={onClose}>{t('common.close') || 'Close'}</Button>}
      >
        <div className="space-y-3">
          <p className="break-all font-mono text-sm font-semibold text-text-primary">{claim.name}</p>
          <ClaimInstructions claim={claim} />
          <p className="text-xs text-text-muted">
            {t('domainOwnership.claims.whereToCheck') || 'The claim is listed above the domains: check it from there once the record is published.'}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('domains.form.createTitle') || 'Add a domain'}
      icon={<Globe className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          {claimable ? (
            <Button size="sm" loading={saving} onClick={() => { void startClaim(); }}>
              <Flag size={13} className="mr-1.5" />{t('domainOwnership.claims.start') || 'Claim this domain'}
            </Button>
          ) : (
            <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {fixedAccountId == null && (
          <div>
            <label className={labelCls} htmlFor="dom-account">{t('domains.form.account') || 'Hosting account'}</label>
            <select id="dom-account" value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('domains.form.chooseAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="dom-name">{t('domains.form.name') || 'Domain name'}</label>
          <input
            id="dom-name"
            value={name}
            autoFocus
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            placeholder="example.com"
            className={cn(inputCls, 'font-mono', name && !normalized && 'ring-2 ring-status-down')}
          />
          {name && !normalized && <p className="mt-1 text-xs text-status-down">{t('domains.form.nameInvalid') || 'Not a valid domain name.'}</p>}
          {normalized && normalized !== name.trim().toLowerCase() && (
            <p className="mt-1 font-mono text-xs text-text-muted">{t('domains.form.normalized', { name: normalized, defaultValue: 'Stored as {{name}}' })}</p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dom-kind">{t('domains.form.kind') || 'Kind'}</label>
            <select id="dom-kind" value={kind} onChange={(e) => setKind(e.target.value as DomainKind)} className={selectCls}>
              {DOMAIN_KINDS.map((k) => <option key={k} value={k}>{domainKindLabel(t, k)}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="dom-tls">{t('domains.form.tls') || 'TLS'}</label>
            <select id="dom-tls" value={tlsMode} onChange={(e) => setTlsMode(e.target.value as TlsMode)} className={selectCls}>
              <option value="letsencrypt">{tlsModeLabel(t, 'letsencrypt')}</option>
              <option value="none">{tlsModeLabel(t, 'none')}</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="dom-dns">{t('dns.createDomain.zone') || 'DNS zone'}</label>
          <select id="dom-dns" value={dnsZone} onChange={(e) => setDnsZone(e.target.value as DnsZoneChoice)} className={selectCls}>
            <option value="auto">{t('dns.createDomain.auto') || 'Automatic (hosted here when the DNS service is on)'}</option>
            <option value="hosted">{t('dns.createDomain.hosted') || 'Hosted here (our name servers)'}</option>
            <option value="external">{t('dns.createDomain.external') || 'Hosted elsewhere (records to create at my provider)'}</option>
            <option value="none">{t('dns.createDomain.none') || 'No zone'}</option>
          </select>
          <p className="mt-1 text-xs text-text-muted">
            {kind === 'subdomain'
              ? (t('dns.createDomain.subdomainHint') || 'A subdomain goes into the zone of its parent domain when the account has it.')
              : (t('dns.createDomain.hint') || 'The zone gets the web records (A / AAAA, www) automatically; it is published once the ownership is verified.')}
          </p>
        </div>
        <div className="space-y-2">
          {kind !== 'subdomain' && (
            <ToggleSwitch checked={includeWww} onChange={setIncludeWww} label={t('domains.form.includeWww') || 'Also serve www.'} description={normalized ? `www.${normalized}` : undefined} />
          )}
          <ToggleSwitch
            checked={tlsMode !== 'none' && forceHttps}
            disabled={tlsMode === 'none'}
            onChange={setForceHttps}
            label={t('domains.forceHttps') || 'Force HTTPS'}
            description={t('domains.form.forceHttpsHint') || 'Redirect HTTP to HTTPS once the certificate is valid.'}
          />
          <ToggleSwitch
            checked={wildcard}
            disabled={wildcardBlocked}
            onChange={setWildcard}
            label={t('dns.wildcard.label') || 'Wildcard (*.domain)'}
            description={wildcardBlocked
              ? (t('dns.wildcard.needsHosted') || 'Needs a DNS zone hosted here (certificate through DNS-01).')
              : normalized ? `*.${normalized}` : (t('dns.wildcard.hint') || 'Also serve every subdomain (certificate through DNS-01).')}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="dom-site">{t('domains.form.site') || 'Route "/" to a site (optional)'}</label>
          <select id="dom-site" value={siteId} disabled={accountId === ''} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
            <option value="">{t('domains.form.noSite') || 'No route for now'}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
          </select>
        </div>
        <p className="text-xs text-text-muted">
          {t('domainOwnership.createHint') || 'After creation, prove that you own the domain (TXT record or our name servers): until then visitors see a placeholder page and no certificate is issued.'}
        </p>
        {claimable && (
          <div className="space-y-1 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs">
            <p className="font-medium text-amber-400">{t('domainOwnership.claims.takenTitle', { name: claimable, defaultValue: '{{name}} is used by another account' })}</p>
            <p className="text-text-secondary">{t('domainOwnership.claims.takenText') || 'If the domain is yours, claim it: you prove the ownership with a TXT record, then the domain is moved to this account.'}</p>
          </div>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * « Add a domain » text button that opens DomainCreateModal in place, with the
 * account preset (instead of a bare link to /domains that leaves the form).
 * Renders nothing when the caller may not add domains to this account.
 */
export function AddDomainInline({ accountId, onCreated, label, className }: {
  accountId: number;
  onCreated: (d: Domain) => void;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [open, setOpen] = useState(false);
  if (!can('domains.manage', accountId)) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn('text-accent hover:underline', className)}>
        {label ?? (t('domains.create') || 'Add a domain')}
      </button>
      <DomainCreateModal
        open={open}
        accountId={accountId}
        onClose={() => setOpen(false)}
        onCreated={(d) => {
          setOpen(false);
          toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
          onCreated(d);
        }}
      />
    </>
  );
}
