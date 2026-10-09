import type { HostingAccount, PhpSettings } from '@oblimint/shared';
import { previewHostname, siteUpstream } from '../hosting/naming';
import { edgeCertPaths, type EdgeLocation, type EdgeVhost } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// PURE mapping "database rows → desired edge vhosts" (edge.service reads the
// rows, this file decides). One vhost per:
//   d-<domainId>  domain of an account in active|suspended|provisioning|error
//                 (accounts being deleted are skipped), locations = site_routes;
//   p-<siteId>    blue/green preview of a site (preview_base set), served on
//                 previewHostname(site, panel_hostname) — needs panel_hostname;
//   panel         the panel itself on panel_hostname (when set).
// TLS is enabled only when the certificate row is 'valid' AND both files exist
// in edge/certs/<primary_name>/ (a missing file would make `nginx -t` fail).
// A server name already claimed by an earlier vhost is dropped from the later
// one (nginx would only warn and serve the first anyway).
//
// client_max_body_size: DEFAULT_CLIENT_MAX_BODY_MB, raised to the largest PHP
// post_max_size / upload_max_filesize of the routed sites — PHP itself stays
// the real limit, the edge must just never be stricter than the site.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CLIENT_MAX_BODY_MB = 512;
export const PANEL_CLIENT_MAX_BODY_MB = 100;
export const PREVIEW_HEADERS: Record<string, string> = { 'X-Robots-Tag': 'noindex, nofollow' };

/** Account statuses whose domains are served (deleting → never). */
export const SERVED_ACCOUNT_STATUSES: ReadonlyArray<HostingAccount['status']> = ['active', 'suspended', 'provisioning', 'error'];

export interface PlanDomain {
  id: number;
  name: string;
  include_www: boolean;
  tls_mode: 'letsencrypt' | 'none';
  force_https: boolean;
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

/** panel_hostname itself or a name under .preview.<panel_hostname>: never a tenant domain. */
export function isReservedPlatformName(name: string, panelHostname: string | null | undefined): boolean {
  const panel = panelHostname?.trim().toLowerCase();
  if (!panel) return false;
  const n = name.trim().toLowerCase();
  return n === panel || n.endsWith(`.preview.${panel}`);
}

function certNames(c: PlanCertificate): string[] | null {
  let v: unknown = c.names;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : null;
}

export interface EdgePlanInput {
  domains: PlanDomain[];
  routes: PlanRoute[];
  /** Sites of the served accounts (routed ones + previews). */
  sites: PlanSite[];
  certificates: PlanCertificate[];
  /** app_config panel_hostname (null = no panel / preview vhosts). */
  panelHostname: string | null;
  /** e.g. https://oblimint-panel:8443 */
  panelUpstream: string;
  /** Do fullchain.pem AND privkey.pem exist for this primary name (host side)? */
  certFilesExist: (primaryName: string) => boolean;
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

/**
 * The vhosts the edge should serve for these rows. Platform names are claimed
 * FIRST (panel, then previews under .preview.<panel>), so a tenant domain can
 * never take over the panel or a preview host name; then domains by id.
 */
export function planVhosts(input: EdgePlanInput): EdgeVhost[] {
  const vhosts: EdgeVhost[] = [];
  const claimed = new Set<string>();
  const panelHost = input.panelHostname ? input.panelHostname.trim().toLowerCase() : null;

  const tlsFor = (cert: PlanCertificate | undefined): EdgeVhost['tls'] => {
    if (!cert || cert.status !== 'valid' || !input.certFilesExist(cert.primary_name)) return null;
    return edgeCertPaths(cert.primary_name);
  };
  const claim = (names: string[]): string[] => {
    const kept = names.filter((n) => !claimed.has(n));
    kept.forEach((n) => claimed.add(n));
    return kept;
  };

  // ── panel ──
  if (panelHost) {
    const cert = input.certificates.find((c) => c.domain_id === null && c.site_id === null && c.primary_name === panelHost);
    const tls = tlsFor(cert);
    const names = claim([panelHost]);
    if (names.length) {
      vhosts.push({
        id: 'panel',
        serverNames: names,
        tls,
        forceHttps: !!tls,
        suspended: false,
        locations: [
          { pathPrefix: '/', upstream: input.panelUpstream, kind: 'panel', siteId: null },
          { pathPrefix: '/socket.io/', upstream: input.panelUpstream, kind: 'panel', siteId: null },
        ],
        extraHeaders: {},
        clientMaxBodyMb: PANEL_CLIENT_MAX_BODY_MB,
      });
    }
  }

  // ── previews ──
  if (panelHost) {
    for (const s of [...input.sites].sort((a, b) => a.id - b.id)) {
      if (!s.preview_base || !served(s.account_status)) continue;
      const host = previewHostname(s, panelHost);
      const names = claim([host]);
      if (!names.length) continue;
      const tls = tlsFor(input.certificates.find((c) => c.domain_id === null && c.site_id === s.id && c.primary_name === host));
      vhosts.push({
        id: `p-${s.id}`,
        serverNames: names,
        tls,
        forceHttps: !!tls,
        suspended: s.account_status === 'suspended',
        locations: [{ pathPrefix: '/', upstream: siteUpstream(s.id, 'preview'), kind: 'preview', siteId: s.id }],
        extraHeaders: { ...PREVIEW_HEADERS },
        clientMaxBodyMb: clientMaxBodyFor([s]),
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
    const name = d.name.toLowerCase();
    const names = claim((d.include_www ? [name, `www.${name}`] : [name]).filter((n) => !isReservedPlatformName(n, panelHost)));
    if (!names.length) continue;
    const routes = routesByDomain.get(d.id) ?? [];
    const locations: EdgeLocation[] = routes.map((r) => r.runtime_id === null
      ? { pathPrefix: r.path_prefix, upstream: siteUpstream(r.site_id), kind: 'site', siteId: r.site_id }
      : { pathPrefix: r.path_prefix, upstream: siteUpstream(r.site_id, 'secondary', r.runtime_id), kind: 'secondary', siteId: r.site_id });
    const cert = d.tls_mode === 'letsencrypt' ? input.certificates.find((c) => c.domain_id === d.id) : undefined;
    const tls = tlsFor(cert);
    // A certificate that does not cover every name yet (www just added, its
    // issuance pending or failed): no forced redirect to an HTTPS that would
    // present a mismatching certificate on the uncovered name.
    const covered = cert ? certNames(cert) : null;
    const coversAll = covered === null || names.every((n) => covered.includes(n));
    vhosts.push({
      id: `d-${d.id}`,
      serverNames: names,
      tls,
      forceHttps: !!d.force_https && coversAll,
      suspended: d.account_status === 'suspended',
      locations,
      extraHeaders: {},
      clientMaxBodyMb: clientMaxBodyFor(routes.map((r) => sitesById.get(r.site_id))),
    });
  }

  return vhosts;
}
