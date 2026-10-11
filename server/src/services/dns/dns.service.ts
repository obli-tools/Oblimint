import type { Request } from 'express';
import type {
  DnsDelegationCheck, DnsExpectedRecord, DnsRecord, DnsRecordInput, DnsServerStatus, DnsTemplate, DnsTemplateInput, DnsZone, DnsZoneCreate,
  DnsZoneDetail, DnsZoneKind, DnsZoneUpdate, DnssecInfo,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { publicDns, PublicDnsError } from '../../utils/publicDns';
import { auditService } from '../audit.service';
import { platformSettings } from '../platformSettings';
import { actorCan, actorSees, assertNeedSomewhere, assertStaff, loadAccount, scopeToActor, type HostingActor, type HostingNeed } from '../hosting/access';
import { emitHosting } from '../hosting/events';
import { forActor } from '../hosting/statusMessage';
import { inspectContainer } from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { PDNS_CONTAINER } from '../hosting/naming';
import { pdns } from './pdnsClient';
import {
  exportBind, generatedRecordsExpected, inZone, MAX_RECORDS_PER_ZONE, normalizeZoneName, recordConflict, RecordValidationError,
  soaRname, TemplateValidationError, validateRecord, validateTemplateRecords, verificationExpected,
} from './records';
import {
  applyTemplateRecords, domainRow, generatedAuto, insertZone, loadContext, PLATFORM_TENANT_ID, regenerateAuto, soaPrimary,
  toRecord, toTemplate, toZone, zoneById, zoneForName, zoneQuery, zoneRecords, type RecordRow, type TemplateRow, type ZoneRow,
} from './store';
import {
  handleAccountChanged, handleDomainChanged, handleDomainCreated, handleDomainDeleted, purgeExpired, queue, syncState, syncZone,
} from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// DNS service (module dns, docs/P2-PLAN.md §6.1, §9.1). The SIGNATURES are the
// contract (routes/dns.routes.ts, domains.service.ts of edge-ownership,
// hostingSettings.routes.ts, workers/index.ts call them).
//
// Access (plan §10): load the zone row, then actorSees (404) / actorCan
// (403, dns.manage for changes) — `id AND tenant_id` by construction; platform
// zones (account_id null) and /system/dns: platform admin only; templates:
// staff, tenant-scoped (god view may pass ?tenantId).
// Hook methods (domain*, request*, start, stop) NEVER throw and never block
// (sync.ts queue, 1 s debounce).
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsZoneFilters {
  accountId?: number | null;
  search?: string | null;
  /** God view only. */
  tenantId?: number | null;
  /** Include platform zones (platform admin only). */
  platform?: boolean;
}

const FULL_RESYNC_MS = 60 * 60_000;
const PURGE_MS = 5 * 60_000;
const BOOT_DELAY_MS = 15_000;

function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.caps === '*' && actor.globalView;
}

function notFound(): AppError {
  return new AppError(404, 'DNS zone not found', 'notFound');
}

function forbidden(): AppError {
  return new AppError(403, 'Insufficient permissions');
}

function backendError(err: unknown): AppError {
  return new AppError(502, `PowerDNS: ${(err as Error)?.message ?? String(err)}`, 'backendUnavailable');
}

function recordInvalid(err: RecordValidationError): AppError {
  return new AppError(400, err.message, 'recordInvalid', { field: err.field });
}

/** One zone visible to the actor with `need` (404 invisible, 403 without the need). */
async function loadZone(actor: HostingActor, zoneId: number, need: HostingNeed): Promise<ZoneRow> {
  if (!Number.isInteger(zoneId) || zoneId <= 0) throw notFound();
  const row = await zoneById(zoneId);
  if (!row) throw notFound();
  if (row.account_id === null) {
    if (!isPlatformAdmin(actor)) throw notFound();
    return row;
  }
  const target = { tenantId: row.tenant_id, accountId: row.account_id };
  if (!actorSees(actor, target)) throw notFound();
  if (!actorCan(actor, need, target)) throw forbidden();
  return row;
}

function assertHosted(zone: ZoneRow): void {
  if (zone.kind !== 'hosted') throw new AppError(409, 'This zone is hosted elsewhere: edit it at your DNS provider', 'zoneNotHosted');
}

