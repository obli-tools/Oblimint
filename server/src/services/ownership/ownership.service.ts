import crypto from 'crypto';
import type { Request } from 'express';
import type {
  DomainClaim, DomainClaimCreate, DomainClaimStatus, DomainOwnershipCheckResult, DomainOwnershipNsStatus, DomainOwnershipNsView,
  DomainOwnershipTxtOutcome, DomainVerification, DomainVerificationError, DomainVerificationMethod,
} from '@oblimint/shared';
import { HostingSocketEvents, OWNERSHIP_TXT_LABEL } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { publicDns, type PublicDnsLookup } from '../../utils/publicDns';
import { auditService } from '../audit.service';
import { dnsService } from '../dns/dns.service';
import { pendingZoneForDomain } from '../dns/pendingZone';
import { zoneForName } from '../dns/store';
import { reconcileService } from '../docker/reconcile.service';
import { certificateService } from '../edge/certificate.service';
import { edgeService, loadPlatformHosts } from '../edge/edge.service';
import { platformHostNames } from '../edge/vhostPlan';
import {
  actorCan, actorSees, assertNeedSomewhere, loadAccount, loadDomain, scopeToActor, type HostingActor, type HostingNeed,
} from '../hosting/access';
import { accountDeleting } from '../hosting/accounts.service';
import { insertDomainRow, isUnderPlatformZone } from '../hosting/domains.service';
import { lockTenant } from '../hosting/envelope.service';
import { emitHosting } from '../hosting/events';
import { isPlatformReservedDomain, isSameOrSubdomain, normalizeDomainName, parentDomains } from '../hosting/hostingValidation.service';
import type { DomainRow } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { notify } from '../usage/notifications.service';
import { registryLookup, type RegistryLookup } from './registryDelegation';

// ─────────────────────────────────────────────────────────────────────────────
// Domain ownership (docs/P2-PLAN.md §9.2, audit T3 carry-over). OWNED BY
// MODULE `edge-ownership`.
//
// Proofs, read through PUBLIC resolvers (utils/publicDns.ts, settings
// dns.resolvers — never Docker's embedded DNS):
//   txt        TXT _oblimint-challenge.<name> = oblimint-verify=<token>
//              (the domain's own token, domains.verification_token);
//   ns         settings dns.allowNsProof and EVERY public NS of the name is
//              one of settings dns.nameservers — as seen by the public
//              resolvers, or (they may cache the old NS for hours) by the
//              parent zone's own servers (registryDelegation.ts: the registry
//              delegation, what changes first). Residual risk R-NS-SQUAT: the
//              delegation does not designate an account (a squatter that
//              registered the name before the delegation gets verified); the
//              TXT stays the strong proof, a claim corrects it, an admin can
//              force, and dns.allowNsProof=false disables it. NEVER accepted
//              when the zone of our PowerDNS that serves the name is a platform
//              zone (account_id null) or a zone of ANOTHER account: our own
//              delegation of that zone is not a proof for the tenant;
//   inherited  a VERIFIED parent domain of the SAME account (never across
//              accounts) — at creation, and when a parent becomes verified;
//              losing the parent never removes an acquired inheritance;
//   admin      forced by a platform administrator (audited);
//   legacy     domains of P1 (migration 003).
// Until verified (invariant D1): placeholder vhost, no certificate, zone not
// published — except a PENDING zone (SOA + NS only, dns/pendingZone.ts) so
// that a registrar accepts the switch to our name servers, which the NS proof
// then sees (dns module reads verification_status).
//
// Worker: pending domains re-checked with backoff (1 min, 5 min, 15 min, 1 h,
// then every 6 h — from the creation time), at least every 5 min during the
// 48 h after the creation or after a manual check (verification_requested_at,
// which also re-opens the pending zone window); pending claims expired after
// 7 days. Every check (manual or automatic) stores the outcome of EVERY method
// tried (verification_result, API lastResult: TXT outcome, NS found / expected
// for both views, summary), next to the legacy single code verification_error;
// an automatic check whose outcome changed emits DOMAIN_VERIFICATION_UPDATED
// (status pending) so that an open card refreshes. A verification change emits
// DOMAIN_VERIFICATION_UPDATED and calls dnsService.domainChanged,
// edgeService.scheduleSync, certificateService.ensureForDomain and audits
// `domain.verified` in the domain's tenant.
//
// Claims: a name held by ANOTHER account (squatted) is reclaimed by a TXT
// proof only (never NS: the squatter may hold the delegation), with a token
// of the claim; success ⇒ in ONE transaction the holder's domain (and every
// name under it held by other accounts) is deleted — routes and certificate
// rows cascade, files removed after commit — and the domain is created,
// verified 'txt', in the claimer's account (envelope / plan limits enforced
// under the tenant lock); audit `domain.reclaimed` in BOTH tenants, neither
// side learning the other's identity (A2).
// ─────────────────────────────────────────────────────────────────────────────

/** TXT record of a domain / claim: name and expected value. */
export function ownershipTxt(name: string, token: string): { txtName: string; txtValue: string } {
  return { txtName: `${OWNERSHIP_TXT_LABEL}.${name}`, txtValue: `oblimint-verify=${token}` };
}

/** One manual check per domain / claim per 30 s (429 rateLimited). */
export const CHECK_COOLDOWN_SEC = 30;
export const CLAIM_TTL_MS = 7 * 24 * 3600_000;
/** Backoff of the worker: 1 min, 5 min, 15 min, 1 h after creation, then every 6 h. */
export const CHECK_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 3600_000];
export const CHECK_FINAL_INTERVAL_MS = 6 * 3600_000;
/**
 * Fast window: for 48 h after the creation of the domain or after a manual
 * « Verify » click, a check at least every 5 min (the delegation to our name
 * servers — pending zone, dns/pendingZone.ts — is seen within minutes). The
 * worker batch (WORKER_BATCH per WORKER_TICK_MS) bounds the load.
 */
