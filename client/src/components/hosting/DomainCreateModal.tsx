import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { BadgeCheck, Clock, CornerDownRight, Flag, Globe, Info, Network } from 'lucide-react';
import type { DnsZoneKind, Domain, DomainClaim, DomainKind, HostingAccount, Site, TlsMode } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { domainOwnershipApi, domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ClaimInstructions } from '@/components/dns/DomainClaims';
import { apiErrorDetails, ownershipErrorMessage } from '@/components/dns/dnsErrors';
import { cn } from '@/utils/cn';
import { apiErrorCode, inputCls, isStepUpHandled, labelCls, selectCls } from './hostingUi';
import { normalizeDomainName } from './hostingFormat';
import {
  cleanDomainInput, composeSubdomain, domainTreeKey, findParentDomain, ownLabel, subdomainLabel, subdomainLabelIssue, type SubdomainLabelIssue,
} from './domainParent';

export const DOMAIN_KINDS: DomainKind[] = ['primary', 'addon', 'alias', 'subdomain'];
/** Kinds of the « Domain » mode (a subdomain is the other mode). */
const OWN_DOMAIN_KINDS: DomainKind[] = ['primary', 'addon', 'alias'];

export function domainKindLabel(t: TFunction, k: DomainKind): string {
  const fallback: Record<DomainKind, string> = { primary: 'Primary', addon: 'Add-on', alias: 'Alias', subdomain: 'Subdomain' };
  return t(`domains.kind.${k}`) || fallback[k];
}

export function tlsModeLabel(t: TFunction, m: TlsMode): string {
  return m === 'letsencrypt' ? (t('domains.tls.letsencrypt') || "Let's Encrypt") : (t('domains.tls.none') || 'None (HTTP only)');
}

/** DNS zone choice of the create form ('auto' = the server default policy). */
type DnsZoneChoice = 'auto' | DnsZoneKind | 'none';

/** « Domain » (its own name, own zone) or « Subdomain » (below a domain of the account, in its zone). */
export type DomainCreateMode = 'domain' | 'subdomain';

function labelIssueText(t: TFunction, issue: Exclude<SubdomainLabelIssue, null | 'empty'>): string {
  switch (issue) {
    case 'wildcard': return t('domains.form.sub.issue.wildcard') || 'No * here: use the Wildcard option below.';
    case 'emptyLabel': return t('domains.form.sub.issue.emptyLabel') || 'Empty label (two dots in a row, or a dot at either end).';
    case 'labelTooLong': return t('domains.form.sub.issue.labelTooLong') || 'A label has 63 characters at most.';
    default: return t('domains.form.sub.issue.chars') || 'Letters, digits and dashes only (not at the start or the end of a label), dots between labels.';
  }
}

/**
 * Create a domain (optionally routed at '/' to a site of the account). A name
 * held by another account (409 domainTaken with details.claimable) offers to
 * start a claim (TXT proof) instead.
 *
 * Two modes: « Domain » and « Subdomain » (label + a domain of the account,
 * kind 'subdomain': records in the parent's zone, no zone of its own, www off
 * by default). A name typed in « Domain » mode below a domain of the account
 * switches to « Subdomain » (nearest parent) — « Domain » stays possible for a
 * delegated sub-zone. Ownership: a VERIFIED parent of the same account vouches
 * for the name at creation; a pending one passes it on once verified (server:
 * domains.service verifiedParentOf, ownership propagateInheritance).
 */
