import { normalizePathPrefix } from '@oblimint/shared';
import { banCheckLines } from '../security/honeypotRender';

// ─────────────────────────────────────────────────────────────────────────────
// PURE nginx config generation for oblimint-edge (ported from Oblihub
// nginx.service.ts: templates, ACME location first, sanitizeForNginx).
// OWNED BY MODULE `edge-ownership` (P2).
//
// Invariant H5 (docs/P1-PLAN.md §14): no tenant data reaches the edge config
// unvalidated. Every vhost goes through validateVhost() before rendering: an
// invalid one THROWS (EdgeConfigError) — the caller skips that vhost and logs,
// the other vhosts are still served. Values are additionally passed through
// sanitizeForNginx() at render time (defence in depth).
//
// Contract with the edge image (images/edge/):
//   - nginx.conf includes /etc/nginx/oblimint/conf.d/*.conf inside http{},
//     defines `resolver 127.0.0.11 valid=10s ipv6=off;` and
//     `map $http_upgrade $connection_upgrade`, default servers answer 404;
//   - certificates: /etc/nginx/oblimint/certs/<primaryName>/{fullchain,privkey}.pem;
//   - ACME webroot: /var/www/acme (tokens under .well-known/acme-challenge/);
//   - error pages: /usr/share/oblimint/errors/{404,502,503,suspended,pending}.html;
//   - access log `oblimint_json` (docs/P2-PLAN.md §6.8) reads the variables
//     $oblimint_site / $oblimint_account / $oblimint_tenant / $oblimint_kind:
//     EVERY generated location sets the four of them (`set`, rewrite phase).
//     Never at server level: an internal redirect (error_page → 502 page)
//     re-runs the server-level rewrites and would reset the site of the
//     location that failed; the internal error-page location sets nothing
//     and keeps the values of the location that redirected to it.
//     P4b (docs/P4b-PLAN.md §8.7): + $oblimint_host / $oblimint_app /
//     $oblimint_hp, always "" on these vhosts (proxy objects set them);
//   - P4b ban check (honeypot-bans banCheckLines) right after server_name in
//     every server block; the variables come from the global unit g-bans;
//   - every vhost becomes an edge UNIT (edge-robustness, pipeline.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** P4: + mail (autoconfig / autodiscover / MTA-STS policy → panel), webmail (→ webmail container) — edge/contributors.ts. */
export type EdgeLocationKind = 'site' | 'secondary' | 'preview' | 'panel' | 'dbadmin' | 'probe' | 'mail' | 'webmail';

/**
 * What a vhost serves:
 *   site         a verified tenant domain (locations = its routes);
 *   placeholder  an UNVERIFIED tenant domain (invariant D1): a static
 *                "pending verification" page, no route to any site, no TLS;
 *   preview      blue/green preview on the preview domain;
 *   panel / dbadmin / probe  platform host names.
 */
export type EdgeVhostKind = 'site' | 'placeholder' | 'preview' | 'panel' | 'dbadmin' | 'probe' | 'mail' | 'webmail';

/** $oblimint_kind of the access log (plan §6.8). */
export type EdgeLogKind = EdgeLocationKind | 'placeholder' | 'suspended' | 'redirect' | 'default' | 'stub';

/** 'suspended': the suspension page of a suspended account (never billed as traffic). */
/** 'stub': the 503 page of a refused / disabled edge unit (edge-robustness, docs/P4b-PLAN.md §8.3). */
export const EDGE_LOG_KINDS: readonly EdgeLogKind[] = ['site', 'secondary', 'preview', 'panel', 'placeholder', 'suspended', 'dbadmin', 'probe', 'redirect', 'default', 'mail', 'webmail', 'stub'];

