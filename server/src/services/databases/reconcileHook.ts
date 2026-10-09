import type { AccountPassContext, AccountPassHook } from '../docker/extensions';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { inspectContainer, isUnreachable, labelHash } from '../docker/dockerOps';
import { specHashLabel } from '../docker/specs';
import { dbInstanceContainer } from '../hosting/naming';
import { dbFamilyOf } from '@oblimint/shared';
import { accountRuns, instanceSpec, instanceWanted, isInstanceBusy, requestConverge, rootPassword, syncDefaultSocket } from './instances';
import type { DbInstanceRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Databases ↔ account reconcile (module databases, docs/P2-PLAN.md §7).
// Called once per reconcile pass of an account, INSIDE the account lock
// (never call withAccountLock / reconcileAccountNow from here). Converges the
// account's db_instances: container created / started when the account runs
// (active / provisioning / error) and the instance is not stopped by the
// user; stopped (never removed) when the account is suspended; hostd dirs are
// ensured by the converge, the default-socket links here (every pass). An
// account whose deletion failed never gets a MISSING container recreated
// (its data may already be purged: the deletion is retried instead).
//
// Must return quickly: this pass only OBSERVES (one inspect per instance)
// and queues a converge (instances.ts requestConverge → account lock, i.e.
// right after this pass) for every instance that is not already in its
// desired state — the converge may pull an image or wait for a first
// initialisation (minutes), which must never hold the pass.
//
// Instances stuck in 'deleting' (failed purge, panel restarted mid-deletion)
// are NEVER converged: their deletion is resumed instead (queued: it needs
// the account lock this pass holds), so the container cannot outlive the
// request, keep its published port or be re-initialised on purged data.
// ─────────────────────────────────────────────────────────────────────────────

export const databaseReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    const account = ctx.state.account;
    const all = await db('db_instances').where({ account_id: account.id }).orderBy('id') as DbInstanceRow[];
    const rows = all.filter((r) => r.status !== 'deleting');
    const stuck = all.filter((r) => r.status === 'deleting' && !isInstanceBusy(r.id));
    if (stuck.length) {
      void import('./databases.service')
        .then((m) => { for (const r of stuck) void m.requestInstanceDeletionRetry(r.id); })
        .catch((err) => logger.warn({ accountId: account.id, err: errText(err) }, 'DB instance deletion retry not queued'));
    }
    // A failed account deletion leaves the account in 'error' (still a running
    // status) after hostd may already have purged its tree: never initialise a
    // fresh, empty instance in place of a purged one — the deletion is retried.
    let deletionFailed = false;
    if (rows.length && account.status === 'error' && account.status_message) {
      try {
        deletionFailed = account.status_message === (await import('../hosting/accounts.service')).DELETION_FAILED_MESSAGE;
      } catch { /* unknown: converge as usual */ }
    }
    for (const row of rows) {
      try {
        const info = await inspectContainer(ctx.docker, dbInstanceContainer(row.id));
        if (!info && deletionFailed) continue;
        const running = !!info?.State?.Running;
        if (!instanceWanted(row, account)) {
          if (running) requestConverge(row.id, account.id, 'reconcile-stop');
          continue;
        }
        let drift = !info;
        if (info) {
          try {
            drift = labelHash(info.Config?.Labels) !== specHashLabel(instanceSpec(row, account, rootPassword(row)));
          } catch {
            drift = true; // unreadable secret: the converge reports it
          }
        }
        if (drift || !running || row.status !== 'running') requestConverge(row.id, account.id, 'reconcile');
      } catch (err) {
        if (isUnreachable(err)) return;
        logger.warn({ instanceId: row.id, accountId: account.id, err: errText(err) }, 'DB instance observe failed');
      }
    }
    // Default-socket links (hostd, idempotent, one call per family in use): a
    // dbsock/<family> dir recreated by hostd ensureAccount gets its link back.
    if (!accountRuns(account.status)) return;
    const families = new Set(rows.map((r) => dbFamilyOf(r.engine)));
    for (const family of families) {
      try {
        await syncDefaultSocket(account.node_id, account.id, family);
      } catch (err) {
        logger.warn({ accountId: account.id, family, err: errText(err) }, 'DB default socket link not ensured');
      }
    }
  },
};
