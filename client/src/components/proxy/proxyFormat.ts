// Pure helpers of the proxy / bans / traffic / edge UI (no React, no i18n
// instance): validation rules mirrored from the server contract, small
// derivations. OWNED BY MODULE `ui-proxy`.

import type {
  Domain, EdgeUnitStatusKind, ProxyDeadHost, ProxyHost, ProxyRedirection, ProxyTarget,
} from '@oblimint/shared';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(v: string): boolean {
  return IPV4_RE.test(v);
}

/** Loose IPv6 check (hex groups, one `::`), enough to catch typos before the server. */
export function isIpv6(v: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(v) || !v.includes(':')) return false;
  const dbl = v.split('::');
  if (dbl.length > 2) return false;
  const groups = v.split(':').filter((g) => g !== '');
  if (groups.length > 8) return false;
  return groups.every((g, i) => (i === groups.length - 1 && g.includes('.') ? isIpv4(g) : /^[0-9a-fA-F]{1,4}$/.test(g)));
}

export function isIp(v: string): boolean {
  return isIpv4(v) || isIpv6(v);
}

/** IPv4 / IPv6 address or CIDR ('all' refused: an empty allow list is "everyone"). */
export function isValidCidr(input: string): boolean {
  const v = input.trim();
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined || !addr) return false;
  if (prefix === undefined) return isIp(addr);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const p = Number(prefix);
  if (isIpv4(addr)) return p >= 0 && p <= 32;
  if (isIpv6(addr)) return p >= 0 && p <= 128;
  return false;
}

/** Public host name (FQDN, lower case) or an IP literal. */
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidHostOrIp(v: string): boolean {
  const s = v.trim().toLowerCase();
  return HOSTNAME_RE.test(s) || isIp(s);
}

export function isValidHostname(v: string): boolean {
  return HOSTNAME_RE.test(v.trim().toLowerCase());
}

// ── Mirrors of server/src/services/proxy/validation.ts + the zod bounds of
// routes/proxy.routes.ts (keep in sync: the server refuses the whole PUT
// with a generic 'validation' error otherwise).