/** Variables of the access log set by every generated location. */
/** P4b (docs/P4b-PLAN.md §8.7): + $oblimint_host (proxy object id), $oblimint_app (target stack), $oblimint_hp (honeypot hit). */
export const EDGE_LOG_VARIABLES = ['$oblimint_kind', '$oblimint_site', '$oblimint_account', '$oblimint_tenant', '$oblimint_host', '$oblimint_app', '$oblimint_hp'] as const;

export interface EdgeLocation {
  /**
   * '/' or '/shop/' — rendered as `location ^~ <prefix>` (longest prefix
   * wins); with `exact`, an exact path without trailing slash
   * (`location = /api/ip-probe`).
   */
  pathPrefix: string;
  /** e.g. http://oblimint-site-12:8080 — resolved at request time (resolver 127.0.0.11 + variable). */
  upstream: string;
  kind: EdgeLocationKind;
  siteId: number | null;
  exact?: boolean;
}

export interface EdgeVhost {
  /** Stable file stem, e.g. `d-42` (domain), `p-12` (preview), `panel`, `dbadmin`, `probe-v4`. */
  id: string;
  kind: EdgeVhostKind;
  /** Lower-case server names (domain, www.domain, *.domain for a wildcard domain…). */
  serverNames: string[];
  /** Certificate files as seen INSIDE the edge container, null = HTTP only. */
  tls: { certPath: string; keyPath: string } | null;
  /** Redirect HTTP → HTTPS (only when tls is set; the ACME location stays on HTTP). */
  forceHttps: boolean;
  /**
   * tls is the panel's self-signed fallback certificate (platform vhosts with
   * no ACME certificate: private / reserved names, issuance pending or
   * failed). Never sends HSTS (a browser must stay free to accept the
   * exception now and get the real certificate later).
   */
  selfSigned?: boolean;
  /** Account suspended: every location answers 503 with the suspension page. */
  suspended: boolean;
  locations: EdgeLocation[];
  /** e.g. { 'X-Robots-Tag': 'noindex, nofollow' } on preview vhosts. */
  extraHeaders: Record<string, string>;
  clientMaxBodyMb: number;
  /** Access log fields (null on platform vhosts). */
  accountId: number | null;
  tenantId: number | null;
}

/** Container-side paths of the edge image (see the contract above). */
export const EDGE_CONTAINER_PATHS = {
  confD: '/etc/nginx/oblimint/conf.d',
  certs: '/etc/nginx/oblimint/certs',
  acmeWebroot: '/var/www/acme',
  errorPages: '/usr/share/oblimint/errors',
} as const;

/** ACME HTTP-01 location (served on port 80 by every vhost, before anything else). */
export const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
/** Internal location aliasing the error pages (never reachable from outside: `internal`). */
export const ERROR_PAGES_PREFIX = '/__oblimint_edge/';
/** Static page of an unverified domain (images/edge/errors/pending.html). */
export const PLACEHOLDER_PAGE = 'pending.html';

/** HSTS max-age (180 days), only when the vhost forces HTTPS. */
export const HSTS_MAX_AGE = 15552000;
export const MAX_CLIENT_BODY_MB = 10240;

// Labels of 1–63 chars with inner hyphens (consecutive ones too: punycode
// `xn--…`), at least two labels, 253 chars max, lower case, no wildcard.
const SERVER_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UPSTREAM_RE = /^(https?):\/\/([a-z0-9-]+):([0-9]{1,5})$/;
const VHOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// <primary name>/ (ACME) or _selfsigned/ (fallback of the platform vhosts: `_` is never in a server name).
const CERT_FILE_RE = /^\/etc\/nginx\/oblimint\/certs\/(?:[a-z0-9.-]{1,253}|_selfsigned)\/(fullchain|privkey)\.pem$/;
/** Exact location path: absolute, no trailing slash, plain segments. */
const EXACT_PATH_RE = /^(?:\/[A-Za-z0-9._-]{1,64}){1,8}$/;
/** Characters allowed in a header value once sanitized (rendered inside double quotes). */
const HEADER_VALUE_RE = /^[\x20-\x7e]{0,512}$/;

