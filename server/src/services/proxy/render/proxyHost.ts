import type { ProxyHostHoneypot, ProxyHostOptions, ProxyHostSsl, ProxyRouteAccessMode, ProxyRouteAuthMode } from '@oblimint/shared';
import { AUTH_SIDECAR_PORT, authSidecarContainer } from '../../hosting/naming';
import { aclTrapLines, banCheckLines, honeypotLocationBlocks, type HoneypotRenderInput } from '../../security/honeypotRender';
import { ERROR_PAGES_PREFIX, isValidServerName, sanitizeForNginx } from '../../edge/nginxConfig';
import type { EdgeConfigUnit, EdgeUpstreamRef } from '../../edge/units';
import { hostPort, normalizeIp } from '../targets';
import {
  AUTH_EMAIL_RE, AUTH_GROUP_RE, CORS_ORIGIN_RE, escapeRegex, isAllowedResponseHeader, isAllowedUpstreamHeader, isSafeHeaderValue,
  isValidRewritePrefix, isValidRoutePath, uniq,
} from '../validation';
import { accessListBlock, type RenderAccessList } from './accessLists';
import {
  I1, I2, UNIT_PAGES_PREFIX, acmeLocation, builtinErrorPages, header, indent, isValidCertPath, listenLines, logLines, serverNameLine,
  tlsLines, unitPagesLocation, type LogContext,
} from './common';
import { BUILTIN_WAKING_PAGE, isCustomPageCode, renderPagePlaceholders } from './pages';

// ─────────────────────────────────────────────────────────────────────────────
// PURE rendering of one proxy host into its edge unit `ph-<id>` (docs/P4b-
// PLAN.md §8.8, parity Oblihub §1.2). One server pair (80 + 443 when the
// domain has a certificate on disk) PER BOUND DOMAIN, each with its own
// certificate. Body order (normative):
//   ban check (right after server_name) → ACME → honeypot baits → error pages
//   → exploit blocking (in the proxied locations) → access lists (union) →
//   ACL trap → forward-auth → sub-routes (longest first) → location / →
//   options → advancedConfig (staff).
// Every upstream goes through a variable set in its location (ED2); every
// value is validated here again and sanitized (H5): an invalid target throws
// ProxyRenderError (the provider skips the unit and reports it), an invalid
// optional value (header, origin, group…) is dropped.
// ─────────────────────────────────────────────────────────────────────────────

export class ProxyRenderError extends Error {
  constructor(public unitId: string, message: string) {
    super(`${unitId}: ${message}`);
    this.name = 'ProxyRenderError';
  }
}

export interface RenderTarget {
  scheme: 'http' | 'https';
  /** Container alias (internal) or public host / IP (external). */
  host: string;
  /**
   * External host NAME: the address resolved and validated by the provider
   * for this pass (PX2, DNS-rebinding pin). The upstream URL uses it, the name
   * stays for the Host header and the TLS name. Required for an external name
   * (an IP literal host needs none): nginx never resolves a tenant name.
   */
  address?: string | null;
  port: number;
  internal: boolean;
  appStackId: number | null;
  /** Target app stack sleeps when idle: 502–504 → waking page. */
  sleepEnabled: boolean;
}

export interface RenderDomain {
  domainId: number;
  name: string;
  /** Names kept for this unit (claimed ones already removed). */
  serverNames: string[];
  /** Certificate files as seen in the edge (null = HTTP only). */
  tls: { certPath: string; keyPath: string } | null;
  /** The certificate covers every server name (else no forced redirect). */
  tlsCoversAll: boolean;
}

export interface RenderRoute {
  path: string;
  rewritePrefix: string | null;
  target: RenderTarget;
  authMode: ProxyRouteAuthMode;
  accessListMode: ProxyRouteAccessMode;
  accessLists: RenderAccessList[];
  websocket: boolean | null;
  buffering: boolean | null;
}