export const FAST_CHECK_WINDOW_MS = 48 * 3600_000;
export const FAST_CHECK_INTERVAL_MS = 5 * 60_000;

const WORKER_TICK_MS = 30_000;
const WORKER_FIRST_DELAY_MS = 20_000;
const WORKER_BATCH = 25;

/**
 * Delay before the next automatic check of a pending domain, from the time
 * elapsed since its creation: checks land at +1 min, +6 min, +21 min, +81 min,
 * then every 6 h — capped at 5 min while in the fast window (48 h after the
 * creation, or after the last manual check: `elapsedSinceRequestMs`). Pure (tests).
 */
export function nextCheckDelayMs(elapsedSinceCreationMs: number, elapsedSinceRequestMs: number | null = null): number {
  let base = CHECK_FINAL_INTERVAL_MS;
  let due = 0;
  for (const step of CHECK_BACKOFF_MS) {
    due += step;
    if (elapsedSinceCreationMs < due) { base = step; break; }
  }
  const fast = elapsedSinceCreationMs < FAST_CHECK_WINDOW_MS
    || (elapsedSinceRequestMs !== null && elapsedSinceRequestMs >= 0 && elapsedSinceRequestMs < FAST_CHECK_WINDOW_MS);
  return fast ? Math.min(base, FAST_CHECK_INTERVAL_MS) : base;
}

export interface OwnershipProof {
  ok: boolean;
  method: 'txt' | 'ns' | null;
  /** Legacy single code (domains.verification_error, API lastError). */
  error: DomainVerificationError | null;
  /** Outcome of EVERY method tried (domains.verification_result, API lastResult) — `at` / `trigger` set by the caller. */
  result: Omit<DomainOwnershipCheckResult, 'at' | 'trigger'>;
}

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/** Delegation `found` against our name servers (empty = none). */
export function classifyNs(found: string[], ours: ReadonlySet<string>): DomainOwnershipNsStatus {
  if (!found.length) return 'none';
  const mine = found.filter((n) => ours.has(n)).length;
  if (mine === found.length) return 'ours';
  return mine === 0 ? 'elsewhere' : 'mixed';
}

const TXT_FOUND_MAX = 5;
const TXT_FOUND_LEN = 255;

/**
 * Evaluates the ownership proofs of `name` with `token` (pure apart from the
 * injected lookups). TXT first; then, unless txtOnly (claims), the NS proof
 * when allowed: the public resolvers, and — when they do not show our name
 * servers and a registry lookup is given — the parent zone's own servers
 * (registryDelegation.ts: what changes first after a switch at the
 * registrar, resolvers may cache the old NS for hours). Every public NS of
 * either view being ours is the proof.
 *
 * `result` describes every method tried (summary proven / notProven /
 * resolverFailed). Legacy `error` precedence (unchanged): a TXT record with
 * another value → txtMismatch; a public lookup failure → resolverFailed; a
 * delegation partly to our name servers → nsMismatch; otherwise txtMissing.
 */
export async function evaluateOwnership(
  lookup: PublicDnsLookup,
  name: string,
  token: string,
  opts: { allowNs: boolean; nameservers: string[]; txtOnly?: boolean; registry?: RegistryLookup | null },
): Promise<OwnershipProof> {
  const { txtName, txtValue } = ownershipTxt(name, token);
  let txtFailed = false;
  let txt: string[] = [];
  try {
    txt = (await lookup.txt(txtName)).map((v) => v.trim());
  } catch {
    txtFailed = true;
  }
  const txtOutcome: DomainOwnershipTxtOutcome = txt.includes(txtValue) ? 'found'
    : txt.length > 0 ? 'mismatch' : txtFailed ? 'resolverFailed' : 'missing';
  const txtResult = {
    outcome: txtOutcome,
    found: txtOutcome === 'mismatch' ? txt.slice(0, TXT_FOUND_MAX).map((v) => v.slice(0, TXT_FOUND_LEN)) : [],
  };
  if (txtOutcome === 'found') {
    return { ok: true, method: 'txt', error: null, result: { summary: 'proven', provenBy: 'txt', txt: txtResult, ns: null } };
  }

  const ours = new Set(opts.nameservers.map(normHost).filter(Boolean));
  let ns: NonNullable<DomainOwnershipCheckResult['ns']> | null = null;
  if (!opts.txtOnly && opts.allowNs && ours.size > 0) {
    let pub: DomainOwnershipNsView;
    try {
      const found = [...new Set((await lookup.ns(name)).map(normHost).filter(Boolean))].sort();
      pub = { found, status: classifyNs(found, ours), failed: false };
    } catch {
      pub = { found: [], status: 'none', failed: true };
    }
    let registry: (DomainOwnershipNsView & { zone: string }) | null = null;
    if (pub.status !== 'ours' && opts.registry) {
      try {
        const r = await opts.registry(name);
        const found = [...new Set(r.found.map(normHost).filter(Boolean))].sort();
        registry = { zone: r.zone, found, status: r.failed ? 'none' : classifyNs(found, ours), failed: r.failed };
      } catch {
        registry = null;
      }
    }
    ns = { expected: [...ours].sort(), public: pub, registry, matches: pub.status === 'ours' || registry?.status === 'ours' };
  }

  if (ns?.matches) {
    return { ok: true, method: 'ns', error: null, result: { summary: 'proven', provenBy: 'ns', txt: txtResult, ns } };
  }
  const nsFailed = !!ns?.public.failed;
  const allFailed = txtFailed && (!ns || (ns.public.failed && (!ns.registry || ns.registry.failed)));
  const result = { summary: allFailed ? 'resolverFailed' as const : 'notProven' as const, provenBy: null, txt: txtResult, ns };
  const nsPartial = ns?.public.status === 'mixed' || ns?.registry?.status === 'mixed';
  if (txt.length > 0) return { ok: false, method: null, error: 'txtMismatch', result };
  if (txtFailed || nsFailed) return { ok: false, method: null, error: 'resolverFailed', result };
  if (nsPartial) return { ok: false, method: null, error: 'nsMismatch', result };
  return { ok: false, method: null, error: 'txtMissing', result };
}

