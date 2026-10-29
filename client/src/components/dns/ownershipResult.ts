import type { TFunction } from 'i18next';
import type { DomainOwnershipCheckResult, DomainOwnershipNsStatus, DomainOwnershipNsView } from '@oblimint/shared';
import type { Tone } from '@/components/common/Pill';

// Ownership check result → one sentence describing EVERY method tried
// (TXT and name servers), the method of the active tab first. Used by the
// ownership card (result line, toast) for manual and automatic checks alike.

type NsResult = NonNullable<DomainOwnershipCheckResult['ns']>;

const list = (t: TFunction, hosts: string[]) => (hosts.length ? hosts.join(', ') : (t('domainOwnership.result.noneFound') || 'none'));

/** The delegation view that tells the most: the registry's (changes first) when it answered, else the public resolvers'. */
export function primaryNsView(ns: NsResult): (DomainOwnershipNsView & { source: 'registry' | 'public'; zone?: string }) {
  if (ns.registry && !ns.registry.failed) return { ...ns.registry, source: 'registry' };
  return { ...ns.public, source: 'public' };
}

function txtClause(t: TFunction, r: DomainOwnershipCheckResult): string {
  switch (r.txt.outcome) {
    case 'mismatch':
      return t('domainOwnership.result.txt.mismatch', { found: r.txt.found.join(', '), defaultValue: 'the TXT record has another value ({{found}})' });
    case 'resolverFailed':
      return t('domainOwnership.result.txt.resolverFailed') || 'the TXT record could not be queried';
    case 'found':
      return t('domainOwnership.result.txt.found') || 'the TXT record is published';
    default:
      return t('domainOwnership.result.txt.missing') || 'no TXT record found';
  }
}

function nsClause(t: TFunction, ns: NsResult): string {
  const view = primaryNsView(ns);
  const expected = list(t, ns.expected);
  let clause: string;
  if (view.failed) {
    clause = t('domainOwnership.result.ns.failed') || 'the name servers could not be queried';
  } else if (view.status === 'elsewhere') {
    clause = t('domainOwnership.result.ns.elsewhere', { found: list(t, view.found), expected, defaultValue: 'the domain is still delegated to {{found}} (expected: {{expected}})' });
  } else if (view.status === 'mixed') {
    clause = t('domainOwnership.result.ns.mixed', { found: list(t, view.found), expected, defaultValue: 'the domain is only partly delegated to our name servers: {{found}} (expected: {{expected}} only)' });
  } else if (view.status === 'ours') {
    clause = t('domainOwnership.result.ns.ours') || 'the domain is delegated to our name servers';
  } else {
    clause = t('domainOwnership.result.ns.none', { expected, defaultValue: 'no name server is published for the domain (expected: {{expected}})' });
  }
  // The resolvers lag behind the registry (caches): say what they still show.
  if (view.source === 'registry' && !ns.public.failed && list(t, ns.public.found) !== list(t, view.found)) {
    clause += ` ${t('domainOwnership.result.ns.publicView', { found: list(t, ns.public.found), defaultValue: '(public resolvers: {{found}})' })}`;
  }
  return clause;
}

/** Was the NS method tried without success while the delegation answered (the registrar delay hint applies)? */
export function nsPendingSwitch(r: DomainOwnershipCheckResult): boolean {
  if (!r.ns || r.ns.matches) return false;
  const view = primaryNsView(r.ns);
  return !view.failed;
}

/**
 * « Not proven yet: no TXT record found, and the domain is still delegated
 * to … (expected: …). A change of name servers can take … » — `focus` puts
 * the method of the active tab first. Never only the TXT outcome when the NS
 * method was tried.
 */
export function ownershipResultMessage(t: TFunction, r: DomainOwnershipCheckResult, focus: 'txt' | 'ns' = 'txt'): string {
  if (r.summary === 'proven') return t('domainOwnership.verifiedToast') || 'Domain verified';
  if (r.summary === 'resolverFailed') {
    return t('domainOwnership.errors.resolverFailed') || 'The public resolvers could not be queried. Retry in a moment.';
  }
  const clauses = [txtClause(t, r)];
  if (r.ns) {
    const ns = nsClause(t, r.ns);
    if (focus === 'ns') clauses.unshift(ns); else clauses.push(ns);
  }
  const details = clauses.join(t('domainOwnership.result.and') || ', and ');
  let msg = t('domainOwnership.result.notProven', { details, defaultValue: 'Not proven yet: {{details}}.' });
  if (nsPendingSwitch(r)) {
    msg += ` ${t('domainOwnership.result.delayHint') || 'A change of name servers can take from a few minutes to a few hours at the registrar.'}`;
  }
  return msg;
}

/** Badge of a delegation view: ours / elsewhere / mixed / none / not queried. */
export function nsStatusBadge(t: TFunction, v: DomainOwnershipNsView): { tone: Tone; label: string } {
  if (v.failed) return { tone: 'muted', label: t('domainOwnership.result.badge.failed') || 'not queried' };
  const fb: Record<DomainOwnershipNsStatus, string> = { ours: 'ours', elsewhere: 'elsewhere', mixed: 'mixed', none: 'none' };
  const tone: Record<DomainOwnershipNsStatus, Tone> = { ours: 'green', elsewhere: 'amber', mixed: 'red', none: 'muted' };
  return { tone: tone[v.status], label: t(`domainOwnership.result.badge.${v.status}`) || fb[v.status] };
}

export { list as nsHostList };