const VHOST_KINDS: readonly EdgeVhostKind[] = ['site', 'placeholder', 'preview', 'panel', 'dbadmin', 'probe', 'mail', 'webmail'];
const LOCATION_KINDS: readonly EdgeLocationKind[] = ['site', 'secondary', 'preview', 'panel', 'dbadmin', 'probe', 'mail', 'webmail'];

export class EdgeConfigError extends Error {
  constructor(public vhostId: string, message: string) {
    super(`vhost ${vhostId}: ${message}`);
    this.name = 'EdgeConfigError';
  }
}

/**
 * Strips anything that could break out of an nginx directive: `;` `{` `}`
 * quotes, backslash, `$` (variable interpolation), `#` (comment) and every
 * control character (newlines, tabs, NUL…). Spaces are kept — callers that
 * need a single token validate it with a strict regex anyway.
 */
export function sanitizeForNginx(value: string): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[;{}'"`\\$#\x00-\x1f\x7f]/g, '');
}

/** True when `name` is a valid lower-case FQDN (punycode allowed, at least one dot, no wildcard). */
export function isValidServerName(name: string): boolean {
  return typeof name === 'string' && SERVER_NAME_RE.test(name);
}

/** A server_name entry: a valid FQDN, or `*.` + a valid FQDN (wildcard domain, P2). */
export function isValidServerNameEntry(name: string): boolean {
  if (typeof name !== 'string') return false;
  return name.startsWith('*.') ? isValidServerName(name.slice(2)) : isValidServerName(name);
}

/** Certificate file as seen inside the edge: /etc/nginx/oblimint/certs/<dir>/{fullchain,privkey}.pem, no '..'. */
export function isValidCertPath(p: string): boolean {
  return typeof p === 'string' && CERT_FILE_RE.test(p) && !p.includes('..');
}

/** True when `upstream` is `http(s)://<container-name>:<port>` (no path, no user info). */
export function isValidUpstream(upstream: string): boolean {
  const m = typeof upstream === 'string' ? UPSTREAM_RE.exec(upstream) : null;
  if (!m) return false;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535;
}

const isOptionalId = (v: unknown): boolean => v === null || (Number.isInteger(v) && (v as number) > 0);

