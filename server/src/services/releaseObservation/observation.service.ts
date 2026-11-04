import type {
  NotificationEvent, ObservationAction, ObservationRevertBlock, ReleaseLogLine, ReleaseTrigger, ReleaseVerdict, ReleaseVerdictReason,
} from '@oblimint/shared';
import { HostingSocketEvents, OBSERVATION_WINDOW_DEFAULT_MINUTES, OBSERVATION_WINDOW_MAX_MINUTES, OBSERVATION_WINDOW_MIN_MINUTES } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import { siteUpstream } from '../hosting/naming';
import { releaseDeps } from '../releases/deps';
import { subscribeEdgeLog } from '../usage/edgeLog';
import { notify, type NotificationPayload } from '../usage/notifications.service';
import { factsOf, type ObservationRow } from './rows';
import { SiteTraffic } from './traffic';
import { computeVerdict, factsText, verdictText } from './verdict';

// ─────────────────────────────────────────────────────────────────────────────
// Observation of a release after it went live (migration 040, shared/
// releaseObservation.ts). OWNED BY MODULE `releaseObservation`.
//
//   onReleaseLive   the pipeline (release.service deploy) after a release became
//                   current: one row (UNIQUE release_id), baseline = the same span
//                   just before the switch (edge log ring), counting starts.
//                   Rollbacks / reverts never call it: no observation, no loop.
//   tick (30 s)     counters drained into the row, one health probe per minute,
//                   new PHP error groups of the release (siteErrors), verdict;
//                   a release no longer live is closed as superseded.
//   finalize        claim (state watching → done, only one caller wins), log line,
//                   notification; mode revert + failed + no migrations + a
//                   previous release ready → ONE revertTo (the existing rollback
//                   path: provenance 'revert', audited), traced in the row.
// Never throws to its callers (pipeline, workers).
// ─────────────────────────────────────────────────────────────────────────────

export const OBSERVE_TICK_MS = 30_000;
export const PROBE_EVERY_MS = 60_000;
const MINUTE = 60_000;

export interface ObservationDeps {
  /** One health probe of the site (no retry): ok = status < 500. */
  probe(site: { id: number; healthcheck_path: string }): Promise<{ ok: boolean; error: string | null }>;
  /** The existing rollback path of an automatic return (releaseService.revertTo). */
  revertTo(siteId: number, releaseId: number, reason: string): Promise<void>;
  notify(event: NotificationEvent, payload: NotificationPayload): void;
}

const defaults: ObservationDeps = {
  async probe(site) {
    const { healthcheckHost } = await import('../releases/release.service');
    const d = releaseDeps();
    const p = site.healthcheck_path?.startsWith('/') ? site.healthcheck_path : `/${site.healthcheck_path ?? ''}`;
    const r = await d.probe(siteUpstream(site.id) + p, await healthcheckHost(site.id), d.health.timeoutMs);
    return { ok: r.ok, error: r.ok ? null : (r.error ?? `HTTP ${r.status}`) };
  },
  async revertTo(siteId, releaseId, reason) {
    const { releaseService } = await import('../releases/release.service');
    await releaseService.revertTo(siteId, releaseId, reason);
  },
  notify: (event, payload) => notify(event, payload),
};

let deps: ObservationDeps = { ...defaults };

export function setObservationDeps(over: Partial<ObservationDeps>): void {
  deps = { ...deps, ...over };
}

export function resetObservationDeps(): void {
  deps = { ...defaults };
}

const traffic = new SiteTraffic();

/** A release that ran (or may have run) database migrations / release commands: never reverted automatically. */
export function ranMigrations(trigger: ReleaseTrigger): boolean {
  // An adapter update runs the application's migrations after the switch (post_deploy) and has its own
  // rollback with database snapshots: putting the old code back over a migrated schema is the dangerous case.
  return trigger === 'adapter';
}

function clampWindow(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return OBSERVATION_WINDOW_DEFAULT_MINUTES;
  return Math.min(OBSERVATION_WINDOW_MAX_MINUTES, Math.max(OBSERVATION_WINDOW_MIN_MINUTES, v));
}