/** Result when the public DNS could not even be set up (every tried method failed). */
function unreachableResult(nsTried: boolean, nameservers: string[]): OwnershipProof['result'] {
  const failed: DomainOwnershipNsView = { found: [], status: 'none', failed: true };
  return {
    summary: 'resolverFailed',
    provenBy: null,
    txt: { outcome: 'resolverFailed', found: [] },
    ns: nsTried ? { expected: [...new Set(nameservers.map(normHost).filter(Boolean))].sort(), public: failed, registry: null, matches: false } : null,
  };
}

const NS_STATUSES: readonly string[] = ['ours', 'elsewhere', 'mixed', 'none'];
const TXT_OUTCOMES: readonly string[] = ['found', 'missing', 'mismatch', 'resolverFailed'];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function nsView(v: unknown): DomainOwnershipNsView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { found: strings(o.found), status: NS_STATUSES.includes(o.status as string) ? o.status as DomainOwnershipNsStatus : 'none', failed: o.failed === true };
}

/** Stored verification_result → API (defensive: unknown shapes give null). */
export function parseCheckResult(raw: unknown): DomainOwnershipCheckResult | null {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const txt = (o.txt ?? {}) as Record<string, unknown>;
  const summary = o.summary === 'proven' || o.summary === 'resolverFailed' ? o.summary : 'notProven';
  let ns: DomainOwnershipCheckResult['ns'] = null;
  if (o.ns && typeof o.ns === 'object') {
    const n = o.ns as Record<string, unknown>;
    const pub = nsView(n.public) ?? { found: [], status: 'none', failed: true };
    const reg = nsView(n.registry);
    const zone = n.registry && typeof (n.registry as Record<string, unknown>).zone === 'string' ? (n.registry as Record<string, string>).zone : '';
    ns = { expected: strings(n.expected), public: pub, registry: reg ? { ...reg, zone } : null, matches: n.matches === true };
  }
  return {
    at: typeof o.at === 'string' ? o.at : new Date(0).toISOString(),
    trigger: o.trigger === 'manual' ? 'manual' : 'auto',
    summary,
    provenBy: o.provenBy === 'txt' || o.provenBy === 'ns' ? o.provenBy : null,
    txt: { outcome: TXT_OUTCOMES.includes(txt.outcome as string) ? txt.outcome as DomainOwnershipTxtOutcome : 'missing', found: strings(txt.found) },
    ns,
  };
}

/** What a user would notice changing between two results (the worker announces only those). */
export function checkResultSignature(r: Pick<DomainOwnershipCheckResult, 'summary' | 'txt' | 'ns'> | null): string {
  if (!r) return '';
  return JSON.stringify([r.summary, r.txt.outcome, r.txt.found,
    r.ns ? [r.ns.public.status, r.ns.public.found, r.ns.public.failed, r.ns.registry?.status, r.ns.registry?.found, r.ns.registry?.failed, r.ns.expected] : null]);
}

const VERIFICATION_ERRORS: readonly DomainVerificationError[] = ['txtMissing', 'txtMismatch', 'nsMismatch', 'resolverFailed', 'rateLimited'];
const asError = (v: unknown): DomainVerificationError | null =>
  (VERIFICATION_ERRORS as readonly unknown[]).includes(v) ? v as DomainVerificationError : null;
const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

type VerifiableDomain = Pick<DomainRow, 'id' | 'tenant_id' | 'account_id' | 'name'> & Partial<DomainRow>;

/** The nearest VERIFIED parent domain of the same account, or null. */
async function verifiedParent(d: Pick<DomainRow, 'account_id' | 'name'>): Promise<{ id: number; name: string } | null> {
  const parents = parentDomains(d.name);
  if (!parents.length) return null;
  const rows = await db('domains').where({ account_id: d.account_id, verification_status: 'verified' }).whereIn('name', parents)
    .select('id', 'name') as Array<{ id: number; name: string }>;
  if (!rows.length) return null;
  return rows.sort((a, b) => b.name.length - a.name.length)[0];
}

async function dnsSettings(): Promise<{ allowNs: boolean; nameservers: string[] }> {
  try {
    const s = await platformSettings.section('dns');
    return { allowNs: !!s.allowNsProof, nameservers: s.nameservers ?? [] };
  } catch {
    return { allowNs: false, nameservers: [] };
  }
}

/**
 * May the NS proof vouch for `name` in `accountId`? Not when the zone of our
 * PowerDNS covering the name (longest suffix) is a platform zone or belongs to
 * another account: the public NS then point at us because WE serve that zone,
 * not because the tenant delegated the name. Fails closed (DB error ⇒ no NS).
 */
