import type { Request } from 'express';
import type {
  ApiV1DnsRecord, ApiV1DnsUpsertResult, ApiV1DnsZone, ApiV1DnsZoneRecords, DnsRecord, DnsRecordInput, DnsRecordType, DnsRestorePlan,
  DnsRestoreResult, DnsZoneRevision, DnsZoneRevisionDetail,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { assertRecordFits, dnsService, validatedRecord } from '../dns/dns.service';
import { inZone, txtKind, validateRecord, type GeneratedRecord, type NormalizedRecord } from '../dns/records';
import type { RestoreRules } from '../dns/history';
import { generatedAuto, loadContext, zoneQuery, type RecordRow, type ZoneRow } from '../dns/store';
import type { GateSpec } from '../restrictions/gate';
import { asKeyRequest, keyGated } from '../restrictions/targets';
import { keyAllowsDomain, requireScope, type ApiKeyContext } from './apiKeys.service';
import { keyWriteGuard, platformNamesIn, protectedRecordError, storedReadOnly, type KeyZoneFacts } from './keyDnsRules';

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
// Order of the checks: scope, zone, record, validation, protection, record limit,
// conflict — then the gate, so nobody confirms something that would be refused
// anyway. A record a key writes keeps its provenance (dns_records.api_key_id):
// it never takes the place of a generated record later (dns/store).
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

/** What the key rules know of a zone: its generated records and its other facts (keyDnsRules). */
interface ZoneRules {
  generated: GeneratedRecord[];
  facts: KeyZoneFacts;
}

/**
 * Generated records of the zone before overrides (what a key never touches), the names it publishes besides
 * (records of the panel, templates, auto — the keys' own, disabled and challenge ones aside, as dns/store
 * regenerateAuto sees them; `selfId`: the record being changed aside) and the platform host names in it.
 */
async function zoneRules(zone: ZoneRow, selfId?: number): Promise<ZoneRules> {
  const ctx = await loadContext();
  const generated = await generatedAuto(zone, ctx);
  const rows = await db('dns_records').where({ zone_id: zone.id, disabled: false }).whereNot({ origin: 'system' }).whereNull('api_key_id')
    .select('id', 'name') as Array<{ id: number; name: string }>;
  return {
    generated,
    facts: {
      existing: rows.filter((r) => r.id !== selfId).map((r) => r.name),
      platformNames: platformNamesIn(zone.name, ctx.hosts),
    },
  };
}

function readOnlyOf(r: Pick<DnsRecord, 'name' | 'type' | 'content' | 'origin' | 'writtenByKey'>, rules: ZoneRules) {
  return storedReadOnly({ name: r.name, type: r.type, content: r.content, origin: r.origin, byKey: !!r.writtenByKey }, rules.generated, rules.facts);
}

const rowReadOnly = (r: RecordRow, rules: ZoneRules) => readOnlyOf({ ...r, writtenByKey: !!r.api_key_id }, rules);

function recordView(zone: string, r: DnsRecord, rules: ZoneRules): ApiV1DnsRecord {
  const readOnlyReason = readOnlyOf(r, rules);
  return {
    id: r.id, name: r.name, fqdn: r.name === '@' ? zone : `${r.name}.${zone}`, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority,
    disabled: r.disabled, comment: r.comment, origin: r.origin, readOnly: readOnlyReason !== null, readOnlyReason,
  };
}

function assertHosted(zone: ZoneRow): void {
  if (zone.kind !== 'hosted') throw new AppError(409, 'This zone is hosted elsewhere: edit it at your DNS provider', 'zoneNotHosted');
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

const fqdnOf = (zone: string, name: string) => (name === '@' ? zone : `${name}.${zone}`);

function gateSpec(zone: ZoneRow, action: 'dns.record_write' | 'dns.record_delete' | 'dns.zone_restore', params: Record<string, unknown>): GateSpec {
  return {
    action,
    target: { tenantId: Number(zone.tenant_id), accountId: Number(zone.account_id), siteId: null },
    params: { zone: zone.name, ...params },
  };
}

const recordParams = (rec: Pick<NormalizedRecord, 'type' | 'content' | 'ttl' | 'priority' | 'disabled' | 'comment'>) => ({
  type: rec.type, content: rec.content, ttl: rec.ttl, priority: rec.priority, disabled: rec.disabled, comment: rec.comment,
});

/**
 * Every check of a write before the gate, so nobody confirms what would be refused anyway: the panel's
 * validation (dnsService), the protection of the platform's records, then the zone's record limit and the
 * conflicts (dnsService again, re-checked by the write itself).
 */
async function prepareWrite(zone: ZoneRow, input: DnsRecordInput, selfId?: number): Promise<{ rec: NormalizedRecord; rules: ZoneRules }> {
  const rec = validatedRecord(zone, input);
  const rules = await zoneRules(zone, selfId);
  const reason = keyWriteGuard(rec, rules.generated, rules.facts);
  if (reason) throw protectedRecordError(reason, rec);
  await assertRecordFits(zone, rec, selfId);
  return { rec, rules };
}

async function writableZone(ctx: ApiKeyContext, zoneName: string): Promise<ZoneRow> {
  requireScope(ctx, 'dns.write');
  const { zone } = await keyZone(ctx, zoneName);
  assertHosted(zone);
  return zone;
}

async function create(ctx: ApiKeyContext, req: Request, zone: ZoneRow, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
  const { rec, rules } = await prepareWrite(zone, input);
  const row = await keyGated(ctx, req, gateSpec(zone, 'dns.record_write', { op: 'create', name: fqdnOf(zone.name, rec.name), record: recordParams(rec) }),
    () => dnsService.createRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, input, { apiKeyId: ctx.id }));
  return recordView(zone.name, row, rules);
}

async function update(ctx: ApiKeyContext, req: Request, zone: ZoneRow, recordId: number, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
  const current = await recordOf(zone, recordId);
  const was = rowReadOnly(current, await zoneRules(zone));
  if (was) throw protectedRecordError(was, current);
  const { rec, rules } = await prepareWrite(zone, input, current.id);
  const row = await keyGated(ctx, req, gateSpec(zone, 'dns.record_write', {
    op: 'update', recordId: current.id, name: fqdnOf(zone.name, rec.name), record: recordParams(rec),
  }), () => dnsService.updateRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, current.id, input, { apiKeyId: ctx.id }));
  return recordView(zone.name, row, rules);
}