async function audit(req: Request, zone: Pick<ZoneRow, 'id' | 'tenant_id' | 'name' | 'account_id'>, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReqAs(req, zone.tenant_id, action, {
    resourceType: 'dnsZone', resourcePath: String(zone.id), details: { zone: zone.name, accountId: zone.account_id, ...details },
  });
}

function emitZone(zone: Pick<ZoneRow, 'id' | 'domain_id' | 'account_id' | 'tenant_id'>): void {
  emitHosting(HostingSocketEvents.DNS_ZONE_UPDATED, { zoneId: zone.id, domainId: zone.domain_id, accountId: zone.account_id },
    { tenantId: zone.tenant_id, accountId: zone.account_id });
}

function safeHook(what: string, fn: () => void): void {
  try { fn(); } catch (err) { logger.warn({ err: (err as Error)?.message, hook: what }, 'dns hook failed'); }
}

/** After a change: the zone is pushed by the queue (immediately when the worker runs). */
function changed(zone: Pick<ZoneRow, 'id' | 'domain_id' | 'account_id' | 'tenant_id'>, reason: string): void {
  emitZone(zone);
  queue.zone(zone.id, reason);
}

/**
 * TTL of the records written by people (manual / template) set to `ttl` — auto records follow the zone default,
 * system records (ACME / ownership challenges) keep their short TTL. Returns the number of records changed.
 */
async function applyTtlToRecords(zoneId: number, ttl: number): Promise<number> {
  return db('dns_records').where({ zone_id: zoneId }).whereIn('origin', ['manual', 'template']).whereNot('ttl', ttl)
    .update({ ttl, updated_at: db.fn.now() });
}

async function zoneView(actor: HostingActor, zoneId: number): Promise<DnsZone> {
  const row = await zoneById(zoneId);
  if (!row) throw notFound();
  return forActor(actor, toZone(row));
}

async function dnssecInfo(zone: ZoneRow): Promise<DnssecInfo | null> {
  if (zone.kind !== 'hosted') return null;
  if (!zone.dnssec || zone.status !== 'active') return { enabled: !!zone.dnssec, ds: [], dnskeys: [] };
  try {
    const keys = (await (await pdns()).listCryptokeys(zone.name)).filter((k) => k.active);
    return {
      enabled: true,
      ds: [...new Set(keys.flatMap((k) => k.ds))],
      dnskeys: keys.map((k) => k.dnskey).filter((k): k is string => !!k).map((k) => `${zone.name}. IN DNSKEY ${k}`),
    };
  } catch (err) {
    logger.debug({ zone: zone.name, err: (err as Error)?.message }, 'dns: cryptokeys unavailable');
    return { enabled: true, ds: [], dnskeys: [] };
  }
}

async function detail(actor: HostingActor, zoneId: number): Promise<DnsZoneDetail> {
  const zone = await zoneById(zoneId);
  if (!zone) throw notFound();
  const ctx = await loadContext();
  const records = (await zoneRecords(zone.id)).filter((r) => r.origin !== 'system');
  const expected: DnsExpectedRecord[] = [];
  if (zone.kind === 'hosted') {
    for (const ns of ctx.settings.nameservers) expected.push({ name: '@', type: 'NS', content: `${ns}.`, priority: null, purpose: 'delegation' });
  } else {
    expected.push(...generatedRecordsExpected(await generatedAuto(zone, ctx)));
  }
  if (zone.domain_id) {
    const d = await domainRow(zone.domain_id);
    if (d && d.verification_status !== 'verified' && d.verification_token) {
      const v = verificationExpected(d.name, d.verification_token, zone.name);
      if (v) expected.push(v);
    }
  }
  return {
    ...forActor(actor, toZone(zone)),
    records: records.map(toRecord),
    nameservers: ctx.settings.nameservers,
    expected,
    dnssecInfo: await dnssecInfo(zone),
  };
}

/** Records of the zone counted against MAX_RECORDS_PER_ZONE. */
async function recordCount(zoneId: number): Promise<number> {
  const r = await db('dns_records').where({ zone_id: zoneId }).whereNot({ origin: 'system' }).count('* as c').first() as { c: string | number };
  return Number(r.c);
}

