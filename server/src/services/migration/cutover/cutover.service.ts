import type { Request } from 'express';
import ipaddr from 'ipaddr.js';
import type {
  MigrationAccountPlan, MigrationCutoverDomain, MigrationCutoverSwitch, MigrationCutoverUpdate, MigrationRun, PlannedDomain,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { registerRunFinishedHook } from '../contracts/execution';
import { emitMigration } from '../events';
import { migrationObjectMap } from '../objectMap';
import { ACTIVE_STATUSES } from '../execution/store';
import {
  applyFacts, applyManualItems, buildInstructions, cutoverDomainsOf, CutoverItemError, itemCodesFor, itemDone, mailMigratedFor,
  mergeItemList, migratedZoneOf, modeOf, rollbackGuidance, stateAfterRun, type CutoverFacts,
} from './checklist';
import { cutoverDeps } from './deps';
import {
  accountPlanOf, cutoverRow, cutoverRowsOfPlan, domainFacts, initialDone, lastFinalSyncAt, rowItems, sourceDnsOf, switchedDomainsOfAccount,
  toCutoverDomain, zoneStatus, type CutoverRow,
} from './store';

// ─────────────────────────────────────────────────────────────────────────────
// Cutover helper (docs/P5-PLAN.md §10). OWNED BY MODULE `executor-mail-dns`.
// One checklist per migrated domain (migration_cutover_domains), created /
// refreshed after each run (registerRunFinishedHook, registered when this module
// loads — the cutover route imports it at boot), live DNS checks through the
// platform resolvers, final sync (delegates to migrationRunsService.startRuns
// kind 'final-sync'), switch (ownership check, Let's Encrypt take-over, proxy
// hosts back to SSL 'auto'), rollback guidance. NEVER writes on the source:
// "lower the TTL" is an instruction + a live check (MG1). Nothing is deleted.
//
// States: pending → prepared (a successful initial run exists) → synced (a
// final-sync run succeeded) → switched; rollback → prepared (switched_at kept:
// maildir mirroring stays refused for that domain, MG5).
// ─────────────────────────────────────────────────────────────────────────────

const NOTES_MAX = 4000;

const notFound = () => new AppError(404, 'Cutover item not found', 'notFound');
/** Days a certificate must still be valid at the switch (checklist item certificateIssued). */
const CERT_MIN_DAYS = 7;
const lower = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');

function plannedDomain(account: MigrationAccountPlan, fqdn: string): PlannedDomain | null {
  return account.domains.find((d) => lower(d.fqdn) === lower(fqdn)) ?? null;
}

function emit(row: Pick<CutoverRow, 'id' | 'plan_id' | 'source_id' | 'state'>): void {
  emitMigration({ entity: 'cutover', id: row.id, planId: row.plan_id, sourceId: row.source_id, status: row.state });
}

async function audit(req: Request, action: string, row: Pick<CutoverRow, 'id' | 'plan_id' | 'fqdn' | 'cwp_username'>, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReq(req, action, {
    resourceType: 'migration_cutover', resourcePath: String(row.id),
    details: { planId: row.plan_id, fqdn: row.fqdn, account: row.cwp_username, ...details },
  });
}

// ── facts ────────────────────────────────────────────────────────────────────

async function dbFacts(planId: number, cwpUsername: string, d: PlannedDomain, account: MigrationAccountPlan, domainId: number | null): Promise<CutoverFacts> {
  const facts = await domainFacts(domainId, d.servedBy);
  const initial = await initialDone(planId, cwpUsername);
  const mode = modeOf(d);
  const apex = migratedZoneOf(account, d.fqdn);
  const zone = mode === 'ns-delegation' && apex ? await zoneStatus(apex) : null;
  const zoneActive = mode === 'ns-delegation' ? zone === 'active' : null;
  const cert = facts.certificate;
  return {
    verified: { ok: facts.verificationStatus === 'verified', status: facts.verificationStatus },
    // Advisory (never blocks the switch): the certificate served at the switch — the one imported from the source
    // until Let's Encrypt (HTTP-01, possible only once the DNS points here) replaces it.
    certificateIssued: {
      ok: !!cert && cert.status === 'valid' && (!cert.notAfter || new Date(cert.notAfter).getTime() > Date.now() + CERT_MIN_DAYS * 86_400_000),
      issuer: cert?.issuer ?? null, status: cert?.status ?? null, notAfter: cert?.notAfter ?? null,
    },
    targetReady: { ok: initial && facts.exists && facts.published && zoneActive !== false, initialDone: initial, published: facts.published, zoneActive },
    lastFinalSyncAt: await lastFinalSyncAt(planId, cwpUsername),
  };
}

const errCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'resolverFailed';

function sameIp(a: string, b: string | null): boolean {
  if (!b) return false;
  try { return ipaddr.parse(a).toNormalizedString() === ipaddr.parse(b).toNormalizedString(); } catch { return a === b; }
}

/** Live DNS facts of one row (resolvers of the platform + the current authoritative NS for the TTL). */
async function liveFacts(row: CutoverRow, mailMigrated: boolean): Promise<CutoverFacts> {
  const deps = cutoverDeps();
  const lookup = await deps.dns();
  const platform = await deps.platformDns();
  const fqdn = row.fqdn;
  const facts: CutoverFacts = {};

  // Closest delegated zone of the name (the registrable apex for a subdomain).
  let nameservers: string[] = [];
  let nsError: string | null = null;
  try {
    const labels = fqdn.split('.');
    for (let i = 0; i < labels.length - 1 && !nameservers.length; i++) nameservers = await lookup.ns(labels.slice(i).join('.'));
  } catch (err) {
    nsError = errCode(err);
  }

  let observed: number | null = null;
  let ttlError: string | null = nsError;
  for (const ns of nameservers.slice(0, 3)) {
    try {
      const ttl = await lookup.ttlAt(ns, fqdn);
      if (ttl !== null) observed = observed === null ? ttl : Math.max(observed, ttl);
    } catch (err) {
      ttlError = errCode(err);
    }
  }
  facts.ttl = { observedTtl: observed, nameservers, error: observed === null ? ttlError ?? (nameservers.length ? 'noAnswer' : 'noNameservers') : null };

  if (row.mode === 'ns-delegation') {
    const expected = platform.nameservers;
    facts.nsChanged = {
      ok: !nsError && expected.length > 0 && nameservers.length > 0 && nameservers.every((n) => expected.includes(n)),
      seen: nameservers, expected, error: nsError,
    };
  }

  try {
    const [a, aaaa] = await Promise.all([lookup.a(fqdn), lookup.aaaa(fqdn)]);
    const expected = [platform.ipv4, platform.ipv6].filter((x): x is string => !!x);
    facts.aRecordsChanged = {
      ok: a.length + aaaa.length > 0 && a.every((x) => sameIp(x, platform.ipv4)) && aaaa.every((x) => sameIp(x, platform.ipv6)),
      seen: [...a, ...aaaa], expected, error: null,
    };
  } catch (err) {
    facts.aRecordsChanged = { ok: false, seen: [], expected: [], error: errCode(err) };
  }

  if (mailMigrated) {
    const host = await deps.mailHost();
    try {
      const mx = await lookup.mx(fqdn);
      facts.mxChanged = { ok: !!host && mx.length > 0 && mx.every((m) => m.exchange === host), seen: mx.map((m) => `${m.priority} ${m.exchange}`), expected: host, error: null };
    } catch (err) {
      facts.mxChanged = { ok: false, seen: [], expected: host, error: errCode(err) };
    }
  }
  return facts;
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * Once a row is switched, ttlLowered and finalSync are frozen: the TTL then
 * served is the platform's own (imported zone TTL) and a later final sync is
 * refused — re-evaluating them would only turn them red.
 */
function frozenFacts(f: CutoverFacts): CutoverFacts {
  const { ttl: _ttl, lastFinalSyncAt: _last, ...rest } = f;
  return rest;
}

/**
 * Creates / refreshes the rows of one account of a plan from the plan result,
 * the object map and the DB facts (no network). `run`: the run that just ended
 * (state machine). Returns the rows of the account.
 */
async function syncAccountRows(planId: number, cwpUsername: string, run: MigrationRun | null = null): Promise<CutoverRow[]> {
  const plan = await accountPlanOf(planId, cwpUsername);
  if (!plan) return [];
  const { sourceId, account } = plan;
  const deps = cutoverDeps();
  const platform = await deps.platformDns();
  const initial = await initialDone(planId, cwpUsername);
  const finalSyncDone = run?.kind === 'final-sync' && run.status === 'done';
  const out: CutoverRow[] = [];
  const now = new Date();
  // Target account of the account's runs: a domain mapping is only this account's when it was recorded for
  // this CWP user AND its row belongs to that account (objectMap.resolveOwned, tenant isolation).
  const lastRun = await db('migration_runs').where({ plan_id: planId, cwp_username: cwpUsername }).whereNotNull('target_account_id')
    .orderBy('id', 'desc').first('target_account_id') as { target_account_id: number } | undefined;
  const owner = { cwpUsername, accountId: lastRun ? Number(lastRun.target_account_id) : null };

  for (const d of cutoverDomainsOf(account)) {
    const fqdn = lower(d.fqdn);
    const mode = modeOf(d);
    const mailMigrated = mailMigratedFor(account, fqdn);
    const domainId = await migrationObjectMap.resolveOwned(sourceId, 'domain', fqdn, owner);
    const facts = await domainFacts(domainId, d.servedBy);
    let mailRecords: Awaited<ReturnType<typeof deps.mailRecords>> = [];
    if (mode === 'records' && mailMigrated) {
      try { mailRecords = await deps.mailRecords(fqdn); } catch (err) { logger.debug({ err: (err as Error)?.message, fqdn }, 'cutover: mail records unavailable'); }
    }
    const instructions = buildInstructions({
      fqdn, mode, zoneApex: migratedZoneOf(account, fqdn), includeWww: facts.exists ? facts.includeWww : d.includeWww,
      nameservers: platform.nameservers, ipv4: platform.ipv4, ipv6: platform.ipv6, mailRecords,
      verificationToken: d.verification === 'txt' && facts.verificationStatus !== 'verified' ? facts.verificationToken : null,
    });

    const checklistFacts = await dbFacts(planId, cwpUsername, d, account, domainId);

    // Read-modify-write under a row lock: a concurrent switch / rollback /
    // manual update is never reverted by this refresh (state and items are
    // recomputed from the row as it is NOW).
    const { row, existing } = await db.transaction(async (trx) => {
      const cur = await trx('migration_cutover_domains').where({ plan_id: planId, fqdn }).forUpdate().first() as CutoverRow | undefined;
      const base = mergeItemList(cur ? rowItems(cur) : [], itemCodesFor(mode, mailMigrated));
      const { items } = applyFacts(base, cur?.state === 'switched' ? frozenFacts(checklistFacts) : checklistFacts, now);
      const state = stateAfterRun(cur?.state ?? 'pending', { initialDone: initial, finalSyncDone });
      const values = {
        source_id: sourceId, cwp_username: cwpUsername, target_domain_id: domainId, mode, state,
        items: JSON.stringify(items), instructions: JSON.stringify(instructions), updated_at: now,
      };
      if (cur) {
        const [r] = await trx('migration_cutover_domains').where({ id: cur.id }).update(values).returning('*') as CutoverRow[];
        return { row: r, existing: cur };
      }
      // Inserted concurrently by another refresh: keep that row (and its state) as is.
      const [r] = await trx('migration_cutover_domains').insert({ plan_id: planId, fqdn, ...values, created_at: now })
        .onConflict(['plan_id', 'fqdn']).ignore().returning('*') as CutoverRow[];
      return { row: r ?? await trx('migration_cutover_domains').where({ plan_id: planId, fqdn }).first() as CutoverRow, existing: cur };
    });
    out.push(row);
    if (!existing || existing.state !== row.state) emit(row);
  }
  return out;
}

/** Live checks of one row (+ its DB facts), persisted. */
async function checkRow(row: CutoverRow): Promise<CutoverRow> {
  const plan = await accountPlanOf(row.plan_id, row.cwp_username);
  const d = plan ? plannedDomain(plan.account, row.fqdn) : null;
  const mailMigrated = plan ? mailMigratedFor(plan.account, row.fqdn) : false;
  const now = new Date();
  let facts: CutoverFacts = {};
  if (plan && d) facts = await dbFacts(row.plan_id, row.cwp_username, d, plan.account, row.target_domain_id);
  // ttlLowered first: finalSync is evaluated against its `since`.
  const live = await liveFacts(row, mailMigrated);
  const updated = await db.transaction(async (trx) => {
    // Facts gathered above (network, no lock held), applied to the row as it is NOW.
    const cur = await trx('migration_cutover_domains').where({ id: row.id }).forUpdate().first() as CutoverRow | undefined;
    if (!cur) return null;
    const switched = cur.state === 'switched';
    const observed = live.ttl ? live.ttl.observedTtl : null;
    const first = applyFacts(rowItems(cur), switched ? frozenFacts(live) : live, now);
    const second = applyFacts(first.items, switched ? frozenFacts(facts) : facts, now);
    const [r] = await trx('migration_cutover_domains').where({ id: cur.id }).update({
      items: JSON.stringify(second.items),
      observed_ttl: observed ?? cur.observed_ttl,
      updated_at: now,
    }).returning('*') as CutoverRow[];
    return r;
  });
  if (!updated) throw notFound();
  emit(updated);
  return updated;
}

async function loadRow(id: number): Promise<CutoverRow> {
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const row = await cutoverRow(id);
  if (!row) throw notFound();
  return row;
}

// ── run-finished hook ────────────────────────────────────────────────────────

/** Rows of the account refreshed after every run end (done / failed / cancelled). Never throws. */
export async function onRunFinished(run: MigrationRun): Promise<void> {
  try {
    await syncAccountRows(run.planId, run.cwpUsername, run);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, runId: run.id }, 'cutover: checklist refresh after the run failed');
  }
}

