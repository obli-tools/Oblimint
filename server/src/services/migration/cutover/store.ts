import type { Knex } from 'knex';
import type { MigrationAccountPlan, MigrationCutoverDomain, MigrationCutoverItem, MigrationCutoverState, MigrationPlanResult } from '@oblimint/shared';
import { db } from '../../../db';
import type { CutoverInstruction, CutoverMode } from './checklist';

// ─────────────────────────────────────────────────────────────────────────────
// migration_cutover_domains rows + the DB facts of the checklist (docs/P5-PLAN.md
// §10). Platform table (no tenant scope): only the platform admin reaches it.
// ─────────────────────────────────────────────────────────────────────────────

type Conn = Knex | Knex.Transaction;

export interface CutoverRow {
  id: number;
  plan_id: number;
  source_id: number;
  cwp_username: string;
  fqdn: string;
  target_domain_id: number | null;
  mode: CutoverMode;
  state: MigrationCutoverState;
  items: unknown;
  instructions: unknown;
  observed_ttl: number | null;
  notes: string | null;
  switched_at: Date | string | null;
  switched_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());
const json = <T>(v: unknown, fallback: T): T => {
  const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  return (Array.isArray(parsed) ? parsed : fallback) as T;
};

export function rowItems(r: Pick<CutoverRow, 'items'>): MigrationCutoverItem[] {
  return json<MigrationCutoverItem[]>(r.items, []);
}

export function rowInstructions(r: Pick<CutoverRow, 'instructions'>): CutoverInstruction[] {
  return json<CutoverInstruction[]>(r.instructions, []);
}

export function toCutoverDomain(r: CutoverRow): MigrationCutoverDomain {
  return {
    id: r.id,
    planId: r.plan_id,
    cwpUsername: r.cwp_username,
    fqdn: r.fqdn,
    targetDomainId: r.target_domain_id,
    mode: r.mode,
    state: r.state,
    items: rowItems(r),
    instructions: rowInstructions(r),
    observedTtl: r.observed_ttl,
    notes: r.notes,
    switchedAt: iso(r.switched_at),
    updatedAt: iso(r.updated_at) as string,
  };
}

export async function cutoverRow(id: number, conn: Conn = db): Promise<CutoverRow | null> {
  return (await conn('migration_cutover_domains').where({ id }).first() as CutoverRow | undefined) ?? null;
}

export async function cutoverRowsOfPlan(planId: number, conn: Conn = db): Promise<CutoverRow[]> {
  return await conn('migration_cutover_domains').where({ plan_id: planId }).orderBy([{ column: 'cwp_username' }, { column: 'fqdn' }]) as CutoverRow[];
}

/** Zone apex a switched ns-delegation row moved (its NS instruction), else the fqdn itself. */
function delegatedApexOf(r: Pick<CutoverRow, 'fqdn' | 'instructions'>): string {
  const ns = rowInstructions(r).find((i) => i.type === 'NS');
  return (ns?.name ?? r.fqdn).toLowerCase().replace(/\.$/, '');
}

/**
 * MG5 / D-RESYNC: true when the domain was switched at least once — switched
 * now, or switched then rolled back (mail received by Oblimint meanwhile must
 * not be mirrored away) — in ANY plan of the source of `planId` (a new plan of
 * the same source starts with fresh rows), either by its own row or by an
 * ns-delegation row whose delegated zone holds it (a mail domain below a zone
 * whose NS moved receives its mail here too).
 */
export async function cutoverDomainSwitched(planId: number, fqdn: string, conn: Conn = db): Promise<boolean> {
  const name = fqdn.toLowerCase().replace(/\.$/, '');
  if (!name) return false;
  const plan = await conn('migration_plans').where({ id: planId }).first('source_id') as { source_id: number } | undefined;
  const rows = await conn('migration_cutover_domains')
    .where((w) => (plan ? w.where({ source_id: plan.source_id }) : w.where({ plan_id: planId })))
    .andWhere((w) => w.where({ state: 'switched' }).orWhereNotNull('switched_at'))
    .select('fqdn', 'mode', 'instructions') as Array<Pick<CutoverRow, 'fqdn' | 'mode' | 'instructions'>>;
  return rows.some((r) => {
    if (r.fqdn.toLowerCase() === name) return true;
    if (r.mode !== 'ns-delegation') return false;
    const apex = delegatedApexOf(r);
    return name === apex || name.endsWith(`.${apex}`);
  });
}

/** Fqdns of the account switched now (any plan of the source): a final sync would overwrite their live data. */
export async function switchedDomainsOfAccount(sourceId: number, cwpUsername: string, conn: Conn = db): Promise<string[]> {
  const rows = await conn('migration_cutover_domains').where({ source_id: sourceId, cwp_username: cwpUsername, state: 'switched' })
    .orderBy('fqdn').select('fqdn') as Array<{ fqdn: string }>;
  return [...new Set(rows.map((r) => r.fqdn))];
}

