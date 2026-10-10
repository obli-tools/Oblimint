import { banCheckLines } from '../security/honeypotRender';
import { ACME_CHALLENGE_PREFIX, EDGE_CONTAINER_PATHS, ERROR_PAGES_PREFIX, isValidCertPath, isValidServerNameEntry, sanitizeForNginx } from './nginxConfig';
import type { EdgeConfigUnit } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// 503 stub of an http server unit (docs/P4b-PLAN.md §8.3) — PURE. Served when
// a unit is refused and has no good version, or when its owner is disabled:
// it keeps the unit's server names (and certificate) so that its hosts never
// fall through to another vhost or the default server (Oblihub parity §1.1),
// still answers ACME HTTP-01 (issuance / renewal keep working) and logs with
// kind 'stub'. Nothing in it comes from the unit except validated names, ids
// and certificate paths.
// ─────────────────────────────────────────────────────────────────────────────

const I1 = '    ';
const I2 = '        ';

/** $oblimint_host of a stub: the proxy object id (proxy host / redirection / dead host), else "". */
function hostVar(u: Pick<EdgeConfigUnit, 'owner'>): string {
  const k = u.owner.kind;
  return (k === 'proxy-host' || k === 'redirection' || k === 'dead-host') && Number.isInteger(u.owner.id) && (u.owner.id ?? 0) > 0
    ? `"${Number(u.owner.id)}"` : '""';
}

function idVar(n: number | null | undefined): string {
  return Number.isInteger(n) && (n as number) > 0 ? `"${Number(n)}"` : '""';
}

function logLines(u: Pick<EdgeConfigUnit, 'owner'>): string[] {
  return [
    `${I2}set $oblimint_kind stub;`,
    `${I2}set $oblimint_site "";`,
    `${I2}set $oblimint_account ${idVar(u.owner.accountId)};`,
    `${I2}set $oblimint_tenant ${idVar(u.owner.tenantId)};`,
    `${I2}set $oblimint_host ${hostVar(u)};`,
    `${I2}set $oblimint_app "";`,
    `${I2}set $oblimint_hp "";`,
  ];
}

function body(u: Pick<EdgeConfigUnit, 'owner'>): string[] {
  return [
    // Server level: inherited by the internal error-page location too.
    `${I1}add_header Retry-After 120 always;`,
    `${I1}add_header Cache-Control "no-store" always;`,
    `${I1}location ^~ ${ACME_CHALLENGE_PREFIX} {`,
    ...logLines(u),
    `${I2}root ${EDGE_CONTAINER_PATHS.acmeWebroot};`,
    `${I2}default_type text/plain;`,
    `${I2}try_files $uri =404;`,
    `${I1}}`,
    `${I1}error_page 503 ${ERROR_PAGES_PREFIX}503.html;`,
    `${I1}location ^~ ${ERROR_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}alias ${EDGE_CONTAINER_PATHS.errorPages}/;`,
    `${I1}}`,
    `${I1}location / {`,
    ...logLines(u),
    `${I2}return 503;`,
    `${I1}}`,
  ];
}

/**
 * The stub configuration of an http server unit, or null when the unit
 * cannot have one (stream / global unit, no valid server name). `withTls`
 * false renders HTTP only (used when the certificate itself is the problem).
 */
export function renderStub(u: Pick<EdgeConfigUnit, 'id' | 'scope' | 'level' | 'owner' | 'serverNames' | 'tls'>, opts: { withTls?: boolean; reason?: 'refused' | 'disabled' } = {}): string | null {
  if (u.scope !== 'http' || u.level !== 'server') return null;
  const names = (u.serverNames ?? []).filter(isValidServerNameEntry)
    .map((n) => (n.startsWith('*.') ? `*.${sanitizeForNginx(n.slice(2))}` : sanitizeForNginx(n)));
  if (names.length === 0) return null;
  const tls = opts.withTls !== false && u.tls && isValidCertPath(u.tls.certPath) && isValidCertPath(u.tls.keyPath) ? u.tls : null;
  const serverName = `${I1}server_name ${names.join(' ')};`;
  const ban = banCheckLines(u.owner.accountId ?? null, I1);
  const out = [
    `# Oblimint edge stub of unit ${sanitizeForNginx(u.id)} (${opts.reason === 'disabled' ? 'owner disabled' : 'configuration refused'}): 503, names kept.`,
    ['server {', `${I1}listen 80;`, `${I1}listen [::]:80;`, serverName, ...ban, '', ...body(u), '}'].join('\n'),
  ];
  if (tls) {
    out.push([
      'server {', `${I1}listen 443 ssl;`, `${I1}listen [::]:443 ssl;`, `${I1}http2 on;`, serverName, ...ban,
      `${I1}ssl_certificate ${sanitizeForNginx(tls.certPath)};`,
      `${I1}ssl_certificate_key ${sanitizeForNginx(tls.keyPath)};`,
      `${I1}ssl_protocols TLSv1.2 TLSv1.3;`,
      '', ...body(u), '}',
    ].join('\n'));
  }
  return out.join('\n\n') + '\n';
}