export async function nsProofAllowedFor(name: string, accountId: number): Promise<boolean> {
  try {
    const zone = await zoneForName(name);
    return !zone || (zone.account_id !== null && zone.account_id === accountId);
  } catch (err) {
    logger.warn({ name, err: (err as Error).message }, 'ownership: zone lookup failed, NS proof refused');
    return false;
  }
}

/** NS method shown only when it could actually verify this name (same rule as runCheck). */
async function nsProofView(row: DomainRow): Promise<{ nameservers: string[]; nsProofAllowed: boolean }> {
  const settings = await dnsSettings();
  const allowed = settings.allowNs && settings.nameservers.length > 0 && await nsProofAllowedFor(row.name, row.account_id);
  return { nameservers: settings.nameservers, nsProofAllowed: allowed };
}

async function toVerification(row: DomainRow): Promise<DomainVerification> {
  const token = row.verification_token ?? '';
  const { txtName, txtValue } = ownershipTxt(row.name, token);
  const status = row.verification_status === 'verified' ? 'verified' : 'pending';
  const method = (row.verification_method ?? null) as DomainVerificationMethod | null;
  return {
    domainId: row.id,
    domainName: row.name,
    status,
    method,
    verifiedAt: iso(row.verified_at),
    txtName,
    txtValue,
    ...(await nsProofView(row)),
    inheritedFrom: method === 'inherited' ? (await verifiedParent(row))?.name ?? null : null,
    lastCheckAt: iso(row.verification_checked_at),
    lastError: status === 'verified' ? null : asError(row.verification_error),
    lastResult: status === 'verified' ? null : parseCheckResult(row.verification_result),
    nextCheckAt: status === 'verified' ? null : iso(row.verification_next_check_at),
    pendingZone: status === 'verified' ? null : await pendingZoneForDomain({
      id: row.id,
      name: row.name,
      account_id: row.account_id,
      verification_status: row.verification_status ?? 'pending',
      created_at: row.created_at,
      verification_requested_at: row.verification_requested_at ?? null,
    }),
  };
}

async function freshVerification(domainId: number): Promise<DomainVerification> {
  const row = await db('domains').where({ id: domainId }).first() as DomainRow | undefined;
  if (!row) throw new AppError(404, 'Domain not found', 'notFound');
  return toVerification(row);
}

interface VerifyContext {
  req?: Request;
  forced?: boolean;
  inheritedFrom?: string;
}

/** Side effects of a domain becoming verified (each one isolated: hooks never break the caller). */
async function announceVerified(d: VerifiableDomain, method: DomainVerificationMethod, ctx: VerifyContext): Promise<void> {
  const scope = { tenantId: d.tenant_id, accountId: d.account_id };
  const safe = (what: string, fn: () => void) => {
    try { fn(); } catch (err) { logger.warn({ err: (err as Error).message, domainId: d.id }, `ownership: ${what} failed`); }
  };
  safe('socket', () => {
    emitHosting(HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED, { domainId: d.id, status: 'verified' }, scope);
    emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'domain', id: d.id, accountId: d.account_id, action: 'updated' }, scope);
  });
  safe('dnsService.domainChanged', () => dnsService.domainChanged(d.id, 'verified'));
  safe('edgeService.scheduleSync', () => edgeService.scheduleSync(`domain ${d.id} verified`));
  safe('certificateService.ensureForDomain', () => certificateService.ensureForDomain(d.id));
  safe('notify', () => notify('domain.verified', {
    tenantId: d.tenant_id, accountId: d.account_id, key: `domain:${d.id}`, severity: 'info',
    title: `Domaine vérifié : ${d.name}`,
    message: method === 'inherited' && ctx.inheritedFrom
      ? `La propriété de ${d.name} est acquise par celle de ${ctx.inheritedFrom} : le domaine peut être mis en ligne (certificat en cours).`
      : `La propriété de ${d.name} est prouvée : le domaine peut être mis en ligne (certificat en cours).`,
    link: '/domains',
  }));
  const details ={ name: d.name, accountId: d.account_id, method, ...(ctx.forced ? { forced: true } : {}), ...(ctx.inheritedFrom ? { inheritedFrom: ctx.inheritedFrom } : {}) };
  try {
    if (ctx.req) {
      await auditService.logReqAs(ctx.req, d.tenant_id, 'domain.verified', { resourceType: 'domain', resourcePath: String(d.id), details });
    } else {
      await auditService.log({ tenantId: d.tenant_id, action: 'domain.verified', resourceType: 'domain', resourcePath: String(d.id), details });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, domainId: d.id }, 'ownership: audit failed');
  }
}

/**
 * Every PENDING domain of the same account under `parent` becomes verified
 * 'inherited' (never across accounts). Returns how many were verified.
 */
async function propagateInheritance(parent: VerifiableDomain, ctx: VerifyContext): Promise<number> {
  const pending = await db('domains').where({ account_id: parent.account_id, verification_status: 'pending' })
    .select('id', 'tenant_id', 'account_id', 'name') as VerifiableDomain[];
  let n = 0;
  for (const child of pending) {
    if (child.name === parent.name || !isSameOrSubdomain(child.name, parent.name)) continue;
    if (await markVerified(child, 'inherited', { req: ctx.req, inheritedFrom: parent.name }, { propagate: false })) n++;
  }
  return n;
}

/**
 * pending → verified (no-op when already verified: the conditional update
 * makes concurrent checks announce once). Then the names below it inherit.
 */
