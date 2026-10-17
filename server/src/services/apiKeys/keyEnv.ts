import type { Request } from 'express';
import type { SiteEnvVar, SiteEnvVarInput } from '@oblimint/shared';
import { siteEnvService } from '../hosting/siteEnv.service';
import { requireScope, type ApiKeyContext } from './apiKeys.service';
import { keySite } from './keyApi';

// ─────────────────────────────────────────────────────────────────────────────
// Environment variables of a key's site (scope sites.manage). The panel form
// replaces the whole set; a key changes some names and keeps the others
// (secrets stay write-only: kept without ever being read back).
// ─────────────────────────────────────────────────────────────────────────────

export const keyEnv = {
  async list(ctx: ApiKeyContext, siteId: number): Promise<SiteEnvVar[]> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return siteEnvService.list(ctx.actor, site.id);
  },

  /** Sets `set` (added or replaced) and removes `remove`; the others are kept. A change restarts the site. */
  async update(ctx: ApiKeyContext, req: Request, siteId: number, set: SiteEnvVarInput[], remove: string[] = []): Promise<{ vars: SiteEnvVar[]; changed: boolean }> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    const current = await siteEnvService.list(ctx.actor, site.id);
    const touched = new Set([...set.map((v) => v.name), ...remove]);
    const kept: SiteEnvVarInput[] = current.filter((v) => !touched.has(v.name)).map((v) => ({ name: v.name, secret: v.secret, value: v.secret ? null : v.value }));
    // A secret re-sent without a value keeps its stored one (same rule as the panel form).
    const merged = [...kept, ...set.map((v) => ({ name: v.name, secret: v.secret ?? current.find((c) => c.name === v.name)?.secret ?? false, value: v.value ?? null }))];
    return siteEnvService.replace(req, ctx.actor, site.id, merged);
  },
};
