import type Docker from 'dockerode';
import type { AccountTeardownContext, AccountTeardownHook } from '../docker/extensions';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { cleanName, listByLabel, removeContainer, removeNetwork } from '../docker/dockerOps';
import { LABELS, P4B_LABELS } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { removeVolume } from './appDocker';
import { appsDeps } from './deps';
import { cancelAndWaitStack } from './deployments';
import { kindNoFollow } from './fsSafe';

// Account teardown (docs/P4b-PLAN.md §5.8): called by reconcileService.destroyAccount after every container
// labelled oblimint.account was removed, before the account networks go: removes the stacks' private
// networks and named volumes (data dirs → app_volume_tombstones unless purge), built images, stack rows
// stay to the account CASCADE. OWNED BY MODULE `apps-core`.
// Never calls withAccountLock (it runs inside it). Docker failures are appended to ctx.errors (the destroy
// is reported failed and retried), never thrown. The stacks of the account come from the database and,
// should it be unreadable, from the labels of the account's app volumes (oblimint.account + oblimint.app).

async function listVolumes(docker: Docker, label: string): Promise<Array<{ Name: string; Labels?: Record<string, string> | null }>> {
  if (typeof docker.listVolumes !== 'function') return [];
  const res = await docker.listVolumes({ filters: { label: [label] } }) as { Volumes?: Array<{ Name: string; Labels?: Record<string, string> | null }> | null };
  return res.Volumes ?? [];
}

export const appsTeardownHook: AccountTeardownHook = {
  async beforeNetworksRemoved(ctx: AccountTeardownContext): Promise<void> {
    const stacks = new Set<number>();
    let dbOk = true;
    try {
      for (const id of await db('app_stacks').where({ account_id: ctx.accountId }).pluck('id') as number[]) stacks.add(Number(id));
    } catch (err) {
      dbOk = false;
      logger.warn({ err: errText(err), accountId: ctx.accountId }, 'apps teardown: stacks unreadable, using the volume labels');
    }
    try {
      for (const v of await listVolumes(ctx.docker, `${LABELS.account}=${ctx.accountId}`)) {
        const id = Number(v.Labels?.[P4B_LABELS.app]);
        if (Number.isInteger(id) && id > 0) stacks.add(id);
      }
    } catch (err) {
      ctx.errors.push(`apps: volumes of account ${ctx.accountId}: ${errText(err)}`);
    }
    for (const stackId of stacks) {
      try {
        // A running action (wake, git poll, reconcile start, auto-update) could recreate containers after the
        // account's were removed: cancelled and awaited, then any app container left is removed (never kept
        // running on a fabric nobody reconciles any more).
        await cancelAndWaitStack(stackId);
        for (const c of await listByLabel(ctx.docker, `${P4B_LABELS.app}=${stackId}`)) {
          const name = cleanName(c.Names?.[0]);
          if (name && c.Labels?.[LABELS.role] === 'app') await removeContainer(ctx.docker, name);
        }
        const nets = await ctx.docker.listNetworks({ filters: { label: [`${P4B_LABELS.appNetwork}=${stackId}`] } }) as Array<{ Name: string }>;
        for (const n of nets) await removeNetwork(ctx.docker, n.Name);
        for (const v of await listVolumes(ctx.docker, `${P4B_LABELS.app}=${stackId}`)) await removeVolume(ctx.docker, v.Name);
        if (typeof ctx.docker.listImages === 'function') {
          try {
            const images = await ctx.docker.listImages({ filters: { label: [`${P4B_LABELS.app}=${stackId}`] } }) as Array<{ Id: string; RepoTags?: string[] }>;
            for (const img of images) await ctx.docker.getImage(img.RepoTags?.[0] ?? img.Id).remove({ force: true }).catch(() => undefined);
          } catch { /* built images: best effort */ }
        }
      } catch (err) {
        ctx.errors.push(`apps: stack ${stackId}: ${errText(err)}`);
        continue;
      }
      try {
        await appsDeps().segments.releaseAppNetworks(stackId);
      } catch { /* segmentation releases its subnets in its own teardown hook too */ }
      if (!ctx.purge && dbOk) {
        // Data kept 7 days (the account tree itself is not purged): tombstone the volume directory.
        const rel = `${stackId}/volumes`;
        const appsDir = localPaths.apps(ctx.accountId);
        try {
          if (kindNoFollow(appsDir, rel) === 'dir') {
            const already = await db('app_volume_tombstones').where({ stack_id: stackId, purged_at: null }).first('id');
            if (!already) {
              await db('app_volume_tombstones').insert({
                account_id: ctx.accountId, stack_id: stackId, path: `${appsDir}/${rel}`, purge_after: new Date(Date.now() + 7 * 86_400_000),
              });
            }
          }
        } catch (err) {
          logger.warn({ err: errText(err), stackId }, 'apps teardown: volume tombstone not recorded');
        }
      }
    }
  },
};