/** Throws EdgeConfigError when anything in the vhost is not strictly valid (H5). */
export function validateVhost(v: EdgeVhost): void {
  const id = typeof v?.id === 'string' ? v.id : '?';
  const fail = (msg: string): never => { throw new EdgeConfigError(sanitizeForNginx(id).slice(0, 64), msg); };
  if (!VHOST_ID_RE.test(id)) fail('invalid id');
  if (!VHOST_KINDS.includes(v.kind)) fail('invalid vhost kind');
  if (!isOptionalId(v.accountId) || !isOptionalId(v.tenantId)) fail('invalid account / tenant id');

  if (!Array.isArray(v.serverNames) || v.serverNames.length === 0) fail('no server name');
  const seenNames = new Set<string>();
  for (const name of v.serverNames) {
    if (!isValidServerNameEntry(name)) fail(`invalid server name ${JSON.stringify(String(name).slice(0, 80))}`);
    if (seenNames.has(name)) fail(`duplicate server name ${name}`);
    seenNames.add(name);
  }

  if (v.tls !== null) {
    if (!v.tls || !CERT_FILE_RE.test(v.tls.certPath) || !CERT_FILE_RE.test(v.tls.keyPath)) fail('invalid certificate path');
    if (v.tls.certPath.includes('..') || v.tls.keyPath.includes('..')) fail('invalid certificate path');
  }
  // The self-signed fallback is for the platform's own names only, never a tenant's.
  const fallback = selfSignedCertPaths();
  const usesFallback = v.tls !== null && (v.tls.certPath === fallback.certPath || v.tls.keyPath === fallback.keyPath);
  if (usesFallback && !SELF_SIGNED_KINDS.includes(v.kind)) fail('the self-signed fallback certificate only serves platform vhosts');
  if (v.selfSigned !== undefined && v.selfSigned !== usesFallback) fail('selfSigned does not match the certificate path');

  if (!Array.isArray(v.locations)) fail('no locations');
  // D1: an unverified domain is never routed nor served over TLS.
  if (v.kind === 'placeholder' && (v.locations.length > 0 || v.tls !== null)) fail('a placeholder vhost has no location nor certificate');
  const seenPrefixes = new Set<string>();
  for (const loc of v.locations) {
    const prefix = loc?.pathPrefix;
    if (loc?.exact) {
      if (typeof prefix !== 'string' || !EXACT_PATH_RE.test(prefix)) fail(`invalid exact path ${JSON.stringify(String(prefix).slice(0, 80))}`);
    } else if (typeof prefix !== 'string' || normalizePathPrefix(prefix) !== prefix) {
      fail(`invalid path prefix ${JSON.stringify(String(prefix).slice(0, 80))}`);
    }
    if (prefix.startsWith(ACME_CHALLENGE_PREFIX) || prefix.startsWith(ERROR_PAGES_PREFIX)
      || `${prefix}/`.startsWith(ACME_CHALLENGE_PREFIX) || `${prefix}/`.startsWith(ERROR_PAGES_PREFIX)) {
      fail(`reserved path prefix ${prefix}`);
    }
    const key = `${loc.exact ? '=' : '^~'}${prefix}`;
    if (seenPrefixes.has(key)) fail(`duplicate path prefix ${prefix}`);
    seenPrefixes.add(key);
    if (!isValidUpstream(loc.upstream)) fail(`invalid upstream ${JSON.stringify(String(loc.upstream).slice(0, 80))}`);
    if (!LOCATION_KINDS.includes(loc.kind)) fail('invalid location kind');
    if (!isOptionalId(loc.siteId)) fail('invalid site id');
  }

  for (const [name, value] of Object.entries(v.extraHeaders ?? {})) {
    if (!HEADER_NAME_RE.test(name)) fail(`invalid header name ${JSON.stringify(name.slice(0, 64))}`);
    if (typeof value !== 'string' || !HEADER_VALUE_RE.test(value) || sanitizeForNginx(value) !== value) {
      fail(`invalid value for header ${name}`);
    }
  }

  if (!Number.isInteger(v.clientMaxBodyMb) || v.clientMaxBodyMb < 1 || v.clientMaxBodyMb > MAX_CLIENT_BODY_MB) {
    fail('invalid clientMaxBodyMb');
  }
}

/** Exact locations first, then longest prefix first (ties: lexical) — keeps diffs stable. */
export function sortLocations(locations: EdgeLocation[]): EdgeLocation[] {
  return [...locations].sort((a, b) => Number(!!b.exact) - Number(!!a.exact)
    || b.pathPrefix.length - a.pathPrefix.length || a.pathPrefix.localeCompare(b.pathPrefix));
}

const I1 = '    ';
const I2 = '        ';

/** $oblimint_kind of the locations of a vhost that are not a proxied route (ACME, 404, suspension). */
function serverLogKind(v: EdgeVhost): EdgeLogKind {
  return v.kind;
}

/** The `set` lines of the access log variables (inside a location, rewrite phase). */
export function logVariableLines(v: Pick<EdgeVhost, 'accountId' | 'tenantId'>, kind: EdgeLogKind, siteId: number | null): string[] {
  const val = (n: number | null) => (n === null ? '""' : `"${Number(n)}"`);
  return [
    `${I2}set $oblimint_kind ${EDGE_LOG_KINDS.includes(kind) ? kind : 'default'};`,
    `${I2}set $oblimint_site ${val(siteId)};`,
    `${I2}set $oblimint_account ${val(v.accountId)};`,
    `${I2}set $oblimint_tenant ${val(v.tenantId)};`,
    // P4b: proxy object / app stack / honeypot hit — never set by these vhosts.
    `${I2}set $oblimint_host "";`,
    `${I2}set $oblimint_app "";`,
    `${I2}set $oblimint_hp "";`,
  ];
}