async function markVerified(d: VerifiableDomain, method: DomainVerificationMethod, ctx: VerifyContext, opts: { propagate?: boolean } = {}): Promise<boolean> {
  const updated = await db('domains').where({ id: d.id, verification_status: 'pending' }).update({
    verification_status: 'verified',
    verification_method: method,
    verified_at: db.fn.now(),
    verification_error: null,
    verification_next_check_at: null,
    updated_at: db.fn.now(),
  }).returning('id') as Array<{ id: number }>;
  if (!updated.length) return false;
  logger.info({ domainId: d.id, name: d.name, method }, 'domain ownership verified');
  await announceVerified(d, method, ctx);
  if (opts.propagate !== false) await propagateInheritance(d, ctx);
  return true;
}

/**
 * One verification attempt of a pending domain: inheritance first, then the
 * public DNS proofs. Records the outcome; never throws on a DNS problem.
 */
async function runCheck(row: VerifiableDomain & { verification_token?: string }, ctx: VerifyContext): Promise<boolean> {
  const parent = await verifiedParent(row);
  if (parent) return markVerified(row, 'inherited', { ...ctx, inheritedFrom: parent.name });
  const token = row.verification_token
    ?? (await db('domains').where({ id: row.id }).first('verification_token') as { verification_token: string } | undefined)?.verification_token;
  if (!token) return false;
  let proof: OwnershipProof;
  const settings = await dnsSettings();
  if (settings.allowNs && !(await nsProofAllowedFor(row.name, row.account_id))) settings.allowNs = false;
  try {
    proof = await evaluateOwnership(await publicDns(), row.name, token, { ...settings, registry: await registryLookupSafe() });
  } catch (err) {
    logger.warn({ domainId: row.id, err: (err as Error).message }, 'ownership: public DNS unavailable');
    proof = { ok: false, method: null, error: 'resolverFailed', result: unreachableResult(settings.allowNs && settings.nameservers.length > 0, settings.nameservers) };
  }
  // Every method's outcome, manual or automatic (the card shows the same summary for both).
  const result: DomainOwnershipCheckResult = { at: new Date().toISOString(), trigger: ctx.req ? 'manual' : 'auto', ...proof.result };
  const updated = await db('domains').where({ id: row.id, verification_status: 'pending' })
    .update({ verification_error: proof.ok ? null : proof.error, verification_result: JSON.stringify(result) })
    .returning('id') as Array<{ id: number }>;
  if (proof.ok && proof.method) return markVerified(row, proof.method, ctx);
  // An automatic re-check whose outcome changed (e.g. the delegation moved): the open card refreshes.
  if (updated.length && !ctx.req && checkResultSignature(result) !== checkResultSignature(parseCheckResult(row.verification_result ?? null))) {
    try {
      emitHosting(HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED, { domainId: row.id, status: 'pending' }, { tenantId: row.tenant_id, accountId: row.account_id });
    } catch (err) {
      logger.warn({ err: (err as Error).message, domainId: row.id }, 'ownership: socket failed');
    }
  }
  return false;
}

async function registryLookupSafe(): Promise<RegistryLookup | null> {
  try {
    return await registryLookup();
  } catch {
    return null;
  }
}

// ── claims ───────────────────────────────────────────────────────────────────

