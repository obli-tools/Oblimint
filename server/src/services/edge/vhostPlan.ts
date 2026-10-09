import type { DomainVerificationStatus, HostingAccount, PhpSettings } from '@oblimint/shared';
import { isPlatformReservedDomain, platformHostList, type PlatformHostNames } from '../hosting/hostingValidation.service';
import { ADMINER_CONTAINER, PHPMYADMIN_CONTAINER, previewHost, siteUpstream } from '../hosting/naming';
import { edgeCertPaths, isValidServerName, selfSignedCertPaths, type EdgeLocation, type EdgeVhost } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// PURE mapping "database rows + platform settings → desired edge vhosts"
// (edge.service reads the rows, this file decides). OWNED BY MODULE
// `edge-ownership` (P2). One vhost per:
//   panel         the panel itself on panel_hostname (when set);
//   dbadmin       settings dbAdmin.hostname → /phpmyadmin/ and /adminer/;
//   probe-v4/v6   settings access.probeHostV4 / V6 → only `= /api/ip-probe`;
//   p-<siteId>    blue/green preview of a site (preview_base set), served on
//                 previewHost(site, settings preview.previewDomain) — none
//                 when no preview domain is configured (audit R-SAMESITE:
//                 never under the panel host any more);
//   d-<domainId>  domain of an account in active|suspended|provisioning|error
//                 (accounts being deleted are skipped): locations = site_routes
//                 when the domain is VERIFIED, else a placeholder page
//                 (invariant D1: no route, no certificate, no redirect);
//                 a wildcard domain also answers *.<name>.
// TLS is enabled only when the certificate row is 'valid' AND both files exist
// in edge/certs/<primary_name>/ (a missing file would make `nginx -t` fail).
// Platform vhosts (panel, dbadmin, probes) without such a certificate (private
// / reserved name, issuance pending or failed) fall back to the self-signed
// certificate in edge/certs/_selfsigned/ when it covers the name
// (selfSignedFallback.ts): the panel / SSO cookies are Secure and every
// platform URL is https://, so HTTP only would leave them unusable.
// A server name already claimed by an earlier vhost is dropped from the later
// one (nginx would only warn and serve the first anyway).
//
// client_max_body_size: DEFAULT_CLIENT_MAX_BODY_MB, raised to the largest PHP
// post_max_size / upload_max_filesize of the routed sites — PHP itself stays
// the real limit, the edge must just never be stricter than the site.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CLIENT_MAX_BODY_MB = 512;
export const PANEL_CLIENT_MAX_BODY_MB = 100;
/** phpMyAdmin / Adminer imports (SQL files) go through the edge. */
export const DBADMIN_CLIENT_MAX_BODY_MB = 512;
/** Port of the DB admin containers (images/dbadmin). */
export const DBADMIN_PORT = 8080;
/** Path of the IP probe on the panel (routes/ipProbe.routes.ts, mounted on /api). */
export const IP_PROBE_PATH = '/api/ip-probe';
export const PREVIEW_HEADERS: Record<string, string> = { 'X-Robots-Tag': 'noindex, nofollow' };
export const DBADMIN_HEADERS: Record<string, string> = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

/** Account statuses whose domains are served (deleting → never). */
export const SERVED_ACCOUNT_STATUSES: ReadonlyArray<HostingAccount['status']> = ['active', 'suspended', 'provisioning', 'error'];

export interface PlanDomain {
  id: number;
  account_id: number;
  tenant_id: number;
  name: string;
  include_www: boolean;
  tls_mode: 'letsencrypt' | 'none';
  force_https: boolean;
  /** P2: also serve *.<name>. */
  wildcard: boolean;
  /** P2: anything but 'verified' is served as a placeholder (D1). */
  verification_status: DomainVerificationStatus;
  account_status: HostingAccount['status'];
}

export interface PlanRoute {
  domain_id: number;
  path_prefix: string;
  site_id: number;
  runtime_id: number | null;
}

export interface PlanSite {
  id: number;
  account_id: number;
  tenant_id: number;
  slug: string;
  preview_base: string | null;
  php_settings: PhpSettings | null;
  account_status: HostingAccount['status'];
}

