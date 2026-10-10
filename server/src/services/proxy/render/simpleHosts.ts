import { isValidServerName, sanitizeForNginx } from '../../edge/nginxConfig';
import type { EdgeConfigUnit } from '../../edge/units';
import { banCheckLines } from '../../security/honeypotRender';
import { normalizeIp } from '../targets';
import { isValidTargetPath } from '../validation';
import {
  I1, I2, UNIT_PAGES_PREFIX, acmeLocation, builtinErrorPages, header, isValidCertPath, listenLines, logLines, serverNameLine, tlsLines,
  unitPagesLocation, type LogContext,
} from './common';
import { renderPagePlaceholders } from './pages';
import { ProxyRenderError, type RenderDomain } from './proxyHost';

// ─────────────────────────────────────────────────────────────────────────────
// PURE rendering of the redirections (`rd-<id>`) and dead hosts (`dh-<id>`)
// (docs/P4b-PLAN.md §8.8, Oblihub §1.4 / §1.6). One server pair per bound
// domain (own certificate), ACME first, ban check right after server_name.
// ─────────────────────────────────────────────────────────────────────────────

export interface RedirectionRenderInput {
  id: number;
  accountId: number;
  tenantId: number;
  disabled: boolean;
  domains: RenderDomain[];
  targetScheme: 'http' | 'https' | 'auto';
  targetDomain: string;
  targetPath: string | null;
  preservePath: boolean;
  statusCode: 301 | 302 | 307 | 308;
  ssl: { forceSsl: boolean; http2: boolean; hsts: boolean };
}

export interface DeadHostRenderInput {
  id: number;
  accountId: number;
  tenantId: number;
  disabled: boolean;
  domains: RenderDomain[];
  ssl: { forceSsl: boolean; http2: boolean };
  /** Custom 404 page HTML (placeholders not yet replaced), null = built-in. */
  page: { html: string } | null;
  appName: string;
}

export const redirectionUnitId = (id: number): string => `rd-${Number(id)}`;
export const deadHostUnitId = (id: number): string => `dh-${Number(id)}`;

/** `return` target of a redirection (validated; throws ProxyRenderError). */
export function redirectTarget(unitId: string, r: Pick<RedirectionRenderInput, 'targetScheme' | 'targetDomain' | 'targetPath' | 'preservePath'>): string {
  const domain = String(r.targetDomain ?? '').toLowerCase();
  const ip = normalizeIp(domain);
  if (!ip && !isValidServerName(domain)) throw new ProxyRenderError(unitId, 'invalid target domain');
  const host = ip ? (ip.includes(':') ? `[${ip}]` : ip) : domain;
  if (r.targetPath !== null && !isValidTargetPath(r.targetPath)) throw new ProxyRenderError(unitId, 'invalid target path');
  const scheme = r.targetScheme === 'auto' ? '$scheme' : r.targetScheme === 'http' ? 'http' : 'https';
  let path = r.targetPath ?? '';
  if (r.preservePath && path.endsWith('/')) path = path.slice(0, -1);
  return `${scheme}://${sanitizeForNginx(host)}${sanitizeForNginx(path)}${r.preservePath ? '$request_uri' : ''}`;
}

function checkDomains(unitId: string, domains: RenderDomain[]): RenderDomain[] {
  const kept = domains.filter((d) => d.serverNames.length > 0);
  for (const d of kept) {
    if (d.tls && (!isValidCertPath(d.tls.certPath) || !isValidCertPath(d.tls.keyPath))) throw new ProxyRenderError(unitId, 'invalid certificate path');
  }
  return kept;
}

