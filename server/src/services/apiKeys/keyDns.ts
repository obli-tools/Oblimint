import type { Request } from 'express';
import type {
  ApiV1DnsRecord, ApiV1DnsUpsertResult, ApiV1DnsZone, ApiV1DnsZoneRecords, DnsRecord, DnsRecordInput, DnsRecordType,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { dnsService } from '../dns/dns.service';
import { inZone, recordConflict, RecordValidationError, validateRecord, type GeneratedRecord, type NormalizedRecord } from '../dns/records';
import { generatedAuto, loadContext, zoneQuery, type RecordRow, type ZoneRow } from '../dns/store';
import type { GateSpec } from '../restrictions/gate';
import { asKeyRequest, keyGated } from '../restrictions/targets';
import { keyAllowsDomain, requireScope, type ApiKeyContext } from './apiKeys.service';
import { keyWriteGuard, protectedRecordError, storedReadOnly } from './keyDnsRules';

// ─────────────────────────────────────────────────────────────────────────────
// DNS records through an access key (scopes dns.read / dns.write; routes/v1
// /zones…, MCP list_dns_zones, list_dns_records, upsert_dns_record,
// delete_dns_record). No parallel path: every write goes through dnsService
// (validation, conflicts, auto records, audit, PowerDNS sync) with the key's
// actor, behind the same gates as the panel (dns.record_write,
// dns.record_delete).
//
// Perimeter: the zones of the key's account (never a platform zone, never
// another account or tenant) whose domain is given to the key — every zone of
// the account for a key on every domain (domainScope 'all', which needs the
// domain management right of its user). A zone of the account outside it:
// 403 keyDomainNotManageable; anything else: 404.
// What a key writes: keyDnsRules.ts (the platform's records stay read-only).
// Order of the checks: scope, zone, record, validation, protection, conflict —
// then the gate, so nobody confirms something that would be refused anyway.
// ─────────────────────────────────────────────────────────────────────────────

const NOT_GIVEN = 'This DNS zone belongs to a domain that is not given to this key: give the domain to the key in the panel (Access keys › Domains)';

interface KeyZone {
  zone: ZoneRow;
  domain: { id: number; name: string } | null;
  allowed: boolean;
}

const normalizeName = (raw: unknown) => String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');

/** Zones of the key's account with the domain each belongs to (its own, else the closest domain of the account above it). */
async function accountZones(ctx: ApiKeyContext): Promise<KeyZone[]> {
  const zones = await zoneQuery().where('z.account_id', ctx.accountId).andWhere('z.tenant_id', ctx.tenantId).orderBy('z.name') as ZoneRow[];
  if (!zones.length) return [];
  const doms = (await db('domains').where({ account_id: ctx.accountId }).select('id', 'name') as Array<{ id: number; name: string }>)
    .map((d) => ({ id: Number(d.id), name: String(d.name).toLowerCase() }));
  return zones.map((zone) => {
    const own = zone.domain_id ? doms.find((d) => d.id === Number(zone.domain_id)) : undefined;
    const domain = own ?? doms.filter((d) => inZone(zone.name, d.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
    const allowed = ctx.domainScope === 'all' || (domain !== null && keyAllowsDomain(ctx, domain.id));
    return { zone, domain, allowed };
  });
}

/** One zone of the key by name (404 unknown, 403 not given). */
async function keyZone(ctx: ApiKeyContext, rawName: string): Promise<KeyZone> {
  const name = normalizeName(rawName);
  const z = (await accountZones(ctx)).find((x) => x.zone.name === name);
  if (!z) throw new AppError(404, 'DNS zone not found', 'notFound');
  if (!z.allowed) throw new AppError(403, NOT_GIVEN, 'keyDomainNotManageable', { zone: z.zone.name });
  return z;
}

function zoneView(ctx: ApiKeyContext, z: KeyZone): ApiV1DnsZone {
  return {
    name: z.zone.name,
    kind: z.zone.kind,
    status: z.zone.status,
    served: z.zone.served ?? null,
    domain: z.domain?.name ?? null,
    defaultTtl: z.zone.default_ttl,
    recordCount: Number(z.zone.record_count ?? 0),
    writable: z.zone.kind === 'hosted' && ctx.scopes.has('dns.write'),
  };
}

function recordView(zone: string, r: DnsRecord, generated: readonly GeneratedRecord[]): ApiV1DnsRecord {
  const readOnlyReason = storedReadOnly(r, generated);
  return {
    id: r.id, name: r.name, fqdn: r.name === '@' ? zone : `${r.name}.${zone}`, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority,
    disabled: r.disabled, comment: r.comment, origin: r.origin, readOnly: readOnlyReason !== null, readOnlyReason,
  };
}

/** Records generated for the zone, before overrides (what a key never touches). */
async function generatedOf(zone: ZoneRow): Promise<GeneratedRecord[]> {
  return generatedAuto(zone, await loadContext());
}

function assertHosted(zone: ZoneRow): void {
  if (zone.kind !== 'hosted') throw new AppError(409, 'This zone is hosted elsewhere: edit it at your DNS provider', 'zoneNotHosted');
}

/** Same validation as the panel (dnsService re-validates): 400 recordInvalid. */
function normalized(zone: ZoneRow, input: DnsRecordInput): NormalizedRecord {
  try {
    return validateRecord(input, { zone: zone.name, defaultTtl: zone.default_ttl });
  } catch (err) {
    if (err instanceof RecordValidationError) throw new AppError(400, err.message, 'recordInvalid', { field: err.field });
    throw err;
  }
}

/** Records of the zone a key may look up (challenge records aside). */
async function zoneRows(zoneId: number): Promise<RecordRow[]> {
  return await db('dns_records').where({ zone_id: zoneId }).whereNot({ origin: 'system' }).orderBy([{ column: 'name' }, { column: 'type' }, { column: 'id' }]) as RecordRow[];
}

async function recordOf(zone: ZoneRow, recordId: number): Promise<RecordRow> {
  const row = Number.isInteger(recordId) && recordId > 0
    ? await db('dns_records').where({ id: recordId, zone_id: zone.id }).whereNot({ origin: 'system' }).first() as RecordRow | undefined
    : undefined;
  if (!row) throw new AppError(404, 'DNS record not found', 'notFound');
  return row;
}

/** The conflict the service would answer after the gate, answered before it (same rule, dns/records recordConflict). */
async function assertNoConflict(zone: ZoneRow, rec: NormalizedRecord, selfId?: number): Promise<void> {
  const existing = await db('dns_records').where({ zone_id: zone.id }).select('id', 'name', 'type', 'content', 'priority', 'origin') as RecordRow[];
  const conflict = recordConflict(rec, existing, selfId);
  if (conflict) throw new AppError(409, conflict, 'recordConflict', { field: rec.type === 'CNAME' ? 'type' : 'content' });
}

const fqdnOf = (zone: string, name: string) => (name === '@' ? zone : `${name}.${zone}`);

function gateSpec(zone: ZoneRow, action: 'dns.record_write' | 'dns.record_delete', params: Record<string, unknown>): GateSpec {
  return {
    action,
    target: { tenantId: Number(zone.tenant_id), accountId: Number(zone.account_id), siteId: null },
    params: { zone: zone.name, ...params },
  };
}

const recordParams = (rec: Pick<NormalizedRecord, 'type' | 'content' | 'ttl' | 'priority' | 'disabled' | 'comment'>) => ({
  type: rec.type, content: rec.content, ttl: rec.ttl, priority: rec.priority, disabled: rec.disabled, comment: rec.comment,
});

/** Checks of a write (protection, conflict): the normalized record and the generated set. */
async function prepareWrite(zone: ZoneRow, input: DnsRecordInput, selfId?: number, known?: GeneratedRecord[]): Promise<{ rec: NormalizedRecord; generated: GeneratedRecord[] }> {
  const rec = normalized(zone, input);
  const generated = known ?? await generatedOf(zone);
  const reason = keyWriteGuard(rec, generated);
  if (reason) throw protectedRecordError(reason, rec);
  await assertNoConflict(zone, rec, selfId);
  return { rec, generated };
}

async function writableZone(ctx: ApiKeyContext, zoneName: string): Promise<ZoneRow> {
  requireScope(ctx, 'dns.write');
  const { zone } = await keyZone(ctx, zoneName);
  assertHosted(zone);
  return zone;
}

async function create(ctx: ApiKeyContext, req: Request, zone: ZoneRow, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
  const { rec, generated } = await prepareWrite(zone, input);
  const row = await keyGated(ctx, req, gateSpec(zone, 'dns.record_write', { op: 'create', name: fqdnOf(zone.name, rec.name), record: recordParams(rec) }),
    () => dnsService.createRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, input));
  return recordView(zone.name, row, generated);
}

async function update(ctx: ApiKeyContext, req: Request, zone: ZoneRow, recordId: number, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
  const current = await recordOf(zone, recordId);
  const before = await generatedOf(zone);
  const was = storedReadOnly(current, before);
  if (was) throw protectedRecordError(was, current);
  const { rec, generated } = await prepareWrite(zone, input, current.id, before);
  const row = await keyGated(ctx, req, gateSpec(zone, 'dns.record_write', {
    op: 'update', recordId: current.id, name: fqdnOf(zone.name, rec.name), record: recordParams(rec),
  }), () => dnsService.updateRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, current.id, input));
  return recordView(zone.name, row, generated);
}

/** The single record of the zone matching name + type (+ content): 404 none, 409 recordAmbiguous several. */
async function matching(zone: ZoneRow, name: string, type: DnsRecordType, content?: string | null): Promise<RecordRow[]> {
  // The name normalized as stored (relative, lower case, punycode); the content too when it is valid for the type.
  const probe = normalized(zone, { name, type: 'TXT', content: 'x' });
  let wanted: string | null = null;
  if (content !== undefined && content !== null) {
    try {
      wanted = validateRecord({ name, type, content, priority: 0 }, { zone: zone.name, defaultTtl: zone.default_ttl }).content;
    } catch {
      wanted = String(content).trim();
    }
  }
  return (await zoneRows(zone.id)).filter((r) => r.name === probe.name && r.type === type && (wanted === null || r.content === wanted));
}

function ambiguous(rows: RecordRow[]): AppError {
  return new AppError(409, `Several records have this name and type (${rows.map((r) => `#${r.id} ${r.content}`).join(', ')}): give record_id (REST: the record id), or add: true to add another one`,
    'recordAmbiguous', { recordIds: rows.map((r) => r.id) });
}

export const keyDns = {
  /** Zones the key reaches (dns.read). */
  async zones(ctx: ApiKeyContext): Promise<ApiV1DnsZone[]> {
    requireScope(ctx, 'dns.read');
    return (await accountZones(ctx)).filter((z) => z.allowed).map((z) => zoneView(ctx, z));
  },

  /** A zone and its records (challenge records aside), each with readOnly / readOnlyReason (dns.read). */
  async records(ctx: ApiKeyContext, zoneName: string): Promise<ApiV1DnsZoneRecords> {
    requireScope(ctx, 'dns.read');
    const z = await keyZone(ctx, zoneName);
    // The panel's read (loadZone with the key's actor: its account, its tenant).
    const detail = await dnsService.getZone(ctx.actor, z.zone.id);
    const generated = await generatedOf(z.zone);
    return { zone: zoneView(ctx, z), records: detail.records.map((r) => recordView(z.zone.name, r, generated)) };
  },

  async create(ctx: ApiKeyContext, req: Request, zoneName: string, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
    return create(ctx, req, await writableZone(ctx, zoneName), input);
  },

  async update(ctx: ApiKeyContext, req: Request, zoneName: string, recordId: number, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
    return update(ctx, req, await writableZone(ctx, zoneName), recordId, input);
  },

  /**
   * MCP upsert_dns_record: recordId → that record; add → a new record; otherwise the record with this
   * name and type is changed (created when there is none; 409 recordAmbiguous when there are several).
   */
  async upsert(ctx: ApiKeyContext, req: Request, zoneName: string, input: DnsRecordInput, opts: { recordId?: number | null; add?: boolean } = {}): Promise<ApiV1DnsUpsertResult> {
    const zone = await writableZone(ctx, zoneName);
    if (opts.recordId) return { action: 'updated', record: await update(ctx, req, zone, opts.recordId, input) };
    if (opts.add) return { action: 'created', record: await create(ctx, req, zone, input) };
    const rec = normalized(zone, input);
    const rows = await matching(zone, rec.name, rec.type);
    if (rows.length > 1) throw ambiguous(rows);
    if (rows.length === 1) return { action: 'updated', record: await update(ctx, req, zone, rows[0].id, input) };
    return { action: 'created', record: await create(ctx, req, zone, input) };
  },

  /** Deletes a free record (gate dns.record_delete: a second factor by default). */
  async remove(ctx: ApiKeyContext, req: Request, zoneName: string, recordId: number): Promise<void> {
    const zone = await writableZone(ctx, zoneName);
    const current = await recordOf(zone, recordId);
    const reason = storedReadOnly(current, await generatedOf(zone));
    if (reason) throw protectedRecordError(reason, current);
    await keyGated(ctx, req, gateSpec(zone, 'dns.record_delete', {
      op: 'delete', recordId: current.id, name: fqdnOf(zone.name, current.name), record: { type: current.type, content: current.content, priority: current.priority },
    }), () => dnsService.deleteRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, current.id));
  },

  /** MCP delete_dns_record by name + type (+ content) instead of an id: exactly one record must match. */
  async removeMatching(ctx: ApiKeyContext, req: Request, zoneName: string, name: string, type: DnsRecordType, content?: string | null): Promise<{ deleted: true; id: number }> {
    const zone = await writableZone(ctx, zoneName);
    const rows = await matching(zone, name, type, content);
    if (!rows.length) throw new AppError(404, 'DNS record not found', 'notFound');
    if (rows.length > 1) throw ambiguous(rows);
    await keyDns.remove(ctx, req, zoneName, rows[0].id);
    return { deleted: true, id: rows[0].id };
  },
};