interface ClaimRow {
  id: number; tenant_id: number; account_id: number; name: string; token: string; status: DomainClaimStatus;
  domain_id: number | null; created_by: number | null; last_check_at: Date | string | null; last_error: string | null;
  expires_at: Date | string; completed_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

function claimExpiredByTime(r: Pick<ClaimRow, 'status' | 'expires_at'>, now = Date.now()): boolean {
  return r.status === 'pending' && new Date(r.expires_at).getTime() <= now;
}

function toClaim(r: ClaimRow): DomainClaim {
  const { txtName, txtValue } = ownershipTxt(r.name, r.token);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    name: r.name,
    status: claimExpiredByTime(r) ? 'expired' : r.status,
    txtName,
    txtValue,
    domainId: r.domain_id,
    lastCheckAt: iso(r.last_check_at),
    lastError: asError(r.last_error),
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

async function loadClaim(actor: HostingActor, claimId: number, need: HostingNeed): Promise<ClaimRow> {
  const notFound = new AppError(404, 'Claim not found', 'notFound');
  if (!Number.isInteger(claimId) || claimId <= 0) throw notFound;
  const row = await db('domain_claims').where({ id: claimId }).first() as ClaimRow | undefined;
  const target = row ? { tenantId: row.tenant_id, accountId: row.account_id } : null;
  if (!row || !target || !actorSees(actor, target)) throw notFound;
  if (!actorCan(actor, need, target)) throw new AppError(403, 'Insufficient permissions');
  return row;
}

function claimExpired(): AppError {
  return new AppError(409, 'This claim has expired: create a new one', 'claimExpired');
}

/**
 * Manual check cooldown of a domain (per panel process, NOT the column
 * verification_checked_at, which the worker writes too). Synchronous: the
 * check-and-set cannot interleave with another request.
 */
const manualChecks = new Map<number, number>();
const MANUAL_CHECKS_PRUNE_AT = 10_000;

function takeManualSlot(domainId: number, now = Date.now()): boolean {
  const cooldownMs = CHECK_COOLDOWN_SEC * 1000;
  const last = manualChecks.get(domainId);
  if (last !== undefined && now - last < cooldownMs) return false;
  if (manualChecks.size >= MANUAL_CHECKS_PRUNE_AT) {
    for (const [id, at] of manualChecks) if (now - at >= cooldownMs) manualChecks.delete(id);
  }
  manualChecks.set(domainId, now);
  return true;
}

/** Tests only: forget the manual check cooldowns. */
export function _resetManualCheckCooldowns(): void {
  manualChecks.clear();
}

function rateLimited(): AppError {
  return new AppError(429, `Please wait ${CHECK_COOLDOWN_SEC} seconds between two checks`, 'rateLimited', { retryAfterSec: CHECK_COOLDOWN_SEC });
}

async function platformNamesSafe(): Promise<ReturnType<typeof platformHostNames>> {
  try {
    return platformHostNames(await loadPlatformHosts());
  } catch {
    return platformHostNames(null);
  }
}

function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.caps === '*';
}

interface ReclaimedDomain { id: number; name: string; account_id: number; tenant_id: number }

/**
 * Transfer of a claimed name (TXT proven) — ONE transaction: the claimer's
 * tenant locked (envelope), the domains of OTHER accounts named `name` or
 * under it deleted (routes + certificate rows cascade; certificate files
 * removed after commit), the domain created verified 'txt' in the claimer's
 * account (or the claimer's existing one marked verified), the claim
 * succeeded. Side effects after commit.
 */
async function transferClaim(req: Request, claim: ClaimRow): Promise<void> {
  const name = claim.name;
  if (isPlatformReservedDomain(name, await platformNamesSafe(), { platformAdmin: true })) {
    throw new AppError(400, 'This name belongs to the panel', 'domainReserved');
  }
  const outcome = await db.transaction(async (trx) => {
    await lockTenant(trx, claim.tenant_id);
    const account = await trx('hosting_accounts').where({ id: claim.account_id, tenant_id: claim.tenant_id }).first('id', 'tenant_id', 'plan_id', 'status') as
      { id: number; tenant_id: number; plan_id: number; status: string } | undefined;
    if (!account || account.status === 'deleting') throw accountDeleting();
    const current = await trx('domain_claims').where({ id: claim.id }).forUpdate().first('status', 'expires_at') as Pick<ClaimRow, 'status' | 'expires_at'> | undefined;
    if (!current || current.status !== 'pending' || claimExpiredByTime(current)) throw claimExpired();

    // The squatted name and everything under it held by other accounts (subdomains follow their parent, T3).
    const victims = await trx('domains')
      .where((b) => { b.where('name', name).orWhere('name', 'like', `%.${name}`); })
      .whereNot('account_id', account.id)
      .forUpdate()
      .select('id', 'name', 'account_id', 'tenant_id') as ReclaimedDomain[];
    for (const v of victims) await certificateService.removeForDomain(v.id, { trx });
    if (victims.length) await trx('domains').whereIn('id', victims.map((v) => v.id)).del();

    const own = await trx('domains').where({ name, account_id: account.id }).first('id', 'verification_status') as
      { id: number; verification_status: string } | undefined;
    let domainId: number;
    let created = false;
    if (own) {
      domainId = own.id;
      if (own.verification_status !== 'verified') {
        await trx('domains').where({ id: own.id }).update({
          verification_status: 'verified', verification_method: 'txt', verified_at: trx.fn.now(), verification_error: null,
          verification_next_check_at: null, updated_at: trx.fn.now(),
        });
      }
    } else {
      // Same path as POST /domains (envelope + plan maxDomains re-checked under the tenant lock).
      domainId = await insertDomainRow(trx, account, {
        name, kind: 'addon', include_www: false, tls_mode: 'letsencrypt', force_https: true, wildcard: false,
        verification: { status: 'verified', method: 'txt' },
      });
      created = true;
    }
    await trx('domain_claims').where({ id: claim.id }).update({
      status: 'succeeded',
      domain_id: domainId,
      completed_at: trx.fn.now(),
      last_error: null,
      // Kept for the platform staff only (never returned by the API: A2).
      previous_owner: JSON.stringify(victims.map((v) => ({ domainId: v.id, name: v.name, accountId: v.account_id, tenantId: v.tenant_id }))),
      updated_at: trx.fn.now(),
    });
    return { domainId, created, victims, account };
  });

  // ── after commit: the holder side (no identity of the claimer) ──
  for (const v of outcome.victims) {
    try { dnsService.domainDeleted({ id: v.id, name: v.name, accountId: v.account_id, tenantId: v.tenant_id }); } catch (err) { logger.warn({ err, domainId: v.id }, 'dnsService.domainDeleted failed'); }
    try { reconcileService.requestAccount(v.account_id, `domain ${v.id} reclaimed`); } catch (err) { logger.warn({ err, accountId: v.account_id }, 'reconcileService.requestAccount failed'); }
    emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'domain', id: v.id, accountId: v.account_id, action: 'deleted' },
      { tenantId: v.tenant_id, accountId: v.account_id });
    await auditService.log({
      tenantId: v.tenant_id,
      action: 'domain.reclaimed',
      resourceType: 'domain',
      resourcePath: String(v.id),
      details: { name: v.name, accountId: v.account_id, side: 'holder', reason: 'ownershipProvenByAnotherAccount' },
    });
    // The holder is told (never who took it back: A2).
    notify('domain.reclaimed', {
      tenantId: v.tenant_id, accountId: v.account_id, key: `domain:${v.id}`, severity: 'warning',
      title: `Domaine retiré : ${v.name}`,
      message: `Le domaine ${v.name} a été retiré de ce compte : son propriétaire a prouvé qu’il le détient (enregistrement DNS TXT).`,
      link: null,
    });
  }
  // ── the claimer side (no identity of the holder) ──
  const domain = { id: outcome.domainId, tenant_id: outcome.account.tenant_id, account_id: outcome.account.id, name };
  await auditService.logReqAs(req, domain.tenant_id, 'domain.reclaimed', {
    resourceType: 'domain', resourcePath: String(domain.id),
    details: { name, accountId: domain.account_id, side: 'claimer', claimId: claim.id, removedDomains: outcome.victims.length },
  });
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'domain', id: domain.id, accountId: domain.account_id, action: outcome.created ? 'created' : 'updated' },
    { tenantId: domain.tenant_id, accountId: domain.account_id });
  if (outcome.created) {
    try { dnsService.domainCreated(domain.id); } catch (err) { logger.warn({ err, domainId: domain.id }, 'dnsService.domainCreated failed'); }
  }
  await announceVerified(domain, 'txt', { req });
  await propagateInheritance(domain, { req });
}