export function DomainCreateModal({
  open, onClose, onCreated, onClaimCreated, accountId: fixedAccountId, siteId: fixedSiteId, initialMode, parentDomainId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (d: Domain) => void;
  /** A claim was started from the « name taken » answer. */
  onClaimCreated?: (c: DomainClaim) => void;
  /** Fixed account (account detail page); otherwise an account select is shown. */
  accountId?: number;
  /** Site page: the '/' route goes to this site (select preset and locked). Needs accountId. */
  siteId?: number;
  /** Mode shown first (default « Domain »). */
  initialMode?: DomainCreateMode;
  /** Subdomain mode: parent domain preselected (a domain of `accountId`). */
  parentDomainId?: number;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [sites, setSites] = useState<Site[]>([]);
  /** Domains of the chosen account (parents of a subdomain); null = loading / unreadable. */
  const [accountDomains, setAccountDomains] = useState<Domain[] | null>(null);
  const [mode, setMode] = useState<DomainCreateMode>('domain');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<number | ''>('');
  const [label, setLabel] = useState('');
  /** Parent name when the typed name was switched to « Subdomain » automatically (note shown). */
  const [detectedFrom, setDetectedFrom] = useState<string | null>(null);
  /** Name kept as a domain on purpose (delegated sub-zone): not detected again. */
  const [keptAsDomain, setKeptAsDomain] = useState<string | null>(null);
  /** The label field takes the focus when it appears (not after a detection on blur: the focus went elsewhere). */
  const [labelAutoFocus, setLabelAutoFocus] = useState(true);
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
    const m = initialMode ?? 'domain';
    setMode(m); setName(''); setLabel(''); setParentId(parentDomainId ?? ''); setDetectedFrom(null); setKeptAsDomain(null);
    setKind('primary'); setIncludeWww(m === 'domain'); setTlsMode('letsencrypt'); setForceHttps(true);
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
    setSiteId(fixedSiteId != null && accountId === fixedAccountId ? fixedSiteId : '');
    return () => { cancelled = true; };
  }, [open, accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Domains of the account: parents offered in « Subdomain » mode, detection in « Domain » mode.
  useEffect(() => {
    if (!open || accountId === '') { setAccountDomains(null); return; }
    let cancelled = false;
    setAccountDomains(null);
    domainsApi.list({ accountId })
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => domainTreeKey(a.name).localeCompare(domainTreeKey(b.name)));
        setAccountDomains(sorted);
        // Parent preselected by the caller (same account only), else the first one.
        setParentId((cur) => (cur !== '' && sorted.some((d) => d.id === cur) ? cur : (sorted[0]?.id ?? '')));
      })
      .catch(() => { if (!cancelled) setAccountDomains([]); });
    return () => { cancelled = true; };
  }, [open, accountId]);

  const domains = useMemo(() => accountDomains ?? [], [accountDomains]);
  const parent = mode === 'subdomain' ? (domains.find((d) => d.id === parentId) ?? null) : null;
  const normalized = normalizeDomainName(name);
  const labelIssue = mode === 'subdomain' && parent ? subdomainLabelIssue(ownLabel(label, parent.name)) : null;
  const fullName = mode === 'domain' ? normalized : (parent ? composeSubdomain(label, parent.name) : null);
  // Subdomain mode before the label is typed: what applies to any name below the chosen parent.
  const probeName = fullName ?? (parent ? `x.${parent.name}` : null);
  /**
   * Nearest domain of the account above the name (any mode): the server puts
   * a subdomain's records in its zone and inherits its ownership — it may be
   * deeper than the chosen parent (« eu.shop » under example.com → shop.example.com).
   */
  const ancestor = probeName ? findParentDomain(probeName, domains) : null;
  /** The server inherits from the nearest VERIFIED one (never across accounts). */
  const verifiedAncestor = probeName ? findParentDomain(probeName, domains.filter((d) => d.verification?.status === 'verified')) : null;
  const alreadyThere = !!fullName && domains.some((d) => d.name === fullName);
  /** Subdomain whose parent has a zone: the records go there, no zone choice. */
  const parentZone = mode === 'subdomain' ? ((ancestor ?? parent)?.zone ?? null) : null;
  const zoneChoice: DnsZoneChoice = parentZone ? 'auto' : dnsZone;
  // A wildcard certificate goes through DNS-01: it needs a zone hosted here
  // (server assertWildcardAllowed: explicit hosted zone, else the zone of the account above the name, else the choice).
  const ancestorZone = ancestor?.zone ?? null;
  const wildcardBlocked = zoneChoice === 'hosted' ? false : ancestorZone ? ancestorZone.kind !== 'hosted' : (zoneChoice === 'external' || zoneChoice === 'none');
  const canSubmit = fullName !== null && accountId !== '' && !saving && !alreadyThere;

  // Another name or account: the « taken » answer no longer applies.
  useEffect(() => { setClaimable(null); }, [fullName, accountId]);
  useEffect(() => { if (wildcardBlocked) setWildcard(false); }, [wildcardBlocked]);

  /** « Domain » mode: a name below a domain of the account becomes a subdomain of it (nearest). */
  const detect = (focus: boolean) => {
    if (mode !== 'domain') return;
    const n = normalizeDomainName(name);
    if (!n || n === keptAsDomain) return;
    const p = findParentDomain(n, domains);
    if (!p) return;
    setMode('subdomain');
    setParentId(p.id);
    setLabel(subdomainLabel(n, p.name) ?? '');
    setDetectedFrom(p.name);
    setIncludeWww(false);
    setLabelAutoFocus(focus);
  };
  // Detected once the typing pauses, not while « lucy.example.c… » is being typed. The label
  // field takes the focus only if the name field still had it (Tab to another field: left there).
  useEffect(() => {
    if (mode !== 'domain' || !normalized || !domains.length) return;
    const timer = setTimeout(() => detect(document.activeElement?.id === 'dom-name'), 600);
    return () => clearTimeout(timer);
  }, [normalized, domains, mode, keptAsDomain]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeMode = (m: DomainCreateMode) => {
    if (m === mode) return;
    setDetectedFrom(null);
    setLabelAutoFocus(true);
    if (m === 'subdomain') {
      const p = normalized ? findParentDomain(normalized, domains) : null;
      if (p) {
        setParentId(p.id);
        setLabel(subdomainLabel(normalized!, p.name) ?? '');
      } else {
        // A bare label typed first (« lucy ») is kept; a foreign name is not.
        setLabel(name && !name.includes('.') ? name : '');
        if (parentId === '' && domains[0]) setParentId(domains[0].id);
      }
      setIncludeWww(false);
    } else {
      // Back to « Domain » with the full name: kept as a domain (delegated sub-zone), not detected again.
      const full = parent ? composeSubdomain(label, parent.name) : null;
      if (full) { setName(full); setKeptAsDomain(full); } else if (parent && label) setName(`${cleanDomainInput(label)}.${parent.name}`);
      if (kind === 'subdomain') setKind('primary');
      setIncludeWww(true);
    }
    setMode(m);
  };

  const submit = async () => {
    if (!canSubmit || typeof accountId !== 'number' || !fullName) return;
    // « Create » clicked before the detection ran: show the subdomain form first, never create it unseen.
    if (mode === 'domain' && fullName !== keptAsDomain && findParentDomain(fullName, domains)) { detect(true); return; }
    setSaving(true);
    setError(null);
    try {
      onCreated(await domainsApi.create({
        accountId,
        name: fullName,
        kind: mode === 'subdomain' ? 'subdomain' : kind,
        includeWww,
        tlsMode,
        forceHttps: tlsMode === 'none' ? false : forceHttps,
        siteId: siteId === '' ? null : siteId,
        wildcard: wildcardBlocked ? false : wildcard,
        // A subdomain with a parent zone goes into it (server default): no choice sent.
        ...(zoneChoice === 'auto' ? {} : { dnsZone: zoneChoice }),
      }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      if (apiErrorCode(err) === 'domainTaken' && apiErrorDetails(err)?.claimable === true) {
        setClaimable(fullName);
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

  const verifiedText = t('domainOwnership.badge.verified') || 'Verified';
  const pendingText = t('domainOwnership.badge.pending') || 'To verify';

  const zoneSelect = (
    <div>
      <label className={labelCls} htmlFor="dom-dns">{t('dns.createDomain.zone') || 'DNS zone'}</label>
      <select id="dom-dns" value={dnsZone} onChange={(e) => setDnsZone(e.target.value as DnsZoneChoice)} className={selectCls}>
        <option value="auto">{t('dns.createDomain.auto') || 'Automatic (hosted here when the DNS service is on)'}</option>
        <option value="hosted">{t('dns.createDomain.hosted') || 'Hosted here (our name servers)'}</option>
        <option value="external">{t('dns.createDomain.external') || 'Hosted elsewhere (records to create at my provider)'}</option>
        <option value="none">{t('dns.createDomain.none') || 'No zone'}</option>
      </select>
      <p className="mt-1 text-xs text-text-muted">
        {mode === 'subdomain'
          ? (t('domains.form.sub.noParentZone', { parent: (ancestor ?? parent)?.name ?? '', defaultValue: '{{parent}} has no DNS zone here: the subdomain gets its own zone, unless you choose "No zone".' }))
          : (t('dns.createDomain.hint') || 'The zone gets the web records (A / AAAA, www) automatically; it is published once the ownership is verified.')}
      </p>
    </div>
  );

  // Ownership: inherited from a verified domain of the account above the name, else proven (TXT / NS).
  const ownershipHint = verifiedAncestor ? (
    <p className="flex items-start gap-1.5 text-xs text-text-muted">
      <BadgeCheck size={13} className="mt-px shrink-0 text-status-up" />
      <span>{t('domains.form.sub.inherits', { parent: verifiedAncestor.name, defaultValue: '{{parent}} is verified: the ownership is inherited, no TXT / NS record to create.' })}</span>
    </p>
  ) : ancestor ? (
    <p className="flex items-start gap-1.5 text-xs text-text-muted">
      <Clock size={13} className="mt-px shrink-0 text-amber-400" />
      <span>{t('domains.form.sub.inheritsLater', { parent: ancestor.name, defaultValue: '{{parent}} is not verified yet: this name will be verified with it (until then visitors see a placeholder page and no certificate is issued).' })}</span>
    </p>
  ) : (
    <p className="text-xs text-text-muted">
      {t('domainOwnership.createHint') || 'After creation, prove that you own the domain (TXT record or our name servers): until then visitors see a placeholder page and no certificate is issued.'}
    </p>
  );

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

        <SegmentedTabs<DomainCreateMode>
          size="sm"
          value={mode}
          onChange={changeMode}
          ariaLabel={t('domains.form.createTitle') || 'Add a domain'}
          tabs={[
            { id: 'domain', label: t('domains.form.mode.domain') || 'Domain', icon: <Globe size={13} /> },
            { id: 'subdomain', label: t('domains.form.mode.subdomain') || 'Subdomain', icon: <CornerDownRight size={13} /> },
          ]}
        />

        {mode === 'domain' ? (
          <div>
            <label className={labelCls} htmlFor="dom-name">{t('domains.form.name') || 'Domain name'}</label>
            <input
              id="dom-name"
              value={name}
              autoFocus
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              onChange={(e) => setName(cleanDomainInput(e.target.value))}
              placeholder="example.com"
              className={cn(inputCls, 'font-mono', name && !normalized && 'ring-2 ring-status-down')}
            />
            {name && !normalized && <p className="mt-1 text-xs text-status-down">{t('domains.form.nameInvalid') || 'Not a valid domain name.'}</p>}
            {alreadyThere && <p className="mt-1 text-xs text-status-down">{t('domains.form.sub.exists', { name: fullName, defaultValue: '{{name}} is already a domain of this account.' })}</p>}
            {normalized && normalized !== name.replace(/\.$/, '') && (
              <p className="mt-1 font-mono text-xs text-text-muted">{t('domains.form.normalized', { name: normalized, defaultValue: 'Stored as {{name}}' })}</p>
            )}
            {normalized && ancestor && normalized === keptAsDomain && (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-text-muted">
                <Info size={13} className="mt-px shrink-0 text-accent" />
                <span>
                  {t('domains.form.sub.keptAsDomain', { parent: ancestor.name, defaultValue: 'Below {{parent}}, a domain of this account: created as a separate domain, it gets its own DNS zone (delegated sub-zone).' })}{' '}
                  <button type="button" onClick={() => { setKeptAsDomain(null); changeMode('subdomain'); }} className="text-accent hover:underline">
                    {t('domains.form.sub.useSubdomain') || 'Make it a subdomain'}
                  </button>
                </span>
              </p>
            )}
          </div>
        ) : accountId === '' ? (
          <p className="rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-muted">{t('domains.form.sub.chooseAccountFirst') || 'Choose the account first: a subdomain goes below one of its domains.'}</p>
        ) : accountDomains !== null && domains.length === 0 ? (
          <p className="rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-muted">
            {t('domains.form.sub.noParent') || 'This account has no domain yet: add the parent domain first ("Domain"), then its subdomains.'}
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={labelCls} htmlFor="dom-parent">{t('domains.form.sub.parent') || 'Parent domain'}</label>
              <select id="dom-parent" value={parentId} onChange={(e) => { setParentId(e.target.value ? Number(e.target.value) : ''); setDetectedFrom(null); }} className={cn(selectCls, 'font-mono')}>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} — {d.verification?.status === 'verified' ? verifiedText : pendingText}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="dom-label">{t('domains.form.sub.label') || 'Subdomain'}</label>
              <div className={cn(
                'flex items-center overflow-hidden rounded-md bg-bg-tertiary focus-within:ring-2 focus-within:ring-accent',
                label && labelIssue && labelIssue !== 'empty' && 'ring-2 ring-status-down',
              )}>
                <input
                  id="dom-label"
                  value={label}
                  autoFocus={labelAutoFocus}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                  onChange={(e) => { setLabel(cleanDomainInput(e.target.value)); setDetectedFrom(null); }}
                  placeholder={t('domains.form.sub.labelPlaceholder') || 'blog'}
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 text-right font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none coarse:min-h-10"
                />
                <span className="max-w-[60%] shrink-0 truncate py-2 pr-3 font-mono text-sm text-text-muted" title={parent ? `.${parent.name}` : undefined}>
                  .{parent?.name ?? '…'}
                </span>
              </div>
              {label && labelIssue && labelIssue !== 'empty' ? (
                <p className="mt-1 text-xs text-status-down">{labelIssueText(t, labelIssue)}</p>
              ) : alreadyThere ? (
                <p className="mt-1 text-xs text-status-down">{t('domains.form.sub.exists', { name: fullName, defaultValue: '{{name}} is already a domain of this account.' })}</p>
              ) : fullName ? (
                <p className="mt-1 break-all font-mono text-xs text-text-secondary">
                  {t('domains.form.sub.preview', { name: fullName, defaultValue: 'Full name: {{name}}' })}
                </p>
              ) : label && parent ? (
                <p className="mt-1 text-xs text-status-down">{t('domains.form.nameInvalid') || 'Not a valid domain name.'}</p>
              ) : null}
              {detectedFrom && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-text-muted">
                  <Info size={13} className="mt-px shrink-0 text-accent" />
                  <span>
                    {t('domains.form.sub.detected', { parent: detectedFrom, defaultValue: 'Detected as a subdomain of {{parent}}.' })}{' '}
                    <button type="button" onClick={() => changeMode('domain')} className="text-accent hover:underline">
                      {t('domains.form.sub.keepDomain') || 'Create it as a separate domain instead (delegated sub-zone)'}
                    </button>
                  </span>
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dom-kind">{t('domains.form.kind') || 'Kind'}</label>
            {mode === 'subdomain' ? (
              <select id="dom-kind" value="subdomain" disabled className={selectCls}>
                <option value="subdomain">{domainKindLabel(t, 'subdomain')}</option>
              </select>
            ) : (
              <select id="dom-kind" value={kind} onChange={(e) => setKind(e.target.value as DomainKind)} className={selectCls}>
                {OWN_DOMAIN_KINDS.map((k) => <option key={k} value={k}>{domainKindLabel(t, k)}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="dom-tls">{t('domains.form.tls') || 'TLS'}</label>
            <select id="dom-tls" value={tlsMode} onChange={(e) => setTlsMode(e.target.value as TlsMode)} className={selectCls}>
              <option value="letsencrypt">{tlsModeLabel(t, 'letsencrypt')}</option>
              <option value="none">{tlsModeLabel(t, 'none')}</option>
            </select>
          </div>
        </div>

        {parentZone ? (
          <div>
            <span className={labelCls}>{t('dns.createDomain.zone') || 'DNS zone'}</span>
            <p className="flex items-start gap-1.5 rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
              <Network size={13} className="mt-px shrink-0 text-accent" />
              <span>
                {parentZone.kind === 'hosted'
                  ? t('domains.form.sub.zoneHosted', { zone: parentZone.name, defaultValue: 'No separate zone: the records are added to the zone {{zone}}.' })
                  : t('domains.form.sub.zoneExternal', {
                    zone: parentZone.name, name: fullName ?? `….${parentZone.name}`,
                    defaultValue: 'The zone {{zone}} is hosted at another provider: create there the A / AAAA records of {{name}} (they are listed in the zone {{zone}} after the creation).',
                  })}
              </span>
            </p>
          </div>
        ) : (mode === 'domain' || parent) && zoneSelect}

        <div className="space-y-2">
          <ToggleSwitch
            checked={includeWww}
            onChange={setIncludeWww}
            label={t('domains.form.includeWww') || 'Also serve www.'}
            description={fullName ? `www.${fullName}` : undefined}
          />
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
              : fullName ? `*.${fullName}` : (t('dns.wildcard.hint') || 'Also serve every subdomain (certificate through DNS-01).')}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="dom-site">{t('domains.form.site') || 'Route "/" to a site (optional)'}</label>
          <select id="dom-site" value={siteId} disabled={accountId === '' || fixedSiteId != null} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
            <option value="">{t('domains.form.noSite') || 'No route for now'}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
          </select>
          {fixedSiteId != null && (
            <p className="mt-1 text-xs text-text-muted">{t('domains.form.siteFixedHint') || 'The domain is routed to this site at "/". Other paths can be added afterwards in the Domains tab of the site.'}</p>
          )}
        </div>
        {ownershipHint}
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