function acmeLocation(v: EdgeVhost): string {
  return [
    `${I1}# ACME HTTP-01 — FIRST, never redirected nor proxied (Let's Encrypt issuance / renewal).`,
    `${I1}location ^~ ${ACME_CHALLENGE_PREFIX} {`,
    ...logVariableLines(v, serverLogKind(v), null),
    `${I2}root ${EDGE_CONTAINER_PATHS.acmeWebroot};`,
    `${I2}default_type text/plain;`,
    `${I2}try_files $uri =404;`,
    `${I1}}`,
  ].join('\n');
}

function errorPagesBlock(): string {
  return [
    `${I1}error_page 502 504 ${ERROR_PAGES_PREFIX}502.html;`,
    `${I1}error_page 503 ${ERROR_PAGES_PREFIX}503.html;`,
    `${I1}location ^~ ${ERROR_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}alias ${EDGE_CONTAINER_PATHS.errorPages}/;`,
    `${I1}}`,
  ].join('\n');
}

function suspendedBlock(v: EdgeVhost): string {
  return [
    `${I1}# Account suspended: every request answers 503 with the suspension page.`,
    `${I1}error_page 503 ${ERROR_PAGES_PREFIX}suspended.html;`,
    `${I1}location ^~ ${ERROR_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}alias ${EDGE_CONTAINER_PATHS.errorPages}/;`,
    `${I1}}`,
    `${I1}location / {`,
    ...logVariableLines(v, 'suspended', null),
    `${I2}return 503;`,
    `${I1}}`,
  ].join('\n');
}

/**
 * Unverified domain (invariant D1): a static page, 200, for every path. No
 * proxy, no TLS, no redirect; never indexed nor cached.
 */
function placeholderBlock(v: EdgeVhost): string {
  return [
    `${I1}# Domain not verified yet: placeholder page only (no route to any site, no certificate).`,
    `${I1}location / {`,
    ...logVariableLines(v, 'placeholder', null),
    `${I2}root ${EDGE_CONTAINER_PATHS.errorPages};`,
    `${I2}charset utf-8;`,
    `${I2}add_header Cache-Control "no-store" always;`,
    `${I2}add_header X-Robots-Tag "noindex, nofollow" always;`,
    `${I2}try_files /${PLACEHOLDER_PAGE} =404;`,
    `${I1}}`,
  ].join('\n');
}

/**
 * Panel route that streams a database dump INTO the panel (databases module,
 * §6.3): up to 2 GiB, never buffered to the edge's disk (the dump must never
 * touch a disk), with the restore's own long timeouts.
 */
export const PANEL_RESTORE_PATH_RE = '^/api/databases/instances/[0-9]+/databases/[0-9]+/restore$';
export const PANEL_RESTORE_MAX_BODY_MB = 2048;
const PANEL_RESTORE_TIMEOUT_S = 6 * 3600 + 30 * 60;

function proxyDirectives(indent: string, variable: string, upstream: string, timeoutS: number): string[] {
  const lines = [
    // proxy_pass through a variable: the name is resolved at REQUEST time
    // (resolver 127.0.0.11), so a stopped / missing site container never
    // breaks `nginx -t`. No URI part → the request URI is passed unchanged.
    `${indent}set ${variable} ${upstream};`,
    `${indent}proxy_pass ${variable};`,
    `${indent}proxy_http_version 1.1;`,
    `${indent}proxy_set_header Host $host;`,
    `${indent}proxy_set_header X-Real-IP $remote_addr;`,
    `${indent}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${indent}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${indent}proxy_set_header X-Forwarded-Host $host;`,
    `${indent}proxy_set_header Upgrade $http_upgrade;`,
    `${indent}proxy_set_header Connection $connection_upgrade;`,
    `${indent}proxy_connect_timeout 10s;`,
    `${indent}proxy_send_timeout ${timeoutS}s;`,
    `${indent}proxy_read_timeout ${timeoutS}s;`,
  ];
  if (upstream.startsWith('https://')) {
    // The panel serves a self-signed certificate on the internal network.
    lines.push(`${indent}proxy_ssl_verify off;`, `${indent}proxy_ssl_server_name on;`);
  }
  return lines;
}

