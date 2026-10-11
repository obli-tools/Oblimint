import { promises as dnsPromises } from 'dns';
import type { Request } from 'express';
import type { MigrationRun } from '@oblimint/shared';
import type { HostingActor } from '../../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// Calls of the cutover checklist into the platform (live DNS through the
// platform resolvers, ownership, certificates, proxy hosts, the run engine),
// behind one seam replaced by doubles in the tests (setCutoverDepsForTests).
// Live DNS: plain queries through settings dns.resolvers, plus ONE direct query
// to the domain's current authoritative name servers for the TTL they serve
// (observedTtl) — a DNS question, never a command on the source (MG1).
// ─────────────────────────────────────────────────────────────────────────────

export interface CutoverDnsLookup {
  /** Public NS of `name` (lower case, no trailing dot), [] when none / NXDOMAIN. */
  ns(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  mx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  /** TTL of the A records of `name` as served by the name server `nameserver` (host name) itself; null = no A answer. */
  ttlAt(nameserver: string, name: string): Promise<number | null>;
}

export interface CutoverDeps {
  dns(): Promise<CutoverDnsLookup>;
  startFinalSync(req: Request, planId: number, cwpUsername: string): Promise<MigrationRun>;
  actor(req: Request): Promise<HostingActor>;
  ownershipCheck(req: Request, actor: HostingActor, domainId: number): Promise<void>;
  startCertificate(domainId: number): Promise<void>;
  /**
   * Proxy hosts bound to the domain whose SSL mode is 'imported' → back to 'auto',
   * only when every domain bound to the host is switched (a domain with cutover
   * rows needs one 'switched'; one never migrated does not block). `deferred`:
   * hosts left 'imported' until the switch of their last name.
   */
  proxySslAuto(req: Request, actor: HostingActor, domainId: number): Promise<{ changed: number[]; deferred: number[] }>;
  /** Expected mail records of a mail domain named `fqdn` (empty when it has no mail domain here). */
  mailRecords(fqdn: string): Promise<Array<{ fqdn: string; type: import('@oblimint/shared').DnsRecordType; content: string; priority: number | null; kind: string; zone: boolean }>>;
  /** Mail host of the node (MX target), null when not configured. */
  mailHost(): Promise<string | null>;
  platformDns(): Promise<{ nameservers: string[]; ipv4: string | null; ipv6: string | null }>;
  /** TTL of our hosted zone `name` (default + manual / template records); null = no such hosted zone. */
  setZoneTtl(req: Request, name: string, ttl: number): Promise<{ zoneId: number; recordsRetimed: number } | null>;
}

const TIMEOUT_MS = 4_000;
const EMPTY = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const clean = (n: string) => n.toLowerCase().replace(/\.$/, '');

export function createCutoverDns(resolvers: string[]): CutoverDnsLookup {
  const make = (servers: string[]) => {
    const r = new dnsPromises.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
    if (servers.length) r.setServers(servers);
    return r;
  };
  const run = async <T>(fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (EMPTY.has((err as NodeJS.ErrnoException).code ?? '')) return empty;
      throw err;
    }
  };
  const pub = () => make(resolvers.filter(Boolean));
  return {
    ns: (name) => run(async () => (await pub().resolveNs(name)).map(clean), [] as string[]),
    a: (name) => run(() => pub().resolve4(name), [] as string[]),
    aaaa: (name) => run(() => pub().resolve6(name), [] as string[]),
    mx: (name) => run(async () => (await pub().resolveMx(name)).map((m) => ({ exchange: clean(m.exchange), priority: m.priority })), [] as Array<{ exchange: string; priority: number }>),
    async ttlAt(nameserver, name) {
      const ips = await run(() => pub().resolve4(nameserver), [] as string[]);
      if (!ips.length) return null;
      const answers = await run(() => make([ips[0]]).resolve4(name, { ttl: true }), [] as Array<{ address: string; ttl: number }>);
      return answers.length ? Math.max(...answers.map((a) => a.ttl)) : null;
    },
  };
}

