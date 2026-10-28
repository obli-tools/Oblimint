import type { Request } from 'express';
import type { SiteEnvVar, SiteEnvVarInput } from '@oblimint/shared';
import { SITE_ENV_MAX_VALUE, SITE_ENV_MAX_VARS, SITE_ENV_NAME_RE, reservedEnvName } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { open, seal } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import { loadSite, type HostingActor } from './access';

// ─────────────────────────────────────────────────────────────────────────────
// Environment variables of a site (shared/src/siteEnv.ts). Stored sealed;
// given to every container of the site (docker Env) by the reconcile planner;
// PHP-FPM reads them (clear_env = no in the site images). A secret is
// write-only: never sent back, kept when the form leaves it empty.
// Reading and writing both need sites.manage (values may be secrets).
// ─────────────────────────────────────────────────────────────────────────────

interface EnvRow { id: number; site_id: number; name: string; value_sealed: string; secret: boolean; updated_at: Date | string }

const iso = (v: Date | string) => new Date(v).toISOString();

function openValue(row: Pick<EnvRow, 'value_sealed' | 'site_id' | 'name'>): string | null {
  try {
    return open('site-env', row.value_sealed);
  } catch (err) {
    logger.warn({ err, siteId: row.site_id, name: row.name }, 'site env: value cannot be opened (skipped)');
    return null;
  }
}

/** Decrypted variables of sites (reconcile planner): siteId → [name, value][] sorted by name. */
export async function siteEnvFor(siteIds: number[]): Promise<Map<number, Array<[string, string]>>> {
  const out = new Map<number, Array<[string, string]>>();
  if (!siteIds.length) return out;
  const rows = await db('site_env_vars').whereIn('site_id', siteIds).orderBy('name') as EnvRow[];
  for (const r of rows) {
    const v = openValue(r);
    if (v === null) continue;
    const list = out.get(r.site_id) ?? [];
    list.push([r.name, v]);
    out.set(r.site_id, list);
  }
  return out;
}

/**
 * Feature B: variables of a site for its release / staging preview container.
 * 'public' (default) = non-secret variables only; 'all' (sites.manage, checked
 * by the preview service) = every variable, as siteEnvFor.
 */
export async function siteEnvForPreview(siteId: number, mode: 'public' | 'all'): Promise<Array<[string, string]>> {
  const q = db('site_env_vars').where({ site_id: siteId }).orderBy('name');
  if (mode !== 'all') q.where({ secret: false });
  const rows = await q as EnvRow[];
  const out: Array<[string, string]> = [];
  for (const r of rows) {
    const v = openValue(r);
    if (v !== null) out.push([r.name, v]);
  }
  return out;
}

/** Feature B: does the site have secret variables (warning secretsHidden)? */
export async function siteHasSecretEnv(siteId: number): Promise<boolean> {
  return !!(await db('site_env_vars').where({ site_id: siteId, secret: true }).first('id'));
}

function validate(vars: SiteEnvVarInput[]): void {
  if (vars.length > SITE_ENV_MAX_VARS) throw new AppError(400, `At most ${SITE_ENV_MAX_VARS} variables`, 'validation');
  const seen = new Set<string>();
  for (const v of vars) {
    if (!SITE_ENV_NAME_RE.test(v.name)) throw new AppError(400, `Invalid name: ${v.name} (letters, digits, _; not starting with a digit)`, 'envNameInvalid', { name: v.name });
    if (reservedEnvName(v.name)) throw new AppError(400, `${v.name} is reserved by the platform`, 'envNameReserved', { name: v.name });
    if (seen.has(v.name)) throw new AppError(400, `Duplicate variable ${v.name}`, 'envNameDuplicate', { name: v.name });
    seen.add(v.name);
    if (typeof v.value === 'string') {
      if (v.value.length > SITE_ENV_MAX_VALUE) throw new AppError(400, `${v.name}: value too long`, 'validation');
      if (v.value.includes('\0')) throw new AppError(400, `${v.name}: NUL character not allowed`, 'validation');
    }
  }
}

export const siteEnvService = {
  async list(actor: HostingActor, siteId: number): Promise<SiteEnvVar[]> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const rows = await db('site_env_vars').where({ site_id: site.id }).orderBy('name') as EnvRow[];
    return rows.map((r) => ({ name: r.name, secret: r.secret, value: r.secret ? null : openValue(r), updatedAt: iso(r.updated_at) }));
  },

  /**
   * Replaces the whole set (the form sends every variable). A secret sent
   * without a value keeps its stored one; a new secret needs a value, and so
   * does a secret turned visible (its stored value is never revealed: it
   * would come back in clear from list()).
   * Returns true when something changed (the site containers are recreated).
   */
  async replace(req: Request, actor: HostingActor, siteId: number, vars: SiteEnvVarInput[]): Promise<{ vars: SiteEnvVar[]; changed: boolean }> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    validate(vars);
    const changed = await db.transaction(async (trx) => {
      await trx('sites').where({ id: site.id }).forUpdate().first('id');
      const current = new Map((await trx('site_env_vars').where({ site_id: site.id }) as EnvRow[]).map((r) => [r.name, r]));
      let dirty = false;
      for (const name of current.keys()) {
        if (!vars.some((v) => v.name === name)) { await trx('site_env_vars').where({ site_id: site.id, name }).del(); dirty = true; }
      }
      for (const v of vars) {
        const prev = current.get(v.name);
        const secret = v.secret === true;
        if (v.value === undefined || v.value === null) {
          if (!prev) throw new AppError(400, `${v.name}: a value is required`, 'envValueRequired', { name: v.name });
          if (prev.secret && !secret) throw new AppError(400, `${v.name}: a new value is required to make a secret visible`, 'envValueRequired', { name: v.name });
          if (prev.secret !== secret) { await trx('site_env_vars').where({ id: prev.id }).update({ secret, updated_at: trx.fn.now() }); dirty = true; }
          continue;
        }
        if (prev && prev.secret === secret && openValue(prev) === v.value) continue;
        const row = { value_sealed: seal('site-env', v.value), secret, updated_at: trx.fn.now() };
        if (prev) await trx('site_env_vars').where({ id: prev.id }).update(row);
        else await trx('site_env_vars').insert({ site_id: site.id, account_id: site.account_id, name: v.name, ...row });
        dirty = true;
      }
      return dirty;
    });
    if (changed) {
      await auditService.logReqAs(req, site.tenant_id, 'site.env.update', {
        resourceType: 'site', resourcePath: String(site.id), details: { names: vars.map((v) => v.name) },
      });
      try {
        const { reconcileService } = await import('../docker/reconcile.service');
        reconcileService.requestAccount(site.account_id, `site ${site.id} environment changed`);
      } catch (err) { logger.warn({ err, siteId: site.id }, 'site env: reconcile request failed'); }
    }
    return { vars: await siteEnvService.list(actor, site.id), changed };
  },
};