export interface PlanCertificate {
  domain_id: number | null;
  site_id: number | null;
  primary_name: string;
  status: 'pending' | 'valid' | 'failed' | 'expired';
  /** Names the certificate covers (jsonb, may arrive as a string). */
  names?: string[] | string | null;
}

/** Platform host names of the edge (app_config panel_hostname + platform settings). */
export interface PlatformHosts {
  panel: string | null;
  /** settings preview.previewDomain */
  previewDomain: string | null;
  /** settings dbAdmin.hostname */
  dbAdmin: string | null;
  /** settings access.probeHostV4 / probeHostV6 */
  probeV4: string | null;
  probeV6: string | null;
  /**
   * P4: other platform host names (settings mail.hostname, mail.webmailHostname):
   * reserved for the platform (never a tenant domain), platform certificates;
   * their vhosts come from the edge contributors (edge/contributors.ts).
   */
  extra?: string[];
}

/** PlatformHosts → the shape of the hosting validation rules. */
export function platformHostNames(p: Partial<PlatformHosts> | string | null | undefined): PlatformHostNames {
  if (typeof p !== 'object' || p === null) return { panelHostname: p ?? null };
  return {
    panelHostname: p.panel ?? null,
    previewDomain: p.previewDomain ?? null,
    dbAdminHostname: p.dbAdmin ?? null,
    probeHosts: [p.probeV4 ?? null, p.probeV6 ?? null],
    extraHosts: p.extra ?? [],
  };
}

/**
 * A name the platform serves itself: the panel, the P1 preview zone
 * (.preview.<panel>), the preview domain and everything under it, the DB
 * admin host, the probe hosts — never a tenant domain (the edge serves the
 * platform vhost, the certificate service never issues it for a tenant).
 * A plain string = the panel host name only. Names under the panel host stay
 * possible for a platform admin (www.<panel>), as in P1.
 */
export function isReservedPlatformName(name: string, platform: Partial<PlatformHosts> | string | null | undefined): boolean {
  return isPlatformReservedDomain(name.trim().toLowerCase(), platformHostNames(platform), { platformAdmin: true });
}

function certNames(c: PlanCertificate): string[] | null {
  let v: unknown = c.names;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : null;
}

/** Does a certificate covering `covered` serve `name` (exact, or one-label wildcard)? `*.x` needs `*.x` itself. */
export function certCovers(covered: readonly string[], name: string): boolean {
  if (covered.includes(name)) return true;
  if (name.startsWith('*.')) return false;
  const dot = name.indexOf('.');
  return dot > 0 && covered.includes(`*.${name.slice(dot + 1)}`);
}

/** Names a domain vhost answers for: name, www.name (includeWww), *.name (wildcard, verified only). */
export function domainServerNames(d: Pick<PlanDomain, 'name' | 'include_www' | 'wildcard'>, opts: { wildcard: boolean }): string[] {
  const name = d.name.toLowerCase();
  const names = d.include_www ? [name, `www.${name}`] : [name];
  if (d.wildcard && opts.wildcard) names.push(`*.${name}`);
  return names;
}

export interface EdgePlanInput {
  domains: PlanDomain[];
  routes: PlanRoute[];
  /** Sites of the served accounts (routed ones + previews). */
  sites: PlanSite[];
  certificates: PlanCertificate[];
  /** Platform host names (null fields = no such vhost). */
  platform: PlatformHosts;
  /** e.g. https://oblimint-panel:8443 */
  panelUpstream: string;
  /** Do fullchain.pem AND privkey.pem exist for this primary name (host side)? */
  certFilesExist: (primaryName: string) => boolean;
  /** Platform names the self-signed fallback certificate on disk covers (null / absent = none). */
  selfSignedNames?: readonly string[] | null;
}

function served(status: HostingAccount['status']): boolean {
  return SERVED_ACCOUNT_STATUSES.includes(status);
}

function phpBodyMb(s: PhpSettings | null | undefined): number {
  if (!s) return 0;
  return Math.max(Number(s.postMaxSizeMb) || 0, Number(s.uploadMaxFilesizeMb) || 0);
}