/** Appends lines to a release log (jsonb concat: never rewrites what the pipeline wrote) and tells the UI. */
async function releaseLog(row: Pick<ObservationRow, 'release_id' | 'site_id' | 'tenant_id'>, lines: Array<Pick<ReleaseLogLine, 'level' | 'message'>>): Promise<void> {
  try {
    const at = new Date().toISOString();
    const add = lines.map((l) => ({ at, level: l.level, message: l.message.slice(0, 2000) }));
    await db('releases').where({ id: row.release_id, site_id: row.site_id })
      .update({ log: db.raw('COALESCE(log, \'[]\'::jsonb) || ?::jsonb', [JSON.stringify(add)]), updated_at: db.fn.now() });
  } catch (err) {
    logger.warn({ err, releaseId: row.release_id }, 'Release observation: cannot write the release log');
  }
}

async function emitUpdated(row: Pick<ObservationRow, 'release_id' | 'site_id' | 'tenant_id'>): Promise<void> {
  try {
    const r = await db('releases as r').join('sites as s', 's.id', 'r.site_id').where('r.id', row.release_id)
      .first('r.status', 's.account_id') as { status: string; account_id: number } | undefined;
    if (r) emitHosting(HostingSocketEvents.RELEASE_UPDATED, { siteId: row.site_id, releaseId: row.release_id, status: r.status }, { tenantId: row.tenant_id, accountId: r.account_id });
  } catch { /* UI refresh only */ }
}

/** New PHP error groups of a release (none of the earlier releases had the fingerprint): fatal, parse, warning. */
async function phpFacts(row: ObservationRow): Promise<{ groups: number; fatals: number; occurrences: number }> {
  const r = await db.raw(`
    SELECT COUNT(*) AS groups, COUNT(*) FILTER (WHERE g.level IN ('fatal', 'parse')) AS fatals, COALESCE(SUM(g.count), 0) AS occurrences
    FROM site_error_groups g
    WHERE g.site_id = ? AND g.tenant_id = ? AND g.release_number = ? AND g.release_number > 0
      AND g.level IN ('fatal', 'parse', 'warning')
      AND NOT EXISTS (SELECT 1 FROM site_error_groups o WHERE o.site_id = g.site_id AND o.fingerprint = g.fingerprint
        AND o.release_number > 0 AND o.release_number < g.release_number)`, [row.site_id, row.tenant_id, row.release_number]) as {
    rows: Array<{ groups: string | number; fatals: string | number; occurrences: string | number }>;
  };
  const x = r.rows[0];
  return { groups: Number(x?.groups ?? 0), fatals: Number(x?.fatals ?? 0), occurrences: Number(x?.occurrences ?? 0) };
}

interface SiteState {
  id: number; tenant_id: number; account_id: number; name: string; status: string; healthcheck_path: string; current_release_id: number | null;
}

/** Why mode revert would not put the previous release back now (null: it may). */
async function revertBlockOf(row: ObservationRow): Promise<ObservationRevertBlock | null> {
  const rel = await db('releases').where({ id: row.release_id }).first('trigger') as { trigger: ReleaseTrigger } | undefined;
  if (!rel || ranMigrations(rel.trigger)) return 'migrations';
  if (!row.previous_release_id) return 'noPrevious';
  const prev = await db('releases').where({ id: row.previous_release_id, site_id: row.site_id }).first('status') as { status: string } | undefined;
  return prev?.status === 'ready' ? null : 'noPrevious';
}

const BLOCK_TEXT: Record<ObservationRevertBlock, string> = {
  migrations: 'pas de retour automatique : la release a lancé des migrations de base (alerte seulement)',
  noPrevious: 'pas de retour automatique : aucune release précédente disponible',
};

async function notifyVerdict(row: ObservationRow, site: SiteState, verdict: ReleaseVerdict, action: ObservationAction, detail: string): Promise<void> {
  if (verdict !== 'failed' && verdict !== 'degraded') return;
  const prev = row.previous_release_number ? `#${row.previous_release_number}` : null;
  let message = `La release #${row.release_number} du site ${site.name} est ${verdictText(verdict)} après sa mise en ligne (${detail}).`;
  if (action === 'reverted' && prev) message += ` La release ${prev} a été remise en ligne automatiquement.`;
  else if (action === 'revertFailed') message += ` Le retour automatique à la release ${prev ?? 'précédente'} a échoué : la release #${row.release_number} reste en ligne.`;
  else if (verdict === 'failed') message += prev ? ` Elle reste en ligne : revenez à la release ${prev} si le site est cassé.` : ' Elle reste en ligne.';
  if (row.revert_blocked === 'migrations' && verdict === 'failed') message += ' Pas de retour automatique : cette release a lancé des migrations de base.';
  deps.notify(verdict === 'failed' ? 'release.failedObservation' : 'release.degraded', {
    tenantId: site.tenant_id, accountId: site.account_id, key: `release:${row.release_id}:observation`,
    severity: verdict === 'failed' ? 'critical' : 'warning',
    title: `${verdict === 'failed' ? (action === 'reverted' ? 'Release retirée' : 'Release en échec') : 'Release dégradée'} : ${site.name}`,
    message,
    link: `/sites/${site.id}?tab=releases&release=${row.release_id}`,
  });
}

