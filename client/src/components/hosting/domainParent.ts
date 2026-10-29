// Subdomain helpers of the « Add a domain » form (pure, no React / i18n:
// unit-tested with node:test). A name below a domain the account already has
// is a subdomain of it: same rule as the server (domains.service
// verifiedParentOf / dns parentZoneOf: the NEAREST domain above the name).

import { normalizeDomainName } from './hostingFormat';

/** What the user types in a domain / label field: lower case, no blanks (`LUCY ` → `lucy`). */
export function cleanDomainInput(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '');
}

/**
 * The nearest domain of `domains` strictly above `name` (longest match), or
 * null. `name` is normalised first (case, trailing dot, IDN → punycode);
 * the domain names are the stored ones (already normalised).
 */
export function findParentDomain<T extends { name: string }>(name: string, domains: readonly T[]): T | null {
  const n = normalizeDomainName(name);
  if (!n) return null;
  let best: T | null = null;
  for (const d of domains) {
    const p = d.name.toLowerCase();
    if (n.length > p.length && n.endsWith(`.${p}`) && (!best || p.length > best.name.length)) best = d;
  }
  return best;
}

/** Label part of `name` below `parent` (`lucy.example.com`, `example.com` → `lucy`), null when not below it. */
export function subdomainLabel(name: string, parent: string): string | null {
  const n = normalizeDomainName(name);
  if (!n) return null;
  const suffix = `.${parent.toLowerCase()}`;
  return n.length > suffix.length && n.endsWith(suffix) ? n.slice(0, -suffix.length) : null;
}

export type SubdomainLabelIssue = 'empty' | 'emptyLabel' | 'wildcard' | 'chars' | 'labelTooLong' | null;

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why the label part typed for a subdomain is invalid (null = valid). One or
 * more dot-separated labels (`a.b`), each 1-63 characters of letters, digits
 * and dashes (not at either end); an IDN label is accepted (it becomes punycode).
 */
export function subdomainLabelIssue(label: string): SubdomainLabelIssue {
  if (!label) return 'empty';
  if (label.includes('*')) return 'wildcard';
  const parts = label.split('.');
  if (parts.some((p) => p === '')) return 'emptyLabel';
  for (const p of parts) {
    // Non-ASCII (IDN): its punycode form is checked by composeSubdomain.
    if (/[^\x00-\x7f]/.test(p)) continue;
    if (p.length > 63) return 'labelTooLong';
    if (!LABEL_RE.test(p)) return 'chars';
  }
  return null;
}

/**
 * The label part typed for a subdomain of `parent`, cleaned: lower case, no
 * blanks, no trailing dot, and without the parent suffix when the full name
 * was pasted (`Lucy.Example.com` → `lucy`).
 */
export function ownLabel(label: string, parent: string): string {
  const clean = cleanDomainInput(label).replace(/\.$/, '');
  const suffix = `.${parent.toLowerCase()}`;
  return clean.length > suffix.length && clean.endsWith(suffix) ? clean.slice(0, -suffix.length) : clean;
}

/**
 * Full stored name of the subdomain `label`.`parent` (punycode), or null when
 * the label is invalid or the result is not a valid name (length…). A label
 * typed with the parent suffix (`lucy.example.com`) is accepted as is.
 */
export function composeSubdomain(label: string, parent: string): string | null {
  const p = parent.toLowerCase();
  const own = ownLabel(label, p);
  if (subdomainLabelIssue(own) !== null) return null;
  const full = normalizeDomainName(`${own}.${p}`);
  return full && subdomainLabel(full, p) !== null ? full : null;
}

/** Sort key keeping subdomains right below their parent (`example.com`, `a.example.com`, `example.org`). */
export function domainTreeKey(name: string): string {
  return name.split('.').reverse().join('.');
}