export async function planResultOf(planId: number, conn: Conn = db): Promise<{ sourceId: number; discoveryId: number; result: MigrationPlanResult | null } | null> {
  const row = await conn('migration_plans').where({ id: planId }).first('source_id', 'discovery_id', 'result') as
    { source_id: number; discovery_id: number; result: unknown } | undefined;
  if (!row) return null;
  const result = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as MigrationPlanResult | null;
  return { sourceId: row.source_id, discoveryId: row.discovery_id, result: result ?? null };
}

export async function accountPlanOf(planId: number, cwpUsername: string, conn: Conn = db): Promise<{ sourceId: number; discoveryId: number; account: MigrationAccountPlan } | null> {
  const p = await planResultOf(planId, conn);
  const account = p?.result?.accounts.find((a) => a.cwpUsername === cwpUsername);
  return p && account ? { sourceId: p.sourceId, discoveryId: p.discoveryId, account } : null;
}

// ── DB facts ─────────────────────────────────────────────────────────────────

export async function initialDone(planId: number, cwpUsername: string, conn: Conn = db): Promise<boolean> {
  return !!(await conn('migration_runs').where({ plan_id: planId, cwp_username: cwpUsername, kind: 'initial', status: 'done' }).first('id'));
}

export async function lastFinalSyncAt(planId: number, cwpUsername: string, conn: Conn = db): Promise<string | null> {
  const r = await conn('migration_runs').where({ plan_id: planId, cwp_username: cwpUsername, kind: 'final-sync', status: 'done' })
    .whereNotNull('finished_at').orderBy('finished_at', 'desc').first('finished_at') as { finished_at: Date | string } | undefined;
  return r ? iso(r.finished_at) : null;
}

export interface DomainFacts {
  exists: boolean;
  verificationStatus: string | null;
  verificationToken: string | null;
  includeWww: boolean;
  /** Site routes all point at a site with a current release, or a proxy binding exists. */
  published: boolean;
  certificate: { status: string; issuer: string } | null;
}

export async function domainFacts(domainId: number | null, servedBy: 'site' | 'proxy' | 'none', conn: Conn = db): Promise<DomainFacts> {
  const none: DomainFacts = { exists: false, verificationStatus: null, verificationToken: null, includeWww: false, published: false, certificate: null };
  if (!domainId) return none;
  const d = await conn('domains').where({ id: domainId })
    .first('id', 'verification_status', 'verification_token', 'include_www') as
    { id: number; verification_status: string | null; verification_token: string | null; include_www: boolean } | undefined;
  if (!d) return none;
  let published = false;
  if (servedBy === 'proxy') {
    published = !!(await conn('edge_domain_bindings').where({ domain_id: domainId, kind: 'proxy' }).first('domain_id'));
  } else if (servedBy === 'none') {
    published = true; // mail-only domain: nothing to publish
  } else {
    const routes = await conn('site_routes as r').join('sites as s', 's.id', 'r.site_id').where('r.domain_id', domainId)
      .select('s.current_release_id') as Array<{ current_release_id: number | null }>;
    published = routes.length > 0 && routes.every((r) => r.current_release_id !== null);
  }
  const cert = await conn('certificates').where({ domain_id: domainId }).first('status', 'issuer') as { status: string; issuer: string } | undefined;
  return {
    exists: true,
    verificationStatus: d.verification_status,
    verificationToken: d.verification_token,
    includeWww: !!d.include_www,
    published,
    certificate: cert ?? null,
  };
}

/** Status of the zone named `name` on our DNS (null = no such zone). */
export async function zoneStatus(name: string, conn: Conn = db): Promise<string | null> {
  const z = await conn('dns_zones').where({ name: name.toLowerCase() }).first('status') as { status: string } | undefined;
  return z?.status ?? null;
}

/** Original NS / apex A of a zone or name, from the discovery inventory (rollback guidance). */
export async function sourceDnsOf(discoveryId: number, fqdn: string, conn: Conn = db): Promise<{ nameservers: string[]; a: string[] }> {
  const row = await conn('migration_discoveries').where({ id: discoveryId }).first('inventory') as { inventory: unknown } | undefined;
  const inv = (typeof row?.inventory === 'string' ? JSON.parse(row.inventory) : row?.inventory) as
    { dnsZones?: Array<{ name: string; nameservers?: string[]; records?: Array<{ name: string; type: string; content: string }> }> } | null | undefined;
  const name = fqdn.toLowerCase();
  const zone = (inv?.dnsZones ?? []).filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) return { nameservers: [], a: [] };
  return {
    nameservers: zone.nameservers ?? [],
    a: (zone.records ?? []).filter((r) => r.name === name && r.type === 'A').map((r) => r.content),
  };
}