function proxyLocation(v: EdgeVhost, loc: EdgeLocation, index: number): string {
  const prefix = sanitizeForNginx(loc.pathPrefix);
  const upstream = sanitizeForNginx(loc.upstream);
  const variable = `$up_${index}`;
  const panel = loc.kind === 'panel';
  const lines = [
    `${I1}location ${loc.exact ? '=' : '^~'} ${prefix} {`,
    ...logVariableLines(v, loc.kind, loc.siteId),
    ...proxyDirectives(I2, variable, upstream, panel ? 3600 : 300),
  ];
  if (panel && !loc.exact && prefix === '/') {
    // Nested: a top-level regex location is never tried after a `^~` match.
    // set / proxy_pass are not inherited by a nested location: repeated.
    const I3 = I2 + I2.slice(I1.length);
    lines.push(
      `${I2}location ~ ${PANEL_RESTORE_PATH_RE} {`,
      ...logVariableLines(v, loc.kind, loc.siteId).map((l) => I3 + l.trimStart()),
      ...proxyDirectives(I3, variable, upstream, PANEL_RESTORE_TIMEOUT_S),
      `${I3}client_max_body_size ${PANEL_RESTORE_MAX_BODY_MB}m;`,
      `${I3}client_body_timeout 300s;`,
      `${I3}proxy_request_buffering off;`,
      `${I2}}`,
    );
  }
  lines.push(`${I1}}`);
  if (!loc.exact && prefix !== '/') {
    // `/shop` (no trailing slash) does not match `^~ /shop/`: redirect it.
    const bare = prefix.slice(0, -1);
    lines.push(`${I1}location = ${bare} {`, ...logVariableLines(v, 'redirect', loc.siteId), `${I2}return 301 ${prefix}$is_args$args;`, `${I1}}`);
  }
  return lines.join('\n');
}

function serverBody(v: EdgeVhost): string {
  if (v.suspended) return suspendedBlock(v);
  if (v.kind === 'placeholder') return placeholderBlock(v);
  const parts = [errorPagesBlock()];
  const locations = sortLocations(v.locations);
  locations.forEach((loc, i) => parts.push(proxyLocation(v, loc, i)));
  if (!locations.some((l) => !l.exact && l.pathPrefix === '/')) {
    // Only sub-paths are routed: everything else is a 404 page, never the nginx default root.
    parts.push([`${I1}location / {`, ...logVariableLines(v, serverLogKind(v), null), `${I2}return 404;`, `${I1}}`].join('\n'));
  }
  return parts.join('\n\n');
}

function commonServerLines(v: EdgeVhost, names: string): string[] {
  return [
    `${I1}server_name ${names};`,
    // P4b: web bans (platform + this account) — right after server_name (honeypot-bans).
    ...banCheckLines(v.accountId, I1),
    `${I1}client_max_body_size ${v.clientMaxBodyMb}m;`,
  ];
}

function headerLines(v: EdgeVhost, https: boolean): string[] {
  const lines: string[] = [];
  // add_header only at server level (a location-level add_header would drop these).
  for (const [name, value] of Object.entries(v.extraHeaders).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${I1}add_header ${sanitizeForNginx(name)} "${sanitizeForNginx(value)}" always;`);
  }
  if (https && v.forceHttps && !v.selfSigned) lines.push(`${I1}add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE}" always;`);
  return lines;
}

