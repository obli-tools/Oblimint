import type { Knex } from 'knex';
import type {
  DnsRecord, DnsRecordOrigin, DnsRecordType, DnsSettings, DnsTemplate, DnsTemplateRecord, DnsZone, DnsZoneKind, DnsZoneStatus,
} from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { platformSettings } from '../platformSettings';
import { iso, json } from '../hosting/rows';
import {
  applyOverrides, autoRecords, inZone, platformAutoRecords, recordConflict, RecordValidationError, sameRecordSet, substitute,
  validateRecord, type AutoContext, type AutoDomain, type GeneratedRecord, type PlatformHosts, type TemplateVars,
} from './records';

// ─────────────────────────────────────────────────────────────────────────────
// DB side of the dns module: rows of dns_zones / dns_records / dns_templates,
// their API mappers, the platform context (IPs, panel host, mail engine,
// settings), zone lookup by name, auto-record regeneration and template
// application. The panel DB is the source of truth; sync.ts projects it to
// PowerDNS.
// ─────────────────────────────────────────────────────────────────────────────

export type Db = Knex | Knex.Transaction;

export interface ZoneRow {
  id: number; tenant_id: number; account_id: number | null; domain_id: number | null; name: string;
  kind: DnsZoneKind; status: DnsZoneStatus; status_message: string | null; serial: number | string;
  default_ttl: number; dnssec: boolean; template_id: number | null; last_synced_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
  /** joined */ account_username?: string | null; record_count?: number | string | null;
}