const real: CutoverDeps = {
  async dns() {
    const { platformSettings } = await import('../../platformSettings');
    return createCutoverDns((await platformSettings.section('dns')).resolvers);
  },
  async startFinalSync(req, planId, cwpUsername) {
    const { migrationRunsService } = await import('../execution/runs.service');
    const runs = await migrationRunsService.startRuns(req, planId, { accounts: [cwpUsername], kind: 'final-sync' });
    if (!runs[0]) throw new Error('No final-sync run was queued');
    return runs[0];
  },
  async actor(req) {
    return (await import('../../hosting/access')).resolveActor(req);
  },
  async ownershipCheck(req, actor, domainId) {
    await (await import('../../ownership/ownership.service')).ownershipService.check(req, actor, domainId);
  },
  async startCertificate(domainId) {
    await (await import('../../edge/certificate.service')).certificateService.startRequest(domainId, { force: true, staff: true });
  },
  async proxySslAuto(req, actor, domainId) {
    const { db } = await import('../../../db');
    const { proxyHostsService } = await import('../../proxy/hosts.service');
    const rows = await db('edge_domain_bindings as b').join('proxy_hosts as p', 'p.id', 'b.ref_id')
      .where({ 'b.domain_id': domainId, 'b.kind': 'proxy' }).select('p.id', 'p.ssl') as Array<{ id: number; ssl: unknown }>;
    const changed: number[] = [];
    const deferred: number[] = [];
    for (const r of rows) {
      const ssl = (typeof r.ssl === 'string' ? JSON.parse(r.ssl) : r.ssl) as { mode?: string } | null;
      if (ssl?.mode !== 'imported') continue;
      const bound = (await db('edge_domain_bindings').where({ kind: 'proxy', ref_id: r.id }).distinct('domain_id') as Array<{ domain_id: number }>)
        .map((b) => b.domain_id);
      const cut = await db('migration_cutover_domains').whereIn('target_domain_id', bound).select('target_domain_id', 'state') as
        Array<{ target_domain_id: number; state: string }>;
      const ready = bound.every((id) => {
        const own = cut.filter((c) => c.target_domain_id === id);
        return own.length === 0 || own.some((c) => c.state === 'switched');
      });
      if (!ready) { deferred.push(r.id); continue; }
      await proxyHostsService.update(req, actor, r.id, { ssl: { mode: 'auto', importedCertificateId: null } });
      changed.push(r.id);
    }
    return { changed, deferred };
  },
  async mailRecords(fqdn) {
    const { expectedRecordsOf, loadMailPlatformContext, mailDomainViews } = await import('../../mail/dns/domains');
    const views = await mailDomainViews((q) => q.where('md.name', fqdn));
    if (!views.length) return [];
    const ctx = await loadMailPlatformContext();
    return (await expectedRecordsOf(views, ctx)).get(views[0].id) ?? [];
  },
  async mailHost() {
    const { loadMailPlatformContext } = await import('../../mail/dns/domains');
    return (await loadMailPlatformContext()).host;
  },
  async setZoneTtl(req, name, ttl) {
    const { dnsService } = await import('../../dns/dns.service');
    return dnsService.setZoneTtlByName(req, name, ttl);
  },
  async platformDns() {
    const { db } = await import('../../../db');
    const { platformSettings } = await import('../../platformSettings');
    const rows = await db('app_config').whereIn('key', ['public_ipv4', 'public_ipv6']).select('key', 'value') as Array<{ key: string; value: string | null }>;
    const get = (k: string) => rows.find((r) => r.key === k)?.value?.trim() || null;
    return { nameservers: (await platformSettings.section('dns')).nameservers.map(clean), ipv4: get('public_ipv4'), ipv6: get('public_ipv6') };
  },
};

let override: Partial<CutoverDeps> | null = null;

export function cutoverDeps(): CutoverDeps {
  return override ? { ...real, ...override } : real;
}

/** Tests: replace some of the calls (null restores the real ones). */
export function setCutoverDepsForTests(fakes: Partial<CutoverDeps> | null): void {
  override = fakes;
}
