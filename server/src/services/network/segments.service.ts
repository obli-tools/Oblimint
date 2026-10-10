import type { Request } from 'express';
import type Docker from 'dockerode';
import type {
  NetworkFlowView, NetworkLink, NetworkLinkCreate, NetworkLinkProtocol, NetworkLinkUpdate, NetworkMigrateRequest, NetworkSegmentInfo,
  NetworkSystemStatus, SegmentKind, SegmentRef,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { connectNetwork, createNetwork, inspectContainer, inspectNetwork } from '../docker/dockerOps';
import { withAccountLock } from '../docker/locks';
import { loadAccount, type HostingActor } from '../hosting/access';
import { emitHosting } from '../hosting/events';
import { appContainer, appPrivateNetwork, appServiceAlias, LABELS, P2_LABELS, P3_LABELS } from '../hosting/naming';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { iso } from '../hosting/rows';
import { errText, selfContainerRef } from '../setup/docker';
import { allocateSubnet, listDockerSubnets, poolStatus, releaseSubnets } from './allocator';
import { segmentBackends } from './deps';
import { fabricNetworkName, fabricNetworkOptions } from './fabric';
import { migrateAccount } from './migration';
import { observeNode, stackExposedPorts, type LinkRow } from './model';
import { buildPolicy, classifyEndpoint, dbEnginePort, type FabricWhich, type SegmentModel } from './policy';
import { pushStatus, requestPolicySync, startEvents, stopEvents, syncPolicyNow } from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// Network segmentation (docs/P4b-PLAN.md §4, §6.2, SG1–SG6). OWNED BY MODULE
// `segmentation` (signatures FROZEN — apps-core consumes allocateAppNetworks /
// releaseAppNetworks / stackFabricPlan / ensureAccountFabrics, proxy-hosts and
// apps-core call requestPolicySync).
//
// Links (network_links): both ends in the SAME account (loaded with the
// account; never an id of another account), apps.manage on that account; a
// site is never a target; an app target names a service exposing the port;
// ≤ MAX_LINKS_PER_ACCOUNT user links per account (migration links excluded).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_LINKS_PER_ACCOUNT = 100;
const SERVICE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PERIODIC_MS = 5 * 60_000;

export interface AllocatedAppNetwork {
  /** Compose network name. */
  name: string;
  /** Docker network name (naming.appPrivateNetwork). */
  dockerName: string;
  subnet: string;
  gateway: string;
}

/** Fabric attachments of a stack's services (apps-core uses it when it builds the containers). */
export interface StackFabricPlan {
  accountId: number;
  /** Account FRONT fabric (oblimint-acct-<id>): services with exposed ports join it (alias naming.appServiceAlias). */
  frontNetwork: string;
  /** Account BACK fabric (oblimint-acct-<id>-db): services that are a source or a target of a declared link join it. */
  backNetwork: string;
  backServices: string[];
}

// ── endpoints ────────────────────────────────────────────────────────────────

interface ResolvedEnd {
  ref: SegmentRef;
  label: string;
  /** Ports a link may target (db: engine port; app service: exposed ports). */
  ports: Array<{ port: number; protocol: NetworkLinkProtocol }>;
}

const invalidEndpoint = (msg: string) => new AppError(400, msg, 'linkInvalidEndpoint');

/** Resolves one end of a link INSIDE `accountId` (400 linkInvalidEndpoint otherwise: unknown / other account). */
async function resolveEnd(accountId: number, ref: SegmentRef, side: 'source' | 'target'): Promise<ResolvedEnd> {
  const id = Number(ref?.id);
  const service = ref?.service ?? null;
  if (!Number.isInteger(id) || id <= 0) throw invalidEndpoint(`Invalid ${side}`);
  switch (ref.kind) {
    case 'site': {
      if (side === 'target') throw invalidEndpoint('A site cannot be the target of a link');
      if (service !== null) throw invalidEndpoint('A site has no service');
      const row = await db('sites').where({ id, account_id: accountId }).first('id', 'name') as { id: number; name: string } | undefined;
      if (!row) throw invalidEndpoint(`Unknown ${side} site`);
      return { ref: { kind: 'site', id, service: null }, label: row.name, ports: [] };
    }
    case 'db': {
      if (service !== null) throw invalidEndpoint('A database instance has no service');
      const row = await db('db_instances').where({ id, account_id: accountId }).first('id', 'name', 'engine') as { id: number; name: string; engine: string } | undefined;
      if (!row) throw invalidEndpoint(`Unknown ${side} database instance`);
      const port = dbEnginePort(row.engine);
      return { ref: { kind: 'db', id, service: null }, label: row.name, ports: port === null ? [] : [{ port, protocol: 'tcp' }] };
    }
    case 'app': {
      const row = await db('app_stacks').where({ id, account_id: accountId }).first('id', 'name', 'display_name', 'effective', 'validation') as
        { id: number; name: string; display_name: string | null; effective: unknown; validation: unknown } | undefined;
      if (!row) throw invalidEndpoint(`Unknown ${side} application`);
      const exposed = stackExposedPorts(row);
      const stackLabel = row.display_name || row.name;
      if (service === null) {
        if (side === 'target') throw invalidEndpoint('The target service of an application is required');
        return { ref: { kind: 'app', id, service: null }, label: stackLabel, ports: [] };
      }
      if (typeof service !== 'string' || !SERVICE_RE.test(service)) throw invalidEndpoint('Invalid service name');
      const known = Object.keys(exposed);
      if (known.length > 0 && !known.includes(service)) throw invalidEndpoint(`Unknown service ${service}`);
      if (known.length === 0 && side === 'target') throw invalidEndpoint('The application has no validated configuration yet');
      return { ref: { kind: 'app', id, service }, label: `${stackLabel} / ${service}`, ports: exposed[service] ?? [] };
    }
    default:
      throw invalidEndpoint(`Invalid ${side} kind`);
  }
}

/** The link port: given (must be one the target exposes) or the target's natural one. */
function choosePort(target: ResolvedEnd, protocol: NetworkLinkProtocol | undefined, port: number | undefined): { port: number; protocol: NetworkLinkProtocol } {
  const candidates = target.ports.filter((p) => !protocol || p.protocol === protocol);
  const exposed = target.ports.map((p) => `${p.port}/${p.protocol}`);
  if (port !== undefined) {
    const hit = candidates.find((p) => p.port === port);
    if (!hit) throw new AppError(400, `Port ${port}/${protocol ?? 'tcp'} is not exposed by the target`, 'linkPortNotExposed', { exposedPorts: exposed });
    return hit;
  }
  if (candidates.length === 1) return candidates[0];
  throw new AppError(400, candidates.length === 0 ? 'The target exposes no port' : 'The target exposes several ports: choose one',
    'linkPortNotExposed', { exposedPorts: exposed });
}

function sameSegment(a: SegmentRef, b: SegmentRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// ── rows → API ───────────────────────────────────────────────────────────────

async function endLabels(rows: LinkRow[]): Promise<Map<string, string>> {
  const ids = { site: new Set<number>(), db: new Set<number>(), app: new Set<number>() } as Record<SegmentKind, Set<number>>;
  for (const r of rows) {
    ids[r.source_kind]?.add(Number(r.source_id));
    ids[r.target_kind]?.add(Number(r.target_id));
  }
  const out = new Map<string, string>();
  const [sites, insts, stacks] = await Promise.all([
    ids.site.size ? db('sites').whereIn('id', [...ids.site]).select('id', 'name') : [],
    ids.db.size ? db('db_instances').whereIn('id', [...ids.db]).select('id', 'name') : [],
    ids.app.size ? db('app_stacks').whereIn('id', [...ids.app]).select('id', 'name', 'display_name') : [],
  ]) as [Array<{ id: number; name: string }>, Array<{ id: number; name: string }>, Array<{ id: number; name: string; display_name: string | null }>];
  for (const s of sites) out.set(`site:${s.id}`, s.name);
  for (const i of insts) out.set(`db:${i.id}`, i.name);
  for (const a of stacks) out.set(`app:${a.id}`, a.display_name || a.name);
  return out;
}

function toLink(r: LinkRow, labels: Map<string, string>): NetworkLink {
  const end = (kind: SegmentKind, id: number, service: string | null) => {
    const base = labels.get(`${kind}:${id}`) ?? `#${id}`;
    return { kind, id: Number(id), service: service ?? null, label: kind === 'app' && service ? `${base} / ${service}` : base };
  };
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    source: end(r.source_kind, r.source_id, r.source_service),
    target: end(r.target_kind, r.target_id, r.target_service),
    protocol: r.protocol === 'udp' ? 'udp' : 'tcp',
    port: Number(r.port),
    origin: r.origin,
    enabled: !!r.enabled,
    description: r.description ?? null,
    status: r.status,
    statusMessage: r.status_message ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

async function linkOut(id: number): Promise<NetworkLink> {
  const row = await db('network_links').where({ id }).first() as LinkRow;
  return toLink(row, await endLabels([row]));
}

function emitLink(tenantId: number, accountId: number, linkId: number | null): void {
  emitHosting(HostingSocketEvents.NETWORK_UPDATED, { accountId, linkId }, { tenantId, accountId });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

// ── worker state ─────────────────────────────────────────────────────────────

let periodicTimer: NodeJS.Timeout | null = null;
/**
 * A link takes effect without a redeploy: the RUNNING containers of the app services that the account's links now
 * place on the BACK fabric (stackFabricPlan) are connected to it at once (same alias as the deployment, specs.ts);
 * the policy push that follows then sees their address. Sites and DB instances are always on the BACK fabric.
 * Best effort, never throws: a service not attached here (container absent, Docker error) joins the fabric at its
 * next deployment, and the link stays pending with its message until then.
 */
async function attachLinkEnds(accountId: number, ends: SegmentRef[]): Promise<void> {
  const stackIds = [...new Set(ends.filter((e) => e.kind === 'app').map((e) => Number(e.id)))];
  if (!stackIds.length) return;
  try {
    const account = await db('hosting_accounts').where({ id: accountId }).first('node_id', 'network_model') as { node_id: number; network_model: string } | undefined;
    if (!account || account.network_model !== 'segmented') return;
    const docker = await segmentBackends().docker(Number(account.node_id));
    let back: string | null = null;
    for (const stackId of stackIds) {
      const plan = await segmentService.stackFabricPlan(stackId);
      for (const service of plan.backServices) {
        const name = appContainer(stackId, service);
        const info = await inspectContainer(docker, name);
        if (!info || info.HostConfig?.NetworkMode === 'none') continue;
        if (info.NetworkSettings?.Networks?.[plan.backNetwork]) continue;
        back ??= (await segmentService.ensureAccountFabrics(accountId)).back;
        await connectNetwork(docker, back, name, [appServiceAlias(stackId, service)]);
        logger.info({ accountId, stackId, service, network: back }, 'segments: app service joined the BACK fabric for a link');
      }
    }
  } catch (err) {
    logger.warn({ accountId, err: errText(err) }, 'segments: link ends not attached now (the next deployment attaches them)');
  }
}

let workerRunning = false;
let sweepRunning = false;

/** Migrates the legacy accounts of the local node (each under its account lock). Never throws. */
async function migrateLegacySweep(onlyAccountId?: number): Promise<{ migrated: number; failed: number }> {
  const out = { migrated: 0, failed: 0 };
  try {
    const backends = segmentBackends();
    const qb = db('hosting_accounts').where({ network_model: 'legacy' }).whereNot('status', 'deleting');
    if (onlyAccountId) qb.andWhere('id', onlyAccountId);
    else qb.andWhere('node_id', await backends.localNode());
    const rows = await qb.orderBy('id').select('id', 'node_id') as Array<{ id: number; node_id: number }>;
    const engines = new Map<number, Docker>();
    for (const r of rows) {
      try {
        let docker = engines.get(Number(r.node_id));
        if (!docker) { docker = await backends.docker(Number(r.node_id)); engines.set(Number(r.node_id), docker); }
        const outcome = await withAccountLock(Number(r.id), () => migrateAccount(docker!, Number(r.id)));
        if (outcome === 'segmented') out.migrated++;
        else if (outcome === 'failed') out.failed++;
      } catch (err) {
        out.failed++;
        logger.warn({ accountId: r.id, err: errText(err) }, 'segments: migration sweep failed for an account');
      }
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'segments: migration sweep failed');
  }
  return out;
}

export const segmentService = {
  // ── REST ──

  /** GET /network/segments?accountId — the account's segments for the link picker (read). */
  async segments(actor: HostingActor, accountId: number): Promise<NetworkSegmentInfo[]> {
    const account = await loadAccount(actor, accountId, 'read');
    const [sites, insts, stacks] = await Promise.all([
      db('sites').where({ account_id: account.id }).orderBy('id').select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
      db('db_instances').where({ account_id: account.id }).orderBy('id').select('id', 'name', 'engine') as Promise<Array<{ id: number; name: string; engine: string }>>,
      db('app_stacks').where({ account_id: account.id }).orderBy('id').select('id', 'name', 'display_name', 'effective', 'validation') as
        Promise<Array<{ id: number; name: string; display_name: string | null; effective: unknown; validation: unknown }>>,
    ]);

    // Containers of the account fabrics (best effort: Docker down → no container listed).
    const containers = new Map<string, Array<{ name: string; network: string; ip: string | null }>>();
    try {
      const docker = await segmentBackends().docker(Number(account.node_id));
      const labels = new Map<string, Record<string, string>>();
      for (const c of await docker.listContainers({ all: true, filters: { label: [`${LABELS.account}=${account.id}`] } })) labels.set(c.Id, c.Labels ?? {});
      const runs = [...labels.values()].map((l) => Number(l[P3_LABELS.adapterRun])).filter((n) => Number.isInteger(n) && n > 0);
      const runRows = runs.length ? await db('adapter_runs').whereIn('id', runs).select('id', 'site_id') as Array<{ id: number; site_id: number }> : [];
      const model: SegmentModel = {
        mode: 'enforce', accounts: [],
        sites: new Map(sites.map((s) => [Number(s.id), account.id])),
        dbInstances: new Map(insts.map((i) => [Number(i.id), { accountId: account.id, engine: i.engine }])),
        stacks: new Map(stacks.map((s) => [Number(s.id), { accountId: account.id, exposed: stackExposedPorts(s) }])),
        adapterRuns: new Map(runRows.map((r) => [Number(r.id), Number(r.site_id)])),
        panelRefs: [selfContainerRef() ?? ''].filter(Boolean), links: [], proxyTargets: [], internalPort: 0,
      };
      for (const which of ['front', 'back'] as FabricWhich[]) {
        const network = fabricNetworkName(account.id, which);
        const net = await inspectNetwork(docker, network);
        for (const [id, c] of Object.entries(net?.Containers ?? {})) {
          const ep = { id, name: String((c as { Name?: string }).Name ?? ''), ip: (c as { IPv4Address?: string }).IPv4Address ?? null, labels: labels.get(id) ?? null };
          const role = classifyEndpoint(model, account.id, which, ep);
          const keys = role.kind === 'site' ? [`site:${role.siteId}`]
            : role.kind === 'db' ? [`db:${role.instanceId}`]
              : role.kind === 'app' ? [`app:${role.stackId}:`, `app:${role.stackId}:${role.service}`] : [];
          for (const k of keys) {
            const list = containers.get(k) ?? [];
            list.push({ name: ep.name, network, ip: ep.ip ? ep.ip.split('/')[0] : null });
            containers.set(k, list);
          }
        }
      }
    } catch (err) {
      logger.debug({ accountId: account.id, err: errText(err) }, 'segments: containers of the account not observable');
    }

    const fabricOf = (list: Array<{ network: string }>): NetworkSegmentInfo['fabric'] => {
      const front = list.some((c) => c.network === fabricNetworkName(account.id, 'front'));
      const back = list.some((c) => c.network === fabricNetworkName(account.id, 'back'));
      return front && back ? 'both' : front ? 'front' : back ? 'back' : 'none';
    };
    const out: NetworkSegmentInfo[] = [];
    for (const s of sites) {
      const list = containers.get(`site:${s.id}`) ?? [];
      out.push({ ref: { kind: 'site', id: Number(s.id), service: null }, label: s.name, fabric: fabricOf(list), containers: list, linkablePorts: [] });
    }
    for (const i of insts) {
      const list = containers.get(`db:${i.id}`) ?? [];
      const port = dbEnginePort(i.engine);
      out.push({ ref: { kind: 'db', id: Number(i.id), service: null }, label: i.name, fabric: fabricOf(list), containers: list, linkablePorts: port === null ? [] : [port] });
    }
    for (const a of stacks) {
      const label = a.display_name || a.name;
      const all = containers.get(`app:${a.id}:`) ?? [];
      out.push({ ref: { kind: 'app', id: Number(a.id), service: null }, label, fabric: fabricOf(all), containers: all, linkablePorts: [] });
      for (const [service, ports] of Object.entries(stackExposedPorts(a))) {
        const list = containers.get(`app:${a.id}:${service}`) ?? [];
        out.push({
          ref: { kind: 'app', id: Number(a.id), service }, label: `${label} / ${service}`, fabric: fabricOf(list), containers: list,
          linkablePorts: [...new Set(ports.map((p) => p.port))].sort((x, y) => x - y),
        });
      }
    }
    return out;
  },

  /** GET /network/links?accountId&tenantId (read, scoped). */
  async listLinks(actor: HostingActor, q: { accountId?: number | null; tenantId?: number | null }): Promise<NetworkLink[]> {
    const qb = db('network_links as l');
    if (q.accountId) {
      const account = await loadAccount(actor, q.accountId, 'read');
      qb.where('l.account_id', account.id);
    } else {
      scopeOwned(actor, qb, 'l', { filterTenantId: q.tenantId ?? null });
    }
    const rows = await qb.orderBy('l.id').select('l.*') as LinkRow[];
    const labels = await endLabels(rows);
    return rows.map((r) => toLink(r, labels));
  },

  /** POST /network/links (apps.manage on accountId; both ends in that account). */
  async createLink(req: Request, actor: HostingActor, input: NetworkLinkCreate): Promise<NetworkLink> {
    const account = await loadAccount(actor, input.accountId, 'apps.manage');
    const source = await resolveEnd(account.id, input.source, 'source');
    const target = await resolveEnd(account.id, input.target, 'target');
    if (sameSegment(source.ref, target.ref)) throw invalidEndpoint('The source and the target are the same segment');
    const { port, protocol } = choosePort(target, input.protocol, input.port);

    const [{ n }] = await db('network_links').where({ account_id: account.id }).whereNot('origin', 'migration').count<{ n: string | number }[]>('id as n');
    if (Number(n) >= MAX_LINKS_PER_ACCOUNT) {
      throw new AppError(409, `At most ${MAX_LINKS_PER_ACCOUNT} network links per account`, 'planLimit', { dimension: 'networkLinks', limit: MAX_LINKS_PER_ACCOUNT });
    }
    let id: number;
    try {
      const [row] = await db('network_links').insert({
        tenant_id: account.tenant_id, account_id: account.id,
        source_kind: source.ref.kind, source_id: source.ref.id, source_service: source.ref.service ?? null,
        target_kind: target.ref.kind, target_id: target.ref.id, target_service: target.ref.service ?? null,
        protocol, port, origin: 'user', enabled: true, description: input.description?.trim() || null,
        status: 'pending', created_by: actor.userId,
      }).returning('id');
      id = Number((row as { id: number }).id ?? row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This link already exists', 'linkExists');
      throw err;
    }
    await auditService.logReqAs(req, account.tenant_id, 'network.link.create', {
      resourceType: 'network_link', resourcePath: String(id),
      details: { accountId: account.id, username: account.username, source: source.ref, target: target.ref, protocol, port },
    });
    await attachLinkEnds(account.id, [source.ref, target.ref]);
    requestPolicySync(`link:${id}`);
    emitLink(account.tenant_id, account.id, id);
    return linkOut(id);
  },

  /** PUT /network/links/:id (apps.manage). */
  async updateLink(req: Request, actor: HostingActor, id: number, input: NetworkLinkUpdate): Promise<NetworkLink> {
    const row = await loadOwned<LinkRow & { [column: string]: unknown }>(actor, 'network_links', id, 'apps.manage', 'Network link');
    const patch: Record<string, unknown> = {};
    if (input.enabled !== undefined) patch.enabled = !!input.enabled;
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.port !== undefined && input.port !== Number(row.port)) {
      const target = await resolveEnd(Number(row.account_id), { kind: row.target_kind, id: Number(row.target_id), service: row.target_service }, 'target');
      patch.port = choosePort(target, row.protocol, input.port).port;
    }
    if (Object.keys(patch).length) {
      if ('enabled' in patch || 'port' in patch) {
        patch.status = 'pending';
        patch.status_message = null;
      }
      patch.updated_at = db.fn.now();
      try {
        await db('network_links').where({ id: row.id }).update(patch);
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'This link already exists', 'linkExists');
        throw err;
      }
      await auditService.logReqAs(req, Number(row.tenant_id), 'network.link.update', {
        resourceType: 'network_link', resourcePath: String(row.id),
        details: { accountId: Number(row.account_id), ...('enabled' in patch ? { enabled: patch.enabled } : {}), ...('port' in patch ? { port: patch.port } : {}), ...('description' in patch ? { description: true } : {}) },
      });
      if (patch.enabled === true) {
        await attachLinkEnds(Number(row.account_id), [
          { kind: row.source_kind, id: Number(row.source_id), service: row.source_service ?? null },
          { kind: row.target_kind, id: Number(row.target_id), service: row.target_service ?? null },
        ]);
      }
      requestPolicySync(`link:${row.id}`);
      emitLink(Number(row.tenant_id), Number(row.account_id), Number(row.id));
    }
    return linkOut(Number(row.id));
  },

  /** DELETE /network/links/:id (apps.manage). */
  async deleteLink(req: Request, actor: HostingActor, id: number): Promise<{ deleted: true }> {
    const row = await loadOwned<LinkRow & { [column: string]: unknown }>(actor, 'network_links', id, 'apps.manage', 'Network link');
    // A default site → DB link (origin 'migration') is DISABLED, not deleted: the row is what keeps
    // ensureDefaultDbLinks from re-creating it at the next pass (defaultLinks.ts). The flow goes away the same.
    const keepDisabled = row.origin === 'migration' && row.source_kind === 'site' && row.target_kind === 'db';
    if (keepDisabled) {
      await db('network_links').where({ id: row.id }).update({ enabled: false, status: 'pending', status_message: null, updated_at: db.fn.now() });
    } else {
      await db('network_links').where({ id: row.id }).del();
    }
    await auditService.logReqAs(req, Number(row.tenant_id), 'network.link.delete', {
      resourceType: 'network_link', resourcePath: String(row.id),
      details: {
        accountId: Number(row.account_id), origin: row.origin, ...(keepDisabled ? { keptDisabled: true } : {}),
        source: { kind: row.source_kind, id: Number(row.source_id), service: row.source_service }, target: { kind: row.target_kind, id: Number(row.target_id), service: row.target_service },
        protocol: row.protocol, port: Number(row.port),
      },
    });
    requestPolicySync(`link-deleted:${row.id}`);
    emitLink(Number(row.tenant_id), Number(row.account_id), null);
    return { deleted: true };
  },

  /** GET /system/network (platform admin). */
  async systemStatus(): Promise<NetworkSystemStatus> {
    const { platformSettings } = await import('../platformSettings');
    const mode = (await platformSettings.section('network')).mode;
    const counts = await db('hosting_accounts').whereNot('status', 'deleting')
      .select(db.raw(`count(*) FILTER (WHERE network_model = 'segmented') AS segmented`),
        db.raw(`count(*) FILTER (WHERE network_model = 'legacy' AND network_error IS NULL) AS legacy`),
        db.raw(`count(*) FILTER (WHERE network_model = 'legacy' AND network_error IS NOT NULL) AS failed`)) as Array<{ segmented: string | number; legacy: string | number; failed: string | number }>;
    const st = pushStatus();
    let dropped: number | null = null;
    let hostdBridges: number | null = null;
    let hostdRules: number | null = null;
    try {
      const b = segmentBackends();
      const hs = await b.hostd(await b.localNode()).segmentsStatus();
      dropped = hs.dropped ?? null;
      hostdBridges = hs.bridges;
      hostdRules = hs.rules;
    } catch (err) {
      logger.debug({ err: errText(err) }, 'segments: hostd status unavailable');
    }
    return {
      mode,
      pools: await poolStatus(),
      accounts: { segmented: Number(counts[0]?.segmented ?? 0), legacy: Number(counts[0]?.legacy ?? 0), failed: Number(counts[0]?.failed ?? 0) },
      lastPushAt: st.lastPushAt ? st.lastPushAt.toISOString() : null,
      lastPushError: st.lastPushError,
      bridges: st.lastState?.bridges.length ?? hostdBridges ?? 0,
      rules: st.lastState?.allow.length ?? hostdRules ?? 0,
      dropped,
    };
  },

  /** POST /system/network/sync — push the policy now. */
  async syncNow(): Promise<NetworkSystemStatus> {
    await syncPolicyNow('manual');
    return segmentService.systemStatus();
  },

  /** POST /system/network/migrate — one account, or every legacy account (audited). */
  async migrate(req: Request, body: NetworkMigrateRequest): Promise<NetworkSystemStatus> {
    let tenantId = 1;
    if (body.accountId !== undefined) {
      const row = await db('hosting_accounts').where({ id: body.accountId }).first('id', 'tenant_id', 'network_model', 'network_error') as
        { id: number; tenant_id: number; network_model: string } | undefined;
      if (!row) throw new AppError(404, 'Account not found', 'notFound');
      tenantId = Number(row.tenant_id);
    }
    const result = await migrateLegacySweep(body.accountId);
    await auditService.logReqAs(req, tenantId, 'network.migrate', {
      resourceType: body.accountId ? 'account' : undefined, resourcePath: body.accountId ? String(body.accountId) : undefined,
      details: { accountId: body.accountId ?? null, ...result },
    });
    await syncPolicyNow('migration');
    return segmentService.systemStatus();
  },

  /** GET /system/network/flows?accountId — allowed flows as computed now (accountId ≤ 0 = every account). */
  async flows(accountId: number): Promise<NetworkFlowView[]> {
    const b = segmentBackends();
    const { platformSettings } = await import('../platformSettings');
    const mode = (await platformSettings.section('network')).mode;
    let nodeId: number;
    if (Number.isInteger(accountId) && accountId > 0) {
      const row = await db('hosting_accounts').where({ id: accountId }).first('node_id') as { node_id: number } | undefined;
      if (!row) throw new AppError(404, 'Account not found', 'notFound');
      nodeId = Number(row.node_id);
    } else {
      nodeId = await b.localNode();
    }
    let observed: Awaited<ReturnType<typeof observeNode>>;
    try {
      observed = await observeNode(nodeId, { mode: mode === 'off' ? 'enforce' : mode, accountId: accountId > 0 ? accountId : null });
    } catch (err) {
      throw new AppError(502, `Docker unavailable: ${errText(err)}`, 'dockerUnavailable');
    }
    return buildPolicy(observed.model).flows.map((f) => ({
      bridge: f.bridge, src: f.src, dst: f.dst, protocol: f.protocol, port: f.port, reason: f.reason, linkId: f.linkId,
    }));
  },

  // ── internal API (signatures frozen) ──

  /** Both fabrics of the account exist (created with fabricNetworkOptions when missing; idempotent). */
  async ensureAccountFabrics(accountId: number): Promise<{ front: string; back: string }> {
    const row = await db('hosting_accounts').where({ id: accountId }).first('id', 'node_id') as { id: number; node_id: number } | undefined;
    if (!row) throw new AppError(404, 'Account not found', 'notFound');
    const docker = await segmentBackends().docker(Number(row.node_id));
    const front = fabricNetworkName(accountId, 'front');
    const back = fabricNetworkName(accountId, 'back');
    // Same labels as reconcile.service.ts: the FRONT carries oblimint.account (the edge joins it), the BACK
    // carries oblimint.db-network and NEVER oblimint.account (the edge must not join a database network).
    if (!(await inspectNetwork(docker, front))) {
      await createNetwork(docker, front, { [LABELS.internal]: 'true', [LABELS.account]: String(accountId) }, await fabricNetworkOptions(accountId, 'front', docker));
    }
    if (!(await inspectNetwork(docker, back))) {
      await createNetwork(docker, back, { [LABELS.internal]: 'true', [P2_LABELS.dbNetwork]: String(accountId) }, await fabricNetworkOptions(accountId, 'back', docker));
    }
    return { front, back };
  },

  /** Subnets (app pool) for the private networks of a stack; idempotent per (stack, name). */
  async allocateAppNetworks(stackId: number, accountId: number, names: string[]): Promise<AllocatedAppNetwork[]> {
    const stack = await db('app_stacks').where({ id: stackId, account_id: accountId }).first('id', 'node_id') as { id: number; node_id: number } | undefined;
    if (!stack) throw new AppError(404, 'Application not found', 'notFound');
    const unique = [...new Set(names.map((n) => String(n)))];
    if (!unique.length) return [];
    const subnets = await listDockerSubnets(await segmentBackends().docker(Number(stack.node_id)));
    const out: AllocatedAppNetwork[] = [];
    for (const name of unique) {
      const dockerName = appPrivateNetwork(stackId, name);
      const { cidr, gateway } = await allocateSubnet(dockerName, { pool: 'app', purpose: 'app', accountId, stackId }, subnets);
      out.push({ name, dockerName, subnet: cidr, gateway });
    }
    return out;
  },

  /** Releases every subnet of the stack (kept 1 h before reuse). Idempotent. */
  async releaseAppNetworks(stackId: number): Promise<void> {
    if (!Number.isInteger(stackId) || stackId <= 0) return;
    await releaseSubnets({ stackId });
    requestPolicySync(`stack-released:${stackId}`);
  },

  async stackFabricPlan(stackId: number): Promise<StackFabricPlan> {
    const stack = await db('app_stacks').where({ id: stackId }).first('id', 'account_id', 'effective', 'validation') as
      { id: number; account_id: number; effective: unknown; validation: unknown } | undefined;
    if (!stack) throw new AppError(404, 'Application not found', 'notFound');
    const accountId = Number(stack.account_id);
    const links = await db('network_links').where({ account_id: accountId, enabled: true })
      .andWhere((w) => w.where({ source_kind: 'app', source_id: stackId }).orWhere({ target_kind: 'app', target_id: stackId }))
      .select('source_kind', 'source_id', 'source_service', 'target_kind', 'target_id', 'target_service') as LinkRow[];
    const all = Object.keys(stackExposedPorts(stack));
    const back = new Set<string>();
    for (const l of links) {
      if (l.source_kind === 'app' && Number(l.source_id) === stackId) {
        for (const s of l.source_service ? [l.source_service] : all) back.add(s);
      }
      if (l.target_kind === 'app' && Number(l.target_id) === stackId && l.target_service) back.add(l.target_service);
    }
    return {
      accountId,
      frontNetwork: fabricNetworkName(accountId, 'front'),
      backNetwork: fabricNetworkName(accountId, 'back'),
      backServices: [...back].sort(),
    };
  },

  /** Recompute + push the policy soon (debounced, coalesced). Never throws. */
  requestPolicySync(reason: string): void {
    requestPolicySync(reason);
  },

  /** Settings section `network` changed. Never throws. */
  settingsChanged(): void {
    requestPolicySync('settings');
  },

  // ── worker: Docker events → policy refresh, periodic full push (5 min), legacy migration ──
  start(): void {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const tick = (reason: string) => {
        if (sweepRunning) return;
        sweepRunning = true;
        void migrateLegacySweep()
          .catch(() => undefined)
          .finally(() => { sweepRunning = false; requestPolicySync(reason); });
      };
      tick('boot');
      periodicTimer = setInterval(() => tick('periodic'), PERIODIC_MS);
      periodicTimer.unref?.();
      startEvents();
    } catch (err) {
      logger.warn({ err: errText(err) }, 'segments worker start failed');
    }
  },

  stop(): void {
    workerRunning = false;
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    stopEvents();
  },
};
