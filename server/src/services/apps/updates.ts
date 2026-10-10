import type { AppUpdateCheck } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { parseImageRef, registryAllowed } from './compose/image';
import { appsDeps } from './deps';
import { isStackBusy, startAction } from './deployments';
import { appPolicyService } from './policy.service';
import { remoteDigest, RegistryCheckError } from './registryClient';
import { stackRegistryAuths } from './registry.service';
import { updatePolicyOf, type ServiceRow, type StackRow } from './rows';

// Image update detection and automatic application (docs/P4b-PLAN.md §5.5): the registry digest of each
// service's tag is compared with the digest the service runs (pinned at deploy); app.updateAvailable is
// notified once per digest; auto-updates only run inside the stack's maintenance window.

export async function checkStackUpdates(stack: StackRow, opts: { notify: boolean }): Promise<AppUpdateCheck> {
  const deps = appsDeps();
  const rows = await db('app_services').where({ stack_id: stack.id }).orderBy('name') as ServiceRow[];
  const auths = await stackRegistryAuths(stack.id);
  const policy = await appPolicyService.effective(stack.tenant_id);
  const updatePolicy = updatePolicyOf(stack);
  const out: AppUpdateCheck = { stackId: stack.id, checkedAt: new Date(deps.now()).toISOString(), services: [] };
  for (const row of rows) {
    const entry = { service: row.name, image: row.image, currentDigest: row.current_digest, latestDigest: row.latest_digest, updateAvailable: false, error: null as string | null };
    out.services.push(entry);
    const ref = row.image ? parseImageRef(row.image) : null;
    if (!ref || row.image!.startsWith('oblimint-build/')) { entry.error = row.image?.startsWith('oblimint-build/') ? null : 'image inconnue'; continue; }
    if (ref.digest && !ref.tag) continue; // pinned by the user: nothing to follow
    if (!registryAllowed(ref.registry, policy.allowedRegistries)) { entry.error = 'registre non autorisé'; continue; }
    let latest: string | null = null;
    let error: string | null = null;
    try {
      const auth = auths.get(ref.registry);
      latest = await remoteDigest({ ref, auth: auth ? { username: auth.username, password: auth.password } : null, fetch: deps.fetch });
    } catch (err) {
      error = err instanceof RegistryCheckError ? (err.auth ? 'accès refusé par le registre' : err.message) : `registre injoignable (${errText(err).slice(0, 120)})`;
    }
    entry.latestDigest = latest ?? row.latest_digest;
    entry.error = error;
    entry.updateAvailable = !!entry.latestDigest && !!row.current_digest && entry.latestDigest !== row.current_digest;
    const patch: Record<string, unknown> = { checked_at: db.fn.now(), check_error: error, updated_at: db.fn.now() };
    if (latest) patch.latest_digest = latest;
    if (entry.updateAvailable && opts.notify && updatePolicy.notify && !row.excluded_from_updates && row.notified_digest !== entry.latestDigest) {
      patch.notified_digest = entry.latestDigest;
      deps.notify('app.updateAvailable', {
        tenantId: stack.tenant_id, accountId: stack.account_id, key: `app.updateAvailable:${stack.id}:${row.name}:${entry.latestDigest}`,
        title: `Mise à jour disponible pour ${stack.display_name}`,
        message: `Une nouvelle image est disponible pour le service ${row.name} (${row.image}).`, severity: 'info', link: `/apps/${stack.id}?tab=updates`,
      });
    }
    await db('app_services').where({ id: row.id }).update(patch);
  }
  await db('app_stacks').where({ id: stack.id }).update({ last_update_check_at: db.fn.now() });
  return out;
}

/**
 * A service the automatic pass may update: a newer digest is known and it is not the digest the service left.
 * After a manual image rollback (POST …/updates/rollback) previous_digest holds the digest the user rolled back
 * from; while the registry still serves that digest the auto-update must not re-apply it (the rollback sticks).
 * A newer digest (latest ≠ previous) is auto-applied again; a manual update can still apply the skipped one.
 */
export function autoUpdatable(r: Pick<ServiceRow, 'current_digest' | 'latest_digest' | 'previous_digest' | 'image'>): boolean {
  if (!r.current_digest || !r.latest_digest || r.latest_digest === r.current_digest) return false;
  if (r.image?.startsWith('oblimint-build/')) return false;
  return r.latest_digest !== r.previous_digest;
}

/** Stacks whose check interval elapsed: check, then auto-update inside the maintenance window. Never throws. */
export async function runUpdatePass(minMinutes: number): Promise<void> {
  const deps = appsDeps();
  let stacks: StackRow[];
  try {
    stacks = await db('app_stacks as s').join('hosting_accounts as a', 'a.id', 's.account_id')
      .where('a.status', 'active').whereNotIn('s.status', ['draft', 'deleting', 'deploying'])
      .select('s.*') as StackRow[];
  } catch (err) {
    logger.warn({ err: errText(err) }, 'apps: update pass skipped');
    return;
  }
  const now = deps.now();
  for (const stack of stacks) {
    try {
      const policy = updatePolicyOf(stack);
      const every = Math.max(minMinutes, policy.checkIntervalMin) * 60_000;
      const last = stack.last_update_check_at ? new Date(stack.last_update_check_at).getTime() : 0;
      if (now - last >= every) await checkStackUpdates(stack, { notify: true });
      if (!policy.autoUpdate || isStackBusy(stack.id)) continue;
      // Pending updates (detected now or by an earlier check while the window was closed).
      const rows = await db('app_services').where({ stack_id: stack.id, excluded_from_updates: false }).whereNotNull('latest_digest') as ServiceRow[];
      const services = rows.filter(autoUpdatable).map((r) => r.name);
      if (!services.length) continue;
      // A failed (rolled back) auto-update is retried after the next digest check only, never in a loop.
      const lastAuto = await db('app_deployments').where({ stack_id: stack.id, action: 'update', trigger: 'auto-update' }).orderBy('id', 'desc')
        .first('status', 'created_at') as { status: string; created_at: Date | string } | undefined;
      const checkedAt = await db('app_stacks').where({ id: stack.id }).first('last_update_check_at') as { last_update_check_at: Date | string | null } | undefined;
      if (lastAuto?.status === 'failed' && checkedAt?.last_update_check_at && new Date(lastAuto.created_at) >= new Date(checkedAt.last_update_check_at)) continue;
      const open = await deps.maintenanceOpen({ tenantId: stack.tenant_id, accountId: stack.account_id, windowId: policy.maintenanceWindowId });
      if (!open) continue;
      await startAction(stack, 'update', 'auto-update', { userId: null, services });
    } catch (err) {
      logger.warn({ err: errText(err), stackId: stack.id }, 'apps: update check failed');
    }
  }
}
