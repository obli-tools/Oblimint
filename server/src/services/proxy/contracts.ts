import { db } from '../../db';
import { logger } from '../../utils/logger';
import { emitProxy } from './common';
import { proxyDeps } from './deps';
import { toTarget, type ProxyHostDbRow, type ProxyRouteDbRow, type StreamDbRow } from './rows';

// Internal API of the proxy-hosts module for the other P4b modules (docs/P4b-PLAN.md §7). OWNED BY MODULE
// `proxy-hosts` (signatures FROZEN by the architect).

/** One internal target the edge must reach (segmentation turns it into edge → container:port flows). */
export interface ProxyPolicyTarget {
  accountId: number;
  kind: 'app' | 'site';
  stackId: number | null;
  service: string | null;
  siteId: number | null;
  port: number;
  protocol: 'tcp' | 'udp';
  via: 'host' | 'route' | 'stream';
}

export interface ProxyHostSummary {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  domains: string[];
  enabled: boolean;
}

async function domainNames(hostIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!hostIds.length) return out;
  const rows = await db('edge_domain_bindings as b').join('domains as d', 'd.id', 'b.domain_id')
    .where('b.kind', 'proxy').whereIn('b.ref_id', hostIds).orderBy('d.name').select('b.ref_id', 'd.name') as Array<{ ref_id: number; name: string }>;
  for (const r of rows) out.set(Number(r.ref_id), [...(out.get(Number(r.ref_id)) ?? []), r.name]);
  return out;
}

