import type { EdgeUnitOwnerKind } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { PlanCertificate, PlatformHosts } from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// P4b edge configuration UNITS (docs/P4b-PLAN.md §8) — ARCHITECT FILE (frozen).
//
// The edge configuration is a set of independent units. Each unit is
// validated IN ISOLATION (nginx -t on a sandbox configuration holding the
// global units + that unit only) before it replaces its live file; a unit
// that fails keeps its last good version (status quarantined) or, without
// one, is replaced by a 503 stub that keeps its server names (status stub).
// One broken unit never blocks the others nor the server (owner requirement,
// ARCHITECTURE §3.9).
//
// Producers:
//   - edge-robustness itself: the P1/P2 vhosts (planVhosts + edge
//     contributors, rendered by nginxConfig.renderVhost) become units
//     (id = vhost id, owner 'site-domain' / 'platform' / 'contributed');
//   - providers registered here (registerEdgeUnitProvider), called in
//     registration order AFTER the P1 vhosts: proxy-hosts ('proxy': proxy
//     hosts, redirections, dead hosts, streams + its global unit 'g-proxy'),
//     honeypot-bans ('bans': global unit 'g-bans', the ban geo maps).
//
// Rules every producer follows (checked again by edge-robustness):
//   - id: [a-z0-9][a-z0-9-]{0,63}, stable, unique (prefixes: d- p- panel
//     dbadmin probe- m- w- (P1–P4), ph- proxy host, rd- redirection, dh- dead
//     host, st- stream, g- global);
//   - config: complete text of the unit — server units: one or more server{}
//     blocks; global units: http{}-level (or stream{}-level) directives only
//     (map, geo, limit_req_zone, proxy_cache_path, upstream-free); never
//     `include`, `load_module`, a path outside /etc/nginx/oblimint/ or
//     /usr/share/oblimint/, nor a literal proxy_pass target: EVERY proxy_pass
//     goes through a variable set in the same location (resolved per request,
//     resolver 127.0.0.11 — fixes Oblihub's literal sub-route / stream
//     proxy_pass);
//   - every tenant value is validated by the producer and sanitized
//     (nginxConfig.sanitizeForNginx) — H5;
//   - aux files are written by edge-robustness under edge/aux/<id>/ and are
//     referenced in the config as /etc/nginx/oblimint/aux/<id>/<name>;
//   - server units set the access-log variables in every location
//     ($oblimint_kind, $oblimint_site, $oblimint_account, $oblimint_tenant and
//     P4b $oblimint_host, $oblimint_app, $oblimint_hp — docs §8.7);
//   - server units call honeypot-bans banCheckLines(accountId) right after
//     server_name (security/honeypotRender.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type EdgeUnitScope = 'http' | 'stream';
export type EdgeUnitLevel = 'global' | 'server';

export interface EdgeUnitOwner {
  kind: EdgeUnitOwnerKind;
  /** proxy_hosts.id, proxy_redirections.id, domains.id (site-domain)… null for platform / global units. */
  id: number | null;
  accountId: number | null;
  tenantId: number | null;
  /** Short readable label for logs / errors (e.g. the first server name). */
  label: string;
}

export interface EdgeUpstreamRef {
  internal: boolean;
  /** Container DNS name / alias (internal) or public host / IP (external). */
  host: string;
  port: number;
  protocol: 'tcp' | 'udp';
  /** Where it is used, for errors: 'location /', 'route /api/', 'stream 5432/tcp'. */
  where: string;
  /**
   * Target app stack that may be sleeping (apps-core): an unreachable sleeping
   * target never blocks the activation (the waking page handles it).
   */
  appStackId?: number | null;
}