/**
 * The records of the zone with this name and type (+ content), split into the ones a key may change and the
 * platform's (read-only for a key: they never make a lookup ambiguous). TXT with `kindOf`: only the records of
 * the same use (a site verification never matches the SPF record, as for the panel's overrides).
 */
async function matching(zone: ZoneRow, name: string, type: DnsRecordType, content?: string | null, kindOf?: string): Promise<{ free: RecordRow[]; locked: RecordRow[] }> {
  // The name normalized as stored (relative, lower case, punycode); the content too when it is valid for the type.
  const probe = validatedRecord(zone, { name, type: 'TXT', content: 'x' });
  let wanted: string | null = null;
  if (content !== undefined && content !== null) {
    try {
      wanted = validateRecord({ name, type, content, priority: 0 }, { zone: zone.name, defaultTtl: zone.default_ttl }).content;
    } catch {
      wanted = String(content).trim();
    }
  }
  const rows = (await zoneRows(zone.id)).filter((r) => r.name === probe.name && r.type === type && (wanted === null || r.content === wanted)
    && (kindOf === undefined || type !== 'TXT' || txtKind(r.name, r.content) === kindOf));
  const rules = await zoneRules(zone);
  const free: RecordRow[] = [];
  const locked: RecordRow[] = [];
  for (const r of rows) (rowReadOnly(r, rules) === null ? free : locked).push(r);
  return { free, locked };
}

function ambiguous(rows: RecordRow[]): AppError {
  return new AppError(409, `Several records have this name and type (${rows.map((r) => `#${r.id} ${r.content}`).join(', ')}): give record_id (REST: the record id), or add: true to add another one`,
    'recordAmbiguous', { recordIds: rows.map((r) => r.id) });
}

/**
 * What a key's restore may do (dns/history planRestore): write back only what upsert_dns_record could write, remove
 * only what delete_dns_record could delete — the platform's records and the humans' records on its names stay.
 */