function validated(zone: ZoneRow, input: DnsRecordInput) {
  try {
    return validateRecord(input, { zone: zone.name, defaultTtl: zone.default_ttl });
  } catch (err) {
    if (err instanceof RecordValidationError) throw recordInvalid(err);
    throw err;
  }
}

async function assertNoConflict(zone: ZoneRow, rec: ReturnType<typeof validated>, selfId?: number): Promise<void> {
  const existing = await db('dns_records').where({ zone_id: zone.id }).select('id', 'name', 'type', 'content', 'priority', 'origin') as RecordRow[];
  const conflict = recordConflict(rec, existing, selfId);
  if (conflict) throw new AppError(409, conflict, 'recordConflict', { field: rec.type === 'CNAME' || rec.type === 'NS' ? 'type' : 'content' });
}

/** Template visible to the staff actor with `need` (404 / 403). */
async function loadTemplate(actor: HostingActor, id: number, need: HostingNeed): Promise<TemplateRow> {
  assertStaff(actor);
  const row = await db('dns_templates').where({ id }).first() as TemplateRow | undefined;
  if (!row || !actorSees(actor, { tenantId: row.tenant_id, accountId: null })) throw new AppError(404, 'DNS template not found', 'notFound');
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: null })) throw forbidden();
  return row;
}

function templateRecords(records: DnsTemplateInput['records']) {
  try {
    return validateTemplateRecords(records);
  } catch (err) {
    if (err instanceof TemplateValidationError) throw new AppError(400, err.message, 'templateInvalid', { index: err.index, field: err.field });
    throw err;
  }
}

async function templateNameTaken(tenantId: number, name: string, exceptId?: number): Promise<void> {
  const q = db('dns_templates').where({ tenant_id: tenantId }).whereRaw('lower(name) = ?', [name.toLowerCase()]);
  if (exceptId) q.whereNot({ id: exceptId });
  if (await q.first('id')) throw new AppError(400, 'A template with this name already exists', 'templateInvalid', { field: 'name' });
}

let timers: NodeJS.Timeout[] = [];