// ── worker ───────────────────────────────────────────────────────────────────

const worker: { first: NodeJS.Timeout | null; interval: NodeJS.Timeout | null; running: boolean } = { first: null, interval: null, running: false };

/** One worker pass: due pending domains checked (backoff), expired claims closed. */
export async function ownershipWorkerPass(now = Date.now()): Promise<{ checked: number; verified: number; claimsExpired: number }> {
  const claimsExpired = await db('domain_claims').where({ status: 'pending' }).where('expires_at', '<=', new Date(now))
    .update({ status: 'expired', updated_at: db.fn.now() });
  const due = await db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .where('d.verification_status', 'pending')
    .whereNot('a.status', 'deleting')
    .where((b) => { b.whereNull('d.verification_next_check_at').orWhere('d.verification_next_check_at', '<=', new Date(now)); })
    .orderByRaw('d.verification_next_check_at ASC NULLS FIRST')
    .limit(WORKER_BATCH)
    .select('d.id', 'd.tenant_id', 'd.account_id', 'd.name', 'd.verification_token', 'd.created_at', 'd.verification_requested_at', 'd.verification_result') as
    Array<VerifiableDomain & { verification_token: string; created_at: Date | string; verification_requested_at: Date | string | null }>;
  let verified = 0;
  for (const d of due) {
    // Next slot first: a crash / slow resolver never re-runs the same domain in a loop.
    const elapsed = now - new Date(d.created_at).getTime();
    const sinceRequest = d.verification_requested_at ? now - new Date(d.verification_requested_at).getTime() : null;
    await db('domains').where({ id: d.id }).update({
      verification_next_check_at: new Date(now + nextCheckDelayMs(Math.max(0, elapsed), sinceRequest)),
      verification_checked_at: new Date(now),
    });
    try {
      if (await runCheck(d, {})) verified++;
    } catch (err) {
      logger.warn({ domainId: d.id, err: (err as Error).message }, 'ownership: automatic check failed');
    }
  }
  return { checked: due.length, verified, claimsExpired: Number(claimsExpired) || 0 };
}