async function restoreRules(zone: ZoneRow): Promise<RestoreRules> {
  const rules = await zoneRules(zone);
  return {
    canAdd: (rec) => (keyWriteGuard(rec, rules.generated, rules.facts) ? 'protected' : null),
    canRemove: (row) => (rowReadOnly(row, rules) ? 'protected' : null),
  };
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
    const rules = await zoneRules(z.zone);
    return { zone: zoneView(ctx, z), records: detail.records.map((r) => recordView(z.zone.name, r, rules)) };
  },

  async create(ctx: ApiKeyContext, req: Request, zoneName: string, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
    return create(ctx, req, await writableZone(ctx, zoneName), input);
  },

  async update(ctx: ApiKeyContext, req: Request, zoneName: string, recordId: number, input: DnsRecordInput): Promise<ApiV1DnsRecord> {
    return update(ctx, req, await writableZone(ctx, zoneName), recordId, input);
  },

  /**
   * MCP upsert_dns_record: recordId → that record; add → a new record; otherwise the free record with this
   * name and type (TXT: and the same use) is changed — created when there is none (the platform's records
   * never match: a write on them is refused by the creation's checks); 409 recordAmbiguous when there are several.
   */
  async upsert(ctx: ApiKeyContext, req: Request, zoneName: string, input: DnsRecordInput, opts: { recordId?: number | null; add?: boolean } = {}): Promise<ApiV1DnsUpsertResult> {
    const zone = await writableZone(ctx, zoneName);
    if (opts.recordId) return { action: 'updated', record: await update(ctx, req, zone, opts.recordId, input) };
    if (opts.add) return { action: 'created', record: await create(ctx, req, zone, input) };
    const rec = validatedRecord(zone, input);
    const { free } = await matching(zone, rec.name, rec.type, undefined, rec.type === 'TXT' ? txtKind(rec.name, rec.content) : undefined);
    if (free.length > 1) throw ambiguous(free);
    if (free.length === 1) return { action: 'updated', record: await update(ctx, req, zone, free[0].id, input) };
    return { action: 'created', record: await create(ctx, req, zone, input) };
  },

  /** Deletes a free record (gate dns.record_delete: a second factor by default). */
  async remove(ctx: ApiKeyContext, req: Request, zoneName: string, recordId: number): Promise<void> {
    const zone = await writableZone(ctx, zoneName);
    const current = await recordOf(zone, recordId);
    const reason = rowReadOnly(current, await zoneRules(zone));
    if (reason) throw protectedRecordError(reason, current);
    await keyGated(ctx, req, gateSpec(zone, 'dns.record_delete', {
      op: 'delete', recordId: current.id, name: fqdnOf(zone.name, current.name), record: { type: current.type, content: current.content, priority: current.priority },
    }), () => dnsService.deleteRecord(asKeyRequest(req, ctx), ctx.actor, zone.id, current.id));
  },

  /**
   * MCP delete_dns_record by name + type (+ content) instead of an id: exactly one free record must match
   * (the platform's records never make it ambiguous; when only they match, the refusal says why).
   */
  async removeMatching(ctx: ApiKeyContext, req: Request, zoneName: string, name: string, type: DnsRecordType, content?: string | null): Promise<{ deleted: true; id: number }> {
    const zone = await writableZone(ctx, zoneName);
    const { free, locked } = await matching(zone, name, type, content);
    if (!free.length && locked.length) throw protectedRecordError(rowReadOnly(locked[0], await zoneRules(zone)) ?? 'generated', locked[0]);
    if (!free.length) throw new AppError(404, 'DNS record not found', 'notFound');
    if (free.length > 1) throw ambiguous(free);
    await keyDns.remove(ctx, req, zoneName, free[0].id);
    return { deleted: true, id: free[0].id };
  },

  // ── history of the zone (migration 038, dns/history.ts) ──
  /** Revisions of a zone of the key, most recent first (dns.read). */
  async revisions(ctx: ApiKeyContext, zoneName: string, limit?: number): Promise<DnsZoneRevision[]> {
    requireScope(ctx, 'dns.read');
    const { zone } = await keyZone(ctx, zoneName);
    return dnsService.listRevisions(ctx.actor, zone.id, limit);
  },

  /** A revision, its records, the diff to the current records and what a restore by this key would do (dns.read). */
  async revision(ctx: ApiKeyContext, zoneName: string, revisionId: number): Promise<DnsZoneRevisionDetail> {
    requireScope(ctx, 'dns.read');
    const { zone } = await keyZone(ctx, zoneName);
    return dnsService.revisionDetail(ctx.actor, zone.id, revisionId, await restoreRules(zone));
  },

  /**
   * Restores a revision within the key's rules (dns.write, hosted zone): its free records go back to the revision,
   * the others stay (skipped). Gate dns.zone_restore, with dns.record_write / dns.record_delete when it writes /
   * removes records (the strictest). dryRun: the plan only, nothing gated nor written.
   */
  async restore(ctx: ApiKeyContext, req: Request, zoneName: string, revisionId: number, opts: { dryRun?: boolean } = {}): Promise<DnsRestoreResult | { dryRun: true; plan: DnsRestorePlan }> {
    const zone = await writableZone(ctx, zoneName);
    const rules = await restoreRules(zone);
    const detail = await dnsService.revisionDetail(ctx.actor, zone.id, revisionId, rules);
    if (opts.dryRun) return { dryRun: true, plan: detail.plan };
    if (!detail.plan.add.length && !detail.plan.remove.length) return { revision: null, added: 0, removed: 0, skipped: detail.plan.skipped };
    const params = { op: 'restore', revisionId: detail.revision.id, seq: detail.revision.seq };
    const specs = [gateSpec(zone, 'dns.zone_restore', params)];
    if (detail.plan.add.length) specs.push(gateSpec(zone, 'dns.record_write', params));
    if (detail.plan.remove.length) specs.push(gateSpec(zone, 'dns.record_delete', params));
    return keyGated(ctx, req, specs, () => dnsService.restoreRevision(asKeyRequest(req, ctx), ctx.actor, zone.id, detail.revision.id, { rules, apiKeyId: ctx.id }));
  },
};