export const dnsService = {
  /**
   * Platform-side TTL change of a hosted zone found by name (CWP migration cutover: the zone is delegated to our
   * name servers, the staff lowers / raises its TTL from the checklist). Default TTL + manual / template records,
   * audited, pushed to PowerDNS. null when there is no such hosted zone.
   */
  async setZoneTtlByName(req: Request, name: string, ttl: number): Promise<{ zoneId: number; recordsRetimed: number } | null> {
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 604800) throw new AppError(400, 'TTL must be between 60 and 604800', 'recordInvalid', { field: 'ttl' });
    const zone = await db('dns_zones').where({ name: name.toLowerCase(), kind: 'hosted' }).first() as ZoneRow | undefined;
    if (!zone) return null;
    if (zone.default_ttl !== ttl) await db('dns_zones').where({ id: zone.id }).update({ default_ttl: ttl, updated_at: db.fn.now() });
    const recordsRetimed = await applyTtlToRecords(zone.id, ttl);
    await audit(req, zone, 'dns.zone.ttl', { from: zone.default_ttl, to: ttl, recordsRetimed });
    const fresh = await zoneById(zone.id);
    if (fresh) await regenerateAuto(fresh, await loadContext());
    changed(zone, 'zone-updated');
    return { zoneId: zone.id, recordsRetimed };
  },

  // ── zones ──
  async listZones(actor: HostingActor, filters: DnsZoneFilters): Promise<DnsZone[]> {
    if (filters.platform && !isPlatformAdmin(actor)) throw forbidden();
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = zoneQuery();
    if (filters.platform) {
      if (actor.kind === 'staff' && actor.globalView && filters.tenantId) q.where((w) => w.whereNull('z.account_id').orWhere('z.tenant_id', filters.tenantId!));
    } else {
      q.whereNotNull('z.account_id');
      scopeToActor(actor, q, { tenant: 'z.tenant_id', account: 'z.account_id' }, filters.tenantId);
    }
    if (filters.accountId) q.where('z.account_id', filters.accountId);
    const search = filters.search?.trim().toLowerCase();
    if (search) q.where('z.name', 'like', `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = await q.orderBy('z.name').limit(2000) as ZoneRow[];
    return rows.map((r) => forActor(actor, toZone(r)));
  },

  async getZone(actor: HostingActor, zoneId: number): Promise<DnsZoneDetail> {
    await loadZone(actor, zoneId, 'read');
    return detail(actor, zoneId);
  },

  async createZone(req: Request, actor: HostingActor, body: DnsZoneCreate): Promise<DnsZone> {
    const ctx = await loadContext();
    const kind: DnsZoneKind = body.kind ?? (ctx.settings.enabled ? 'hosted' : 'external');
    if (kind === 'hosted' && !ctx.settings.enabled) throw new AppError(409, 'The platform DNS server is disabled', 'dnsDisabled');

    let tenantId: number;
    let accountId: number | null;
    let domainId: number | null = null;
    let name: string;

    if (body.accountId === null || body.accountId === undefined) {
      if (!isPlatformAdmin(actor)) throw forbidden();
      if (!body.name) throw new AppError(400, 'A platform zone needs a name', 'validation', { field: 'name' });
      tenantId = PLATFORM_TENANT_ID;
      accountId = null;
      try { name = normalizeZoneName(body.name); } catch (err) { throw new AppError(400, (err as Error).message, 'validation', { field: 'name' }); }
      const tenantDomain = await db('domains').where({ name }).first('id');
      if (tenantDomain) throw new AppError(409, 'This name belongs to a hosting account', 'zoneExists');
    } else {
      const account = await loadAccount(actor, body.accountId, 'dns.manage');
      tenantId = account.tenant_id;
      accountId = account.id;
      if (body.domainId) {
        const d = await domainRow(body.domainId);
        if (!d || d.account_id !== account.id) throw new AppError(404, 'Domain not found', 'notFound');
        domainId = d.id;
        name = d.name.toLowerCase();
        if (await db('dns_zones').where({ domain_id: d.id }).first('id')) throw new AppError(409, 'This domain already has a DNS zone', 'zoneExists');
      } else {
        if (!body.name) throw new AppError(400, 'domainId or name is required', 'validation', { field: 'name' });
        try { name = normalizeZoneName(body.name); } catch (err) { throw new AppError(400, (err as Error).message, 'validation', { field: 'name' }); }
        const doms = await db('domains').where({ account_id: account.id }).select('id', 'name') as Array<{ id: number; name: string }>;
        const covering = doms.filter((d) => inZone(name, d.name));
        if (!covering.length) throw new AppError(400, 'The zone must be a domain of the account or a name below one', 'validation', { field: 'name' });
        const exact = covering.find((d) => d.name === name);
        if (exact && !(await db('dns_zones').where({ domain_id: exact.id }).first('id'))) domainId = exact.id;
      }
      // A tenant zone below a platform zone would be the more specific zone in
      // PowerDNS and shadow platform names (same rule as domains.create: names
      // held from before that rule do not get a zone there). Platform admin only.
      if (!isPlatformAdmin(actor) && await zoneForName(name, null)) {
        throw new AppError(400, 'This name is reserved by the platform', 'domainReserved');
      }
    }
    if (await db('dns_zones').where({ name }).first('id')) throw new AppError(409, 'A DNS zone with this name already exists', 'zoneExists');
    let templateId: number | null = null;
    if (body.templateId) {
      const t = await db('dns_templates').where({ id: body.templateId, tenant_id: tenantId }).first('id');
      if (!t) throw new AppError(404, 'DNS template not found', 'notFound');
      templateId = t.id;
    }

    const row = await db.transaction((trx) => insertZone(trx, { tenantId, accountId, domainId, name, kind, templateId }, ctx));
    await audit(req, row, 'dns.zone.create', { kind, domainId, templateId });
    changed(row, 'zone-created');
    return zoneView(actor, row.id);
  },

  async updateZone(req: Request, actor: HostingActor, zoneId: number, body: DnsZoneUpdate): Promise<DnsZoneDetail> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined && body.kind !== zone.kind) {
      if (body.kind === 'hosted' && !(await platformSettings.section('dns')).enabled) {
        throw new AppError(409, 'The platform DNS server is disabled', 'dnsDisabled');
      }
      patch.kind = body.kind;
      patch.status = body.kind === 'external' ? 'disabled' : 'pending';
      patch.status_message = null;
      if (body.kind === 'external') patch.dnssec = false;
    }
    if (body.defaultTtl !== undefined && body.defaultTtl !== zone.default_ttl) {
      if (!Number.isInteger(body.defaultTtl) || body.defaultTtl < 60 || body.defaultTtl > 604800) {
        throw new AppError(400, 'TTL must be between 60 and 604800', 'recordInvalid', { field: 'ttl' });
      }
      patch.default_ttl = body.defaultTtl;
    }
    let recordsRetimed = 0;
    if (body.applyTtlToRecords) recordsRetimed = await applyTtlToRecords(zone.id, (patch.default_ttl as number | undefined) ?? zone.default_ttl);
    if (recordsRetimed && !Object.keys(patch).length) {
      await audit(req, zone, 'dns.zone.update', { ...body, recordsRetimed });
      changed(zone, 'zone-updated');
    }
    const dnssecChange = body.dnssec !== undefined && body.dnssec !== !!zone.dnssec;
    if (dnssecChange) {
      if (body.dnssec && (zone.kind !== 'hosted' || patch.kind === 'external' || zone.status !== 'active')) {
        throw new AppError(409, 'DNSSEC needs a hosted zone that is served by our name servers', 'zoneNotHosted');
      }
      patch.dnssec = body.dnssec;
    }
    if (Object.keys(patch).length) {
      await db('dns_zones').where({ id: zone.id }).update({ ...patch, updated_at: db.fn.now() });
      await audit(req, zone, 'dns.zone.update', { ...body, ...(body.applyTtlToRecords ? { recordsRetimed } : {}) });
    }
    if (dnssecChange) {
      // The user waits for the keys (DS to publish): push now, roll back when PowerDNS is unreachable.
      const r = await syncZone(zone.id, 'dnssec');
      if (!r.ok) {
        await db('dns_zones').where({ id: zone.id }).update({ dnssec: !!zone.dnssec });
        throw backendError(new Error(r.error ?? 'sync failed'));
      }
      emitZone(zone);
    } else if (Object.keys(patch).length) {
      const fresh = await zoneById(zone.id);
      if (fresh) await regenerateAuto(fresh, await loadContext());
      changed(zone, 'zone-updated');
    }
    return detail(actor, zone.id);
  },

  async deleteZone(req: Request, actor: HostingActor, zoneId: number): Promise<void> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    if (zone.domain_id && await db('domains').where({ id: zone.domain_id }).first('id')) {
      throw new AppError(409, 'This zone belongs to a domain: delete the domain first', 'zoneHasDomain');
    }
    await db('dns_zones').where({ id: zone.id }).delete();
    await audit(req, zone, 'dns.zone.delete');
    emitZone(zone);
    queue.remove(zone.name);
    if (zone.account_id !== null) {
      // Subdomain records may move back to a parent zone.
      const parents = await db('dns_zones').where({ account_id: zone.account_id }).select('id', 'name') as Array<{ id: number; name: string }>;
      for (const p of parents) if (inZone(zone.name, p.name)) queue.zone(p.id, 'subzone-deleted');
    }
  },

  /** Regenerates the auto records (and drops manual ones unless keepManual). */
  async resetZone(req: Request, actor: HostingActor, zoneId: number, opts: { keepManual: boolean }): Promise<DnsZoneDetail> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    const ctx = await loadContext();
    await db.transaction(async (trx) => {
      const origins = opts.keepManual ? ['auto', 'template'] : ['auto', 'template', 'manual'];
      await trx('dns_records').where({ zone_id: zone.id }).whereIn('origin', origins).delete();
      const template = zone.template_id ? await trx('dns_templates').where({ id: zone.template_id }).first() as TemplateRow | undefined : undefined;
      if (template) await applyTemplateRecords(trx, zone, template, ctx);
      await regenerateAuto(zone, ctx, trx);
    });
    await audit(req, zone, 'dns.zone.reset', { keepManual: opts.keepManual });
    changed(zone, 'zone-reset');
    return detail(actor, zone.id);
  },

  async applyTemplate(req: Request, actor: HostingActor, zoneId: number, templateId: number): Promise<DnsZoneDetail> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    assertHosted(zone);
    const template = await db('dns_templates').where({ id: templateId, tenant_id: zone.tenant_id }).first() as TemplateRow | undefined;
    if (!template) throw new AppError(404, 'DNS template not found', 'notFound');
    const ctx = await loadContext();
    let written = 0;
    await db.transaction(async (trx) => {
      await trx('dns_records').where({ zone_id: zone.id, origin: 'template' }).delete();
      const count = Number((await trx('dns_records').where({ zone_id: zone.id }).whereNot({ origin: 'system' }).count('* as c').first() as { c: string | number }).c);
      if (count + toTemplate(template).records.length > MAX_RECORDS_PER_ZONE) {
        throw new AppError(409, `A zone holds ${MAX_RECORDS_PER_ZONE} records at most`, 'recordLimit', { max: MAX_RECORDS_PER_ZONE });
      }
      written = await applyTemplateRecords(trx, zone, template, ctx);
      await trx('dns_zones').where({ id: zone.id }).update({ template_id: template.id, updated_at: trx.fn.now() });
      await regenerateAuto(zone, ctx, trx);
    });
    await audit(req, zone, 'dns.zone.update', { templateId: template.id, template: template.name, written });
    changed(zone, 'template-applied');
    return detail(actor, zone.id);
  },

  /** BIND zone file (system records excluded). */
  async exportZone(actor: HostingActor, zoneId: number): Promise<string> {
    const zone = await loadZone(actor, zoneId, 'read');
    const ctx = await loadContext();
    const records = (await zoneRecords(zone.id)).filter((r) => r.origin !== 'system');
    return exportBind({
      zone: zone.name,
      serial: Number(zone.serial),
      mname: soaPrimary(ctx, zone.name),
      rname: soaRname(ctx.settings.hostmasterEmail, zone.name),
      nameservers: ctx.settings.nameservers,
      defaultTtl: zone.default_ttl,
      records: records.map((r) => ({ ...r, expiresAt: r.expires_at })),
    });
  },

  async checkDelegation(actor: HostingActor, zoneId: number): Promise<DnsDelegationCheck> {
    const zone = await loadZone(actor, zoneId, 'read');
    const expected = (await platformSettings.section('dns')).nameservers.map((n) => n.toLowerCase().replace(/\.$/, ''));
    let publicNameservers: string[] = [];
    let error: string | null = null;
    try {
      publicNameservers = [...new Set(await (await publicDns()).ns(zone.name))].sort();
    } catch (err) {
      error = err instanceof PublicDnsError ? err.code : 'resolverFailed';
    }
    const delegated = !error && publicNameservers.length > 0 && expected.length > 0 && publicNameservers.every((n) => expected.includes(n));
    return { zoneId: zone.id, publicNameservers, expectedNameservers: expected, delegated, checkedAt: new Date().toISOString(), error };
  },

  // ── records ──
  async createRecord(req: Request, actor: HostingActor, zoneId: number, input: DnsRecordInput): Promise<DnsRecord> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    assertHosted(zone);
    const rec = validated(zone, input);
    if (await recordCount(zone.id) >= MAX_RECORDS_PER_ZONE) {
      throw new AppError(409, `A zone holds ${MAX_RECORDS_PER_ZONE} records at most`, 'recordLimit', { max: MAX_RECORDS_PER_ZONE });
    }
    await assertNoConflict(zone, rec);
    const [row] = await db('dns_records').insert({
      zone_id: zone.id, name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl, priority: rec.priority,
      origin: 'manual', disabled: rec.disabled, comment: rec.comment,
    }).returning('*') as RecordRow[];
    await regenerateAuto(zone, await loadContext());
    await audit(req, zone, 'dns.record.create', { recordId: row.id, name: rec.name, type: rec.type, content: rec.content });
    changed(zone, 'record-created');
    return toRecord(row);
  },

  async updateRecord(req: Request, actor: HostingActor, zoneId: number, recordId: number, input: DnsRecordInput): Promise<DnsRecord> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    assertHosted(zone);
    const current = await db('dns_records').where({ id: recordId, zone_id: zone.id }).first() as RecordRow | undefined;
    if (!current) throw new AppError(404, 'DNS record not found', 'notFound');
    if (current.origin === 'system') throw new AppError(403, 'This record is managed by the platform', 'systemRecord');
    const rec = validated(zone, input);
    await assertNoConflict(zone, rec, current.id);
    // An edited auto / template record becomes manual: it overrides the generated one.
    const [row] = await db('dns_records').where({ id: current.id }).update({
      name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl, priority: rec.priority, disabled: rec.disabled,
      comment: rec.comment, origin: 'manual', updated_at: db.fn.now(),
    }).returning('*') as RecordRow[];
    await regenerateAuto(zone, await loadContext());
    await audit(req, zone, 'dns.record.update', {
      recordId: row.id, name: rec.name, type: rec.type, content: rec.content, before: { name: current.name, type: current.type, content: current.content },
    });
    changed(zone, 'record-updated');
    return toRecord(row);
  },

  async deleteRecord(req: Request, actor: HostingActor, zoneId: number, recordId: number): Promise<void> {
    const zone = await loadZone(actor, zoneId, 'dns.manage');
    assertHosted(zone);
    const current = await db('dns_records').where({ id: recordId, zone_id: zone.id }).first() as RecordRow | undefined;
    if (!current) throw new AppError(404, 'DNS record not found', 'notFound');
    if (current.origin === 'system') throw new AppError(403, 'This record is managed by the platform', 'systemRecord');
    if (current.origin === 'auto') {
      throw new AppError(409, 'Automatic records follow the domain: disable or override this record instead of deleting it', 'recordConflict', { field: 'origin' });
    }
    await db('dns_records').where({ id: current.id }).delete();
    await regenerateAuto(zone, await loadContext());
    await audit(req, zone, 'dns.record.delete', { recordId: current.id, name: current.name, type: current.type, content: current.content });
    changed(zone, 'record-deleted');
  },

  // ── templates (per tenant; staff dns.manage) ──
  async listTemplates(actor: HostingActor, tenantId?: number | null): Promise<DnsTemplate[]> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    const q = db('dns_templates');
    scopeToActor(actor, q, { tenant: 'tenant_id', account: 'tenant_id' }, tenantId ?? null);
    return (await q.orderBy([{ column: 'tenant_id' }, { column: 'name' }]) as TemplateRow[]).map(toTemplate);
  },

  async createTemplate(req: Request, actor: HostingActor, input: DnsTemplateInput): Promise<DnsTemplate> {
    assertStaff(actor);
    const tenantId = actor.tenantId;
    if (!actorCan(actor, 'dns.manage', { tenantId, accountId: null })) throw forbidden();
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 100) throw new AppError(400, 'Invalid template name', 'templateInvalid', { field: 'name' });
    const records = templateRecords(input.records);
    await templateNameTaken(tenantId, name);
    const row = await db.transaction(async (trx) => {
      if (input.isDefault) await trx('dns_templates').where({ tenant_id: tenantId, is_default: true }).update({ is_default: false });
      const [r] = await trx('dns_templates').insert({
        tenant_id: tenantId, name, description: input.description?.trim() || null, records: JSON.stringify(records), is_default: !!input.isDefault,
      }).returning('*') as TemplateRow[];
      return r;
    });
    await auditService.logReqAs(req, tenantId, 'dns.template.create', { resourceType: 'dnsTemplate', resourcePath: String(row.id), details: { name } });
    return toTemplate(row);
  },

  async updateTemplate(req: Request, actor: HostingActor, id: number, input: Partial<DnsTemplateInput>): Promise<DnsTemplate> {
    const current = await loadTemplate(actor, id, 'dns.manage');
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 100) throw new AppError(400, 'Invalid template name', 'templateInvalid', { field: 'name' });
      if (name !== current.name) await templateNameTaken(current.tenant_id, name, current.id);
      patch.name = name;
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.records !== undefined) patch.records = JSON.stringify(templateRecords(input.records));
    if (input.isDefault !== undefined) patch.is_default = !!input.isDefault;
    const row = await db.transaction(async (trx) => {
      if (input.isDefault) await trx('dns_templates').where({ tenant_id: current.tenant_id, is_default: true }).whereNot({ id: current.id }).update({ is_default: false });
      if (!Object.keys(patch).length) return current;
      const [r] = await trx('dns_templates').where({ id: current.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*') as TemplateRow[];
      return r;
    });
    await auditService.logReqAs(req, current.tenant_id, 'dns.template.update', {
      resourceType: 'dnsTemplate', resourcePath: String(current.id), details: { name: row.name, fields: Object.keys(patch) },
    });
    return toTemplate(row);
  },

  async deleteTemplate(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadTemplate(actor, id, 'dns.manage');
    await db('dns_templates').where({ id: current.id }).delete();
    await auditService.logReqAs(req, current.tenant_id, 'dns.template.delete', {
      resourceType: 'dnsTemplate', resourcePath: String(current.id), details: { name: current.name },
    });
  },

  // ── platform ──
  async status(): Promise<DnsServerStatus> {
    const settings = await platformSettings.section('dns');
    const counts = await db('dns_zones').select('status').count('* as c').groupBy('status') as Array<{ status: string; c: string | number }>;
    const zones = { total: 0, active: 0, pending: 0, error: 0 };
    for (const r of counts) {
      const n = Number(r.c);
      zones.total += n;
      if (r.status === 'active' || r.status === 'pending' || r.status === 'error') zones[r.status] += n;
    }
    let deployed = false;
    let running = false;
    try {
      const info = await inspectContainer(await engineFor(await localNodeId()), PDNS_CONTAINER);
      deployed = !!info;
      running = !!info?.State?.Running;
    } catch { /* engine unreachable */ }
    let apiReachable = false;
    let version: string | null = null;
    try {
      version = (await (await pdns()).serverInfo()).version;
      apiReachable = true;
    } catch { /* not deployed / unreachable */ }
    return {
      enabled: settings.enabled, deployed, running, apiReachable, version, zones,
      lastSyncAt: syncState.lastSyncAt ? syncState.lastSyncAt.toISOString() : null,
      lastSyncError: syncState.lastSyncError,
    };
  },

  /** POST /system/dns/sync: full pass now (awaited), through the serialized queue (never alongside its own pass). */
  async syncAllNow(reason: string): Promise<DnsServerStatus> {
    queue.all(reason);
    await queue.drain();
    return this.status();
  },

  // ── hooks for the other modules: never throw, never block ──
  /** A domain row was created (domains.service). zone: DomainCreate.dnsZone (undefined = default policy). */
  domainCreated(domainId: number, zone?: DnsZoneKind | 'none'): void {
    safeHook('domainCreated', () => queue.job(() => handleDomainCreated(domainId, zone)));
  },
  /** A domain changed: update, www / wildcard toggle, verification, routes, account suspension. */
  domainChanged(domainId: number, reason: string): void {
    safeHook('domainChanged', () => queue.job(() => handleDomainChanged(domainId, reason)));
  },
  /** A domain row was deleted (its zone row survives with domain_id NULL → the module decides). */
  domainDeleted(domain: { id: number; name: string; accountId: number; tenantId: number }): void {
    safeHook('domainDeleted', () => queue.job(() => handleDomainDeleted(domain)));
  },
  /**
   * A hosting account changed status (suspended, 'deleting', back from error):
   * its zones follow rule D1 ('deleting' = unpublished). accounts.service calls
   * it on every status change; after the account row is deleted (zones gone by
   * CASCADE) call requestSyncAll('account-deleted') so PowerDNS drops them.
   */
  accountChanged(accountId: number, reason: string): void {
    safeHook('accountChanged', () => queue.job(() => handleAccountChanged(accountId, reason)));
  },
  /** Re-render and push every zone (settings change, boot, account / tenant deleted). */
  requestSyncAll(reason: string): void {
    safeHook('requestSyncAll', () => queue.all(reason));
  },
  requestSyncZone(zoneId: number, reason: string): void {
    safeHook('requestSyncZone', () => queue.zone(zoneId, reason));
  },

  start(): void {
    try {
      if (timers.length) return;
      queue.activate();
      const boot = setTimeout(() => queue.all('boot'), BOOT_DELAY_MS);
      const hourly = setInterval(() => queue.all('hourly'), FULL_RESYNC_MS);
      const purge = setInterval(() => {
        purgeExpired()
          .then((zones) => { for (const id of zones) queue.zone(id, 'system-records-expired'); })
          .catch((err) => logger.warn({ err: (err as Error)?.message }, 'dns: purge of expired records failed'));
      }, PURGE_MS);
      timers = [boot, hourly, purge];
      for (const t of timers) t.unref?.();
    } catch (err) {
      logger.error({ err: (err as Error)?.message }, 'dns worker failed to start');
    }
  },
  stop(): void {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
    queue.deactivate();
  },
};

