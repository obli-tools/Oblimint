import type { Request } from 'express';
import type { SiteEnvVar, SiteEnvVarInput } from '@oblimint/shared';
import { siteEnvService } from '../hosting/siteEnv.service';
import type { SiteRow } from '../hosting/rows';
import type { GateSpec } from '../restrictions/gate';
import { keyGated, siteTarget } from '../restrictions/targets';
import { requireScope, type ApiKeyContext } from './apiKeys.service';
import { keySite } from './keyApi';

// ─────────────────────────────────────────────────────────────────────────────
// Environment variables of a key's site (scope sites.manage). The panel form
// replaces the whole set; a key changes some names and keeps the others
// (secrets stay write-only: kept without ever being read back).
// site.env_write (spec §2): the names, the non-secret values and the removals
// are shown to the decider; a secret value enters the fingerprint only.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvChange {
  site: SiteRow;
  merged: SiteEnvVarInput[];
  /** site.env_write as the gate sees it. */
  gate: GateSpec;
}

/** The whole set after `set` / `remove`, and the gate spec of that change (nothing written). */
async function prepare(ctx: ApiKeyContext, siteId: number, set: SiteEnvVarInput[], remove: string[], origin?: Record<string, unknown>): Promise<EnvChange> {
  requireScope(ctx, 'sites.manage');
  const site = await keySite(ctx, siteId);
  const current = await siteEnvService.list(ctx.actor, site.id);
  const touched = new Set([...set.map((v) => v.name), ...remove]);
  const kept: SiteEnvVarInput[] = current.filter((v) => !touched.has(v.name)).map((v) => ({ name: v.name, secret: v.secret, value: v.secret ? null : v.value }));
  // A secret re-sent without a value keeps its stored one (same rule as the panel form).
  // Without a value the flag is never guessed as false: an omitted secret
  // keeps the stored flag (a new variable without value is refused anyway),
  // and an explicit secret:false on a secret is refused by replace()
  // (envValueRequired): the stored value would otherwise be read back.
  const changed = set.map((v) => {
    const value = v.value ?? null;
    const stored = current.find((c) => c.name === v.name)?.secret;
    const secret = v.secret ?? (value === null ? stored ?? true : stored ?? false);
    return { name: v.name, secret, value };
  });
  const secretParams: Record<string, unknown> = {};
  for (const v of changed) if (v.secret && v.value !== null) secretParams[v.name] = v.value;
  return {
    site,
    merged: [...kept, ...changed],
    gate: {
      action: 'site.env_write', target: siteTarget(site),
      params: {
        set: changed.map((v) => ({ name: v.name, secret: v.secret, ...(v.secret ? { valueSet: v.value !== null } : { value: v.value }) })),
        remove: [...remove].sort(),
        ...(origin ?? {}),
      },
      secretParams,
    },
  };
}

export const keyEnv = {
  async list(ctx: ApiKeyContext, siteId: number): Promise<SiteEnvVar[]> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return siteEnvService.list(ctx.actor, site.id);
  },

  prepare,

  /** Writes a prepared change (already gated by the caller). */
  async apply(ctx: ApiKeyContext, req: Request, change: EnvChange): Promise<{ vars: SiteEnvVar[]; changed: boolean }> {
    return siteEnvService.replace(req, ctx.actor, change.site.id, change.merged);
  },

  /** Sets `set` (added or replaced) and removes `remove`; the others are kept. A change restarts the site. */
  async update(ctx: ApiKeyContext, req: Request, siteId: number, set: SiteEnvVarInput[], remove: string[] = []): Promise<{ vars: SiteEnvVar[]; changed: boolean }> {
    const change = await prepare(ctx, siteId, set, remove);
    return keyGated(ctx, req, change.gate, () => siteEnvService.replace(req, ctx.actor, change.site.id, change.merged));
  },
};