export interface ProxyHostRenderInput {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  disabled: boolean;
  domains: RenderDomain[];
  target: RenderTarget;
  ssl: ProxyHostSsl;
  options: ProxyHostOptions;
  /** Effective client_max_body_size (MiB), already capped by the platform. */
  bodySizeMb: number;
  accessLists: RenderAccessList[];
  authProviderId: number | null;
  allowedGroups: string[];
  allowedEmails: string[];
  honeypot: ProxyHostHoneypot;
  routes: RenderRoute[];
  /** Custom error page (codes ⊂ CUSTOM_PAGE_CODES), null = built-in pages. */
  errorPage: { html: string; codes: number[] } | null;
  /** Custom waking page, null = built-in. */
  wakingPage: { html: string } | null;
  wakeEtaSec: number | null;
  /** Staff raw snippet (already linted), null = none. */
  advancedConfig: string | null;
  /** {{APP_NAME}} of the pages. */
  appName: string;
}

/** Shared cache zone (declared by the g-proxy unit). */
export const PROXY_CACHE_ZONE = 'oblimint_cache';
/** CA bundle of the edge image (images/edge) for verified https upstreams. */
export const EDGE_CA_BUNDLE = '/usr/share/oblimint/ca-certificates.crt';
export const HSTS_MAX_AGE_PROXY = 63072000;
/** Path of the forward-auth subrequest (internal). */
export const FA_AUTH_PATH = '/__oblimint_fa/auth';

export const proxyHostUnitId = (id: number): string => `ph-${Number(id)}`;
export const rateLimitZone = (id: number): string => `ph_${Number(id)}`;

