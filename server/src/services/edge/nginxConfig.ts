import { normalizePathPrefix } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE nginx config generation for oblimint-edge (ported from Oblihub
// nginx.service.ts: templates, ACME location first, sanitizeForNginx).
//
// Invariant H5 (docs/P1-PLAN.md §14): no tenant data reaches the edge config
// unvalidated. Every vhost goes through validateVhost() before rendering: an
// invalid one THROWS (EdgeConfigError) — the caller skips that vhost and logs,
// the other vhosts are still served. Values are additionally passed through
// sanitizeForNginx() at render time (defence in depth).
//
// Contract with the edge image (module images, images/edge/):
//   - nginx.conf includes /etc/nginx/oblimint/conf.d/*.conf inside http{},
//     defines `resolver 127.0.0.11 valid=10s ipv6=off;` and
//     `map $http_upgrade $connection_upgrade`, default servers answer 404;
//   - certificates: /etc/nginx/oblimint/certs/<primaryName>/{fullchain,privkey}.pem;
//   - ACME webroot: /var/www/acme (tokens under .well-known/acme-challenge/);
//   - error pages: /usr/share/oblimint/errors/{404,502,503,suspended}.html.
// ─────────────────────────────────────────────────────────────────────────────

export type EdgeLocationKind = 'site' | 'secondary' | 'preview' | 'panel';

export interface EdgeLocation {
  /** '/' or '/shop/' — rendered as `location ^~ <prefix>` (longest prefix wins). */
  pathPrefix: string;
  /** e.g. http://oblimint-site-12:8080 — resolved at request time (resolver 127.0.0.11 + variable). */
  upstream: string;
  kind: EdgeLocationKind;
  siteId: number | null;
}

export interface EdgeVhost {
  /** Stable file stem, e.g. `d-42` (domain), `p-12` (preview), `panel`. */
  id: string;
  /** Lower-case server names (domain, www.domain…). */
  serverNames: string[];
  /** Certificate files as seen INSIDE the edge container, null = HTTP only. */
  tls: { certPath: string; keyPath: string } | null;
  /** Redirect HTTP → HTTPS (only when tls is set; the ACME location stays on HTTP). */
  forceHttps: boolean;
  /** Account suspended: every location answers 503 with the suspension page. */
  suspended: boolean;
  locations: EdgeLocation[];
  /** e.g. { 'X-Robots-Tag': 'noindex, nofollow' } on preview vhosts. */
  extraHeaders: Record<string, string>;
  clientMaxBodyMb: number;
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

/** HSTS max-age (180 days), only when the vhost forces HTTPS. */
export const HSTS_MAX_AGE = 15552000;
export const MAX_CLIENT_BODY_MB = 10240;

// Labels of 1–63 chars with inner hyphens (consecutive ones too: punycode
// `xn--…`), at least two labels, 253 chars max, lower case, no wildcard.
const SERVER_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UPSTREAM_RE = /^(https?):\/\/([a-z0-9-]+):([0-9]{1,5})$/;
const VHOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const CERT_FILE_RE = /^\/etc\/nginx\/oblimint\/certs\/[a-z0-9.-]{1,253}\/(fullchain|privkey)\.pem$/;
/** Characters allowed in a header value once sanitized (rendered inside double quotes). */
const HEADER_VALUE_RE = /^[\x20-\x7e]{0,512}$/;

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

/** True when `name` is a valid lower-case FQDN (punycode allowed, at least one dot). */
export function isValidServerName(name: string): boolean {
  return typeof name === 'string' && SERVER_NAME_RE.test(name);
}

/** True when `upstream` is `http(s)://<container-name>:<port>` (no path, no user info). */
export function isValidUpstream(upstream: string): boolean {
  const m = typeof upstream === 'string' ? UPSTREAM_RE.exec(upstream) : null;
  if (!m) return false;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535;
}

/** Throws EdgeConfigError when anything in the vhost is not strictly valid (H5). */
export function validateVhost(v: EdgeVhost): void {
  const id = typeof v?.id === 'string' ? v.id : '?';
  const fail = (msg: string): never => { throw new EdgeConfigError(sanitizeForNginx(id).slice(0, 64), msg); };
  if (!VHOST_ID_RE.test(id)) fail('invalid id');

  if (!Array.isArray(v.serverNames) || v.serverNames.length === 0) fail('no server name');
  const seenNames = new Set<string>();
  for (const name of v.serverNames) {
    if (!isValidServerName(name)) fail(`invalid server name ${JSON.stringify(String(name).slice(0, 80))}`);
    if (seenNames.has(name)) fail(`duplicate server name ${name}`);
    seenNames.add(name);
  }

  if (v.tls !== null) {
    if (!v.tls || !CERT_FILE_RE.test(v.tls.certPath) || !CERT_FILE_RE.test(v.tls.keyPath)) fail('invalid certificate path');
    if (v.tls.certPath.includes('..') || v.tls.keyPath.includes('..')) fail('invalid certificate path');
  }

  if (!Array.isArray(v.locations)) fail('no locations');
  const seenPrefixes = new Set<string>();
  for (const loc of v.locations) {
    const prefix = loc?.pathPrefix;
    if (typeof prefix !== 'string' || normalizePathPrefix(prefix) !== prefix) {
      fail(`invalid path prefix ${JSON.stringify(String(prefix).slice(0, 80))}`);
    }
    if (prefix.startsWith(ACME_CHALLENGE_PREFIX) || prefix.startsWith(ERROR_PAGES_PREFIX)) fail(`reserved path prefix ${prefix}`);
    if (seenPrefixes.has(prefix)) fail(`duplicate path prefix ${prefix}`);
    seenPrefixes.add(prefix);
    if (!isValidUpstream(loc.upstream)) fail(`invalid upstream ${JSON.stringify(String(loc.upstream).slice(0, 80))}`);
    if (!['site', 'secondary', 'preview', 'panel'].includes(loc.kind)) fail('invalid location kind');
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

/** Longest prefix first (ties: lexical) — nginx picks the longest `^~` match anyway; the order keeps diffs stable. */
export function sortLocations(locations: EdgeLocation[]): EdgeLocation[] {
  return [...locations].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length || a.pathPrefix.localeCompare(b.pathPrefix));
}

const I1 = '    ';
const I2 = '        ';

function acmeLocation(): string {
  return [
    `${I1}# ACME HTTP-01 — FIRST, never redirected nor proxied (Let's Encrypt issuance / renewal).`,
    `${I1}location ^~ ${ACME_CHALLENGE_PREFIX} {`,
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

function suspendedBlock(): string {
  return [
    `${I1}# Account suspended: every request answers 503 with the suspension page.`,
    `${I1}error_page 503 ${ERROR_PAGES_PREFIX}suspended.html;`,
    `${I1}location ^~ ${ERROR_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}alias ${EDGE_CONTAINER_PATHS.errorPages}/;`,
    `${I1}}`,
    `${I1}location / {`,
    `${I2}return 503;`,
    `${I1}}`,
  ].join('\n');
}

function proxyLocation(loc: EdgeLocation, index: number): string {
  const prefix = sanitizeForNginx(loc.pathPrefix);
  const upstream = sanitizeForNginx(loc.upstream);
  const variable = `$up_${index}`;
  const panel = loc.kind === 'panel';
  const lines = [
    `${I1}location ^~ ${prefix} {`,
    // proxy_pass through a variable: the name is resolved at REQUEST time
    // (resolver 127.0.0.11), so a stopped / missing site container never
    // breaks `nginx -t`. No URI part → the request URI is passed unchanged.
    `${I2}set ${variable} ${upstream};`,
    `${I2}proxy_pass ${variable};`,
    `${I2}proxy_http_version 1.1;`,
    `${I2}proxy_set_header Host $host;`,
    `${I2}proxy_set_header X-Real-IP $remote_addr;`,
    `${I2}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${I2}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${I2}proxy_set_header X-Forwarded-Host $host;`,
    `${I2}proxy_set_header Upgrade $http_upgrade;`,
    `${I2}proxy_set_header Connection $connection_upgrade;`,
    `${I2}proxy_connect_timeout 10s;`,
    `${I2}proxy_send_timeout ${panel ? 3600 : 300}s;`,
    `${I2}proxy_read_timeout ${panel ? 3600 : 300}s;`,
  ];
  if (upstream.startsWith('https://')) {
    // The panel serves a self-signed certificate on the internal network.
    lines.push(`${I2}proxy_ssl_verify off;`, `${I2}proxy_ssl_server_name on;`);
  }
  lines.push(`${I1}}`);
  if (prefix !== '/') {
    // `/shop` (no trailing slash) does not match `^~ /shop/`: redirect it.
    const bare = prefix.slice(0, -1);
    lines.push(`${I1}location = ${bare} {`, `${I2}return 301 ${prefix}$is_args$args;`, `${I1}}`);
  }
  return lines.join('\n');
}

function serverBody(v: EdgeVhost): string {
  if (v.suspended) return suspendedBlock();
  const parts = [errorPagesBlock()];
  const locations = sortLocations(v.locations);
  locations.forEach((loc, i) => parts.push(proxyLocation(loc, i)));
  if (!locations.some((l) => l.pathPrefix === '/')) {
    // Only sub-paths are routed: everything else is a 404 page, never the nginx default root.
    parts.push(`${I1}location / {\n${I2}return 404;\n${I1}}`);
  }
  return parts.join('\n\n');
}

function commonServerLines(v: EdgeVhost, names: string): string[] {
  return [
    `${I1}server_name ${names};`,
    `${I1}client_max_body_size ${v.clientMaxBodyMb}m;`,
  ];
}

function headerLines(v: EdgeVhost, https: boolean): string[] {
  const lines: string[] = [];
  // add_header only at server level (a location-level add_header would drop these).
  for (const [name, value] of Object.entries(v.extraHeaders).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${I1}add_header ${sanitizeForNginx(name)} "${sanitizeForNginx(value)}" always;`);
  }
  if (https && v.forceHttps) lines.push(`${I1}add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE}" always;`);
  return lines;
}

/** One vhost file (HTTP server with the ACME location FIRST, then HTTPS server when tls). Throws EdgeConfigError when invalid. */
export function renderVhost(vhost: EdgeVhost): string {
  validateVhost(vhost);
  const v = vhost;
  const names = v.serverNames.map(sanitizeForNginx).join(' ');
  const redirect = !!v.tls && v.forceHttps;
  const out: string[] = [];
  out.push(`# Managed by Oblimint (edge) — vhost ${sanitizeForNginx(v.id)}. Do not edit: rewritten at every sync.`);

  // ── HTTP ──
  const http: string[] = [
    'server {',
    `${I1}listen 80;`,
    `${I1}listen [::]:80;`,
    ...commonServerLines(v, names),
    '',
    acmeLocation(),
    '',
  ];
  if (redirect) {
    http.push(`${I1}location / {`, `${I2}return 301 https://$host$request_uri;`, `${I1}}`);
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

/** Certificate paths of a primary name as seen inside the edge container. */
export function edgeCertPaths(primaryName: string): { certPath: string; keyPath: string } {
  return {
    certPath: `${EDGE_CONTAINER_PATHS.certs}/${primaryName}/fullchain.pem`,
    keyPath: `${EDGE_CONTAINER_PATHS.certs}/${primaryName}/privkey.pem`,
  };
}
