import type { Request } from 'express';
import type { AppInstall, AppInstallRetryResult, AppInstallStartRequest, AppInstallStartResult } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { appInstallService, type InstallVia } from '../appInstall/appInstall.service';
import type { AppInstallRow } from '../appInstall/machine';
import { keyGated } from '../restrictions/targets';
import { apiKeysService, requireScope, type ApiKeyContext } from './apiKeys.service';
import { recordKeyDbObject } from './keyDatabases';

// ─────────────────────────────────────────────────────────────────────────────
// Application installer through an access key (MCP install_app…, POST
// /api/v1/apps/install…). Scopes: sites.create + databases.manage +
// releases.publish (previews.manage with previewFirst). The key's account only;
// the site and the database join its reach. Another operation of the account is
// reached only through a site of the key; a cleanup only by the key that started it.
// ─────────────────────────────────────────────────────────────────────────────

const via = (ctx: ApiKeyContext): InstallVia => ({
  apiKeyId: ctx.id,
  onCreated: (kind, id) => recordKeyDbObject(ctx, kind, id),
  onSiteCreated: (siteId) => apiKeysService.recordCreatedSite(ctx, siteId),
});

const notFound = () => new AppError(404, 'Installation not found', 'notFound');

function scopes(ctx: ApiKeyContext): void {
  requireScope(ctx, 'sites.create');
  requireScope(ctx, 'databases.manage');
  requireScope(ctx, 'releases.publish');
}

async function ownRow(ctx: ApiKeyContext, id: number): Promise<AppInstallRow> {
  const row = await appInstallService.loadRow(ctx.actor, id);
  const reach = ctx.siteScope === 'all' || Number(row.api_key_id) === ctx.id || (row.site_id !== null && ctx.siteIds.has(Number(row.site_id)));
  if (Number(row.account_id) !== ctx.accountId || !reach) throw notFound();
  return row;
}

export const keyApps = {
  async install(ctx: ApiKeyContext, req: Request, body: Omit<AppInstallStartRequest, 'accountId'>): Promise<AppInstallStartResult> {
    scopes(ctx);
    if (body.publishMode === 'approval') requireScope(ctx, 'releases.publish');
    if (body.previewFirst) requireScope(ctx, 'previews.manage');
    const full: AppInstallStartRequest = { ...body, accountId: ctx.accountId };
    const pre = await appInstallService.preflight(ctx.actor, full);
    return keyGated(ctx, req, appInstallService.startGates(pre, full), () => appInstallService.start(req, ctx.actor, full, pre, via(ctx)));
  },

  async list(ctx: ApiKeyContext): Promise<AppInstall[]> {
    requireScope(ctx, 'sites.create');
    const all = await appInstallService.list(ctx.actor, { accountId: ctx.accountId });
    if (ctx.siteScope === 'all') return all;
    return all.filter((i) => i.siteId !== null && ctx.siteIds.has(i.siteId));
  },

  async get(ctx: ApiKeyContext, id: number): Promise<AppInstall> {
    requireScope(ctx, 'sites.create');
    await ownRow(ctx, id);
    return appInstallService.get(ctx.actor, id);
  },

  async retry(ctx: ApiKeyContext, req: Request, id: number): Promise<AppInstallRetryResult> {
    scopes(ctx);
    const row = await ownRow(ctx, id);
    return keyGated(ctx, req, appInstallService.retryGates(row), () => appInstallService.retry(req, ctx.actor, id, via(ctx)));
  },

  async publish(ctx: ApiKeyContext, req: Request, id: number): Promise<AppInstall> {
    scopes(ctx);
    const row = await ownRow(ctx, id);
    return keyGated(ctx, req, appInstallService.publishGates(row), () => appInstallService.publishAfterPreview(req, ctx.actor, id, via(ctx)));
  },

  /** Removes a site and databases: only what THIS key started, behind site.delete (2FA by default). */
  async cleanup(ctx: ApiKeyContext, req: Request, id: number): Promise<AppInstall> {
    scopes(ctx);
    const row = await ownRow(ctx, id);
    if (Number(row.api_key_id) !== ctx.id) throw new AppError(403, 'A key can only clean up the installations it started', 'keySiteScope');
    return keyGated(ctx, req, appInstallService.cleanupGates(row), () => appInstallService.cleanup(req, ctx.actor, id, via(ctx)));
  },
};
