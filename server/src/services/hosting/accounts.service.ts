import type { Request } from 'express';
import type { HostingAccount, HostingAccountStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { AccountCreateBody, AccountUpdateBody } from '../../validators/hosting.schema';
import { auditService } from '../audit.service';
import { fileServerService } from '../docker/filesrv.service';
import { reconcileService, type AccountSnapshot, type SiteSnapshot } from '../docker/reconcile.service';
import { certificateService } from '../edge/certificate.service';
import { edgeService } from '../edge/edge.service';
import { releaseService } from '../releases/release.service';
import { assertNeedSomewhere, assertStaff, loadAccount, scopeToActor, type HostingActor } from './access';
import { allocationService, withAllocationRetry } from './allocation.service';
import { clientUsersService } from './clientUsers.service';
import { envelopeService, lockTenant, withTenantLock } from './envelope.service';
import { emitHosting } from './events';
import { isUniqueViolation } from './hostingValidation.service';
import { plansService } from './plans.service';
import { planLimits, toHostingAccount, type AccountRow } from './rows';
import { forActor } from './statusMessage';
import { usageService } from './usage.service';

// ─────────────────────────────────────────────────────────────────────────────
// Hosting accounts (≈ cPanel account): one plan, one uid/gid, one quota, one
// network, one file server. Docker / hostd work is delegated to the reconcile
// (module orchestration): the API only writes the desired state and queues.
// ─────────────────────────────────────────────────────────────────────────────

const STATUSES: readonly HostingAccountStatus[] = ['provisioning', 'active', 'suspended', 'error', 'deleting'];

/** Accounts with the joins toHostingAccount needs (tenant, plan, counts). */
export function selectAccounts() {
  return db('hosting_accounts as a')
    .join('tenants as t', 't.id', 'a.tenant_id')
    .join('plans as p', 'p.id', 'a.plan_id')
    .select('a.*', 't.name as tenant_name', 'p.name as plan_name', 'p.limits as plan_limits',
      db.raw('(SELECT COUNT(*) FROM sites s WHERE s.account_id = a.id) AS site_count'),
      db.raw('(SELECT COUNT(*) FROM domains d WHERE d.account_id = a.id) AS domain_count'));
}

/** One account mapped with its joins (after an access check by the caller). */
export async function fetchAccount(accountId: number): Promise<HostingAccount> {
  const row = await selectAccounts().where('a.id', accountId).first() as AccountRow | undefined;
  if (!row) throw new AppError(404, 'Account not found', 'notFound');
  return toHostingAccount(row);
}

/**
 * 502 backendUnavailable for a Docker / hostd failure. The raw error (socket
 * paths, host paths under /srv/oblimint, daemon messages) is logged and only
 * appended for STAFF callers: a client user gets `what` alone.
 */
export function backendUnavailable(err: unknown, what: string, actor?: HostingActor): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn({ err }, what);
  return new AppError(502, actor?.kind === 'staff' ? `${what}: ${msg}` : what, 'backendUnavailable');
}

/**
 * status_message stored after a failed deletion. Every member of the account
 * sees it (client users included): no backend detail, which goes to the audit
 * log (details.error) and the server log instead.
 */
export const DELETION_FAILED_MESSAGE = "La suppression a échoué : les ressources de l'hôte n'ont pas pu être retirées (détails dans le journal d'audit). Relancez la suppression.";

export function accountDeleting(): AppError {
  return new AppError(409, 'The account is being deleted', 'accountDeleting');
}

/**
 * Account deletions running in THIS process (the panel is a single process).
 * A second DELETE of the same account while one runs → 409 accountDeleting.
 * An account found in 'deleting' with no deletion in flight was interrupted
 * (crash / restart between the host teardown and the row DELETE): a new
 * DELETE is then allowed and finishes it (destroyAccount with purge is
 * idempotent). Meanwhile the reconcile skips it and the envelope excludes it.
 */
const accountDeletionsInFlight = new Set<number>();

function emitAccount(account: { id: number; tenant_id: number }, action: 'created' | 'updated' | 'deleted'): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: account.id, accountId: account.id, action },
    { tenantId: account.tenant_id, accountId: account.id });
}

function usernameTaken(): AppError {
  return new AppError(409, 'This account name is already taken', 'usernameTaken');
}