async function finalize(row: ObservationRow, site: SiteState | null, verdict: ReleaseVerdict, reasons: ReleaseVerdictReason[], now: Date): Promise<void> {
  let action: ObservationAction = verdict === 'failed' || verdict === 'degraded' ? 'alerted' : 'none';
  let block = row.revert_blocked;
  if (verdict === 'failed' && row.mode === 'revert') {
    block = await revertBlockOf(row);
    if (!block) action = 'reverting';
  }
  const claimed = await db('release_observations').where({ id: row.id, state: 'watching' }).update({
    state: 'done', verdict, reasons: JSON.stringify(reasons), finished_at: now, action, revert_blocked: block, updated_at: db.fn.now(),
  });
  if (!claimed) return;
  const fresh = { ...row, verdict, revert_blocked: block } as ObservationRow;
  const detail = factsText(factsOf(row));
  const lines: Array<Pick<ReleaseLogLine, 'level' | 'message'>> = [{
    level: verdict === 'failed' ? 'error' : verdict === 'degraded' ? 'warn' : 'info',
    message: `observation terminée : ${verdictText(verdict)} (${detail})`,
  }];
  if (verdict === 'failed' && row.mode === 'revert' && block) lines.push({ level: 'warn', message: `observation : ${BLOCK_TEXT[block]}` });
  await releaseLog(row, lines);
  await emitUpdated(row);
  if (!site) return;

  if (action === 'reverting' && row.previous_release_id) {
    const reason = `observation de la release #${row.release_number} : ${verdictText(verdict)} (${detail})`.slice(0, 480);
    try {
      // Still the live release (a publication / rollback since the pass began is never undone).
      const live = await db('sites').where({ id: row.site_id }).first('current_release_id') as { current_release_id: number | null } | undefined;
      if (live?.current_release_id !== row.release_id) throw new Error('la release n\'est plus en ligne');
      await deps.revertTo(row.site_id, row.previous_release_id, reason);
      action = 'reverted';
      await db('release_observations').where({ id: row.id }).update({
        action, action_reason: reason, reverted_to_release_id: row.previous_release_id, updated_at: db.fn.now(),
      });
      await releaseLog(row, [{ level: 'warn', message: `observation : retour automatique à la release #${row.previous_release_number ?? '?'}` }]);
    } catch (err) {
      action = 'revertFailed';
      const why = `retour automatique impossible : ${(err as Error)?.message ?? String(err)}`.slice(0, 480);
      logger.warn({ err, releaseId: row.release_id, siteId: row.site_id }, 'Release observation: automatic return failed');
      await db('release_observations').where({ id: row.id }).update({ action, action_reason: why, updated_at: db.fn.now() });
      await releaseLog(row, [{ level: 'error', message: `observation : ${why}` }]);
    }
    await emitUpdated(row);
  }
  await notifyVerdict(fresh, site, verdict, action, detail);
}

async function closeSuperseded(row: ObservationRow, now: Date): Promise<void> {
  const facts = factsOf(row);
  const v = computeVerdict(facts, { final: true, elapsedMs: now.getTime() - new Date(row.started_at).getTime() });
  const n = await db('release_observations').where({ id: row.id, state: 'watching' }).update({
    state: 'superseded', verdict: v.provisional, reasons: JSON.stringify(v.reasons), finished_at: now, action: 'none', updated_at: db.fn.now(),
  });
  if (n) {
    await releaseLog(row, [{ level: 'info', message: `observation arrêtée : la release n'est plus en ligne (${verdictText(v.provisional)} jusque-là)` }]);
    await emitUpdated(row);
  }
}

