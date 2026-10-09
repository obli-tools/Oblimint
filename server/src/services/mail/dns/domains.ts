import type { Knex } from 'knex';
import type { MailDomainDnsSettings, MailEngine, MailExternalConfig, MailSettings } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import { db } from '../../../db';
import { platformSettings } from '../../platformSettings';
import { SERVED_ACCOUNT_STATUSES } from '../../edge/vhostPlan';
import { mailHostname } from '../contracts';
import { activeMailEngine, activeMailEngineIn } from '../registry';
import { parseDnsSettings, parseExternalConfig, type MailDkimKeyRow } from '../rows';
import { mailHostNames, mailRecordSpecs, resolveDnsOptions, type MailDnsOptions, type MailRecordSpec } from './records';

// ─────────────────────────────────────────────────────────────────────────────
// DB reads shared by the zone contributor, the DNS service, the edge
// contributor, the TLS service and the public endpoints of module
// mail-dns-tls: platform context (engine, mail host, node addresses, mail
// settings) and the mail domains with what decides whether they are ACTIVE
// (enabled AND domain verified — D1 / MA10 — AND account served).
// ─────────────────────────────────────────────────────────────────────────────

export interface MailPlatformContext {
  engine: MailEngine;
  hasMailboxes: boolean;
  settings: MailSettings;
  /** Node mail host name H (lower case), null when neither mail.hostname nor panel_hostname is set. */
  host: string | null;
  panelHostname: string | null;
  ipv4: string | null;
  ipv6: string | null;
}

export async function loadMailPlatformContext(conn?: Knex | Knex.Transaction): Promise<MailPlatformContext> {
  // `conn` (a transaction of the caller, e.g. the DNS zone contributor): every read goes through it.
  const [engine, settings, host, rows] = conn
    ? await (async () => {
      const e = await activeMailEngineIn(conn);
      const s = (await platformSettings.getWith(conn)).mail;
      const r = await conn('app_config').whereIn('key', ['public_ipv4', 'public_ipv6', 'panel_hostname']).select('key', 'value') as Array<{ key: string; value: string | null }>;
      // Same rule as contracts.mailHostname(): settings mail.hostname, else panel_hostname.
      const panel = r.find((x) => x.key === 'panel_hostname')?.value?.trim().toLowerCase() || null;
      return [e, s, s.hostname ? s.hostname.toLowerCase() : panel, r] as const;
    })()
    : await Promise.all([
      activeMailEngine(),
      platformSettings.section('mail'),
      mailHostname(),
      db('app_config').whereIn('key', ['public_ipv4', 'public_ipv6', 'panel_hostname']).select('key', 'value') as Promise<Array<{ key: string; value: string | null }>>,
    ]);
  const map = new Map(rows.map((r) => [r.key, (r.value ?? '').trim() || null]));
  return {
    engine,
    hasMailboxes: mailEngineHasMailboxes(engine),
    settings,
    host: host?.replace(/\.$/, '') || null,
    panelHostname: map.get('panel_hostname')?.toLowerCase().replace(/\.$/, '') ?? null,
    ipv4: map.get('public_ipv4') ?? null,
    ipv6: map.get('public_ipv6') ?? null,
  };
}

/** A mail domain with its activity inputs (no secret, no DNS check). */
export interface MailDomainView {
  id: number;
  tenantId: number;
  accountId: number;
  domainId: number;
  name: string;
  enabled: boolean;
  verified: boolean;
  accountStatus: string;
  settings: MailDomainDnsSettings;
  external: MailExternalConfig | null;
  /** enabled AND verified AND account served. */
  active: boolean;
}

interface ViewRow {
  id: number; tenant_id: number; account_id: number; domain_id: number; name: string; enabled: boolean;
  dns_settings: unknown; external_dns: unknown; verification_status: string | null; account_status: string;
}

export function isMailDomainActive(v: { enabled: boolean; verified: boolean; accountStatus: string }): boolean {
  return v.enabled && v.verified && (SERVED_ACCOUNT_STATUSES as readonly string[]).includes(v.accountStatus);
}

export function toView(r: ViewRow): MailDomainView {
  const base = {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    domainId: r.domain_id,
    name: r.name.toLowerCase(),
    enabled: !!r.enabled,
    verified: r.verification_status === 'verified',
    accountStatus: r.account_status,
    settings: parseDnsSettings(r.dns_settings),
    external: parseExternalConfig(r.external_dns),
  };
  return { ...base, active: isMailDomainActive(base) };
}

