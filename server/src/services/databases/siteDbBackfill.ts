import type { DbEngine, DbSiteRole } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { siteEnvFor } from '../hosting/siteEnv.service';
import { siteInstanceReasons } from '../network/defaultLinks';
import { envReferences } from '../previews/previewDbClone';
import { errText } from '../setup/docker';
import { syncDatabaseLinks } from './linkSync';

// ─────────────────────────────────────────────────────────────────────────────
// One-shot backfill of the database owners (migration 030 sets app_config
// site_databases_backfill = 'pending'; the boot of the databases worker runs
// it once). The sites' environment variables (sealed: opened here, never
// logged) name their databases — DB_NAME, DB_DATABASE, DATABASE_NAME,
// MYSQL_DATABASE, WORDPRESS_DB_NAME, PGDATABASE, POSTGRES_DB, <prefix>NAME,
// DATABASE_URL / mysql:// postgres:// URLs… (previews/previewDbClone.ts
// envReferences, the same reading as the preview database clone) — matched
// against the databases of the SAME account:
//   - one site names a database   → that site owns it;
//   - several sites name it        → the first by id owns it, the others share it;
//   - a name matching several databases of the account for one site (two
//     instances, no host to tell them apart) → ambiguous, ignored;
//   - nothing matches               → the database stays shared across the account.
// Never breaks anything: every site keeps every default link it has (the links
// the new rule would disable are PINNED, matched site or not), and a database
// already attached is left alone. Audited per account (db.database.backfill).
// ─────────────────────────────────────────────────────────────────────────────

export const BACKFILL_KEY = 'site_databases_backfill';

export interface BackfillAttachment { siteId: number; databaseId: number; role: DbSiteRole }

/**
 * The attachments to create (pure). `refs`: per site, the databases its
 * environment names; `databases`: the account's (id, name); `attached`: the
 * databases already attached (left alone).
 */
export function backfillAttachments(
  refs: ReadonlyMap<number, readonly number[]>,
  databases: ReadonlyArray<{ id: number; name: string }>,
  attached: ReadonlySet<number> = new Set(),
): BackfillAttachment[] {
  const nameOf = new Map(databases.map((d) => [Number(d.id), d.name.toLowerCase()]));
  const sitesOf = new Map<number, number[]>();
  for (const [siteId, ids] of [...refs.entries()].sort((a, b) => a[0] - b[0])) {
    // A name that designates several databases for this site is ambiguous: none of them.
    const byName = new Map<string, number[]>();
    for (const id of new Set(ids.map(Number))) {
      const n = nameOf.get(id);
      if (n === undefined) continue;
      byName.set(n, [...(byName.get(n) ?? []), id]);
    }
    for (const list of byName.values()) {
      if (list.length !== 1) continue;
      const dbId = list[0];
      sitesOf.set(dbId, [...(sitesOf.get(dbId) ?? []), Number(siteId)]);
    }
  }
  const out: BackfillAttachment[] = [];
  for (const [databaseId, sites] of [...sitesOf.entries()].sort((a, b) => a[0] - b[0])) {
    if (attached.has(databaseId)) continue;
    const sorted = [...new Set(sites)].sort((a, b) => a - b);
    sorted.forEach((siteId, i) => out.push({ siteId, databaseId, role: i === 0 ? 'owner' : 'shared' }));
  }
  return out;
}

interface AccountOutcome { attached: number; pinned: number }