function internalTarget(accountId: number, raw: unknown, via: ProxyPolicyTarget['via'], protocols: Array<'tcp' | 'udp'>): ProxyPolicyTarget[] {
  const t = toTarget(raw);
  if (t.kind === 'external' || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return [];
  return protocols.map((protocol) => ({
    accountId,
    kind: t.kind as 'app' | 'site',
    stackId: t.kind === 'app' ? Number(t.stackId) : null,
    service: t.kind === 'app' ? String(t.service) : null,
    siteId: t.kind === 'site' ? Number(t.siteId) : null,
    port: t.port,
    protocol,
    via,
  }));
}

export const proxyContracts = {
  /** segmentation: internal targets of the ENABLED proxy hosts / routes / streams (accountId null = every account). */
  async policyTargets(accountId: number | null): Promise<ProxyPolicyTarget[]> {
    const hostsQ = db('proxy_hosts').where({ enabled: true }).select('id', 'account_id', 'target');
    if (accountId !== null) hostsQ.where({ account_id: accountId });
    const hosts = await hostsQ as Array<Pick<ProxyHostDbRow, 'id' | 'account_id' | 'target'>>;
    const out: ProxyPolicyTarget[] = [];
    for (const h of hosts) out.push(...internalTarget(Number(h.account_id), h.target, 'host', ['tcp']));
    if (hosts.length) {
      const accountOf = new Map(hosts.map((h) => [Number(h.id), Number(h.account_id)]));
      const routes = await db('proxy_routes').whereIn('proxy_host_id', [...accountOf.keys()]).select('proxy_host_id', 'target') as
        Array<Pick<ProxyRouteDbRow, 'proxy_host_id' | 'target'>>;
      for (const r of routes) out.push(...internalTarget(accountOf.get(Number(r.proxy_host_id))!, r.target, 'route', ['tcp']));
    }
    const streamsQ = db('proxy_streams').where({ enabled: true }).whereNotNull('account_id').select('account_id', 'target', 'tcp', 'udp');
    if (accountId !== null) streamsQ.where({ account_id: accountId });
    for (const s of await streamsQ as Array<Pick<StreamDbRow, 'account_id' | 'target' | 'tcp' | 'udp'>>) {
      const protocols = [...(s.tcp ? ['tcp' as const] : []), ...(s.udp ? ['udp' as const] : [])];
      out.push(...internalTarget(Number(s.account_id), s.target, 'stream', protocols));
    }
    // One flow per (account, target, port, protocol): dedupe (the via of the first occurrence is kept).
    const seen = new Set<string>();
    return out.filter((t) => {
      const k = `${t.accountId}|${t.kind}|${t.stackId}|${t.service}|${t.siteId}|${t.port}|${t.protocol}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },

  /** apps-core (stack detail, delete guard): proxy hosts / routes targeting a stack. */
  async hostsTargetingStack(stackId: number): Promise<Array<{ id: number; name: string; domains: string[]; service: string; port: number }>> {
    const hosts = await db('proxy_hosts').where({ target_stack_id: stackId }).select('id', 'name', 'target') as Array<Pick<ProxyHostDbRow, 'id' | 'name' | 'target'>>;
    const routes = await db('proxy_routes as r').join('proxy_hosts as h', 'h.id', 'r.proxy_host_id').where('r.target_stack_id', stackId)
      .select('h.id', 'h.name', 'r.target') as Array<{ id: number; name: string; target: unknown }>;
    const all = [...hosts, ...routes];
    const names = await domainNames([...new Set(all.map((h) => Number(h.id)))]);
    const seen = new Set<string>();
    const out: Array<{ id: number; name: string; domains: string[]; service: string; port: number }> = [];
    for (const h of all) {
      const t = toTarget(h.target);
      if (t.kind !== 'app' || Number(t.stackId) !== stackId) continue;
      const key = `${h.id}|${t.service}|${t.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: Number(h.id), name: h.name, domains: names.get(Number(h.id)) ?? [], service: String(t.service), port: t.port });
    }
    return out;
  },

  /** monitoring-automation / honeypot-bans: label + ownership of a proxy host, null when missing. */
  async hostSummary(id: number): Promise<ProxyHostSummary | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = await db('proxy_hosts').where({ id }).first('id', 'account_id', 'tenant_id', 'name', 'enabled') as
      Pick<ProxyHostDbRow, 'id' | 'account_id' | 'tenant_id' | 'name' | 'enabled'> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), accountId: Number(row.account_id), tenantId: Number(row.tenant_id), name: row.name,
      domains: (await domainNames([Number(row.id)])).get(Number(row.id)) ?? [], enabled: !!row.enabled,
    };
  },

  /**
   * apps-core, when a stack is deleted (force): the hosts / streams targeting it are disabled, the sub-routes
   * targeting it are removed (a route has no switch of its own). Never throws.
   */
  async stackDeleted(stackId: number): Promise<void> {
    try {
      const hosts = await db('proxy_hosts').where({ target_stack_id: stackId, enabled: true }).select('id', 'tenant_id', 'account_id') as
        Array<{ id: number; tenant_id: number; account_id: number }>;
      const routeHosts = await db('proxy_routes as r').join('proxy_hosts as h', 'h.id', 'r.proxy_host_id').where('r.target_stack_id', stackId)
        .distinct('h.id', 'h.tenant_id', 'h.account_id') as Array<{ id: number; tenant_id: number; account_id: number }>;
      const streams = await db('proxy_streams').where({ target_stack_id: stackId, enabled: true }).select('id', 'tenant_id', 'account_id') as
        Array<{ id: number; tenant_id: number; account_id: number | null }>;
      await db.transaction(async (trx) => {
        if (hosts.length) await trx('proxy_hosts').whereIn('id', hosts.map((h) => h.id)).update({ enabled: false, updated_at: trx.fn.now() });
        await trx('proxy_routes').where({ target_stack_id: stackId }).del();
        if (streams.length) await trx('proxy_streams').whereIn('id', streams.map((s) => s.id)).update({ enabled: false, updated_at: trx.fn.now() });
      });
      const touched = new Map<number, { tenant_id: number; account_id: number }>();
      for (const h of [...hosts, ...routeHosts]) touched.set(Number(h.id), h);
      for (const [id, h] of touched) {
        emitProxy('host', id, { tenantId: Number(h.tenant_id), accountId: Number(h.account_id) }, 'updated');
        proxyDeps().syncAutoMonitor(id);
      }
      for (const s of streams) emitProxy('stream', s.id, { tenantId: Number(s.tenant_id), accountId: s.account_id === null ? null : Number(s.account_id) }, 'updated');
      if (touched.size || streams.length) {
        logger.info({ stackId, hosts: [...touched.keys()], streams: streams.map((s) => s.id) }, 'proxy: objects targeting a deleted stack disabled');
        proxyDeps().scheduleEdgeSync(`stack ${stackId} deleted`);
        proxyDeps().requestPolicySync(`stack ${stackId} deleted`);
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, stackId }, 'proxy: stackDeleted failed');
    }
  },
};