/** Mail domains (joined with their domain and account), filtered by `where`. */
export async function mailDomainViews(where?: (qb: Knex.QueryBuilder) => void, conn: Knex | Knex.Transaction = db): Promise<MailDomainView[]> {
  const q = conn('mail_domains as md')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .leftJoin('domains as d', 'd.id', 'md.domain_id')
    .select('md.id', 'md.tenant_id', 'md.account_id', 'md.domain_id', 'md.name', 'md.enabled', 'md.dns_settings', 'md.external_dns',
      'd.verification_status', 'a.status as account_status')
    .orderBy('md.id');
  if (where) where(q);
  return (await q as ViewRow[]).map(toView);
}

export async function mailDomainView(id: number): Promise<MailDomainView | null> {
  return (await mailDomainViews((q) => q.where('md.id', id)))[0] ?? null;
}

/** Active mail domain named `name` (lower case), else null. */
export async function activeMailDomainByName(name: string): Promise<MailDomainView | null> {
  const v = (await mailDomainViews((q) => q.where('md.name', name.toLowerCase())))[0];
  return v && v.active ? v : null;
}

/** Public parts of the DKIM keys (no private key column) of the given mail domains. */
export async function dkimPublicKeys(mailDomainIds: number[], conn: Knex | Knex.Transaction = db): Promise<Map<number, Array<Pick<MailDkimKeyRow, 'id' | 'mail_domain_id' | 'selector' | 'algorithm' | 'public_key' | 'status'>>>> {
  const out = new Map<number, Array<Pick<MailDkimKeyRow, 'id' | 'mail_domain_id' | 'selector' | 'algorithm' | 'public_key' | 'status'>>>();
  if (mailDomainIds.length === 0) return out;
  const rows = await conn('mail_dkim_keys').whereIn('mail_domain_id', mailDomainIds).whereNot('status', 'retired')
    .orderBy('id').select('id', 'mail_domain_id', 'selector', 'algorithm', 'public_key', 'status') as
    Array<Pick<MailDkimKeyRow, 'id' | 'mail_domain_id' | 'selector' | 'algorithm' | 'public_key' | 'status'>>;
  for (const r of rows) {
    const list = out.get(r.mail_domain_id) ?? [];
    list.push(r);
    out.set(r.mail_domain_id, list);
  }
  return out;
}

/** Names among `names` that are tenant domains (`domains` rows, any account): mail never takes them over. */
export async function tenantDomainNames(names: string[], conn: Knex | Knex.Transaction = db): Promise<Set<string>> {
  const list = [...new Set(names.map((n) => n.toLowerCase()))];
  if (list.length === 0) return new Set();
  const rows = await conn('domains').whereIn('name', list).select('name') as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export function optionsOf(v: MailDomainView, ctx: MailPlatformContext): MailDnsOptions {
  return resolveDnsOptions(v.settings, ctx.settings, ctx.hasMailboxes);
}

/** Address host names a mail domain may get (for the "taken" lookup). */
export function candidateHostNames(v: MailDomainView, ctx: MailPlatformContext): string[] {
  return Object.values(mailHostNames(v.name, optionsOf(v, ctx))).filter((n): n is string => !!n);
}

/** Expected records of the given mail domains (one batched read of keys and taken names). */
export async function expectedRecordsOf(views: MailDomainView[], ctx: MailPlatformContext, conn: Knex | Knex.Transaction = db): Promise<Map<number, MailRecordSpec[]>> {
  const keys = ctx.hasMailboxes ? await dkimPublicKeys(views.map((v) => v.id), conn) : new Map();
  const taken = ctx.hasMailboxes ? await tenantDomainNames(views.flatMap((v) => candidateHostNames(v, ctx)), conn) : new Set<string>();
  const out = new Map<number, MailRecordSpec[]>();
  for (const v of views) {
    out.set(v.id, mailRecordSpecs({
      domain: v.name,
      hasMailboxes: ctx.hasMailboxes,
      host: ctx.host,
      ipv4: ctx.ipv4,
      ipv6: ctx.ipv6,
      options: optionsOf(v, ctx),
      dkim: (keys.get(v.id) ?? []).map((k: { selector: string; algorithm: 'rsa-2048' | 'ed25519'; public_key: string; status: 'active' | 'next' | 'retiring' | 'retired' }) => ({
        selector: k.selector, algorithm: k.algorithm, publicKey: k.public_key, status: k.status,
      })),
      external: v.external,
      taken,
    }));
  }
  return out;
}