/** One vhost file (HTTP server with the ACME location FIRST, then HTTPS server when tls). Throws EdgeConfigError when invalid. */
export function renderVhost(vhost: EdgeVhost): string {
  validateVhost(vhost);
  const v = vhost;
  // A server name only keeps [a-z0-9.-] and a leading `*.` (validated above).
  const names = v.serverNames.map((n) => (n.startsWith('*.') ? `*.${sanitizeForNginx(n.slice(2))}` : sanitizeForNginx(n))).join(' ');
  const redirect = !!v.tls && v.forceHttps;
  const out: string[] = [];
  out.push(`# Managed by Oblimint (edge) — vhost ${sanitizeForNginx(v.id)} (${v.kind}). Do not edit: rewritten at every sync.`);

  // ── HTTP ──
  const http: string[] = [
    'server {',
    `${I1}listen 80;`,
    `${I1}listen [::]:80;`,
    ...commonServerLines(v, names),
    '',
    acmeLocation(v),
    '',
  ];
  if (redirect) {
    http.push(`${I1}location / {`, ...logVariableLines(v, 'redirect', null), `${I2}return 301 https://$host$request_uri;`, `${I1}}`);
  } else {
    const headers = headerLines(v, false);
    if (headers.length) http.push(...headers, '');
    http.push(serverBody(v));
  }
  http.push('}');
  out.push(http.join('\n'));

  // ── HTTPS ──
  if (v.tls) {
    const https: string[] = [
      'server {',
      `${I1}listen 443 ssl;`,
      `${I1}listen [::]:443 ssl;`,
      `${I1}http2 on;`,
      ...commonServerLines(v, names),
      `${I1}ssl_certificate ${sanitizeForNginx(v.tls.certPath)};`,
      `${I1}ssl_certificate_key ${sanitizeForNginx(v.tls.keyPath)};`,
      `${I1}ssl_protocols TLSv1.2 TLSv1.3;`,
      `${I1}ssl_prefer_server_ciphers off;`,
      `${I1}ssl_session_cache shared:oblimint_ssl:10m;`,
      `${I1}ssl_session_timeout 1d;`,
    ];
    https.push(...headerLines(v, true), '', serverBody(v), '}');
    out.push(https.join('\n'));
  }
  return out.join('\n\n') + '\n';
}

/** File name of a vhost in conf.d (e.g. `d-42.conf`). */
export function vhostFileName(vhost: Pick<EdgeVhost, 'id'>): string {
  return `${vhost.id}.conf`;
}

/** Directory (under certs/) of the self-signed fallback certificate of the platform vhosts. */
export const SELF_SIGNED_CERT_DIR = '_selfsigned';
/** Vhost kinds that may be served with the self-signed fallback (panel, DB admin, IP probes). */
export const SELF_SIGNED_KINDS: ReadonlyArray<EdgeVhostKind> = ['panel', 'dbadmin', 'probe'];

/** Self-signed fallback certificate paths as seen inside the edge container. */
export function selfSignedCertPaths(): { certPath: string; keyPath: string } {
  return {
    certPath: `${EDGE_CONTAINER_PATHS.certs}/${SELF_SIGNED_CERT_DIR}/fullchain.pem`,
    keyPath: `${EDGE_CONTAINER_PATHS.certs}/${SELF_SIGNED_CERT_DIR}/privkey.pem`,
  };
}

/** Certificate paths of a primary name as seen inside the edge container. */
export function edgeCertPaths(primaryName: string): { certPath: string; keyPath: string } {
  return {
    certPath: `${EDGE_CONTAINER_PATHS.certs}/${primaryName}/fullchain.pem`,
    keyPath: `${EDGE_CONTAINER_PATHS.certs}/${primaryName}/privkey.pem`,
  };
}