registerRunFinishedHook(onRunFinished);

// ── service ──────────────────────────────────────────────────────────────────

export const migrationCutoverService = {
  async list(planId: number): Promise<MigrationCutoverDomain[]> {
    if (!(await db('migration_plans').where({ id: planId }).first('id'))) throw new AppError(404, 'Migration plan not found', 'notFound');
    return (await cutoverRowsOfPlan(planId)).map(toCutoverDomain);
  },

  /** Re-runs the live checks of every domain of the plan (rows of accounts that ran are created / refreshed first). */
  async refresh(_req: Request, planId: number): Promise<MigrationCutoverDomain[]> {
    if (!(await db('migration_plans').where({ id: planId }).first('id'))) throw new AppError(404, 'Migration plan not found', 'notFound');
    const ran = await db('migration_runs').where({ plan_id: planId }).distinct('cwp_username') as Array<{ cwp_username: string }>;
    const accounts = new Set([...ran.map((r) => r.cwp_username), ...(await cutoverRowsOfPlan(planId)).map((r) => r.cwp_username)]);
    for (const a of accounts) await syncAccountRows(planId, a);
    for (const row of await cutoverRowsOfPlan(planId)) {
      try {
        await checkRow(row);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, fqdn: row.fqdn }, 'cutover: live check failed');
      }
    }
    return (await cutoverRowsOfPlan(planId)).map(toCutoverDomain);
  },

  async update(req: Request, id: number, body: MigrationCutoverUpdate): Promise<MigrationCutoverDomain> {
    const row = await loadRow(id);
    const updated = await db.transaction(async (trx) => {
      // Under the row lock: a concurrent refresh / switch is neither reverted nor reverts this change.
      const cur = await trx('migration_cutover_domains').where({ id: row.id }).forUpdate().first() as CutoverRow | undefined;
      if (!cur) throw notFound();
      const notes = body.notes === undefined ? cur.notes : (body.notes === null ? null : String(body.notes).slice(0, NOTES_MAX) || null);
      let items = rowItems(cur);
      if (body.items) {
        try {
          items = applyManualItems(items, body.items, notes, new Date());
        } catch (err) {
          if (err instanceof CutoverItemError) {
            throw new AppError(400, err.code === 'cutoverItemAuto' ? `${err.item} is checked automatically` : 'Forcing this item needs a note',
              err.code, { item: err.item });
          }
          throw err;
        }
      }
      const [r] = await trx('migration_cutover_domains').where({ id: cur.id })
        .update({ items: JSON.stringify(items), notes, updated_at: new Date() }).returning('*') as CutoverRow[];
      return r;
    });
    await audit(req, 'migration.cutover.update', row, { items: body.items ?? null, notes: body.notes !== undefined });
    emit(updated);
    return toCutoverDomain(updated);
  },

  async check(_req: Request, id: number): Promise<MigrationCutoverDomain> {
    const row = await loadRow(id);
    const refreshed = (await syncAccountRows(row.plan_id, row.cwp_username)).find((r) => r.id === row.id) ?? row;
    return toCutoverDomain(await checkRow(refreshed));
  },

  /**
   * TTL of the migrated zone on OUR DNS (default + manual / template records) — only when the zone is already
   * delegated to the platform name servers (live check): lowered before moving records, raised after the switch.
   * 409 cutoverNotDelegated (records mode, or NS not ours yet: the TTL is then the source's), 404 zoneNotFound.
   */
  async setZoneTtl(req: Request, id: number, ttl: number): Promise<MigrationCutoverDomain> {
    const row = await loadRow(id);
    const plan = await accountPlanOf(row.plan_id, row.cwp_username);
    const apex = plan ? migratedZoneOf(plan.account, row.fqdn) : null;
    if (row.mode !== 'ns-delegation' || !apex) throw new AppError(409, 'The zone of this domain is not served by the platform', 'cutoverNotDelegated');
    const deps = cutoverDeps();
    const expected = (await deps.platformDns()).nameservers;
    let seen: string[] = [];
    try { seen = await (await deps.dns()).ns(apex); } catch { seen = []; }
    if (!seen.length || !expected.length || !seen.every((n) => expected.includes(n))) {
      throw new AppError(409, 'The name servers of the zone are not the platform ones yet: lower the TTL at the current DNS host', 'cutoverNotDelegated',
        { seen: seen.join(', '), expected: expected.join(', ') });
    }
    const r = await deps.setZoneTtl(req, apex, ttl);
    if (!r) throw new AppError(404, 'The zone is not hosted on the platform DNS', 'zoneNotFound', { zone: apex });
    await audit(req, 'migration.cutover.zone_ttl', row, { zone: apex, ttl, recordsRetimed: r.recordsRetimed });
    return toCutoverDomain(await checkRow(row));
  },

  async finalSync(req: Request, id: number): Promise<MigrationRun> {
    const row = await loadRow(id);
    if (row.state === 'pending' || !(await initialDone(row.plan_id, row.cwp_username))) {
      throw new AppError(409, 'The initial migration of this account has not succeeded yet', 'cutoverNotReady');
    }
    // A final sync re-imports every database of the account and refreshes its
    // mail: on a domain already live here it would overwrite what was written
    // since the switch. Refused while any domain of the account is switched
    // (any plan of the source); a deliberate post-switch resync goes through the
    // explicit resync dialog (runs API). After a rollback it is allowed again.
    const switchedFqdns = await switchedDomainsOfAccount(row.source_id, row.cwp_username);
    if (switchedFqdns.length) {
      throw new AppError(409, 'A domain of this account is already switched: use an explicit resync', 'cutoverSwitched', { domains: switchedFqdns });
    }
    const run = await cutoverDeps().startFinalSync(req, row.plan_id, row.cwp_username);
    await audit(req, 'migration.cutover.final_sync', row, { runId: run.id });
    emit(row);
    return run;
  },

  /** 400 confirmMismatch; 409 cutoverNotReady (target not ready / no successful run), runActive (a run of the account is in progress). */
  async switchOver(req: Request, id: number, body: MigrationCutoverSwitch): Promise<MigrationCutoverDomain> {
    const row = await loadRow(id);
    if (lower(body?.confirm ?? '') !== row.fqdn) throw new AppError(400, 'Type the domain name to confirm', 'confirmMismatch');
    if (row.state === 'switched') return toCutoverDomain(row);
    const fresh = (await syncAccountRows(row.plan_id, row.cwp_username)).find((r) => r.id === row.id) ?? row;
    if (!itemDone(rowItems(fresh), 'targetReady') || !fresh.target_domain_id) {
      throw new AppError(409, 'The target is not ready: the initial migration must be done and the site published', 'cutoverNotReady');
    }
    const deps = cutoverDeps();
    const actor = await deps.actor(req);
    const now = new Date();
    // A run of the account still queued / running / paused (final sync in progress…) decided "not switched"
    // when its steps started: a maildir mirror (--delete, UID files) or a database re-import after the switch
    // would erase what Oblimint received / the live site wrote since. Refused until it ends — checked IN the
    // conditional write (no window between the check and the switch).
    const activeRun = () => db('migration_runs').where({ source_id: row.source_id, cwp_username: row.cwp_username })
      .whereIn('status', ACTIVE_STATUSES).first('id') as Promise<{ id: number } | undefined>;
    if (await activeRun()) throw new AppError(409, 'A run of this account is queued, running or paused: wait for it to end', 'runActive');
    // Conditional write: of two concurrent switches only one runs the take-over.
    const [switched] = await db('migration_cutover_domains').where({ id: row.id, plan_id: row.plan_id }).whereNot('state', 'switched')
      .whereNotExists(db('migration_runs').select('id').where({ source_id: row.source_id, cwp_username: row.cwp_username }).whereIn('status', ACTIVE_STATUSES))
      .update({
        state: 'switched', switched_at: now, switched_by: req.session?.userId ?? null, updated_at: now,
      }).returning('*') as CutoverRow[];
    if (!switched) {
      if (await activeRun()) throw new AppError(409, 'A run of this account is queued, running or paused: wait for it to end', 'runActive');
      return toCutoverDomain(await loadRow(row.id));
    }
    const plan = await accountPlanOf(row.plan_id, row.cwp_username);
    const servedBy = (plan ? plannedDomain(plan.account, row.fqdn)?.servedBy : null) ?? 'none';

    // Take-over by the platform: ownership (a forced verification stays), then
    // Let's Encrypt — never for an unverified domain (D1) —, proxy hosts → SSL auto.
    const domainId = switched.target_domain_id as number;
    const followUps: Record<string, unknown> = {};
    try {
      const facts = await domainFacts(domainId, 'site');
      if (facts.verificationStatus !== 'verified') await deps.ownershipCheck(req, actor, domainId);
      const after = await domainFacts(domainId, 'site');
      followUps.verified = after.verificationStatus === 'verified';
      if (after.verificationStatus === 'verified') {
        if (servedBy === 'proxy') {
          // A host goes back to SSL auto only once EVERY name bound to it is
          // switched (Let's Encrypt would fail on the names still on CWP); the
          // switch of its last name flips it.
          const proxy = await deps.proxySslAuto(req, actor, domainId);
          followUps.proxyHosts = proxy.changed.length;
          if (proxy.deferred.length) followUps.proxyHostsDeferred = proxy.deferred.length;
        } else if (servedBy === 'site') {
          // Site domains only: a proxy host gets its certificate through SSL auto, a mail-only domain needs none.
          await deps.startCertificate(domainId);
          followUps.certificateRequested = true;
        }
      }
    } catch (err) {
      followUps.error = (err as { code?: string })?.code ?? 'failed';
      logger.warn({ err: (err as Error)?.message, fqdn: row.fqdn }, 'cutover: take-over after the switch incomplete');
    }
    await audit(req, 'migration.cutover.switch', row, followUps);
    emit(switched);
    return toCutoverDomain(switched);
  },

  async rollback(req: Request, id: number): Promise<MigrationCutoverDomain> {
    const row = await loadRow(id);
    if (row.state !== 'switched') throw new AppError(409, 'This domain is not switched', 'cutoverNotSwitched');
    const plan = await accountPlanOf(row.plan_id, row.cwp_username);
    const source = plan ? await sourceDnsOf(plan.discoveryId, row.fqdn) : { nameservers: [], a: [] };
    const guidance = rollbackGuidance({
      fqdn: row.fqdn, mode: row.mode, originalNameservers: source.nameservers, originalA: source.a,
      mailMigrated: plan ? mailMigratedFor(plan.account, row.fqdn) : false, at: new Date(),
    });
    const notes = [row.notes, guidance].filter(Boolean).join('\n\n').slice(-NOTES_MAX);
    // switched_at is kept on purpose: mirroring deletions on the maildirs stays refused (MG5).
    const [updated] = await db('migration_cutover_domains').where({ id: row.id, state: 'switched' }).update({
      state: 'prepared', notes, updated_at: new Date(),
    }).returning('*') as CutoverRow[];
    if (!updated) throw new AppError(409, 'This domain is not switched', 'cutoverNotSwitched');
    await audit(req, 'migration.cutover.rollback', row);
    emit(updated);
    return toCutoverDomain(updated);
  },
};