async function observeOne(row: ObservationRow, now: Date): Promise<void> {
  // Counters since the last tick.
  const c = traffic.drain(row.site_id);
  if (c.requests > 0) {
    try {
      await db('release_observations').where({ id: row.id, state: 'watching' }).update({
        requests: db.raw('requests + ?', [c.requests]), errors_5xx: db.raw('errors_5xx + ?', [c.errors5xx]),
        upstream_errors: db.raw('upstream_errors + ?', [c.upstreamErrors]), updated_at: db.fn.now(),
      });
      row.requests = Number(row.requests) + c.requests;
      row.errors_5xx = Number(row.errors_5xx) + c.errors5xx;
      row.upstream_errors = Number(row.upstream_errors) + c.upstreamErrors;
    } catch (err) {
      traffic.restore(row.site_id, c);
      throw err;
    }
  }

  const site = await db('sites').where({ id: row.site_id, tenant_id: row.tenant_id })
    .first('id', 'tenant_id', 'account_id', 'name', 'status', 'healthcheck_path', 'current_release_id') as SiteState | undefined;
  if (!site || site.current_release_id !== row.release_id) {
    await closeSuperseded(row, now);
    traffic.unwatch(row.site_id);
    return;
  }

  // One health probe per minute while the site runs.
  const lastProbe = row.last_probe_at ? new Date(row.last_probe_at).getTime() : 0;
  if (site.status === 'active' && now.getTime() - lastProbe >= PROBE_EVERY_MS - 1000) {
    let r: { ok: boolean; error: string | null };
    try {
      r = await deps.probe(site);
    } catch (err) {
      r = { ok: false, error: (err as Error)?.message ?? String(err) };
    }
    row.probes = Number(row.probes) + 1;
    row.probe_failures = Number(row.probe_failures) + (r.ok ? 0 : 1);
    row.probe_consecutive = r.ok ? 0 : Number(row.probe_consecutive) + 1;
    row.last_probe_at = now;
    if (!r.ok) row.last_probe_error = (r.error ?? 'échec').slice(0, 300);
    await db('release_observations').where({ id: row.id }).update({
      probes: row.probes, probe_failures: row.probe_failures, probe_consecutive: row.probe_consecutive,
      last_probe_at: now, last_probe_error: row.last_probe_error, updated_at: db.fn.now(),
    });
  }

  try {
    const php = await phpFacts(row);
    if (php.groups !== Number(row.new_error_groups) || php.fatals !== Number(row.new_fatal_groups) || php.occurrences !== Number(row.new_error_occurrences)) {
      row.new_error_groups = php.groups;
      row.new_fatal_groups = php.fatals;
      row.new_error_occurrences = php.occurrences;
      await db('release_observations').where({ id: row.id }).update({
        new_error_groups: php.groups, new_fatal_groups: php.fatals, new_error_occurrences: php.occurrences, updated_at: db.fn.now(),
      });
    }
  } catch (err) {
    logger.warn({ err, releaseId: row.release_id }, 'Release observation: PHP errors not readable');
  }

  const started = new Date(row.started_at).getTime();
  const v = computeVerdict(factsOf(row), { final: now.getTime() >= new Date(row.ends_at).getTime(), elapsedMs: now.getTime() - started });
  if (v.decided) {
    traffic.unwatch(row.site_id);
    await finalize(row, site, v.decided, v.reasons, now);
  }
}

let ticking: Promise<void> | null = null;

async function tickOnce(now: Date): Promise<void> {
  const rows = await db('release_observations').where({ state: 'watching' }).orderBy('id') as ObservationRow[];
  const sites = new Set(rows.map((r) => r.site_id));
  for (const s of traffic.watchedSites()) if (!sites.has(s)) traffic.unwatch(s);
  for (const r of rows) traffic.watch(r.site_id, new Date(r.started_at).getTime());
  for (const row of rows) {
    try {
      await observeOne(row, now);
    } catch (err) {
      logger.warn({ err, releaseId: row.release_id }, 'Release observation: tick failed');
    }
  }
  traffic.prune(now.getTime());
}

let timer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;

