import type { EdgeConfigUnit } from '../../edge/units';
import { I1, header, logLines, type LogContext } from './common';
import { PROXY_CACHE_ZONE, ProxyRenderError, rateLimitZone, targetUpstream, type RenderTarget } from './proxyHost';

// ─────────────────────────────────────────────────────────────────────────────
// PURE rendering of the TCP / UDP streams (`st-<id>`, stream{} scope) and of
// the global unit `g-proxy` (http{} level: cache zone, maps used by the proxy
// hosts, one limit_req_zone per rate-limited host) — docs/P4b-PLAN.md §8.2,
// §8.8. Streams: proxy_pass through a variable (fixes Oblihub's literal one,
// ED2), a server-level resolver (the stream{} context of the image may have
// none), ports ∈ settings edge.streamPorts (ED5, checked by the caller and
// again here).
// ─────────────────────────────────────────────────────────────────────────────

export const streamUnitId = (id: number): string => `st-${Number(id)}`;
export const GLOBAL_PROXY_UNIT_ID = 'g-proxy';
/** Writable cache directory of the edge (tmpfs / volume of the image, docs §8.2 — outside the RO config tree). */
export const PROXY_CACHE_PATH = '/var/cache/nginx/oblimint';

export interface StreamRenderInput {
  id: number;
  accountId: number | null;
  tenantId: number;
  name: string;
  disabled: boolean;
  incomingPort: number;
  tcp: boolean;
  udp: boolean;
  target: RenderTarget;
  /** Platform-approved ports (settings edge.streamPorts). */
  approvedPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

export function renderStreamUnit(input: StreamRenderInput): EdgeConfigUnit | null {
  const unitId = streamUnitId(input.id);
  const port = Number(input.incomingPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyRenderError(unitId, 'invalid incoming port');
  const protocols = (['tcp', 'udp'] as const).filter((p) => (p === 'tcp' ? input.tcp : input.udp))
    .filter((p) => input.approvedPorts.some((a) => a.port === port && a.protocol === p));
  if (!protocols.length) return null;
  // Validates the target (scheme ignored in stream{}): host + port only — an external name goes through its pinned address.
  const upstream = targetUpstream(unitId, { ...input.target, scheme: 'http' }).slice('http://'.length);
  const probeHost = !input.target.internal && input.target.address ? input.target.address : input.target.host;
  const ctx: LogContext = { kind: 'stream', accountId: input.accountId, tenantId: input.tenantId, objectId: input.id };
  const listen = protocols.flatMap((p) => (p === 'udp'
    ? [`${I1}listen ${port} udp;`, `${I1}listen [::]:${port} udp;`]
    : [`${I1}listen ${port};`, `${I1}listen [::]:${port};`]));
  const config = [
    header('stream', input.id, input.name),
    'server {',
    ...listen,
    `${I1}resolver 127.0.0.11 valid=10s ipv6=off;`,
    ...logLines(ctx, { appStackId: input.target.appStackId, indent: I1 }),
    `${I1}set $oblimint_st_up "${upstream}";`,
    `${I1}proxy_pass $oblimint_st_up;`,
    `${I1}proxy_connect_timeout 10s;`,
    `${I1}proxy_timeout 10m;`,
    '}',
  ].join('\n') + '\n';
  return {
    id: unitId,
    scope: 'stream',
    level: 'server',
    owner: { kind: 'stream', id: input.id, accountId: input.accountId, tenantId: input.tenantId, label: `${port}/${protocols.join('+')}` },
    serverNames: [],
    listen: protocols.map((p) => ({ port, protocol: p })),
    tls: null,
    config,
    files: {},
    upstreams: protocols.map((p) => ({
      internal: input.target.internal, host: probeHost, port: input.target.port, protocol: p,
      where: `stream ${port}/${p}`, appStackId: input.target.appStackId,
    })),
    rawSnippets: [],
    ...(input.disabled ? { disabled: true } : {}),
  };
}

/** Static part of g-proxy (also its fallback): cache zone + the maps the server units reference. */
export function globalProxyStatic(): string {
  return [
    `# Managed by Oblimint (proxy-hosts) — global unit ${GLOBAL_PROXY_UNIT_ID}. Do not edit: rewritten at every sync.`,
    `proxy_cache_path ${PROXY_CACHE_PATH} levels=1:2 keys_zone=${PROXY_CACHE_ZONE}:10m max_size=1g inactive=1d use_temp_path=off;`,
    '# Static assets cached by the proxy hosts with the cache option (0 = cacheable).',
    'map $uri $oblimint_nocache {',
    '    default 1;',
    '    "~*\\.(?:css|js|mjs|jpe?g|png|gif|ico|svg|webp|avif|woff2?|ttf|eot|otf|map)$" 0;',
    '}',
    '# Common exploit patterns (blockExploits option): 1 = answered 403 by the proxied locations.',
    'map $request_uri $oblimint_exploit {',
    '    default 0;',
    '    "~\\.\\./" 1;',
    '    "~*%2e%2e" 1;',
    '    "~~(?:\\?|$)" 1;',
    '    "~*\\.(?:bak|conf|dist|fla|in[ci]|log|psd|sh|sql|sw[op]|env)(?:\\?|$)" 1;',
    '    "~*/(?:wp-config\\.php|xmlrpc\\.php)" 1;',
    '    "~*(?:<|%3c)script" 1;',
    '    "~*(?:etc/passwd|proc/self/environ)" 1;',
    '    "~*base64_(?:en|de)code\\(" 1;',
    '    "~*(?:globals|_request)(?:=|\\[|%5b)" 1;',
    '    "~*union(?:%20|\\+|%09)+(?:all(?:%20|\\+|%09)+)?select" 1;',
    '}',
  ].join('\n') + '\n';
}

/** g-proxy: static part + one limit_req_zone per rate-limited host (strictly numeric values). */
export function renderGlobalProxyUnit(rateLimited: ReadonlyArray<{ hostId: number; rps: number }>): EdgeConfigUnit {
  const zones = [...rateLimited]
    .filter((r) => Number.isInteger(r.hostId) && r.hostId > 0 && Number.isInteger(r.rps) && r.rps >= 1 && r.rps <= 100000)
    .sort((a, b) => a.hostId - b.hostId)
    .map((r) => `limit_req_zone $binary_remote_addr zone=${rateLimitZone(r.hostId)}:1m rate=${r.rps}r/s;`);
  const fallback = globalProxyStatic();
  return {
    id: GLOBAL_PROXY_UNIT_ID,
    scope: 'http',
    level: 'global',
    owner: { kind: 'global', id: null, accountId: null, tenantId: null, label: GLOBAL_PROXY_UNIT_ID },
    serverNames: [],
    listen: [],
    tls: null,
    config: zones.length ? `${fallback}${zones.join('\n')}\n` : fallback,
    files: {},
    upstreams: [],
    rawSnippets: [],
    fallbackConfig: fallback,
  };
}