const CONTAINER_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Validates a target; returns its upstream URL (http(s)://host:port). Throws ProxyRenderError. */
export function targetUpstream(unitId: string, t: RenderTarget): string {
  if (t.scheme !== 'http' && t.scheme !== 'https') throw new ProxyRenderError(unitId, 'invalid target scheme');
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new ProxyRenderError(unitId, 'invalid target port');
  let host: string;
  if (t.internal) {
    if (!CONTAINER_HOST_RE.test(t.host)) throw new ProxyRenderError(unitId, 'invalid internal target');
    host = t.host;
  } else {
    const ip = normalizeIp(t.host);
    if (ip) host = ip;
    else if (isValidServerName(t.host)) {
      // Pinned address (DNS rebinding, PX2): never a name nginx would resolve again at request time.
      const pinned = t.address ? normalizeIp(t.address) : null;
      if (!pinned) throw new ProxyRenderError(unitId, 'external target name not resolved');
      host = pinned;
    } else throw new ProxyRenderError(unitId, 'invalid external target');
  }
  return `${t.scheme}://${hostPort(sanitizeForNginx(host), t.port)}`;
}

/** Name for SNI / certificate checks of an https upstream. */
function tlsName(t: RenderTarget, upstreamHostHeader: string | null): string {
  if (upstreamHostHeader && isValidServerName(upstreamHostHeader)) return upstreamHostHeader;
  if (!t.internal && !normalizeIp(t.host)) return t.host;
  return t.internal ? t.host : '$host';
}

/** oauth2-proxy /oauth2/auth query restricting the host to groups / e-mails (ANDed with the provider's). */
export function forwardAuthQuery(groups: readonly string[], emails: readonly string[]): string {
  const g = uniq(groups.filter((x) => AUTH_GROUP_RE.test(x)));
  const e = uniq(emails.map((x) => x.toLowerCase()).filter((x) => AUTH_EMAIL_RE.test(x)));
  const addresses = e.filter((x) => x.includes('@'));
  const domains = e.filter((x) => !x.includes('@'));
  const params: string[] = [];
  if (g.length) params.push(`allowed_groups=${g.join(',')}`);
  if (addresses.length) params.push(`allowed_emails=${addresses.join(',')}`);
  if (domains.length) params.push(`allowed_email_domains=${domains.join(',')}`);
  return params.length ? `?${params.join('&')}` : '';
}

const IDENTITY_HEADERS: Array<[string, string]> = [
  ['X-Auth-User', '$oblimint_auth_user'],
  ['X-Auth-Email', '$oblimint_auth_email'],
  ['X-Auth-Groups', '$oblimint_auth_groups'],
  ['X-Auth-Preferred-Username', '$oblimint_auth_preferred_username'],
  ['X-Forwarded-User', '$oblimint_auth_user'],
  ['X-Forwarded-Email', '$oblimint_auth_email'],
  ['X-Forwarded-Groups', '$oblimint_auth_groups'],
  ['X-Forwarded-Preferred-Username', '$oblimint_auth_preferred_username'],
  ['Remote-User', '$oblimint_auth_user'],
  ['Remote-Email', '$oblimint_auth_email'],
  ['Remote-Name', '$oblimint_auth_preferred_username'],
  ['Remote-Groups', '$oblimint_auth_groups'],
];

interface LocationSpec {
  /** `location` modifier + path: '/' | '^~ /api/' | '= /health'. */
  match: string;
  target: RenderTarget;
  upstream: string;
  variable: string;
  websocket: boolean;
  buffering: boolean;
  /** Forward-auth applies in this location. */
  authActive: boolean;
  /** Route: auth_request off (host has forward-auth, route 'none'). */
  authOff: boolean;
  /** Access-list lines specific to this location (route none / override). */
  aclLines: string[];
  /** Basic auth applies here and the Authorization header must not reach the upstream. */
  stripAuthorization: boolean;
  rewrite: string | null;
  /**
   * Location-level error_page lines replacing the inherited server ones (nginx
   * semantics: any error_page in a location drops every inherited one) — used
   * where the server-level forward-auth `error_page 401` must not catch the
   * 401 challenge of this location's basic auth (route authMode none).
   */
  ownErrorPages: string[] | null;
}

function proxyLocation(input: ProxyHostRenderInput, ctx: LogContext, loc: LocationSpec): string[] {
  const o = input.options;
  const lines: string[] = [`${I1}location ${loc.match} {`, ...logLines(ctx, { appStackId: loc.target.appStackId })];
  if (o.blockExploits) lines.push(`${I2}if ($oblimint_exploit) { return 403; }`);
  if (loc.authOff) lines.push(`${I2}auth_request off;`);
  lines.push(...loc.aclLines);
  if (loc.ownErrorPages) lines.push(...loc.ownErrorPages);
  // The upstream variable is set BEFORE the rewrite: `rewrite … break` stops every later
  // ngx_http_rewrite_module directive of the location (`set` included) — the variable would stay empty (500).
  lines.push(`${I2}set ${loc.variable} "${loc.upstream}";`);
  if (loc.rewrite) lines.push(`${I2}${loc.rewrite}`);
  const hostHeader = o.preserveHost
    ? '$host'
    : (o.upstreamHostHeader && isValidServerName(o.upstreamHostHeader) ? o.upstreamHostHeader : hostPort(loc.target.host, loc.target.port));
  lines.push(
    // Through a variable, resolved at REQUEST time (resolver 127.0.0.11): a stopped target never breaks `nginx -t` (ED2).
    `${I2}proxy_pass ${loc.variable};`,
    `${I2}proxy_http_version 1.1;`,
    o.preserveHost ? `${I2}proxy_set_header Host $host;` : `${I2}proxy_set_header Host "${sanitizeForNginx(hostHeader)}";`,
    `${I2}proxy_set_header X-Real-IP $remote_addr;`,
    `${I2}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${I2}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${I2}proxy_set_header X-Forwarded-Host $host;`,
    `${I2}proxy_set_header X-Forwarded-Port $server_port;`,
  );
  if (loc.websocket) lines.push(`${I2}proxy_set_header Upgrade $http_upgrade;`, `${I2}proxy_set_header Connection $connection_upgrade;`);
  else lines.push(`${I2}proxy_set_header Connection "";`);
  // Identity of the forward-auth session, or emptied (a client never forges Remote-User & co).
  for (const [name, variable] of IDENTITY_HEADERS) lines.push(`${I2}proxy_set_header ${name} ${loc.authActive ? variable : '""'};`);
  if (loc.stripAuthorization) lines.push(`${I2}proxy_set_header Authorization "";`);
  for (const h of o.upstreamHeaders ?? []) {
    if (!isAllowedUpstreamHeader(h.name) || !isSafeHeaderValue(h.value)) continue;
    lines.push(`${I2}proxy_set_header ${sanitizeForNginx(h.name)} "${sanitizeForNginx(h.value)}";`);
  }
  lines.push(
    `${I2}proxy_connect_timeout ${clampInt(o.connectTimeoutSec, 1, 75, 10)}s;`,
    `${I2}proxy_send_timeout ${clampInt(o.sendTimeoutSec, 1, 3600, 60)}s;`,
    `${I2}proxy_read_timeout ${clampInt(o.readTimeoutSec, 1, 3600, 60)}s;`,
  );
  if (!loc.buffering) lines.push(`${I2}proxy_buffering off;`);
  if (!o.requestBuffering) lines.push(`${I2}proxy_request_buffering off;`);
  if (loc.target.scheme === 'https') {
    const name = tlsName(loc.target, o.upstreamHostHeader);
    lines.push(`${I2}proxy_ssl_server_name on;`, `${I2}proxy_ssl_name ${name === '$host' ? '$host' : sanitizeForNginx(name)};`);
    if (o.upstreamTlsVerify) {
      lines.push(`${I2}proxy_ssl_verify on;`, `${I2}proxy_ssl_verify_depth 4;`, `${I2}proxy_ssl_trusted_certificate ${EDGE_CA_BUNDLE};`);
    } else {
      lines.push(`${I2}proxy_ssl_verify off;`);
    }
  }
  if (o.cache) {
    lines.push(
      `${I2}proxy_cache ${PROXY_CACHE_ZONE};`,
      `${I2}proxy_cache_key "ph${Number(input.id)}$scheme$host$request_uri";`,
      `${I2}proxy_cache_valid 200 301 302 1d;`,
      `${I2}proxy_cache_bypass $oblimint_nocache;`,
      `${I2}proxy_no_cache $oblimint_nocache;`,
    );
  }
  // A sleeping target: the 502 / 504 nginx itself produces (container stopped, paused, not listening yet)
  // go through the waking page of the server. NO proxy_intercept_errors: it would send every upstream
  // error through the inherited server error_page (upstream 403 → ACL trap ban, 401 → forward-auth sign-in loop,
  // 404 → our page instead of the app's body).
  lines.push(`${I1}}`);
  return lines;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function hasIpRules(lists: readonly RenderAccessList[]): boolean {
  return lists.some((l) => (l.rules ?? []).length > 0);
}

/** Error page map code → internal URI (built-in, custom, waking). */
function errorPagePlan(input: ProxyHostRenderInput, trapArmed: boolean, waking: boolean): {
  byCode: Map<number, string>; builtin: boolean; files: Record<string, string>;
} {
  const byCode = new Map<number, string>([
    [404, `${ERROR_PAGES_PREFIX}404.html`],
    [502, `${ERROR_PAGES_PREFIX}502.html`],
    [504, `${ERROR_PAGES_PREFIX}502.html`],
    [503, `${ERROR_PAGES_PREFIX}503.html`],
  ]);
  const files: Record<string, string> = {};
  const host = input.domains[0]?.name ?? null;
  if (input.errorPage) {
    for (const code of uniq(input.errorPage.codes)) {
      if (!isCustomPageCode(code)) continue;
      byCode.set(code, `${UNIT_PAGES_PREFIX}${code}.html`);
      files[`pages/${code}.html`] = renderPagePlaceholders(input.errorPage.html, {
        code, appName: input.appName, proxyHostId: input.id, host, wakeEtaSec: input.wakeEtaSec,
      });
    }
  }
  if (waking) {
    for (const code of [502, 503, 504]) byCode.set(code, `${UNIT_PAGES_PREFIX}waking.html`);
    files['pages/waking.html'] = renderPagePlaceholders(input.wakingPage?.html ?? BUILTIN_WAKING_PAGE, {
      code: 503, appName: input.appName, proxyHostId: input.id, host, wakeEtaSec: input.wakeEtaSec,
    });
  }
  // The ACL trap owns 403 (its 404 then goes through the 404 page).
  if (trapArmed) byCode.delete(403);
  const builtin = [...byCode.values()].some((u) => u.startsWith(ERROR_PAGES_PREFIX));
  return { byCode, builtin, files };
}

function errorPageDirectives(plan: ReturnType<typeof errorPagePlan>, indent: string): string[] {
  const byUri = new Map<string, number[]>();
  for (const [code, uri] of [...plan.byCode].sort((a, b) => a[0] - b[0])) {
    const list = byUri.get(uri) ?? [];
    list.push(code);
    byUri.set(uri, list);
  }
  const lines: string[] = [];
  for (const [uri, codes] of byUri) lines.push(`${indent}error_page ${codes.join(' ')} ${uri};`);
  return lines;
}

function errorPageLines(plan: ReturnType<typeof errorPagePlan>, unitId: string): string[] {
  const lines = errorPageDirectives(plan, I1);
  if (plan.builtin) lines.push(...builtinErrorPages({ e404: false, e50x: false }));
  if (Object.keys(plan.files).length) lines.push(...unitPagesLocation(unitId));
  return lines;
}

function forwardAuthLines(input: ProxyHostRenderInput, ctx: LogContext): string[] {
  const pid = Number(input.authProviderId);
  const sidecar = `http://${authSidecarContainer(pid)}:${AUTH_SIDECAR_PORT}`;
  const query = forwardAuthQuery(input.allowedGroups, input.allowedEmails);
  return [
    `${I1}# Forward-auth (oauth2-proxy sidecar of provider ${pid}).`,
    `${I1}auth_request ${FA_AUTH_PATH};`,
    `${I1}auth_request_set $oblimint_auth_user $upstream_http_x_auth_request_user;`,
    `${I1}auth_request_set $oblimint_auth_email $upstream_http_x_auth_request_email;`,
    `${I1}auth_request_set $oblimint_auth_groups $upstream_http_x_auth_request_groups;`,
    `${I1}auth_request_set $oblimint_auth_preferred_username $upstream_http_x_auth_request_preferred_username;`,
    `${I1}error_page 401 = @oblimint_fa_signin;`,
    `${I1}location @oblimint_fa_signin {`,
    ...logLines(ctx),
    `${I2}return 302 /oauth2/start?rd=$scheme://$host$request_uri;`,
    `${I1}}`,
    `${I1}location = ${FA_AUTH_PATH} {`,
    `${I2}internal;`,
    `${I2}set $oblimint_fa_auth "${sidecar}/oauth2/auth${query}";`,
    `${I2}proxy_pass $oblimint_fa_auth;`,
    `${I2}proxy_pass_request_body off;`,
    `${I2}proxy_set_header Content-Length "";`,
    `${I2}proxy_set_header Host $host;`,
    `${I2}proxy_set_header X-Original-URI $request_uri;`,
    `${I2}proxy_set_header X-Forwarded-Host $host;`,
    `${I2}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${I2}proxy_set_header X-Forwarded-For $remote_addr;`,
    `${I2}proxy_buffer_size 64k;`,
    `${I2}proxy_buffers 4 64k;`,
    `${I2}proxy_busy_buffers_size 64k;`,
    `${I1}}`,
    `${I1}location ^~ /oauth2/ {`,
    ...logLines(ctx),
    `${I2}auth_request off;`,
    `${I2}set $oblimint_fa_up "${sidecar}";`,
    `${I2}proxy_pass $oblimint_fa_up;`,
    `${I2}proxy_http_version 1.1;`,
    `${I2}proxy_set_header Host $host;`,
    `${I2}proxy_set_header X-Real-IP $remote_addr;`,
    `${I2}proxy_set_header X-Forwarded-For $remote_addr;`,
    `${I2}proxy_set_header X-Forwarded-Host $host;`,
    `${I2}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${I2}proxy_buffer_size 64k;`,
    `${I2}proxy_buffers 4 64k;`,
    `${I1}}`,
  ];
}

function optionLines(input: ProxyHostRenderInput, https: boolean, tls: boolean): string[] {
  const o = input.options;
  const lines: string[] = [`${I1}client_max_body_size ${clampInt(input.bodySizeMb, 1, 10240, 100)}m;`];
  if (o.gzip) {
    lines.push(
      `${I1}gzip on;`, `${I1}gzip_vary on;`, `${I1}gzip_proxied any;`, `${I1}gzip_comp_level 6;`, `${I1}gzip_min_length 1000;`,
      `${I1}gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;`,
    );
  }
  if (o.rateLimit && Number.isInteger(o.rateLimit.rps) && o.rateLimit.rps > 0) {
    lines.push(`${I1}limit_req zone=${rateLimitZone(input.id)} burst=${clampInt(o.rateLimit.burst, 0, 10000, 10)} nodelay;`, `${I1}limit_req_status 429;`);
  }
  if (o.cache) lines.push(`${I1}add_header X-Cache-Status $upstream_cache_status always;`);
  if (o.cors) {
    const origins = uniq((o.corsOrigins ?? []).map((x) => x.toLowerCase()).filter((x) => CORS_ORIGIN_RE.test(x)));
    if (origins.length) {
      lines.push(
        `${I1}set $oblimint_cors "";`,
        `${I1}if ($http_origin ~* "^(?:${origins.map(escapeRegex).join('|')})$") { set $oblimint_cors $http_origin; }`,
        `${I1}add_header Access-Control-Allow-Origin $oblimint_cors always;`,
        `${I1}add_header Vary Origin always;`,
      );
    } else {
      lines.push(`${I1}add_header Access-Control-Allow-Origin "*" always;`);
    }
    lines.push(
      `${I1}add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS" always;`,
      `${I1}add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Origin, X-Requested-With" always;`,
      `${I1}add_header Access-Control-Max-Age 86400 always;`,
      `${I1}if ($request_method = OPTIONS) { return 204; }`,
    );
  }
  if (https && tls && input.ssl.hsts) {
    lines.push(`${I1}add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE_PROXY}${input.ssl.hstsSubdomains ? '; includeSubDomains' : ''}" always;`);
  }
  for (const h of o.headers ?? []) {
    if (!isAllowedResponseHeader(h.name)) continue;
    if (h.action === 'remove') lines.push(`${I1}proxy_hide_header ${sanitizeForNginx(h.name)};`);
    else if (isSafeHeaderValue(h.value)) lines.push(`${I1}add_header ${sanitizeForNginx(h.name)} "${sanitizeForNginx(h.value)}" always;`);
  }
  return lines;
}

/** Name of the ACL trap location (security/honeypotRender aclTrapLines). */
const ACL_TRAP_ERROR_PAGE = 'error_page 403 = @oblimint_acl_trap;';

/**
 * Bait locations open to everybody: the server-level access lists, basic auth
 * and forward-auth are inherited by every location whatever its place in the
 * text, so each bait cancels them itself (§8.8 « appâts honeypot, avant tout
 * contrôle d'accès ») — a scanner of a protected host still reaches the bait
 * (and its ban) instead of a 401 / 403 / sign-in redirect.
 */
function openBaitLocations(bait: string[], forwardAuth: boolean): string[] {
  const open = [`${I2}satisfy all;`, `${I2}allow all;`, `${I2}auth_basic off;`, ...(forwardAuth ? [`${I2}auth_request off;`] : [])];
  const out: string[] = [];
  for (const l of bait) {
    out.push(l);
    if (/^\s*location\s.*\{\s*$/.test(l)) out.push(...open);
  }
  return out;
}

/** Sub-route location match ('^~ /api/' or '= /health'). */
function routeMatch(path: string): string {
  return path.endsWith('/') ? `^~ ${path}` : `= ${path}`;
}

function routeRewrite(path: string, prefix: string | null): string | null {
  if (prefix === null) return null;
  if (path.endsWith('/')) {
    const to = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return `rewrite ^${escapeRegex(path)}(.*)$ ${to}$1 break;`;
  }
  return `rewrite ^ ${prefix} break;`;
}

/** The unit `ph-<id>` of a proxy host. Throws ProxyRenderError on an invalid target / route / certificate. */
export function renderProxyHostUnit(input: ProxyHostRenderInput): EdgeConfigUnit | null {
  const unitId = proxyHostUnitId(input.id);
  const domains = input.domains.filter((d) => d.serverNames.length > 0);
  if (!domains.length) return null;
  for (const d of domains) {
    if (d.tls && (!isValidCertPath(d.tls.certPath) || !isValidCertPath(d.tls.keyPath))) throw new ProxyRenderError(unitId, 'invalid certificate path');
  }
  const ctx: LogContext = { kind: 'proxy', accountId: input.accountId, tenantId: input.tenantId, objectId: input.id };
  const mainUpstream = targetUpstream(unitId, input.target);
  const routes = [...input.routes]
    .filter((r) => {
      if (!isValidRoutePath(r.path)) throw new ProxyRenderError(unitId, `invalid route path ${JSON.stringify(sanitizeForNginx(String(r.path)).slice(0, 80))}`);
      if (r.rewritePrefix !== null && !isValidRewritePrefix(r.rewritePrefix)) throw new ProxyRenderError(unitId, 'invalid rewrite prefix');
      return true;
    })
    .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  if (new Set(routes.map((r) => r.path)).size !== routes.length) throw new ProxyRenderError(unitId, 'duplicate route path');
  const routeUpstreams = routes.map((r) => targetUpstream(unitId, r.target));

  const files: Record<string, string> = {};
  const hostAcl = accessListBlock(input.accessLists, unitId, 'htpasswd', I1);
  if (hostAcl.htpasswd) files.htpasswd = hostAcl.htpasswd;
  const routeAcls = routes.map((r, i) => {
    // `satisfy all` everywhere a route owns its access: a host-level `satisfy any` must never turn
    // the route's `allow all` into a bypass of its basic auth or of the forward-auth.
    if (r.accessListMode === 'none') {
      return { lines: [`${I2}satisfy all;`, `${I2}allow all;`, `${I2}auth_basic off;`], hasIpRules: false, hasUsers: false, passAuth: true, htpasswd: null };
    }
    if (r.accessListMode === 'override') {
      const b = accessListBlock(r.accessLists, unitId, `htpasswd-route-${i}`, I2);
      if (b.htpasswd) files[`htpasswd-route-${i}`] = b.htpasswd;
      // Own allow/deny + realm replace the host's: without own IP rules `allow all` (else the host's
      // allow/deny are inherited), without own users `auth_basic off` (with users the block has its own
      // auth_basic — a second one in the same location fails nginx -t).
      const own: string[] = [];
      if (!(b.hasIpRules && b.hasUsers)) own.push(`${I2}satisfy all;`);
      if (!b.hasIpRules) own.push(`${I2}allow all;`);
      if (!b.hasUsers) own.push(`${I2}auth_basic off;`);
      return { ...b, lines: [...own, ...b.lines] };
    }
    return null;
  });

  const forwardAuth = input.authProviderId !== null && Number.isInteger(input.authProviderId) && input.authProviderId > 0;
  const trapArmed = !!input.honeypot?.banAclViolations
    && (hasIpRules(input.accessLists) || routes.some((r) => r.accessListMode === 'override' && hasIpRules(r.accessLists)));
  const waking = input.target.sleepEnabled || routes.some((r) => r.target.sleepEnabled);
  const pages = errorPagePlan(input, trapArmed, waking);
  Object.assign(files, pages.files);

  // Forward-auth catches every 401 of the server (error_page 401 → sign-in): a basic-auth challenge
  // under it would loop through the sign-in for ever. Refused at save time; never rendered.
  if (forwardAuth && hostAcl.hasUsers) throw new ProxyRenderError(unitId, 'forward-auth cannot be combined with access-list users');
  routes.forEach((r, i) => {
    const acl = routeAcls[i];
    if (forwardAuth && r.authMode !== 'none' && acl?.hasUsers) {
      throw new ProxyRenderError(unitId, `route ${r.path}: forward-auth cannot be combined with access-list users`);
    }
  });
  // Route without forward-auth but with basic auth on a forward-auth host: own error pages, no 401 → sign-in.
  const noSigninPages = [...errorPageDirectives(pages, I2), ...(trapArmed ? [`${I2}${ACL_TRAP_ERROR_PAGE}`] : [])];

  const honeypotInput: HoneypotRenderInput = {
    proxyHostId: input.id, accountId: input.accountId, tenantId: input.tenantId, honeypot: input.honeypot,
    routePaths: routes.map((r) => r.path), logKind: 'proxy',
  };

  const body = (https: boolean, tls: boolean): string[] => {
    const out: string[] = [];
    if (input.honeypot?.enabled && (input.honeypot.paths ?? []).length) {
      const bait = honeypotLocationBlocks(honeypotInput, I1);
      if (bait.length) out.push('', `${I1}# Honeypot baits (open: no access list, basic auth nor forward-auth).`, ...openBaitLocations(bait, forwardAuth));
    }
    out.push('', ...errorPageLines(pages, unitId));
    if (hostAcl.lines.length) out.push('', ...hostAcl.lines);
    if (trapArmed) {
      const trap = aclTrapLines(honeypotInput, I1);
      if (trap.length) out.push('', ...trap);
    }
    if (forwardAuth) out.push('', ...forwardAuthLines(input, ctx));

    // Sub-routes (longest first), then location /.
    const exactPaths = new Set(routes.filter((r) => !r.path.endsWith('/')).map((r) => r.path));
    routes.forEach((r, i) => {
      const acl = routeAcls[i];
      const usersHere = acl ? acl.hasUsers : hostAcl.hasUsers;
      const passAuth = acl ? acl.passAuth : hostAcl.passAuth;
      out.push('', ...proxyLocation(input, ctx, {
        match: routeMatch(r.path),
        target: r.target,
        upstream: routeUpstreams[i],
        variable: `$oblimint_up_r${i}`,
        websocket: r.websocket ?? input.options.websocket,
        buffering: r.buffering ?? input.options.buffering,
        authActive: forwardAuth && r.authMode !== 'none',
        authOff: forwardAuth && r.authMode === 'none',
        aclLines: acl ? acl.lines : [],
        stripAuthorization: usersHere && !passAuth,
        rewrite: routeRewrite(r.path, r.rewritePrefix),
        ownErrorPages: forwardAuth && r.authMode === 'none' && usersHere ? noSigninPages : null,
      }));
      // `/api` (no trailing slash) does not match `^~ /api/`: redirect it.
      const bare = r.path.endsWith('/') ? r.path.slice(0, -1) : null;
      if (bare && bare !== '' && !exactPaths.has(bare)) {
        out.push(`${I1}location = ${bare} {`, ...logLines(ctx, { appStackId: r.target.appStackId }), `${I2}return 301 ${r.path}$is_args$args;`, `${I1}}`);
      }
    });
    out.push('', ...proxyLocation(input, ctx, {
      match: '/',
      target: input.target,
      upstream: mainUpstream,
      variable: '$oblimint_up',
      websocket: input.options.websocket,
      buffering: input.options.buffering,
      authActive: forwardAuth,
      authOff: false,
      aclLines: [],
      stripAuthorization: hostAcl.hasUsers && !hostAcl.passAuth,
      rewrite: null,
      ownErrorPages: null,
    }));
    out.push('', `${I1}# Options`, ...optionLines(input, https, tls));
    if (input.advancedConfig && input.advancedConfig.trim()) {
      out.push('', `${I1}# Advanced configuration (platform staff, linted)`, ...indent(input.advancedConfig.replace(/\r/g, '').split('\n'), I1));
    }
    return out;
  };

  const blocks: string[] = [header('proxy host', input.id, input.name)];
  for (const d of domains) {
    const names = serverNameLine(d.serverNames);
    const tls = input.ssl.mode !== 'none' ? d.tls : null;
    const redirect = !!tls && input.ssl.forceSsl && d.tlsCoversAll;
    const http: string[] = ['server {', ...listenLines(false, false), names, ...banCheckLines(input.accountId, I1), '', ...acmeLocation(ctx)];
    if (redirect) {
      http.push('', `${I1}location / {`, ...logLines(ctx), `${I2}return 301 https://$host$request_uri;`, `${I1}}`);
    } else {
      http.push(...body(false, false));
    }
    http.push('}');
    blocks.push(http.join('\n'));
    if (tls) {
      blocks.push([
        'server {', ...listenLines(true, input.ssl.http2), names, ...banCheckLines(input.accountId, I1), ...tlsLines(tls), '',
        ...acmeLocation(ctx), ...body(true, true), '}',
      ].join('\n'));
    }
  }

  const upstreams: EdgeUpstreamRef[] = [];
  if (!input.options.skipUpstreamCheck) {
    const seen = new Set<string>();
    const add = (t: RenderTarget, where: string) => {
      // External name: probe the pinned address the configuration uses.
      const probeHost = !t.internal && t.address ? t.address : t.host;
      const key = `${probeHost}:${t.port}`;
      if (seen.has(key)) return;
      seen.add(key);
      upstreams.push({ internal: t.internal, host: probeHost, port: t.port, protocol: 'tcp', where, appStackId: t.appStackId });
    };
    add(input.target, 'location /');
    routes.forEach((r) => add(r.target, `route ${r.path}`));
  }

  const firstTls = domains.map((d) => (input.ssl.mode !== 'none' ? d.tls : null)).find((t) => !!t) ?? null;
  return {
    id: unitId,
    scope: 'http',
    level: 'server',
    owner: { kind: 'proxy-host', id: input.id, accountId: input.accountId, tenantId: input.tenantId, label: domains[0].serverNames[0] },
    serverNames: domains.flatMap((d) => d.serverNames),
    listen: [],
    tls: firstTls,
    config: blocks.join('\n\n') + '\n',
    files,
    upstreams,
    rawSnippets: input.advancedConfig && input.advancedConfig.trim() ? [input.advancedConfig] : [],
    ...(input.disabled ? { disabled: true } : {}),
  };
}