/** Sites of an account as reconcile snapshots (taken BEFORE deleting rows). */
export async function siteSnapshots(account: Pick<AccountRow, 'id' | 'node_id' | 'uid' | 'gid'>, siteIds?: number[]): Promise<SiteSnapshot[]> {
  const q = db('sites').where({ account_id: account.id }).select('id', 'slug');
  if (siteIds) q.whereIn('id', siteIds);
  const sites = await q as Array<{ id: number; slug: string }>;
  if (sites.length === 0) return [];
  const runtimes = await db('site_runtimes').whereIn('site_id', sites.map((s) => s.id)).select('id', 'site_id') as Array<{ id: number; site_id: number }>;
  return sites.map((s) => ({
    id: s.id,
    accountId: account.id,
    nodeId: account.node_id,
    slug: s.slug,
    uid: account.uid,
    gid: account.gid,
    runtimeIds: runtimes.filter((r) => r.site_id === s.id).map((r) => r.id),
  }));
}

function scheduleEdgeSync(reason: string): void {
  try { edgeService.scheduleSync(reason); } catch (err) { logger.warn({ err, reason }, 'edgeService.scheduleSync failed'); }
}

function requestAccount(accountId: number, reason: string): void {
  try { reconcileService.requestAccount(accountId, reason); } catch (err) { logger.warn({ err, accountId, reason }, 'reconcileService.requestAccount failed'); }
}

async function applyFileServerMode(accountId: number): Promise<void> {
  try { await fileServerService.applyMode(accountId); } catch (err) { logger.warn({ err, accountId }, 'fileServerService.applyMode failed (the reconcile will retry)'); }
}

async function localNodeId(): Promise<number> {
  const node = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
  if (!node) throw new AppError(409, 'No local node is registered', 'noNode');
  return node.id;
}

