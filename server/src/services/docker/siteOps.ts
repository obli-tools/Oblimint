import type Docker from 'dockerode';
import type { PlanLimits } from '@oblimint/shared';
import { db } from '../../db';
import { LABELS } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { planLimits, type AccountRow, type DataPathRow, type SiteRow, type SiteRuntimeRow } from '../hosting/rows';
import { errText } from '../setup/docker';
import { cleanName, listByLabel } from './dockerOps';
import { execWith } from './engine';
import { buildRuntimeConfigs, writeRuntimeConfigFiles, type RuntimeConfigInput, type WriteRuntimeResult } from './runtimeConfig';

// Site-level building blocks shared by the reconcile and the runtime service
// (kept out of both so they do not import each other in a cycle).

export interface SiteContext {
  site: SiteRow;
  account: Pick<AccountRow, 'id' | 'tenant_id' | 'node_id' | 'uid' | 'gid' | 'status'> & { limits: PlanLimits };
  runtimes: SiteRuntimeRow[];
  dataPaths: DataPathRow[];
  routes: Array<{ path_prefix: string; runtime_id: number | null }>;
}

/** Site row + its account (with plan limits), runtimes, data paths, routes. null when the site is gone. */
export async function loadSiteContext(siteId: number): Promise<SiteContext | null> {
  const site = await db('sites').where({ id: siteId }).first() as SiteRow | undefined;
  if (!site) return null;
  const account = await db('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .where('a.id', site.account_id)
    .first('a.id', 'a.tenant_id', 'a.node_id', 'a.uid', 'a.gid', 'a.status', 'p.limits as plan_limits') as
    (Pick<AccountRow, 'id' | 'tenant_id' | 'node_id' | 'uid' | 'gid' | 'status'> & { plan_limits: unknown }) | undefined;
  if (!account) return null;
  const [runtimes, dataPaths, routes] = await Promise.all([
    db('site_runtimes').where({ site_id: siteId }).orderBy('id') as Promise<SiteRuntimeRow[]>,
    db('site_data_paths').where({ site_id: siteId }).orderBy('path') as Promise<DataPathRow[]>,
    db('site_routes').where({ site_id: siteId }).select('path_prefix', 'runtime_id') as Promise<Array<{ path_prefix: string; runtime_id: number | null }>>,
  ]);
  const { plan_limits: rawLimits, ...acct } = account;
  return { site, account: { ...acct, limits: planLimits(rawLimits) }, runtimes, dataPaths, routes };
}

export function runtimeConfigInput(ctx: Pick<SiteContext, 'site' | 'runtimes' | 'dataPaths' | 'routes'>): RuntimeConfigInput {
  const s = ctx.site;
  return {
    site: {
      id: s.id,
      accountId: s.account_id,
      base: s.base,
      previewBase: s.preview_base,
      docroot: s.docroot,
      basePath: s.base_path,
      phpSettings: s.php_settings,
      customNginx: s.custom_nginx,
      healthcheckPath: s.healthcheck_path,
    },
    runtimes: ctx.runtimes.map((r) => ({ id: r.id, base: r.base })),
    dataPaths: ctx.dataPaths.map((d) => ({ path: d.path, policy: d.policy, allowedExtensions: d.allowed_extensions })),
    routes: ctx.routes.map((r) => ({ pathPrefix: r.path_prefix, runtimeId: r.runtime_id })),
  };
}

/** Writes sites/<id>/runtime/*.json (only changed files), removes stale ones. */
export async function writeSiteRuntimeConfigs(ctx: Pick<SiteContext, 'site' | 'runtimes' | 'dataPaths' | 'routes'>): Promise<WriteRuntimeResult> {
  const dir = localPaths.runtime(ctx.site.account_id, ctx.site.id);
  return writeRuntimeConfigFiles(dir, buildRuntimeConfigs(runtimeConfigInput(ctx)));
}

export const RELOAD_TIMEOUT_MS = 30_000;

/**
 * `oblimint-reload` in every RUNNING container of the site (label
 * oblimint.site=<id>), except `skip` (containers just (re)created: they
 * rendered the fresh config at start), the release previews (role
 * site-rpreview, feature B) and their database clones (role preview-db).
 */
export async function reloadSiteContainers(docker: Docker, siteId: number, skip: ReadonlySet<string> = new Set()): Promise<{ ok: boolean; errors: string[]; reloaded: string[] }> {
  const errors: string[] = [];
  const reloaded: string[] = [];
  const containers = await listByLabel(docker, `${LABELS.site}=${siteId}`);
  for (const c of containers) {
    const name = cleanName(c.Names?.[0]);
    if (c.State !== 'running' || skip.has(name)) continue;
    // A3: a release preview's config never changes after its build — a publication never depends on its state.
    // Its database clone (role preview-db) is no site container at all.
    if (c.Labels?.[LABELS.role] === 'site-rpreview' || c.Labels?.[LABELS.role] === 'preview-db') continue;
    try {
      const r = await execWith(docker, name, ['oblimint-reload'], { timeoutMs: RELOAD_TIMEOUT_MS });
      if (r.exitCode !== 0) {
        errors.push(`${name}: oblimint-reload exited ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`);
      } else {
        reloaded.push(name);
      }
    } catch (err) {
      errors.push(`${name}: ${errText(err)}`);
    }
  }
  return { ok: errors.length === 0, errors, reloaded };
}