export const ownershipService = {
  async getVerification(actor: HostingActor, domainId: number): Promise<DomainVerification> {
    const row = await loadDomain(actor, domainId, 'read');
    return toVerification(row);
  },

  /** Immediate check (inheritance, TXT, then NS when settings dns.allowNsProof). Rate-limited per domain (1 / 30 s). */
  async check(req: Request, actor: HostingActor, domainId: number): Promise<DomainVerification> {
    const row = await loadDomain(actor, domainId, 'domains.manage');
    if (row.verification_status === 'verified') return toVerification(row);
    // Slot taken synchronously (two concurrent checks cannot both pass). Its
    // own clock: verification_checked_at is also written by the worker, a
    // user clicking right after an automatic pass must not get a 429.
    if (!takeManualSlot(row.id)) throw rateLimited();
    // A manual check re-opens the fast re-check window and the pending zone window (dns/pendingZone.ts).
    const now = new Date();
    await db('domains').where({ id: row.id }).update({ verification_checked_at: now, verification_requested_at: now });
    const verified = await runCheck(row, { req });
    if (!verified) {
      await db('domains').where({ id: row.id, verification_status: 'pending' })
        .update({ verification_next_check_at: new Date(now.getTime() + FAST_CHECK_INTERVAL_MS) });
      // The pending zone follows at once (re-opened window, or first publication).
      try { dnsService.domainChanged(row.id, 'verification-requested'); } catch (err) { logger.warn({ err, domainId: row.id }, 'dnsService.domainChanged failed'); }
    }
    return freshVerification(row.id);
  },

  /** Platform admin: mark verified (method admin), audited in the domain's tenant. */
  async force(req: Request, actor: HostingActor, domainId: number): Promise<DomainVerification> {
    const row = await loadDomain(actor, domainId, 'read');
    if (!isPlatformAdmin(actor)) throw new AppError(403, 'Insufficient permissions');
    if (row.verification_status !== 'verified') await markVerified(row, 'admin', { req, forced: true });
    return freshVerification(row.id);
  },

  async listClaims(actor: HostingActor, accountId?: number | null): Promise<DomainClaim[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = db('domain_claims as c');
    scopeToActor(actor, q, { tenant: 'c.tenant_id', account: 'c.account_id' });
    if (accountId) q.where('c.account_id', accountId);
    const rows = await q.orderBy('c.created_at', 'desc').limit(500).select('c.*') as ClaimRow[];
    return rows.map(toClaim);
  },

  async createClaim(req: Request, actor: HostingActor, body: DomainClaimCreate): Promise<DomainClaim> {
    const account = await loadAccount(actor, body.accountId, 'domains.manage');
    if (account.status === 'deleting') throw accountDeleting();
    const name = normalizeDomainName(body.name);
    if (!name) throw new AppError(400, 'Invalid domain name', 'validation');
    if (isPlatformReservedDomain(name, await platformNamesSafe(), { platformAdmin: isPlatformAdmin(actor) })) {
      throw new AppError(400, 'This name belongs to the panel', 'domainReserved');
    }
    if (!isPlatformAdmin(actor) && await isUnderPlatformZone(name)) {
      throw new AppError(400, 'This name belongs to the panel', 'domainReserved');
    }
    // Only a name held by ANOTHER account can be claimed (A2: the holder is never named).
    const holder = await db('domains').where({ name }).first('account_id') as { account_id: number } | undefined;
    if (!holder || holder.account_id === account.id) {
      throw new AppError(409, 'This name is not held by another account: add it as a domain', 'claimNotNeeded');
    }
    // An expired pending claim frees the (account, name) slot first; a live one is returned as is.
    await db('domain_claims').where({ account_id: account.id, name, status: 'pending' }).where('expires_at', '<=', db.fn.now())
      .update({ status: 'expired', updated_at: db.fn.now() });
    const existing = await db('domain_claims').where({ account_id: account.id, name, status: 'pending' }).first() as ClaimRow | undefined;
    if (existing) return toClaim(existing);
    const [row] = await db('domain_claims').insert({
      tenant_id: account.tenant_id,
      account_id: account.id,
      name,
      token: crypto.randomBytes(16).toString('hex'),
      status: 'pending',
      created_by: actor.userId,
      expires_at: new Date(Date.now() + CLAIM_TTL_MS),
    }).returning('*') as ClaimRow[];
    await auditService.logReqAs(req, account.tenant_id, 'domain.claim_create', {
      resourceType: 'domain_claim', resourcePath: String(row.id), details: { name, accountId: account.id },
    });
    return toClaim(row);
  },

  /** TXT proof → on success the holder's domain row is removed (audited in BOTH tenants) and recreated, verified, in the claimer's account. */
  async checkClaim(req: Request, actor: HostingActor, claimId: number): Promise<DomainClaim> {
    const claim = await loadClaim(actor, claimId, 'domains.manage');
    if (claim.status === 'expired') throw claimExpired();
    if (claim.status !== 'pending') return toClaim(claim);
    if (claimExpiredByTime(claim)) {
      await db('domain_claims').where({ id: claim.id, status: 'pending' }).update({ status: 'expired', updated_at: db.fn.now() });
      throw claimExpired();
    }
    const slot = await db('domain_claims').where({ id: claim.id, status: 'pending' })
      .where((b) => { b.whereNull('last_check_at').orWhereRaw(`last_check_at < now() - interval '${CHECK_COOLDOWN_SEC} seconds'`); })
      .update({ last_check_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('id') as Array<{ id: number }>;
    if (!slot.length) throw rateLimited();

    let proof: OwnershipProof;
    try {
      // TXT only: the squatter may hold the delegation (R-NS-SQUAT).
      proof = await evaluateOwnership(await publicDns(), claim.name, claim.token, { allowNs: false, nameservers: [], txtOnly: true });
    } catch (err) {
      logger.warn({ claimId: claim.id, err: (err as Error).message }, 'ownership claim: public DNS unavailable');
      proof = { ok: false, method: null, error: 'resolverFailed', result: unreachableResult(false, []) };
    }
    if (!proof.ok) {
      await db('domain_claims').where({ id: claim.id }).update({ last_error: proof.error, updated_at: db.fn.now() });
    } else {
      await transferClaim(req, claim);
    }
    return toClaim(await db('domain_claims').where({ id: claim.id }).first() as ClaimRow);
  },

  async cancelClaim(req: Request, actor: HostingActor, claimId: number): Promise<void> {
    const claim = await loadClaim(actor, claimId, 'domains.manage');
    if (claim.status !== 'pending') return;
    await db('domain_claims').where({ id: claim.id, status: 'pending' }).update({ status: 'cancelled', updated_at: db.fn.now() });
    await auditService.logReqAs(req, claim.tenant_id, 'domain.claim_cancel', {
      resourceType: 'domain_claim', resourcePath: String(claim.id), details: { name: claim.name, accountId: claim.account_id },
    });
  },

  /** Re-evaluates inheritance after a parent became verified / a domain was created or moved. Never throws. */
  domainChanged(domainId: number): void {
    void (async () => {
      const row = await db('domains').where({ id: domainId }).first('id', 'tenant_id', 'account_id', 'name', 'verification_status') as
        (VerifiableDomain & { verification_status: string }) | undefined;
      if (!row) return;
      if (row.verification_status === 'verified') {
        await propagateInheritance(row, {});
        return;
      }
      const parent = await verifiedParent(row);
      if (parent) await markVerified(row, 'inherited', { inheritedFrom: parent.name });
    })().catch((err) => logger.warn({ domainId, err: (err as Error).message }, 'ownership domainChanged failed'));
  },

  /** Worker: pending domains checked with backoff (1 min → 6 h), claims expired after 7 days. */
  start(): void {
    if (worker.first || worker.interval) return;
    const tick = () => {
      if (worker.running) return;
      worker.running = true;
      ownershipWorkerPass()
        .then((r) => { if (r.checked || r.claimsExpired) logger.debug(r, 'ownership worker pass'); })
        .catch((err) => logger.warn({ err: (err as Error).message }, 'ownership worker pass failed'))
        .finally(() => { worker.running = false; });
    };
    worker.first = setTimeout(() => { worker.first = null; tick(); }, WORKER_FIRST_DELAY_MS);
    worker.interval = setInterval(tick, WORKER_TICK_MS);
    worker.first.unref?.();
    worker.interval.unref?.();
  },

  stop(): void {
    if (worker.first) clearTimeout(worker.first);
    if (worker.interval) clearInterval(worker.interval);
    worker.first = null;
    worker.interval = null;
  },
};