export const accountsService = {
  async list(actor: HostingActor, filters: { search?: string; status?: string; tenantId?: number | null }): Promise<HostingAccount[]> {
    // Staff: 'read' needs a hosting capability or overview.read (§8), as for
    // GET /accounts/:id. Clients are already scoped to their own accounts.
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = selectAccounts();
    scopeToActor(actor, q, { tenant: 'a.tenant_id', account: 'a.id' }, filters.tenantId ?? null);
    const search = filters.search?.trim();
    if (search) {
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      q.where((b) => { b.where('a.username', 'ilike', like).orWhere('a.display_name', 'ilike', like); });
    }
    if (filters.status && (STATUSES as readonly string[]).includes(filters.status)) q.where('a.status', filters.status);
    return (await q.orderBy('a.username') as AccountRow[]).map((r) => forActor(actor, toHostingAccount(r)));
  },

  async get(actor: HostingActor, accountId: number): Promise<HostingAccount> {
    await loadAccount(actor, accountId, 'read');
    return forActor(actor, await fetchAccount(accountId));
  },

  /** POST /accounts — staff with accounts.manage, in the caller's current tenant. */
  async create(req: Request, actor: HostingActor, body: AccountCreateBody): Promise<HostingAccount> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'accounts.manage');
    const tenantId = actor.tenantId;
    if (await db('hosting_accounts').where({ username: body.username }).first('id')) throw usernameTaken();
    const plan = await plansService.rowInTenant(body.planId, tenantId);
    if (!plan.is_active) throw new AppError(400, 'This plan is inactive', 'planInactive');
    await envelopeService.assertAccountFits(tenantId, planLimits(plan.limits));
    let nodeId: number;
    if (body.nodeId) {
      if (!(await db('nodes').where({ id: body.nodeId }).first('id'))) throw new AppError(400, 'Unknown node', 'unknownNode');
      nodeId = body.nodeId;
    } else nodeId = await localNodeId();
    const owner = body.owner ?? null;
    if (owner) await clientUsersService.assertCreatable(owner);

    let created: { id: number; ownerId: number | null };
    try {
      created = await withAllocationRetry(() => db.transaction(async (trx) => {
        // Authoritative envelope check (maxAccounts, summed plan limits) under
        // the tenant lock: concurrent creations are serialised. The check above
        // only answers early.
        await lockTenant(trx, tenantId);
        await envelopeService.assertAccountFits(tenantId, planLimits(plan.limits), trx);
        const uid = await allocationService.nextUid(trx);
        const port = await allocationService.nextFileServerPort(nodeId, trx);
        const [row] = await trx('hosting_accounts').insert({
          tenant_id: tenantId,
          node_id: nodeId,
          plan_id: plan.id,
          username: body.username,
          display_name: body.displayName ?? null,
          status: 'provisioning',
          uid,
          gid: uid,
          filesrv_port: port,
        }).returning('id') as Array<{ id: number }>;
        const ownerId = owner ? await clientUsersService.createInTrx(trx, { id: row.id, tenant_id: tenantId }, owner) : null;
        return { id: row.id, ownerId };
      }));
    } catch (err) {
      if (isUniqueViolation(err) && await db('hosting_accounts').where({ username: body.username }).first('id')) throw usernameTaken();
      throw err;
    }

    await auditService.logReqAs(req, tenantId, 'account.create', {
      resourceType: 'account', resourcePath: String(created.id),
      details: { username: body.username, planId: plan.id, plan: plan.name, nodeId, ownerUserId: created.ownerId },
    });
    emitAccount({ id: created.id, tenant_id: tenantId }, 'created');
    requestAccount(created.id, 'created');
    return fetchAccount(created.id);
  },

  async update(req: Request, actor: HostingActor, accountId: number, body: AccountUpdateBody): Promise<HostingAccount> {
    const row = await loadAccount(actor, accountId, 'accounts.manage');
    if (row.status === 'deleting') throw accountDeleting();
    const patch: Record<string, unknown> = {};
    const details: Record<string, unknown> = { username: row.username };
    if (body.displayName !== undefined && body.displayName !== row.display_name) {
      patch.display_name = body.displayName;
      details.displayName = body.displayName;
    }
    let planChanged = false;
    if (body.planId !== undefined && body.planId !== row.plan_id) {
      // Same tenant as the ACCOUNT (the composite FK enforces it too).
      const plan = await plansService.rowInTenant(body.planId, row.tenant_id);
      if (!plan.is_active) throw new AppError(400, 'This plan is inactive', 'planInactive');
      await envelopeService.assertPlanChangeFits(row.tenant_id, row.id, planLimits(plan.limits));
      patch.plan_id = plan.id;
      details.fromPlanId = row.plan_id;
      details.toPlanId = plan.id;
      planChanged = true;
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = db.fn.now();
      // The plan change is re-checked under the tenant lock (the check above
      // only answers early), and nothing is written once a deletion started.
      const nextPlanId = planChanged ? Number(patch.plan_id) : null;
      const updated = await withTenantLock(row.tenant_id, async (trx) => {
        if (nextPlanId !== null) {
          const plan = await trx('plans').where({ id: nextPlanId, tenant_id: row.tenant_id }).first('limits') as { limits: unknown } | undefined;
          if (!plan) throw new AppError(404, 'Plan not found', 'notFound');
          await envelopeService.assertPlanChangeFits(row.tenant_id, row.id, planLimits(plan.limits), trx);
        }
        return trx('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id }).whereNot('status', 'deleting').update(patch);
      });
      if (!updated) throw accountDeleting();
      await auditService.logReqAs(req, row.tenant_id, 'account.update', { resourceType: 'account', resourcePath: String(row.id), details });
      emitAccount(row, 'updated');
      // New quota / limits / bases: the reconcile applies them.
      if (planChanged) requestAccount(row.id, 'plan-changed');
    }
    return fetchAccount(row.id);
  },

  async setSuspended(req: Request, actor: HostingActor, accountId: number, suspended: boolean): Promise<HostingAccount> {
    const row = await loadAccount(actor, accountId, 'accounts.manage');
    if (row.status === 'deleting') throw accountDeleting();
    const target: HostingAccountStatus = suspended ? 'suspended' : 'active';
    if (suspended ? row.status !== 'suspended' : row.status === 'suspended') {
      const updated = await db('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id }).whereNot('status', 'deleting')
        .update({ status: target, status_message: null, updated_at: db.fn.now() });
      if (!updated) throw accountDeleting();
      await auditService.logReqAs(req, row.tenant_id, suspended ? 'account.suspend' : 'account.unsuspend', {
        resourceType: 'account', resourcePath: String(row.id), details: { username: row.username },
      });
      emitAccount(row, 'updated');
      requestAccount(row.id, suspended ? 'suspended' : 'unsuspended');
      scheduleEdgeSync(suspended ? `account ${row.id} suspended` : `account ${row.id} unsuspended`);
      await applyFileServerMode(row.id);
    }
    return fetchAccount(row.id);
  },

  /** POST /accounts/:id/usage/refresh — hostd measurement now (502 when hostd is unreachable). */
  async refreshUsage(actor: HostingActor, accountId: number): Promise<HostingAccount> {
    const row = await loadAccount(actor, accountId, 'read');
    try {
      await usageService.refresh(row.id);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw backendUnavailable(err, 'Disk usage unavailable', actor);
    }
    return forActor(actor, await fetchAccount(row.id));
  },

  /**
   * DELETE /accounts/:id {confirm: username}. Docker / hostd teardown first
   * (reconcileService.destroyAccount, purge): on failure the rows are KEPT
   * (status 'error') so the deletion can be retried. Then the rows (cascade),
   * the client users left without any account, an edge sync.
   */
  async remove(req: Request, actor: HostingActor, accountId: number, confirm: unknown): Promise<void> {
    const row = await loadAccount(actor, accountId, 'accounts.manage');
    if (confirm !== row.username) throw new AppError(400, 'Type the account name to confirm the deletion', 'confirmMismatch');
    if (accountDeletionsInFlight.has(row.id)) throw accountDeleting();
    accountDeletionsInFlight.add(row.id);
    try {
      await removeAccount(req, actor, row);
    } finally {
      accountDeletionsInFlight.delete(row.id);
    }
  },
};

async function removeAccount(req: Request, actor: HostingActor, row: AccountRow): Promise<void> {
  // Under the tenant lock: a site / domain creation of this account either
  // committed before (its rows are in the snapshot below) or sees 'deleting'.
  await withTenantLock(row.tenant_id, (trx) => trx('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id })
    .update({ status: 'deleting', status_message: null, updated_at: db.fn.now() }));
  emitAccount(row, 'updated');

  const snapshot: AccountSnapshot = { id: row.id, nodeId: row.node_id, uid: row.uid, gid: row.gid, sites: await siteSnapshots(row) };
  // No publication / rollback of its sites may run during the teardown (it
  // would recreate accounts/<a>/sites/<id>/ behind the purge). One running →
  // 409 publishInProgress and the account gets its status back.
  let unlock: () => void;
  try {
    unlock = await releaseService.lockForTeardown(snapshot.sites.map((s) => s.id));
  } catch (err) {
    const back: HostingAccountStatus = row.status === 'deleting' ? 'error' : row.status;
    await db('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id, status: 'deleting' })
      .update({ status: back, updated_at: db.fn.now() });
    emitAccount(row, 'updated');
    throw err;
  }
  let domainIds: number[];
  try {
    try {
      await reconcileService.destroyAccount(snapshot, { purge: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id })
        .update({ status: 'error', status_message: DELETION_FAILED_MESSAGE, updated_at: db.fn.now() });
      await auditService.logReqAs(req, row.tenant_id, 'account.delete_failed', {
        resourceType: 'account', resourcePath: String(row.id), details: { username: row.username, error: message.slice(0, 500) },
      });
      emitAccount(row, 'updated');
      throw backendUnavailable(err, 'The account could not be removed from the host', actor);
    }

    // Certificates (rows + files) only once the teardown succeeded: a failed
    // one puts the account back in 'error', which the edge still serves — with
    // its certificates.
    domainIds = await db('domains').where({ account_id: row.id }).pluck('id') as number[];
    for (const domainId of domainIds) {
      try { await certificateService.removeForDomain(domainId); } catch (err) { logger.warn({ err, domainId }, 'certificateService.removeForDomain failed'); }
    }
  } finally {
    unlock();
  }

  const userIds = await db('account_users').where({ account_id: row.id }).pluck('user_id') as number[];
  await db('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id }).del();
  const deletedUsers = await clientUsersService.deleteOrphans(userIds);
  scheduleEdgeSync(`account ${row.id} deleted`);
  await auditService.logReqAs(req, row.tenant_id, 'account.delete', {
    resourceType: 'account', resourcePath: String(row.id),
    details: { username: row.username, sites: snapshot.sites.length, domains: domainIds.length, deletedClientUsers: deletedUsers },
  });
  emitAccount(row, 'deleted');
}
