// Registrable domain (eTLD+1) of a host name — heuristic, no public suffix list.
//
// Used by the R-SAMESITE checks (docs/P2-PLAN.md P1'): the preview domain and
// the DB admin host serve tenant code / tenant-reachable tools, so they must
// NOT be same-site with the panel (a sibling such as preview.example.com next
// to panel.example.com can set Domain=example.com cookies, and SameSite does
// not separate them). Two hosts are same-site when their registrable domains
// are equal.
//
// The heuristic knows the usual two-label public suffixes (co.uk, com.au,
// gouv.fr…): a two-letter country TLD whose second label is a generic
// second-level name, plus an explicit list. An unknown multi-label suffix
// makes it OVER-estimate sameness (both hosts reduce to the suffix itself),
// which errs on the refusing side. Kept free of '@/' imports so it can be
// unit-tested (and ported to the server) as is.

/** Generic second-level labels used as public suffixes under country TLDs (co.uk, com.br, ac.jp…). */
const GENERIC_SLDS = new Set([
  'ac', 'ad', 'asso', 'co', 'com', 'ed', 'edu', 'go', 'gob', 'gouv', 'gov', 'govt', 'gr', 'id', 'in', 'info', 'lg',
  'ltd', 'me', 'mil', 'ne', 'net', 'nhs', 'nic', 'nom', 'or', 'org', 'plc', 'police', 'sch',
]);

/** Other multi-label public suffixes (non country TLD or uncommon second level). */
const EXTRA_SUFFIXES = new Set([
  'tm.fr', 'presse.fr', 'avocat.fr', 'notaires.fr', 'cci.fr', 'k12.us',
  'eu.com', 'uk.com', 'us.com', 'de.com', 'gb.net', 'uk.net', 'za.com',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'firebaseapp.com', 'web.app',
]);

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Number of labels of the public suffix of `labels` (1, 2 or 3). */
function suffixLength(labels: string[]): number {
  const n = labels.length;
  if (n >= 3) {
    const last3 = labels.slice(-3).join('.');
    if (EXTRA_SUFFIXES.has(last3)) return 3;
  }
  if (n >= 2) {
    const tld = labels[n - 1];
    const sld = labels[n - 2];
    if (EXTRA_SUFFIXES.has(`${sld}.${tld}`)) return 2;
    if (/^[a-z]{2}$/.test(tld) && GENERIC_SLDS.has(sld)) return 2;
  }
  return 1;
}

/**
 * Registrable domain of `host` (public suffix + one label), e.g.
 * panel.example.com → example.com, a.b.example.co.uk → example.co.uk.
 * A host that is itself a public suffix (or shorter) is returned as is.
 */
export function registrableDomain(host: string): string {
  const h = normalize(host);
  if (!h) return '';
  const labels = h.split('.');
  const take = suffixLength(labels) + 1;
  return labels.length <= take ? h : labels.slice(-take).join('.');
}

/** True when both hosts share the same registrable domain (same-site for cookies / SameSite). */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const ra = registrableDomain(a);
  return !!ra && ra === registrableDomain(b);
}
