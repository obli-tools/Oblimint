import { ACME_CHALLENGE_PREFIX, EDGE_CONTAINER_PATHS, ERROR_PAGES_PREFIX, isValidServerNameEntry, sanitizeForNginx } from '../../edge/nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// PURE building blocks shared by the proxy-hosts renderers (docs/P4b-PLAN.md
// §8.2, §8.7, §8.8). Conventions of the edge contract (edge/units.ts):
//   - every location we own that is not `internal` sets the seven access-log
//     variables ($oblimint_kind, _site, _account, _tenant, _host, _app, _hp);
//     internal error-page / auth locations set nothing (an internal redirect
//     keeps the values of the location that failed: the 502 of a sleeping app
//     must still carry its $oblimint_app);
//   - every proxy_pass goes through a variable `set` in the same location;
//   - aux files are referenced as /etc/nginx/oblimint/aux/<unit>/<name>.
// ─────────────────────────────────────────────────────────────────────────────

export const I1 = '    ';
export const I2 = '        ';
export const I3 = '            ';

export type ProxyLogKind = 'proxy' | 'proxy-redirect' | 'dead' | 'stream';

export interface LogContext {
  kind: ProxyLogKind;
  accountId: number | null;
  tenantId: number | null;
  /** Object id (proxy host / redirection / dead host / stream). */
  objectId: number;
}

/** Container-side directory of a unit's aux files. */
export const AUX_ROOT = '/etc/nginx/oblimint/aux';
export const auxPath = (unitId: string, name: string): string => `${AUX_ROOT}/${unitId}/${name}`;

/** Container-side paths of an imported certificate (files written by proxy-hosts). */
export function importedCertPaths(certId: number): { certPath: string; keyPath: string } {
  return {
    certPath: `${EDGE_CONTAINER_PATHS.certs}/imported-${Number(certId)}/fullchain.pem`,
    keyPath: `${EDGE_CONTAINER_PATHS.certs}/imported-${Number(certId)}/privkey.pem`,
  };
}

/** Allowed TLS file paths: ACME `<name>/` or `imported-<id>/` under the edge certs directory. */
const CERT_FILE_RE = /^\/etc\/nginx\/oblimint\/certs\/(?:[a-z0-9.-]{1,253}|imported-[0-9]{1,10})\/(fullchain|privkey)\.pem$/;
export function isValidCertPath(p: string): boolean {
  return typeof p === 'string' && CERT_FILE_RE.test(p) && !p.includes('..');
}

const num = (n: number | null): string => (n === null || !Number.isInteger(n) ? '""' : `"${Number(n)}"`);

/** The seven `set` lines of the access log (inside a location). appStackId null = "". */
export function logLines(ctx: LogContext, opts: { appStackId?: number | null; indent?: string } = {}): string[] {
  const i = opts.indent ?? I2;
  return [
    `${i}set $oblimint_kind ${ctx.kind};`,
    `${i}set $oblimint_site "";`,
    `${i}set $oblimint_account ${num(ctx.accountId)};`,
    `${i}set $oblimint_tenant ${num(ctx.tenantId)};`,
    `${i}set $oblimint_host ${num(ctx.objectId)};`,
    `${i}set $oblimint_app ${num(opts.appStackId ?? null)};`,
    `${i}set $oblimint_hp "";`,
  ];
}

/** server_name entries kept (valid entries only, sanitized). */
export function serverNameLine(names: readonly string[]): string {
  const kept = names.filter(isValidServerNameEntry).map((n) => (n.startsWith('*.') ? `*.${sanitizeForNginx(n.slice(2))}` : sanitizeForNginx(n)));
  return `${I1}server_name ${kept.join(' ')};`;
}

export function listenLines(https: boolean, http2: boolean): string[] {
  if (!https) return [`${I1}listen 80;`, `${I1}listen [::]:80;`];
  return [`${I1}listen 443 ssl;`, `${I1}listen [::]:443 ssl;`, ...(http2 ? [`${I1}http2 on;`] : [])];
}

export function tlsLines(tls: { certPath: string; keyPath: string }): string[] {
  return [
    `${I1}ssl_certificate ${sanitizeForNginx(tls.certPath)};`,
    `${I1}ssl_certificate_key ${sanitizeForNginx(tls.keyPath)};`,
    `${I1}ssl_protocols TLSv1.2 TLSv1.3;`,
    `${I1}ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';`,
    `${I1}ssl_prefer_server_ciphers off;`,
  ];
}

/**
 * ACME HTTP-01 — the FIRST location, never redirected, proxied, nor gated by
 * an access list / forward-auth (Let's Encrypt must always reach the token).
 */
export function acmeLocation(ctx: LogContext): string[] {
  return [
    `${I1}location ^~ ${ACME_CHALLENGE_PREFIX} {`,
    ...logLines(ctx),
    `${I2}allow all;`,
    `${I2}auth_basic off;`,
    `${I2}auth_request off;`,
    `${I2}root ${EDGE_CONTAINER_PATHS.acmeWebroot};`,
    `${I2}default_type text/plain;`,
    `${I2}try_files $uri =404;`,
    `${I1}}`,
  ];
}

/** Built-in error pages of the edge image (P1 contract): 404, 502 (502 + 504), 503. */
export function builtinErrorPages(codes: { e404: boolean; e50x: boolean }): string[] {
  const lines: string[] = [];
  if (codes.e404) lines.push(`${I1}error_page 404 ${ERROR_PAGES_PREFIX}404.html;`);
  if (codes.e50x) lines.push(`${I1}error_page 502 504 ${ERROR_PAGES_PREFIX}502.html;`, `${I1}error_page 503 ${ERROR_PAGES_PREFIX}503.html;`);
  lines.push(
    `${I1}location ^~ ${ERROR_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}allow all;`,
    `${I2}auth_basic off;`,
    `${I2}auth_request off;`,
    `${I2}alias ${EDGE_CONTAINER_PATHS.errorPages}/;`,
    `${I1}}`,
  );
  return lines;
}

/** Internal prefix of a unit's own pages (custom error pages, waking page): /__oblimint_px/ → aux/<unit>/pages/. */
export const UNIT_PAGES_PREFIX = '/__oblimint_px/';

export function unitPagesLocation(unitId: string): string[] {
  return [
    `${I1}location ^~ ${UNIT_PAGES_PREFIX} {`,
    `${I2}internal;`,
    `${I2}allow all;`,
    `${I2}auth_basic off;`,
    `${I2}auth_request off;`,
    `${I2}default_type text/html;`,
    `${I2}charset utf-8;`,
    `${I2}alias ${AUX_ROOT}/${unitId}/pages/;`,
    `${I1}}`,
  ];
}

/** Indents every line of a block by `extra`. */
export function indent(lines: readonly string[], extra: string): string[] {
  return lines.map((l) => (l ? extra + l : l));
}

export function header(kind: string, id: number, label: string): string {
  return `# Managed by Oblimint (proxy-hosts) — ${kind} ${Number(id)} (${sanitizeForNginx(label).slice(0, 120)}). Do not edit: rewritten at every sync.`;
}