export const releaseObservation = {
  /**
   * The pipeline put `releaseId` live (deploy, after sites.current_release_id moved). Starts its
   * observation unless the site's mode is off. previousReleaseId: the release it replaced. Returns the
   * line the pipeline writes in the release log (null: not observed). Never throws.
   */
  async onReleaseLive(input: { siteId: number; releaseId: number; previousReleaseId: number | null }, now: Date = new Date()): Promise<string | null> {
    try {
      const site = await db('sites').where({ id: input.siteId }).first('id', 'tenant_id', 'observation_mode', 'observation_window_minutes') as
        { id: number; tenant_id: number; observation_mode: string | null; observation_window_minutes: number | null } | undefined;
      if (!site || site.observation_mode === 'off') return null;
      const rel = await db('releases').where({ id: input.releaseId, site_id: input.siteId }).first('number', 'trigger') as
        { number: number; trigger: ReleaseTrigger } | undefined;
      if (!rel) return null;
      const prevId = input.previousReleaseId && input.previousReleaseId !== input.releaseId ? input.previousReleaseId : null;
      const prev = prevId ? await db('releases').where({ id: prevId, site_id: input.siteId }).first('id', 'number') as { id: number; number: number } | undefined : undefined;
      const mode = site.observation_mode === 'revert' ? 'revert' : 'alert';
      const windowMinutes = clampWindow(site.observation_window_minutes ?? OBSERVATION_WINDOW_DEFAULT_MINUTES);
      const t = now.getTime();
      const base = traffic.window(site.id, t - windowMinutes * MINUTE, t);
      const block: ObservationRevertBlock | null = ranMigrations(rel.trigger) ? 'migrations' : !prev ? 'noPrevious' : null;
      // An earlier observation of the site still running: its release is not live any more.
      const older = await db('release_observations').where({ site_id: site.id, state: 'watching' }).whereNot({ release_id: input.releaseId }) as ObservationRow[];
      for (const o of older) await closeSuperseded(o, now);
      const inserted = await db('release_observations').insert({
        tenant_id: site.tenant_id, site_id: site.id, release_id: input.releaseId, release_number: rel.number,
        previous_release_id: prev?.id ?? null, previous_release_number: prev?.number ?? null,
        mode, window_minutes: windowMinutes, state: 'watching', started_at: now, ends_at: new Date(t + windowMinutes * MINUTE),
        baseline: base.minutes > 0 ? JSON.stringify({ requests: base.requests, errors5xx: base.errors5xx, minutes: base.minutes }) : null,
        revert_blocked: block, reasons: JSON.stringify([]),
      }).onConflict('release_id').ignore().returning('id');
      if (!inserted.length) return null;
      traffic.watch(site.id, t);
      const what = mode === 'revert'
        ? (block === 'migrations' ? 'alerte seulement (migrations de base : pas de retour automatique)' : 'retour automatique si la release est en échec')
        : 'alerte';
      return `observation : ${windowMinutes} min, ${what}`;
    } catch (err) {
      logger.warn({ err, siteId: input.siteId, releaseId: input.releaseId }, 'Release observation: cannot start');
      return null;
    }
  },

  /** One pass over the running observations (worker every 30 s; tests call it with their clock). Never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (ticking) return ticking;
    ticking = tickOnce(now).catch((err) => { logger.warn({ err }, 'Release observation: pass failed'); }).finally(() => { ticking = null; });
    return ticking;
  },

  /** An edge access log entry (the worker's subscription; tests feed it directly). */
  ingest(entry: Parameters<SiteTraffic['add']>[0], now?: number): void {
    traffic.add(entry, now);
  },

  /** Boot: an automatic return cut by a restart is never retried (no loop): recorded as failed. */
  async recover(): Promise<void> {
    try {
      const rows = await db('release_observations').where({ action: 'reverting' }) as ObservationRow[];
      for (const r of rows) {
        await db('release_observations').where({ id: r.id, action: 'reverting' })
          .update({ action: 'revertFailed', action_reason: 'retour automatique interrompu par un redémarrage du panel', updated_at: db.fn.now() });
        await releaseLog(r, [{ level: 'error', message: 'observation : retour automatique interrompu par un redémarrage du panel' }]);
      }
    } catch (err) {
      logger.warn({ err }, 'Release observation: recovery failed');
    }
  },

  /** Resolves once the release has no running observation (or at the deadline / abort). */
  async waitForVerdict(siteId: number, releaseId: number, deadline: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const row = await db('release_observations').where({ site_id: siteId, release_id: releaseId }).first('state') as { state: string } | undefined;
      if (!row || row.state !== 'watching' || Date.now() >= deadline || signal?.aborted) return;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
    }
  },

  /** Worker 'release-observation': edge log subscription + a pass every 30 s. Never throws. */
  start(): void {
    if (timer) return;
    void releaseObservation.recover();
    try {
      unsubscribe = subscribeEdgeLog((e) => traffic.add(e));
    } catch (err) {
      logger.warn({ err }, 'Release observation: edge log subscription failed');
    }
    timer = setInterval(() => { void releaseObservation.tick(); }, OBSERVE_TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    try { unsubscribe?.(); } catch { /* stopping */ }
    unsubscribe = null;
  },

  /** Tests. */
  traffic,
};