async function backfillAccount(accountId: number, tenantId: number): Promise<AccountOutcome> {
  const [sites, instances, databases, users, existing] = await Promise.all([
    db('sites').where({ account_id: accountId }).orderBy('id').select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
    db('db_instances').where({ account_id: accountId }).select('id', 'engine', 'is_default') as Promise<Array<{ id: number; engine: DbEngine; is_default: boolean }>>,
    db('db_databases').where({ account_id: accountId }).select('id', 'name', 'instance_id') as Promise<Array<{ id: number; name: string; instance_id: number }>>,
    db('db_users').where({ account_id: accountId }).select('instance_id', 'username') as Promise<Array<{ instance_id: number; username: string }>>,
    db('site_databases').where({ account_id: accountId }).select('site_id', 'database_id', 'role') as Promise<Array<{ site_id: number; database_id: number; role: DbSiteRole }>>,
  ]);
  if (!sites.length || !databases.length) return { attached: 0, pinned: 0 };
  const env = await siteEnvFor(sites.map((s) => Number(s.id)));
  const lite = {
    instances: instances.map((i) => ({ id: Number(i.id), engine: i.engine, isDefault: !!i.is_default })),
    databases: databases.map((d) => ({ id: Number(d.id), name: d.name, instanceId: Number(d.instance_id) })),
    users: users.map((u) => ({ instanceId: Number(u.instance_id), username: u.username })),
  };
  const refs = new Map<number, number[]>();
  for (const s of sites) {
    const vars = (env.get(Number(s.id)) ?? []).map(([name, value]) => ({ name, value, secret: false }));
    if (!vars.length) continue;
    const ids = envReferences(vars, lite.instances, lite.databases, lite.users).databaseIds;
    if (ids.length) refs.set(Number(s.id), ids);
  }
  const plan = backfillAttachments(refs, lite.databases, new Set(existing.map((e) => Number(e.database_id))));

  // Every site keeps every link it has today, matched or not: a site may also
  // reach an instance through settings outside its environment (a config file
  // of the release), which the backfill cannot see.
  const after = [...existing.map((e) => ({ siteId: Number(e.site_id), databaseId: Number(e.database_id), role: e.role })), ...plan];
  const reason = siteInstanceReasons({ databases: lite.databases, attachments: after });
  const toPin: Array<{ siteId: number; instanceId: number }> = [];
  for (const s of sites) {
    for (const i of lite.instances) if (!reason(Number(s.id), i.id)) toPin.push({ siteId: Number(s.id), instanceId: i.id });
  }

  let pinned = 0;
  let attached = 0;
  await db.transaction(async (trx) => {
    if (plan.length) {
      const rows = plan.map((p) => ({ tenant_id: tenantId, account_id: accountId, site_id: p.siteId, database_id: p.databaseId, role: p.role, created_by: null }));
      attached = (await trx('site_databases').insert(rows).onConflict().ignore().returning('site_id')).length;
    }
    for (const p of toPin) {
      pinned += await trx('network_links')
        .where({ account_id: accountId, source_kind: 'site', source_id: p.siteId, target_kind: 'db', target_id: p.instanceId, origin: 'migration', pinned: false, enabled: true })
        .update({ pinned: true });
    }
  });
  if (attached || pinned) {
    const siteName = new Map(sites.map((s) => [Number(s.id), s.name]));
    const dbName = new Map(lite.databases.map((d) => [d.id, d.name]));
    await auditService.log({
      tenantId, action: 'db.database.backfill', resourceType: 'account', resourcePath: String(accountId),
      details: {
        accountId,
        attached: plan.map((p) => ({ databaseId: p.databaseId, database: dbName.get(p.databaseId), siteId: p.siteId, site: siteName.get(p.siteId), role: p.role })),
        pinnedLinks: pinned,
      },
    });
    await syncDatabaseLinks(accountId, 'backfill');
  }
  return { attached, pinned };
}

let running: Promise<void> | null = null;

/**
 * What the stored state asks for (pure): 'pending' / 'running' (interrupted)
 * → every account; 'retry <id>,<id>' → only the accounts that failed last
 * time (never the others again: what the users changed since is theirs);
 * anything else ('done …') → nothing.
 */
export function backfillScope(state: string | null): { all: true } | { accountIds: number[] } | null {
  if (state === 'pending' || state === 'running') return { all: true };
  const m = /^retry ([0-9,]+)$/.exec(state ?? '');
  if (!m) return null;
  const ids = [...new Set(m[1].split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length ? { accountIds: ids } : null;
}

/** The state stored after a run: done, or the accounts to retry at the next boot. */
export function backfillStateAfter(failedAccountIds: readonly number[], now = new Date()): string {
  return failedAccountIds.length ? `retry ${[...new Set(failedAccountIds)].sort((a, b) => a - b).join(',')}` : `done ${now.toISOString()}`;
}

/**
 * Runs the backfill when migration 030 asked for it (and resumes an interrupted
 * run: every step is idempotent). Never throws; per-account failures are
 * logged, skipped and retried (those accounts only) at the next boot.
 */
export function runSiteDatabasesBackfill(): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      const state = (await db('app_config').where({ key: BACKFILL_KEY }).first('value') as { value: string | null } | undefined)?.value ?? null;
      const scope = backfillScope(state);
      if (!scope) return;
      // A retry keeps its list until it is done (an interrupted retry retries the same accounts).
      if ('all' in scope) await db('app_config').where({ key: BACKFILL_KEY }).update({ value: 'running' });
      const q = db('hosting_accounts').whereNot('status', 'deleting').orderBy('id');
      if ('accountIds' in scope) q.whereIn('id', scope.accountIds);
      const accounts = await q.select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
      let attached = 0;
      let pinned = 0;
      const failed: number[] = [];
      for (const a of accounts) {
        try {
          const r = await backfillAccount(Number(a.id), Number(a.tenant_id));
          attached += r.attached;
          pinned += r.pinned;
        } catch (err) {
          failed.push(Number(a.id));
          logger.warn({ accountId: a.id, err: errText(err) }, 'databases: owner backfill failed for an account (left shared across the account, retried at the next boot)');
        }
      }
      await db('app_config').where({ key: BACKFILL_KEY }).update({ value: backfillStateAfter(failed) });
      logger.info({ accounts: accounts.length, attached, pinned, failed: failed.length },'databases: owner sites backfilled from the site environments');
    } catch (err) {
      logger.warn({ err: errText(err) }, 'databases: owner backfill not run (retried at the next boot)');
    } finally {
      running = null;
    }
  })();
  return running;
}