/** Effective client_max_body_size (MiB) of a set of sites. */
export function clientMaxBodyFor(sites: Array<PlanSite | undefined>): number {
  const php = sites.reduce((max, s) => Math.max(max, phpBodyMb(s?.php_settings)), 0);
  return Math.min(10240, Math.max(DEFAULT_CLIENT_MAX_BODY_MB, Math.ceil(php)));
}

const host = (v: string | null | undefined): string | null => {
  const h = (v ?? '').trim().toLowerCase().replace(/\.$/, '');
  return h && isValidServerName(h) ? h : null;
};

/**
 * The vhosts the edge should serve for these rows. Platform names are claimed
 * FIRST (panel, DB admin, probes, then previews on the preview domain), so a
 * tenant domain can never take over one of them; then domains by id.
 */
export function planVhosts(input: EdgePlanInput): EdgeVhost[] {
  const vhosts: EdgeVhost[] = [];
  const claimed = new Set<string>();
  const panelHost = host(input.platform.panel);
  const previewDomain = host(input.platform.previewDomain);
  const reservedHosts = platformHostNames(input.platform);
  const platformList = platformHostList(reservedHosts);

  const tlsFor = (cert: PlanCertificate | undefined): EdgeVhost['tls'] => {
    if (!cert || cert.status !== 'valid' || !input.certFilesExist(cert.primary_name)) return null;
    return edgeCertPaths(cert.primary_name);
  };
  const claim = (names: string[]): string[] => {
    const kept = names.filter((n) => !claimed.has(n));
    kept.forEach((n) => claimed.add(n));
    return kept;
  };
  /** Certificate row of a platform host name (domain_id and site_id null). */
  const platformCert = (name: string) => input.certificates.find((c) => c.domain_id === null && c.site_id === null && c.primary_name === name);
  const platformVhost = (id: string, kind: EdgeVhost['kind'], name: string | null, locations: EdgeLocation[],
    extraHeaders: Record<string, string>, clientMaxBodyMb: number): void => {
    if (!name) return;
    const names = claim([name]);
    if (!names.length) return;
    const acme = tlsFor(platformCert(name));
    const selfSigned = !acme && !!input.selfSignedNames?.includes(name);
    const tls = acme ?? (selfSigned ? selfSignedCertPaths() : null);
    vhosts.push({
      id, kind, serverNames: names, tls, forceHttps: !!tls, ...(selfSigned ? { selfSigned: true } : {}), suspended: false, locations,
      extraHeaders, clientMaxBodyMb, accountId: null, tenantId: null,
    });
  };

  // ── panel ──
  platformVhost('panel', 'panel', panelHost, [
    { pathPrefix: '/', upstream: input.panelUpstream, kind: 'panel', siteId: null },
    { pathPrefix: '/socket.io/', upstream: input.panelUpstream, kind: 'panel', siteId: null },
  ], {}, PANEL_CLIENT_MAX_BODY_MB);

  // ── DB admin (phpMyAdmin / Adminer, shared, SSO only) ──
  platformVhost('dbadmin', 'dbadmin', host(input.platform.dbAdmin), [
    { pathPrefix: '/phpmyadmin/', upstream: `http://${PHPMYADMIN_CONTAINER}:${DBADMIN_PORT}`, kind: 'dbadmin', siteId: null },
    { pathPrefix: '/adminer/', upstream: `http://${ADMINER_CONTAINER}:${DBADMIN_PORT}`, kind: 'dbadmin', siteId: null },
  ], { ...DBADMIN_HEADERS }, DBADMIN_CLIENT_MAX_BODY_MB);

  // ── IP probes (A-only / AAAA-only names): the probe endpoint and nothing else ──
  const probe: EdgeLocation[] = [{ pathPrefix: IP_PROBE_PATH, exact: true, upstream: input.panelUpstream, kind: 'probe', siteId: null }];
  platformVhost('probe-v4', 'probe', host(input.platform.probeV4), probe, {}, 1);
  platformVhost('probe-v6', 'probe', host(input.platform.probeV6), probe.map((l) => ({ ...l })), {}, 1);

  // ── previews (dedicated preview domain only) ──
  if (previewDomain) {
    // Optional wildcard certificate *.previewDomain (DNS-01), row keyed by the apex.
    const wildcard = platformCert(previewDomain);
    const wildcardCovers = wildcard ? (certNames(wildcard) ?? []).includes(`*.${previewDomain}`) : false;
    for (const s of [...input.sites].sort((a, b) => a.id - b.id)) {
      if (!s.preview_base || !served(s.account_status)) continue;
      const name = previewHost(s, previewDomain);
      if (!isValidServerName(name)) continue;
      const names = claim([name]);
      if (!names.length) continue;
      const own = input.certificates.find((c) => c.domain_id === null && c.site_id === s.id && c.primary_name === name);
      const tls = tlsFor(own) ?? (wildcardCovers ? tlsFor(wildcard) : null);
      vhosts.push({
        id: `p-${s.id}`,
        kind: 'preview',
        serverNames: names,
        tls,
        forceHttps: !!tls,
        suspended: s.account_status === 'suspended',
        locations: [{ pathPrefix: '/', upstream: siteUpstream(s.id, 'preview'), kind: 'preview', siteId: s.id }],
        extraHeaders: { ...PREVIEW_HEADERS },
        clientMaxBodyMb: clientMaxBodyFor([s]),
        accountId: s.account_id,
        tenantId: s.tenant_id,
      });
    }
  }

  // ── domains ──
  const sitesById = new Map(input.sites.map((s) => [s.id, s]));
  const routesByDomain = new Map<number, PlanRoute[]>();
  for (const r of input.routes) {
    const list = routesByDomain.get(r.domain_id) ?? [];
    list.push(r);
    routesByDomain.set(r.domain_id, list);
  }
  for (const d of [...input.domains].sort((a, b) => a.id - b.id)) {
    if (!served(d.account_status)) continue;
    const verified = d.verification_status === 'verified';
    const name = d.name.toLowerCase();
    // *.name never answers for a platform host below it (defence in depth: refused at creation too).
    const wildcardOk = verified && !platformList.some((h) => h.endsWith(`.${name}`));
    const names = claim(domainServerNames(d, { wildcard: wildcardOk })
      .filter((n) => n.startsWith('*.') || !isReservedPlatformName(n, input.platform)));
    if (!names.length || (names.length === 1 && names[0].startsWith('*.'))) continue;
    const base = { id: `d-${d.id}`, serverNames: names, extraHeaders: {}, accountId: d.account_id, tenantId: d.tenant_id };

    if (!verified) {
      // D1: an unverified domain gets the placeholder page only (suspended: the P1 503 page).
      vhosts.push({
        ...base, kind: d.account_status === 'suspended' ? 'site' : 'placeholder', tls: null, forceHttps: false,
        suspended: d.account_status === 'suspended', locations: [], clientMaxBodyMb: DEFAULT_CLIENT_MAX_BODY_MB,
      });
      continue;
    }

    const routes = routesByDomain.get(d.id) ?? [];
    const locations: EdgeLocation[] = routes.map((r) => r.runtime_id === null
      ? { pathPrefix: r.path_prefix, upstream: siteUpstream(r.site_id), kind: 'site', siteId: r.site_id }
      : { pathPrefix: r.path_prefix, upstream: siteUpstream(r.site_id, 'secondary', r.runtime_id), kind: 'secondary', siteId: r.site_id });
    const cert = d.tls_mode === 'letsencrypt' ? input.certificates.find((c) => c.domain_id === d.id) : undefined;
    const tls = tlsFor(cert);
    // A certificate that does not cover every name yet (www / wildcard just
    // added, its issuance pending or failed): no forced redirect to an HTTPS
    // that would present a mismatching certificate on the uncovered name.
    const covered = cert ? certNames(cert) : null;
    const coversAll = covered === null || names.every((n) => certCovers(covered, n));
    vhosts.push({
      ...base,
      kind: 'site',
      tls,
      forceHttps: !!d.force_https && coversAll,
      suspended: d.account_status === 'suspended',
      locations,
      clientMaxBodyMb: clientMaxBodyFor(routes.map((r) => sitesById.get(r.site_id))),
    });
  }

  return vhosts;
}