/** Sub-route path: '/api/' (prefix, trailing slash) or '/health' (exact), plain segments only. */
export const ROUTE_PATH_RE = /^(?:\/[A-Za-z0-9._~@:+-]{1,128}){1,16}\/?$/;
/** Rewrite prefix: '/' or a path like ROUTE_PATH_RE. */
export const REWRITE_PREFIX_RE = /^\/(?:[A-Za-z0-9._~@:+-]{1,128}\/?){0,16}$/;
/** Redirection target path ('/' allowed). */
export const TARGET_PATH_RE = /^\/(?:[A-Za-z0-9._~@:+%=&?-]{0,128}\/?){0,16}$/;
/** Prefixes no sub-route / bait may take (ACME, internal pages, forward-auth flow). */
export const RESERVED_PATH_PREFIXES: readonly string[] = ['/.well-known/acme-challenge', '/__oblimint', '/oauth2'];
export const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{0,512}$/;
const HEADER_VALUE_FORBIDDEN_RE = /[;{}'"`\\$#]/;
export const CORS_ORIGIN_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
/** Azure group (object id or name token). */
export const AUTH_GROUP_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Azure tenant: GUID, 'organizations' / 'common', or a verified domain. */
export const AZURE_TENANT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;

/** Request headers the panel sets itself (or that carry the forward-auth identity). */
const RESERVED_UPSTREAM_HEADERS = new Set([
  'host', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'upgrade', 'connection',
  'content-length', 'transfer-encoding', 'authorization', 'x-auth-user', 'x-auth-email', 'x-auth-groups', 'x-auth-preferred-username',
  'x-forwarded-user', 'x-forwarded-email', 'x-forwarded-groups', 'x-forwarded-preferred-username', 'remote-user', 'remote-email',
  'remote-name', 'remote-groups',
]);
/** Response headers managed by the panel (HSTS, CORS, cache status). */
const RESERVED_RESPONSE_HEADERS = new Set([
  'strict-transport-security', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-max-age', 'access-control-expose-headers', 'x-cache-status', 'content-length', 'transfer-encoding', 'connection',
]);

/** Numeric / count bounds of the proxy host schema. */
export const PROXY_HOST_LIMITS = {
  bodySizeMb: 10240,
  connectTimeoutSec: 75,
  timeoutSec: 3600,
  rps: 100000,
  burst: 10000,
  corsOrigins: 20,
  headers: 50,
  honeypotPaths: 100,
  routes: 50,
  allowedGroups: 50,
  allowedEmails: 100,
} as const;

const hasDotSegment = (p: string) => p.split('/').some((seg) => seg === '.' || seg === '..');

/** Sub-route path / honeypot bait (server isValidRoutePath). */
export function isValidRoutePath(v: string): boolean {
  const p = v.trim();
  if (!ROUTE_PATH_RE.test(p) || p.length > 255 || hasDotSegment(p)) return false;
  const lower = p.toLowerCase();
  return !RESERVED_PATH_PREFIXES.some((r) => lower.startsWith(r));
}

/**
 * Honeypot bait: a route path (server zod ROUTE_PATH_RE) that also passes the
 * renderer rule (server security/honeypotRender normalizeBaitPath):
 * [A-Za-z0-9._~/-] only, ≤ 200, no '//', never /__oblimint*, /oauth2,
 * /.well-known/acme-challenge.
 */
export function isValidBaitPath(v: string): boolean {
  const p = v.trim();
  if (!isValidRoutePath(p) || !/^\/[A-Za-z0-9._~/-]{1,199}$/.test(p) || p.includes('//')) return false;
  const under = (r: string) => p === r || p.startsWith(`${r}/`);
  return !p.startsWith('/__oblimint') && !under('/oauth2') && !under('/.well-known/acme-challenge');
}

export function isValidRewritePrefix(v: string): boolean {
  const p = v.trim();
  return REWRITE_PREFIX_RE.test(p) && p.length <= 255 && !hasDotSegment(p);
}

/** Redirection target path. */
export function isValidTargetPath(v: string): boolean {
  const p = v.trim();
  return TARGET_PATH_RE.test(p) && p.length <= 1024 && !hasDotSegment(p);
}

/** HTTP header name (letters, digits, '-'). */
export function isValidHeaderName(v: string): boolean {
  return HEADER_NAME_RE.test(v);
}

/** Response header a rule may add / remove (not managed by the panel). */
export function isAllowedResponseHeader(v: string): boolean {
  return HEADER_NAME_RE.test(v) && !RESERVED_RESPONSE_HEADERS.has(v.toLowerCase());
}

/** Request header the tenant may send to the target (not managed by the panel). */
export function isAllowedUpstreamHeader(v: string): boolean {
  return HEADER_NAME_RE.test(v) && !RESERVED_UPSTREAM_HEADERS.has(v.toLowerCase());
}

/** Header value: printable ASCII, ≤ 512, without ; { } quotes, backtick, backslash, $ or #. */
export function isValidHeaderValue(v: string): boolean {
  return HEADER_VALUE_RE.test(v) && !HEADER_VALUE_FORBIDDEN_RE.test(v);
}

/** CORS origin: http(s)://host[:port] (lower-cased by the server). */
export function isValidOrigin(v: string): boolean {
  return CORS_ORIGIN_RE.test(v.trim().toLowerCase());
}

/** Basic-auth user name of an access list. */
export function isValidUsername(v: string): boolean {
  return /^[A-Za-z0-9._@-]{1,64}$/.test(v.trim());
}

/** Group id / name token of a forward-auth (server AUTH_GROUP_RE). */
export function isValidGroup(v: string): boolean {
  return AUTH_GROUP_RE.test(v.trim());
}

/** Azure tenant: GUID, 'organizations' / 'common', or a tenant domain. */
export function isValidAzureTenant(v: string): boolean {
  return AZURE_TENANT_RE.test(v.trim());
}

/** Full address or a bare domain (allowed e-mails of a forward-auth). */
export function isValidEmailOrDomain(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s.includes('@')) return /^[a-z0-9._+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(s);
  return isValidHostname(s);
}

/** Azure tenant / client id (GUID), or a tenant domain (contoso.onmicrosoft.com). */
export function isGuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

/** Integer of a form field in [min, max], null otherwise. */
export function intIn(v: string, min: number, max: number): number | null {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Regional indicator flag of an ISO 3166-1 alpha-2 country code ('' when unknown). */
export function flagEmoji(cc: string | null | undefined): string {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

/** Duration in minutes → compact label parts ('permanent' when null). */
export function splitMinutes(min: number | null): { value: number; unit: 'min' | 'h' | 'd' } | null {
  if (min == null) return null;
  if (min % 1440 === 0) return { value: min / 1440, unit: 'd' };
  if (min % 60 === 0) return { value: min / 60, unit: 'h' };
  return { value: min, unit: 'min' };
}

/** Tone of an edge unit status pill. */
export function unitTone(s: EdgeUnitStatusKind): 'green' | 'amber' | 'red' | 'blue' | 'muted' {
  switch (s) {
    case 'active': return 'green';
    case 'pending': return 'blue';
    case 'quarantined': return 'amber';
    case 'upstreamUnreachable': return 'amber';
    case 'stub': return 'red';
    default: return 'muted';
  }
}

/** A unit the owner should look at (not served as desired). */
export function unitNeedsAttention(s: EdgeUnitStatusKind | null | undefined): boolean {
  return s === 'quarantined' || s === 'stub' || s === 'upstreamUnreachable';
}

/** Short label of a target when the server one is absent (host:port / stack:service). */
export function targetShort(tg: ProxyTarget): string {
  if (tg.kind === 'external') return `${tg.scheme}://${tg.host ?? '?'}:${tg.port}`;
  if (tg.kind === 'site') return `site #${tg.siteId ?? '?'}`;
  return `${tg.service ?? '?'}:${tg.port}`;
}

/** Proxy objects that bind domains (one consumer per domain, docs §8.1). */
export interface DomainBinding {
  kind: 'proxy' | 'redirect' | 'dead';
  id: number;
  label: string;
}

/** domainId → the proxy object that binds it. */
export function bindingsOf(hosts: ProxyHost[], redirections: ProxyRedirection[], deadHosts: ProxyDeadHost[]): Map<number, DomainBinding> {
  const out = new Map<number, DomainBinding>();
  for (const h of hosts) for (const d of h.domains) out.set(d.domainId, { kind: 'proxy', id: h.id, label: h.name });
  for (const r of redirections) for (const d of r.domains) out.set(d.domainId, { kind: 'redirect', id: r.id, label: `→ ${r.targetDomain}` });
  for (const x of deadHosts) for (const d of x.domains) out.set(d.domainId, { kind: 'dead', id: x.id, label: d.name });
  return out;
}

export type DomainUnavailable = 'notVerified' | 'siteRoutes' | 'bound' | null;

/**
 * Why a domain cannot be bound to the object `self` (null = available).
 * Domains already bound to `self` stay available (they are its own).
 */
export function domainUnavailable(d: Domain, bindings: Map<number, DomainBinding>, self: { kind: DomainBinding['kind']; id: number | null }): DomainUnavailable {
  const b = bindings.get(d.id);
  if (b && b.kind === self.kind && b.id === self.id) return null;
  if (b) return 'bound';
  if (d.routes.length > 0) return 'siteRoutes';
  if (d.verification.status !== 'verified') return 'notVerified';
  return null;
}

/** Lines of a textarea → trimmed, non-empty, de-duplicated values. */
export function linesOf(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

/** Ports reserved by the platform: never a stream port (ED5). */
export const RESERVED_STREAM_PORTS: readonly number[] = [22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 4190, 8081, 8443];

/** Escalation ladder minutes → label-free normalised list (null = permanent). */
export function parseEscalationField(v: string): number | null | undefined {
  const s = v.trim().toLowerCase();
  if (s === '' || s === '∞' || s === 'null' || s === 'permanent') return null;
  const n = intIn(s, 1, 525_600);
  return n === null ? undefined : n;
}

// ── Targets ──

export const EMPTY_TARGET: ProxyTarget = { kind: 'app', stackId: null, service: null, port: 0, scheme: 'http' };

/** True when the target has every field its kind needs. */
export function targetComplete(tg: ProxyTarget): boolean {
  if (!(tg.port >= 1 && tg.port <= 65535)) return false;
  if (tg.kind === 'app') return tg.stackId != null && !!tg.service;
  if (tg.kind === 'site') return tg.siteId != null;
  return !!tg.host && isValidHostOrIp(tg.host);
}
