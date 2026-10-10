import { isValidServerName } from '../edge/nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// PURE value rules of the proxy objects (docs/P4b-PLAN.md §8.8, invariant PX3 /
// H5). Used twice: by the zod schemas of routes/proxy.routes.ts (API refusal)
// and again by the renderers (defence in depth: a value that slipped through
// is dropped, never written). Every regex only lets through characters that
// cannot break out of an nginx token (no space, ; { } quotes $ # \ newline).
// ─────────────────────────────────────────────────────────────────────────────

/** Sub-route path: '/api/' (prefix, trailing slash) or '/health' (exact), plain segments only. */
export const ROUTE_PATH_RE = /^(?:\/[A-Za-z0-9._~@:+-]{1,128}){1,16}\/?$/;
/** Rewrite prefix: '/' or a path like ROUTE_PATH_RE. */
export const REWRITE_PREFIX_RE = /^\/(?:[A-Za-z0-9._~@:+-]{1,128}\/?){0,16}$/;
/** Redirection target path ('/' allowed). */
export const TARGET_PATH_RE = /^\/(?:[A-Za-z0-9._~@:+%=&?-]{0,128}\/?){0,16}$/;
/** HTTP header name. */
export const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Header value: printable ASCII without the characters that break an nginx string. */
export const HEADER_VALUE_RE = /^[\x20-\x7e]{0,512}$/;
const HEADER_VALUE_FORBIDDEN_RE = /[;{}'"`\\$#]/;
/** CORS origin: scheme + host [+ port]. */
export const CORS_ORIGIN_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
/** Azure group (object id or name token). */
export const AUTH_GROUP_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Allowed e-mail entry: full address or domain. */
export const AUTH_EMAIL_RE = /^(?:[a-z0-9._+-]{1,64}@)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Basic-auth user name (htpasswd: never ':'). */
export const ACCESS_USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
/** Azure tenant: GUID, 'organizations' / 'common', or a verified domain. */
export const AZURE_TENANT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;
export const AZURE_CLIENT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Request headers the tenant may NOT set towards the upstream: the panel sets
 * them itself (Host, forwarding headers, websocket upgrade) or they carry the
 * forward-auth identity (spoofing).
 */
const RESERVED_UPSTREAM_HEADERS = new Set([
  'host', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'upgrade', 'connection',
  'content-length', 'transfer-encoding', 'authorization', 'x-auth-user', 'x-auth-email', 'x-auth-groups', 'x-auth-preferred-username',
  'x-forwarded-user', 'x-forwarded-email', 'x-forwarded-groups', 'x-forwarded-preferred-username', 'remote-user', 'remote-email',
  'remote-name', 'remote-groups',
]);

/** Response headers managed by the panel (HSTS, CORS, cache status): not addable / removable by a tenant rule. */
const RESERVED_RESPONSE_HEADERS = new Set([
  'strict-transport-security', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-max-age', 'access-control-expose-headers', 'x-cache-status', 'content-length', 'transfer-encoding', 'connection',
]);

/** Prefixes no sub-route may take (ACME, internal error pages, forward-auth flow, edge internals). */
export const RESERVED_PATH_PREFIXES = ['/.well-known/acme-challenge', '/__oblimint', '/oauth2'];

export function isValidRoutePath(p: unknown): p is string {
  if (typeof p !== 'string' || !ROUTE_PATH_RE.test(p) || p.length > 255) return false;
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  const lower = p.toLowerCase();
  return !RESERVED_PATH_PREFIXES.some((r) => lower === r || lower.startsWith(`${r}/`) || lower.startsWith(r));
}

export function isValidRewritePrefix(p: unknown): p is string {
  if (typeof p !== 'string' || !REWRITE_PREFIX_RE.test(p) || p.length > 255) return false;
  return !p.split('/').some((seg) => seg === '.' || seg === '..');
}

export function isValidTargetPath(p: unknown): p is string {
  if (typeof p !== 'string' || !TARGET_PATH_RE.test(p) || p.length > 1024) return false;
  return !p.split('/').some((seg) => seg === '.' || seg === '..');
}

export function isSafeHeaderValue(v: unknown): v is string {
  return typeof v === 'string' && HEADER_VALUE_RE.test(v) && !HEADER_VALUE_FORBIDDEN_RE.test(v);
}

export function isAllowedUpstreamHeader(name: string): boolean {
  return HEADER_NAME_RE.test(name) && !RESERVED_UPSTREAM_HEADERS.has(name.toLowerCase());
}

export function isAllowedResponseHeader(name: string): boolean {
  return HEADER_NAME_RE.test(name) && !RESERVED_RESPONSE_HEADERS.has(name.toLowerCase());
}

/** External target host: a public-looking FQDN (lower case) or an IP literal (validated by targets.ts). */
export function isValidHostName(h: unknown): h is string {
  return typeof h === 'string' && isValidServerName(h);
}

/** Regex-escape a path for an nginx `rewrite` (path charset of ROUTE_PATH_RE only). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Dedupe keeping order. */
export function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
