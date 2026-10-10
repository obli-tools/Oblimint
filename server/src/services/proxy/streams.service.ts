import type { Request } from 'express';
import type { ProxyStream, ProxyStreamInput, ProxyStreamUpdate, ProxyTarget } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { assertNeedSomewhere, assertStaff, loadAccount, type HostingActor } from '../hosting/access';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { accountLimits, auditProxy, edgeSettings, emitProxy, isPlatformAdmin, normalizeTarget } from './common';
import { proxyDeps } from './deps';
import { edgeView, type ProxyListQuery } from './hosts.service';
import { isoNow, toTarget, type StreamDbRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// TCP / UDP streams (docs/P4b-PLAN.md §6.3, §8.8, ED5): STAFF only — account
// streams by the staff holding proxy.manage on the tenant, platform streams
// (account null) by the platform admin. Incoming port ∈ settings
// edge.streamPorts (approved and published by the edge), one stream per port
// and protocol (partial unique indexes). Targets: an exposed app port of the
// same account, or an external address (plan + tenant policy rules).
// ─────────────────────────────────────────────────────────────────────────────

const selectStreams = () => db('proxy_streams as s').leftJoin('hosting_accounts as a', 'a.id', 's.account_id').select('s.*', 'a.username as account_username');

async function mapStreams(rows: StreamDbRow[], actor: HostingActor): Promise<ProxyStream[]> {
  if (!rows.length) return [];
  const states = await proxyDeps().unitStates('stream', rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    accountUsername: r.account_username ?? null,
    name: r.name,
    enabled: !!r.enabled,
    incomingPort: Number(r.incoming_port),
    tcp: !!r.tcp,
    udp: !!r.udp,
    target: toTarget(r.target),
    edge: edgeView(states.get(Number(r.id)), actor, {
      unitId: `st-${Number(r.id)}`, ownerKind: 'stream', ownerId: Number(r.id), accountId: r.account_id === null ? null : Number(r.account_id),
    }),
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

function portTaken(port: number): AppError {
  return new AppError(409, `Port ${port} is already used by another stream`, 'streamPortTaken', { port });
}

interface StreamState { name: string; enabled: boolean; incomingPort: number; tcp: boolean; udp: boolean; target: ProxyTarget }

async function checkState(actor: HostingActor, owner: { accountId: number | null; tenantId: number }, s: StreamState, previous: StreamState | null, exceptId: number | null): Promise<StreamState> {
  if (!s.tcp && !s.udp) throw new AppError(400, 'Choose TCP and / or UDP', 'validation');
  const approved = (await edgeSettings()).streamPorts;
  for (const proto of (['tcp', 'udp'] as const).filter((p) => s[p])) {
    if (!approved.some((a) => a.port === s.incomingPort && a.protocol === proto)) {
      throw new AppError(400, `Port ${s.incomingPort}/${proto} is not approved by the platform`, 'streamPortNotApproved', { port: s.incomingPort, protocol: proto });
    }
    const q = db('proxy_streams').where({ incoming_port: s.incomingPort, [proto]: true });
    if (exceptId) q.whereNot({ id: exceptId });
    if (await q.first('id')) throw portTaken(s.incomingPort);
  }
  const limits = owner.accountId === null ? null : await accountLimits(db, owner.accountId);
  let target = s.target;
  for (const proto of (['tcp', 'udp'] as const).filter((p) => s[p])) {
    target = await normalizeTarget(s.target, { actor, accountId: owner.accountId, tenantId: owner.tenantId, limits, protocol: proto, previous: previous?.target });
  }
  if (target.kind === 'site') throw new AppError(400, 'A stream targets an application or an external address', 'targetInvalid');
  return { ...s, name: s.name.trim(), target };
}

function values(s: StreamState) {
  return {
    name: s.name, enabled: s.enabled, incoming_port: s.incomingPort, tcp: s.tcp, udp: s.udp, target: JSON.stringify(s.target),
    target_stack_id: s.target.kind === 'app' ? s.target.stackId : null,
  };
}

async function loadForChange(actor: HostingActor, id: number): Promise<StreamDbRow> {
  assertStaff(actor);
  const row = await loadOwned(actor, 'proxy_streams', id, 'proxy.manage', 'Stream') as unknown as StreamDbRow;
  if (row.account_id === null && !isPlatformAdmin(actor)) throw new AppError(403, 'Insufficient permissions');
  return row;
}

export const streamsService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<ProxyStream[]> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    const qb = selectStreams();
    scopeOwned(actor, qb, 's', { filterTenantId: q.tenantId ?? null, includePlatform: true });
    if (q.accountId) qb.where('s.account_id', q.accountId);
    return mapStreams(await qb.orderBy('s.incoming_port') as StreamDbRow[], actor);
  },

  async get(actor: HostingActor, id: number): Promise<ProxyStream> {
    assertStaff(actor);
    await loadOwned(actor, 'proxy_streams', id, 'read', 'Stream');
    return (await mapStreams([await selectStreams().where('s.id', id).first() as StreamDbRow], actor))[0];
  },

  async ports(actor: HostingActor): Promise<Array<{ port: number; protocol: 'tcp' | 'udp'; usedBy: number | null }>> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    const approved = (await edgeSettings()).streamPorts;
    const rows = await db('proxy_streams').select('id', 'incoming_port', 'tcp', 'udp', 'tenant_id') as
      Array<{ id: number; incoming_port: number; tcp: boolean; udp: boolean; tenant_id: number }>;
    return approved.map((a) => {
      const user = rows.find((r) => Number(r.incoming_port) === a.port && (a.protocol === 'tcp' ? r.tcp : r.udp));
      // Another tenant's stream: the port is taken, the id is not disclosed.
      const visible = user && (actor.kind === 'staff' && (actor.globalView || Number(user.tenant_id) === actor.tenantId));
      return { port: a.port, protocol: a.protocol, usedBy: user ? (visible ? Number(user.id) : 0) : null };
    });
  },

  async create(req: Request, actor: HostingActor, body: ProxyStreamInput): Promise<ProxyStream> {
    assertStaff(actor);
    let owner: { accountId: number | null; tenantId: number };
    if (body.accountId === null) {
      if (!isPlatformAdmin(actor)) throw new AppError(403, 'Insufficient permissions');
      owner = { accountId: null, tenantId: actor.tenantId };
    } else {
      const account = await loadAccount(actor, body.accountId, 'proxy.manage');
      owner = { accountId: account.id, tenantId: account.tenant_id };
    }
    const state = await checkState(actor, owner, {
      name: body.name, enabled: body.enabled ?? true, incomingPort: body.incomingPort, tcp: body.tcp ?? true, udp: body.udp ?? false, target: body.target,
    }, null, null);
    let id: number;
    try {
      const [row] = await db('proxy_streams').insert({ tenant_id: owner.tenantId, account_id: owner.accountId, ...values(state) }).returning('id') as Array<{ id: number }>;
      id = Number(row.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw portTaken(state.incomingPort);
      throw err;
    }
    await auditProxy(req, owner.tenantId, 'proxy.stream.create', 'proxy_stream', id, { accountId: owner.accountId, port: state.incomingPort, tcp: state.tcp, udp: state.udp });
    emitProxy('stream', id, owner, 'created');
    proxyDeps().scheduleEdgeSync(`stream ${id} created`);
    proxyDeps().requestPolicySync(`stream ${id} created`);
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: ProxyStreamUpdate): Promise<ProxyStream> {
    const row = await loadForChange(actor, id);
    const prev: StreamState = { name: row.name, enabled: !!row.enabled, incomingPort: Number(row.incoming_port), tcp: !!row.tcp, udp: !!row.udp, target: toTarget(row.target) };
    const owner = { accountId: row.account_id === null ? null : Number(row.account_id), tenantId: Number(row.tenant_id) };
    const state = await checkState(actor, owner, {
      name: body.name ?? prev.name, enabled: body.enabled ?? prev.enabled, incomingPort: body.incomingPort ?? prev.incomingPort,
      tcp: body.tcp ?? prev.tcp, udp: body.udp ?? prev.udp, target: body.target ?? prev.target,
    }, prev, id);
    try {
      await db('proxy_streams').where({ id, tenant_id: row.tenant_id }).update({ ...values(state), updated_at: db.fn.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw portTaken(state.incomingPort);
      throw err;
    }
    await auditProxy(req, owner.tenantId, 'proxy.stream.update', 'proxy_stream', id, { accountId: owner.accountId, fields: Object.keys(body) });
    emitProxy('stream', id, owner, 'updated');
    proxyDeps().scheduleEdgeSync(`stream ${id} updated`);
    proxyDeps().requestPolicySync(`stream ${id} updated`);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadForChange(actor, id);
    await db('proxy_streams').where({ id, tenant_id: row.tenant_id }).del();
    const owner = { accountId: row.account_id === null ? null : Number(row.account_id), tenantId: Number(row.tenant_id) };
    await auditProxy(req, owner.tenantId, 'proxy.stream.delete', 'proxy_stream', id, { accountId: owner.accountId, port: row.incoming_port });
    emitProxy('stream', id, owner, 'deleted');
    proxyDeps().scheduleEdgeSync(`stream ${id} deleted`);
    proxyDeps().requestPolicySync(`stream ${id} deleted`);
  },
};