export interface EdgeConfigUnit {
  id: string;
  scope: EdgeUnitScope;
  level: EdgeUnitLevel;
  owner: EdgeUnitOwner;
  /**
   * server units (http): every server_name entry. A provider NEVER emits a
   * name already in ctx.claimed (P1 vhosts, mail contributors, earlier
   * providers): it renders without it (or skips the unit when none is left)
   * and reports the conflict on its object. edge-robustness drops a unit that
   * still collides (logged, status quarantined).
   */
  serverNames: string[];
  /** stream units: ports listened on (must be in settings edge.streamPorts). */
  listen: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  /** http server units: certificate used by the 503 stub when the unit has no good version (null = HTTP only). */
  tls: { certPath: string; keyPath: string } | null;
  /** Complete configuration text of the unit. */
  config: string;
  /** Auxiliary files (name → content), e.g. 'htpasswd', 'errors/404.html'; names [a-z0-9._/-], no '..'. */
  files: Record<string, string>;
  /** Upstreams probed before activating a changed unit (settings edge.probeUpstreams). */
  upstreams: EdgeUpstreamRef[];
  /** Raw staff snippets (advancedConfig) included in `config`: linted again (lint.ts) before the sandbox test. */
  rawSnippets: string[];
  /**
   * global units only: text used when the unit has never passed (e.g. g-bans
   * `geo $remote_addr $oblimint_ban_p { default 0; }`) so that the variables
   * the server units reference always exist.
   */
  fallbackConfig?: string;
  /** Owner disabled: edge-robustness serves the 503 stub (status disabled) instead of `config`. */
  disabled?: boolean;
  /**
   * The owner could not render the unit (validation, policy, DNS of an external
   * target…): `config` is empty, `serverNames` / `listen` / `tls` are kept and
   * edge-robustness keeps the last good version (else the 503 stub), status
   * invalid, this text as the unit error.
   */
  invalidReason?: string | null;
}

export interface EdgeUnitContext {
  platform: PlatformHosts;
  panelUpstream: string;
  certificates: PlanCertificate[];
  certFilesExist: (primaryName: string) => boolean;
  /** Server names already claimed by the P1 vhosts and earlier providers. */
  claimed: ReadonlySet<string>;
  /** Stream ports approved by the platform (settings edge.streamPorts). */
  streamPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

export interface EdgeUnitProvider {
  id: string;
  /** Never throws on purpose: a throw is logged and the provider's units keep their last applied version this pass. */
  units(ctx: EdgeUnitContext): Promise<EdgeConfigUnit[]>;
}

const providers: EdgeUnitProvider[] = [];

export function registerEdgeUnitProvider(p: EdgeUnitProvider): void {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers[i] = p;
  else providers.push(p);
}

export function unregisterEdgeUnitProvider(id: string): void {
  const i = providers.findIndex((x) => x.id === id);
  if (i >= 0) providers.splice(i, 1);
}

/** Tests. */
export function clearEdgeUnitProvidersForTests(): void {
  providers.splice(0, providers.length);
}

export const UNIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every provider's units, in registration order. A provider that throws is
 * reported in `failed` (edge-robustness then keeps that provider's units at
 * their last applied version instead of deleting them). Never throws.
 */
export async function collectEdgeUnits(ctx: Omit<EdgeUnitContext, 'claimed'> & { claimed: Set<string> }): Promise<{ units: EdgeConfigUnit[]; failed: string[] }> {
  const units: EdgeConfigUnit[] = [];
  const failed: string[] = [];
  const ids = new Set<string>();
  for (const p of providers) {
    let list: EdgeConfigUnit[];
    try {
      list = await p.units(ctx);
    } catch (err) {
      failed.push(p.id);
      logger.warn({ err: (err as Error)?.message, provider: p.id }, 'edge unit provider failed: its units keep their last applied version');
      continue;
    }
    for (const u of Array.isArray(list) ? list : []) {
      if (!u || typeof u.id !== 'string' || !UNIT_ID_RE.test(u.id) || ids.has(u.id)) {
        logger.warn({ provider: p.id, unit: String(u?.id) }, 'edge unit dropped: invalid or duplicate id');
        continue;
      }
      ids.add(u.id);
      units.push(u);
      for (const n of u.serverNames ?? []) ctx.claimed.add(n);
    }
  }
  return { units, failed };
}