export function renderRedirectionUnit(input: RedirectionRenderInput): EdgeConfigUnit | null {
  const unitId = redirectionUnitId(input.id);
  const domains = checkDomains(unitId, input.domains);
  if (!domains.length) return null;
  if (![301, 302, 307, 308].includes(input.statusCode)) throw new ProxyRenderError(unitId, 'invalid status code');
  const target = redirectTarget(unitId, input);
  const ctx: LogContext = { kind: 'proxy-redirect', accountId: input.accountId, tenantId: input.tenantId, objectId: input.id };
  const redirectLocation = [`${I1}location / {`, ...logLines(ctx), `${I2}return ${input.statusCode} ${target};`, `${I1}}`];
  const blocks: string[] = [header('redirection', input.id, domains[0].serverNames[0])];
  for (const d of domains) {
    const names = serverNameLine(d.serverNames);
    const toHttps = !!d.tls && input.ssl.forceSsl && d.tlsCoversAll;
    blocks.push([
      'server {', ...listenLines(false, false), names, ...banCheckLines(input.accountId, I1), '', ...acmeLocation(ctx), '',
      ...(toHttps ? [`${I1}location / {`, ...logLines(ctx), `${I2}return 301 https://$host$request_uri;`, `${I1}}`] : redirectLocation),
      '}',
    ].join('\n'));
    if (d.tls) {
      blocks.push([
        'server {', ...listenLines(true, input.ssl.http2), names, ...banCheckLines(input.accountId, I1), ...tlsLines(d.tls),
        ...(input.ssl.hsts ? [`${I1}add_header Strict-Transport-Security "max-age=63072000" always;`] : []), '',
        ...acmeLocation(ctx), '', ...redirectLocation, '}',
      ].join('\n'));
    }
  }
  return {
    id: unitId,
    scope: 'http',
    level: 'server',
    owner: { kind: 'redirection', id: input.id, accountId: input.accountId, tenantId: input.tenantId, label: domains[0].serverNames[0] },
    serverNames: domains.flatMap((d) => d.serverNames),
    listen: [],
    tls: domains.find((d) => d.tls)?.tls ?? null,
    config: blocks.join('\n\n') + '\n',
    files: {},
    upstreams: [],
    rawSnippets: [],
    ...(input.disabled ? { disabled: true } : {}),
  };
}

export function renderDeadHostUnit(input: DeadHostRenderInput): EdgeConfigUnit | null {
  const unitId = deadHostUnitId(input.id);
  const domains = checkDomains(unitId, input.domains);
  if (!domains.length) return null;
  const ctx: LogContext = { kind: 'dead', accountId: input.accountId, tenantId: input.tenantId, objectId: input.id };
  const files: Record<string, string> = {};
  if (input.page) {
    files['pages/404.html'] = renderPagePlaceholders(input.page.html, {
      code: 404, appName: input.appName, proxyHostId: input.id, host: domains[0].name, wakeEtaSec: null,
    });
  }
  const pages = input.page
    ? [`${I1}error_page 404 ${UNIT_PAGES_PREFIX}404.html;`, ...unitPagesLocation(unitId)]
    : builtinErrorPages({ e404: true, e50x: false });
  const body = [...pages, '', `${I1}location / {`, ...logLines(ctx), `${I2}return 404;`, `${I1}}`];
  const blocks: string[] = [header('dead host', input.id, domains[0].serverNames[0])];
  for (const d of domains) {
    const names = serverNameLine(d.serverNames);
    const toHttps = !!d.tls && input.ssl.forceSsl && d.tlsCoversAll;
    blocks.push([
      'server {', ...listenLines(false, false), names, ...banCheckLines(input.accountId, I1), '', ...acmeLocation(ctx), '',
      ...(toHttps ? [`${I1}location / {`, ...logLines(ctx), `${I2}return 301 https://$host$request_uri;`, `${I1}}`] : body),
      '}',
    ].join('\n'));
    if (d.tls) {
      blocks.push([
        'server {', ...listenLines(true, input.ssl.http2), names, ...banCheckLines(input.accountId, I1), ...tlsLines(d.tls), '',
        ...acmeLocation(ctx), '', ...body, '}',
      ].join('\n'));
    }
  }
  return {
    id: unitId,
    scope: 'http',
    level: 'server',
    owner: { kind: 'dead-host', id: input.id, accountId: input.accountId, tenantId: input.tenantId, label: domains[0].serverNames[0] },
    serverNames: domains.flatMap((d) => d.serverNames),
    listen: [],
    tls: domains.find((d) => d.tls)?.tls ?? null,
    config: blocks.join('\n\n') + '\n',
    files,
    upstreams: [],
    rawSnippets: [],
    ...(input.disabled ? { disabled: true } : {}),
  };
}