export interface RecordRow {
  id: number; zone_id: number; name: string; type: DnsRecordType; content: string; ttl: number; priority: number | null;
  origin: DnsRecordOrigin; disabled: boolean; comment: string | null; system_purpose: string | null;
  expires_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

export interface TemplateRow {
  id: number; tenant_id: number; name: string; description: string | null; records: unknown; is_default: boolean;
  created_at: Date | string; updated_at: Date | string;
}

/** Domain columns the module reads (verification_* written by edge-ownership only). */
export interface ZoneDomainRow {
  id: number; tenant_id: number; account_id: number; name: string; kind: string; include_www: boolean; wildcard: boolean;
  verification_status: string | null; verification_token: string | null;
}

const DOMAIN_COLS = ['id', 'tenant_id', 'account_id', 'name', 'kind', 'include_www', 'wildcard', 'verification_status', 'verification_token'];

// ── mappers ──────────────────────────────────────────────────────────────────

export function toZone(r: ZoneRow): DnsZone {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountUsername: r.account_username ?? null,
    domainId: r.domain_id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    statusMessage: r.status_message,
    serial: Number(r.serial),
    defaultTtl: r.default_ttl,
    dnssec: !!r.dnssec,
    recordCount: Number(r.record_count ?? 0),
    lastSyncedAt: iso(r.last_synced_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export function toRecord(r: RecordRow): DnsRecord {
  return {
    id: r.id,
    zoneId: r.zone_id,
    name: r.name,
    type: r.type,
    content: r.content,
    ttl: r.ttl,
    priority: r.priority,
    origin: r.origin,
    disabled: !!r.disabled,
    comment: r.comment,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export function toTemplate(r: TemplateRow): DnsTemplate {
  const records = json<DnsTemplateRecord[]>(r.records, []);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    records: Array.isArray(records) ? records : [],
    isDefault: !!r.is_default,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/** Zone query with the account user name and the record count (system records excluded). */
export function zoneQuery(conn: Db = db): Knex.QueryBuilder {
  return conn('dns_zones as z')
    .leftJoin('hosting_accounts as a', 'a.id', 'z.account_id')
    .select('z.*', 'a.username as account_username')
    .select(conn.raw("(SELECT count(*) FROM dns_records r WHERE r.zone_id = z.id AND r.origin <> 'system') AS record_count"));
}

export async function zoneById(id: number, conn: Db = db): Promise<ZoneRow | null> {
  return (await zoneQuery(conn).where('z.id', id).first() as ZoneRow | undefined) ?? null;
}

export async function zoneRecords(zoneId: number, conn: Db = db): Promise<RecordRow[]> {
  return await conn('dns_records').where({ zone_id: zoneId }).orderBy([{ column: 'name' }, { column: 'type' }, { column: 'id' }]) as RecordRow[];
}

export async function domainRow(id: number, conn: Db = db): Promise<ZoneDomainRow | null> {
  return (await conn('domains').where({ id }).first(DOMAIN_COLS) as ZoneDomainRow | undefined) ?? null;
}

/**
 * Zone holding `fqdn` (longest suffix). accountId: only the zones of that
 * account (undefined = any zone, null = platform zones only).
 */
export async function zoneForName(fqdn: string, accountId?: number | null, conn: Db = db): Promise<ZoneRow | null> {
  const name = fqdn.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  const candidates: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) candidates.push(labels.slice(i).join('.'));
  if (candidates.length === 0) return null;
  const q = zoneQuery(conn).whereIn('z.name', candidates);
  if (accountId === null) q.whereNull('z.account_id');
  else if (accountId !== undefined) q.where('z.account_id', accountId);
  const rows = await q as ZoneRow[];
  rows.sort((a, b) => b.name.length - a.name.length);
  return rows[0] ?? null;
}

// ── platform context ─────────────────────────────────────────────────────────

export interface DnsContext {
  settings: DnsSettings;
  ipv4: string | null;
  ipv6: string | null;
  panelHostname: string | null;
  mailEngine: string | null;
  hosts: PlatformHosts;
}

export async function loadContext(): Promise<DnsContext> {
  const all = await platformSettings.get();
  const rows = await db('app_config').whereIn('key', ['public_ipv4', 'public_ipv6', 'panel_hostname', 'mail_engine']).select('key', 'value') as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, (r.value ?? '').trim() || null]));
  const panelHostname = map.get('panel_hostname')?.toLowerCase() ?? null;
  return {
    settings: all.dns,
    ipv4: map.get('public_ipv4') ?? null,
    ipv6: map.get('public_ipv6') ?? null,
    panelHostname,
    mailEngine: map.get('mail_engine') ?? null,
    hosts: {
      panelHostname,
      previewDomain: all.preview.previewDomain,
      dbAdminHostname: all.dbAdmin.hostname,
      probeHostV4: all.access.probeHostV4,
      probeHostV6: all.access.probeHostV6,
    },
  };
}

export function templateVars(ctx: DnsContext, zone: string): TemplateVars {
  return { domain: zone, ipv4: ctx.ipv4, ipv6: ctx.ipv6, panel: ctx.panelHostname };
}

/** Primary NS of the SOA: first configured name server, else the panel host. */
export function soaPrimary(ctx: DnsContext, zone: string): string {
  return ctx.settings.nameservers[0] ?? ctx.panelHostname ?? `ns1.${zone}`;
}

// ── auto records ─────────────────────────────────────────────────────────────

/**
 * Domains whose web records live in `zone`: its own domain, and the
 * `subdomain` domains of the same account below it that have no zone of
 * their own and whose closest zone of the account is this one.
 */
export async function domainsOfZone(zone: ZoneRow, conn: Db = db): Promise<AutoDomain[]> {
  if (zone.account_id === null) return [];
  const out: AutoDomain[] = [];
  if (zone.domain_id) {
    const own = await domainRow(zone.domain_id, conn);
    if (own) out.push({ name: own.name, includeWww: !!own.include_www, wildcard: !!own.wildcard });
  }
  const subs = await conn('domains as d')
    .where('d.account_id', zone.account_id)
    .andWhere('d.kind', 'subdomain')
    .andWhere('d.name', 'like', `%.${zone.name.replace(/[\\%_]/g, (c) => `\\${c}`)}`)
    .whereNotExists(function sub() { this.select(conn.raw('1')).from('dns_zones as oz').whereRaw('oz.domain_id = d.id'); })
    .select('d.name', 'd.include_www', 'd.wildcard') as Array<{ name: string; include_www: boolean; wildcard: boolean }>;
  if (subs.length) {
    const accountZones = (await conn('dns_zones').where({ account_id: zone.account_id }).select('name') as Array<{ name: string }>).map((z) => z.name);
    for (const s of subs) {
      if (!inZone(s.name, zone.name) || s.name === zone.name) continue;
      const closest = accountZones.filter((z) => inZone(s.name, z)).sort((a, b) => b.length - a.length)[0];
      if (closest === zone.name) out.push({ name: s.name, includeWww: !!s.include_www, wildcard: !!s.wildcard });
    }
  }
  return out;
}

export function autoContext(ctx: DnsContext, zone: ZoneRow): AutoContext {
  return { zone: zone.name, ttl: zone.default_ttl, ipv4: ctx.ipv4, ipv6: ctx.ipv6, panelHostname: ctx.panelHostname, mailEngine: ctx.mailEngine };
}

/** Desired auto records of the zone (before overrides). */
export async function generatedAuto(zone: ZoneRow, ctx: DnsContext, conn: Db = db): Promise<GeneratedRecord[]> {
  const actx = autoContext(ctx, zone);
  if (zone.account_id === null) return platformAutoRecords(actx, ctx.hosts);
  return autoRecords(actx, await domainsOfZone(zone, conn));
}

/**
 * Rewrites the origin='auto' rows of the zone when they differ from what the
 * domains / settings give (manual, template and system rows untouched; auto
 * records overridden by them are not written). Returns true when changed.
 */
export async function regenerateAuto(zone: ZoneRow, ctx: DnsContext, conn: Db = db): Promise<boolean> {
  const rows = await conn('dns_records').where({ zone_id: zone.id }).select('id', 'name', 'type', 'content', 'ttl', 'priority', 'origin') as RecordRow[];
  const others = rows.filter((r) => r.origin !== 'auto');
  const desired = applyOverrides(await generatedAuto(zone, ctx, conn), others);
  const current = rows.filter((r) => r.origin === 'auto').map((r) => ({ name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority }));
  if (sameRecordSet(current, desired)) return false;
  await conn('dns_records').where({ zone_id: zone.id, origin: 'auto' }).delete();
  if (desired.length) {
    await conn('dns_records').insert(desired.map((r) => ({
      zone_id: zone.id, name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority, origin: 'auto',
    })));
  }
  return true;
}

// ── templates ────────────────────────────────────────────────────────────────

/** Default template of a tenant, if any. */
export async function defaultTemplate(tenantId: number, conn: Db = db): Promise<TemplateRow | null> {
  return (await conn('dns_templates').where({ tenant_id: tenantId, is_default: true }).first() as TemplateRow | undefined) ?? null;
}

/**
 * Writes the records of `template` into the zone (origin 'template'), after
 * placeholder substitution and full validation. Records with a missing
 * placeholder value, invalid or conflicting ones are skipped (logged).
 * Returns the number of records written.
 */
export async function applyTemplateRecords(conn: Db, zone: ZoneRow, template: TemplateRow, ctx: DnsContext): Promise<number> {
  const vars = templateVars(ctx, zone.name);
  const existing = await conn('dns_records').where({ zone_id: zone.id }).select('id', 'name', 'type', 'content', 'priority', 'origin') as RecordRow[];
  const accepted: Array<Pick<RecordRow, 'name' | 'type' | 'content' | 'priority' | 'origin'>> = [...existing];
  const rows: Array<Record<string, unknown>> = [];
  for (const tr of toTemplate(template).records) {
    const content = substitute(String(tr.content ?? ''), vars);
    if (content === null) continue;
    try {
      const n = validateRecord({ name: tr.name, type: tr.type, content, ttl: tr.ttl ?? null, priority: tr.priority ?? null }, { zone: zone.name, defaultTtl: zone.default_ttl });
      if (recordConflict(n, accepted)) continue;
      accepted.push({ ...n, origin: 'template' });
      rows.push({ zone_id: zone.id, name: n.name, type: n.type, content: n.content, ttl: n.ttl, priority: n.priority, origin: 'template' });
    } catch (err) {
      if (!(err instanceof RecordValidationError)) throw err;
      logger.info({ zone: zone.name, template: template.id, record: tr.name, err: err.message }, 'dns: template record skipped');
    }
  }
  if (rows.length) await conn('dns_records').insert(rows);
  return rows.length;
}

// ── zone creation (API + domain hooks) ───────────────────────────────────────

export interface NewZone {
  tenantId: number;
  accountId: number | null;
  domainId: number | null;
  name: string;
  kind: DnsZoneKind;
  templateId: number | null;
}

/** Inserts the zone row, applies the template (explicit, else the tenant default) and the auto records. */
export async function insertZone(conn: Db, z: NewZone, ctx: DnsContext): Promise<ZoneRow> {
  const [row] = await conn('dns_zones').insert({
    tenant_id: z.tenantId,
    account_id: z.accountId,
    domain_id: z.domainId,
    name: z.name,
    kind: z.kind,
    status: z.kind === 'external' ? 'disabled' : 'pending',
    default_ttl: ctx.settings.defaultTtl,
    dnssec: z.kind === 'hosted' && ctx.settings.dnssecDefault,
    template_id: null,
  }).returning('*') as ZoneRow[];
  let template: TemplateRow | null = null;
  if (z.templateId) template = (await conn('dns_templates').where({ id: z.templateId, tenant_id: z.tenantId }).first() as TemplateRow | undefined) ?? null;
  else if (z.accountId !== null) template = await defaultTemplate(z.tenantId, conn);
  if (template) {
    await applyTemplateRecords(conn, row, template, ctx);
    await conn('dns_zones').where({ id: row.id }).update({ template_id: template.id });
    row.template_id = template.id;
  }
  await regenerateAuto(row, ctx, conn);
  return row;
}

export const PLATFORM_TENANT_ID = MASTER_TENANT_ID;

/**
 * D1 input of a zone: is its domain verified? Platform zones are; a zone
 * without domain_id is covered by the closest domain of its account.
 */
export async function zoneVerified(zone: ZoneRow, conn: Db = db): Promise<boolean> {
  if (zone.account_id === null) return true;
  if (zone.domain_id) {
    const d = await domainRow(zone.domain_id, conn);
    if (d) return d.verification_status === 'verified';
  }
  const doms = await conn('domains').where({ account_id: zone.account_id }).select('name', 'verification_status') as Array<{ name: string; verification_status: string | null }>;
  const covering = doms.filter((d) => inZone(zone.name, d.name)).sort((a, b) => b.name.length - a.name.length)[0];
  return covering?.verification_status === 'verified';
}
