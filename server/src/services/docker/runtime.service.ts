import type Docker from 'dockerode';
import type {
  ContainerState, RuntimeContainerStatus, RuntimeRole, RuntimeSwitchCheck, SiteBaseId, SiteRuntimeStatus,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { emitHosting } from '../hosting/events';
import { previewHostname, siteImage } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { errText } from '../setup/docker';
import { scheduleEdgeSync } from './backends';
import { containerState, ensureImage, imageExists, inspectContainer, isUnreachable, restartContainer } from './dockerOps';
import { engineFor } from './engine';
import { reconcileService, type ReconcileReport } from './reconcile.service';
import { loadSiteContext, reloadSiteContainers, writeSiteRuntimeConfigs, type SiteContext } from './siteOps';
import { siteContainerName } from './specs';
import { scanReleaseFacts, switchWarnings, type ReleaseFacts } from './warnings';
import { withAccountLock } from './locks';
import { applyRuntimeChange } from './runtimeSwitch';
import { siteHealthcheck } from '../releases/release.service';

// ─────────────────────────────────────────────────────────────────────────────
// Site runtime operations (ARCHITECTURE §3.1). Callers have ALREADY checked
// access (services/hosting/access.ts). Containers are converged by the
// reconcile (planner.ts): a switch / preview / promotion changes the rows
// (sites.base, sites.preview_base) then runs a reconcile pass of the account
// — the spec hash of the primary changes with its image, so it is recreated
// on the same release; the preview container appears / disappears with
// preview_base. Errors the user waits for → 502 backendUnavailable.
// ─────────────────────────────────────────────────────────────────────────────

async function requireContext(siteId: number): Promise<SiteContext> {
  const ctx = await loadSiteContext(siteId);
  if (!ctx) throw new AppError(404, 'Site not found', 'notFound');
  return ctx;
}

function assertBaseAllowed(ctx: SiteContext, base: SiteBaseId): void {
  const allowed = ctx.account.limits.allowedBases;
  if (allowed && !allowed.includes(base)) {
    throw new AppError(409, `Base ${base} is not allowed by the plan of this account`, 'baseNotAllowed');
  }
}

function backendError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError(502, errText(err), 'backendUnavailable');
}

/** Pulls the image of `base` first: a missing image fails the request before any row changes. */
async function ensureBaseImage(ctx: SiteContext, base: SiteBaseId): Promise<void> {
  const ref = siteImage(base);
  try {
    const docker = await engineFor(ctx.account.node_id);
    await ensureImage(docker, ref, (line) => logger.info({ siteId: ctx.site.id, image: ref }, line));
  } catch (err) {
    if (isUnreachable(err)) throw new AppError(502, `Docker: ${errText(err)}`, 'backendUnavailable');
    throw new AppError(502, `image introuvable : ${ref} (${errText(err)})`, 'backendUnavailable');
  }
}

/** Errors of a pass that concern this site (or block it at the account level). */
export function siteErrors(report: ReconcileReport, siteId: number): string[] {
  return (report.issues ?? []).filter((i) => i.scope === `site:${siteId}` || i.scope === 'account').map((i) => i.message);
}

async function converge(ctx: SiteContext): Promise<void> {
  const report = await reconcileService.reconcileAccountNow(ctx.account.id);
  const errors = siteErrors(report, ctx.site.id);
  if (errors.length) throw new AppError(502, errors.join(' · ').slice(0, 500), 'backendUnavailable');
}

/**
 * Healthcheck of the primary after a runtime change: only when it serves a
 * release (something published, site not stopped, account not suspended).
 */
async function verifyPrimary(ctx: SiteContext): Promise<string | null> {
  const fresh = await db('sites').where({ id: ctx.site.id }).first('id', 'status', 'current_release_id', 'healthcheck_path') as
    { id: number; status: string; current_release_id: number | null; healthcheck_path: string } | undefined;
  if (!fresh || !fresh.current_release_id || fresh.status === 'stopped' || ctx.account.status === 'suspended') return null;
  return siteHealthcheck(fresh);
}

function emitRuntime(ctx: SiteContext): void {
  const scope = { tenantId: ctx.account.tenant_id, accountId: ctx.account.id };
  emitHosting(HostingSocketEvents.RUNTIME_UPDATED, { siteId: ctx.site.id }, scope);
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'site', id: ctx.site.id, accountId: ctx.account.id, action: 'updated' }, scope);
}

async function previewUrlOf(site: { id: number; slug: string; preview_base: SiteBaseId | null }): Promise<string | null> {
  if (!site.preview_base) return null;
  const host = await appConfigService.get('panel_hostname').catch(() => null);
  return host ? `https://${previewHostname(site, host)}` : null;
}

function mapInspect(
  role: RuntimeRole, runtimeId: number | null, name: string, base: SiteBaseId,
  info: Docker.ContainerInspectInfo | null, error: boolean,
): RuntimeContainerStatus {
  const memory = info?.HostConfig?.Memory;
  const cpus = info?.HostConfig?.NanoCpus;
  let state: ContainerState;
  if (error) state = 'unknown';
  else if (!info) state = 'missing';
  else state = containerState(info.State?.Status);
  return {
    role,
    runtimeId,
    name,
    base,
    image: info?.Config?.Image ?? siteImage(base),
    state,
    startedAt: info?.State?.Running && info.State.StartedAt ? new Date(info.State.StartedAt).toISOString() : null,
    health: info?.State?.Health?.Status ?? null,
    memoryLimitMb: memory ? Math.round(memory / 1048576) : null,
    cpuLimit: cpus ? cpus / 1e9 : null,
  };
}

/** Number of the current release (null: nothing published). */
async function currentReleaseNumber(currentReleaseId: number | null): Promise<number | null> {
  if (!currentReleaseId) return null;
  const row = await db('releases').where({ id: currentReleaseId }).first('number') as { number: number } | undefined;
  return row ? Number(row.number) : null;
}

export const runtimeService = {
  /** Containers of the site (primary, secondaries, preview) with their Docker state. */
  async status(siteId: number): Promise<SiteRuntimeStatus> {
    const ctx = await requireContext(siteId);
    const { site } = ctx;
    const wanted: Array<{ role: RuntimeRole; runtimeId: number | null; base: SiteBaseId }> = [
      { role: 'primary', runtimeId: null, base: site.base },
      ...ctx.runtimes.map((r) => ({ role: 'secondary' as const, runtimeId: r.id, base: r.base })),
      ...(site.preview_base ? [{ role: 'preview' as const, runtimeId: null, base: site.preview_base }] : []),
    ];
    let docker: Docker | null = null;
    try { docker = await engineFor(ctx.account.node_id); } catch (err) { logger.debug({ err: errText(err) }, 'runtime status: no engine'); }
    const containers = await Promise.all(wanted.map(async (w) => {
      const name = siteContainerName(site.id, w.role, w.runtimeId);
      if (!docker) return mapInspect(w.role, w.runtimeId, name, w.base, null, true);
      try {
        return mapInspect(w.role, w.runtimeId, name, w.base, await inspectContainer(docker, name), false);
      } catch (err) {
        logger.debug({ siteId, name, err: errText(err) }, 'runtime status: inspect failed');
        return mapInspect(w.role, w.runtimeId, name, w.base, null, true);
      }
    }));
    return {
      siteId: site.id,
      base: site.base,
      previewBase: site.preview_base,
      previewUrl: await previewUrlOf(site),
      containers,
    };
  },

  /** Warnings before switching to `base` (.htaccess on nginx, unmaintained PHP, downgrade…). */
  async checkSwitch(siteId: number, base: SiteBaseId): Promise<RuntimeSwitchCheck> {
    const ctx = await requireContext(siteId);
    const number = await currentReleaseNumber(ctx.site.current_release_id);
    let release: ReleaseFacts | null = null;
    if (number !== null) {
      release = await scanReleaseFacts(localPaths.release(ctx.account.id, ctx.site.id, number)).catch(() => null);
    }
    const imageRef = siteImage(base);
    let imagePresent: boolean | null = null;
    try {
      imagePresent = await imageExists(await engineFor(ctx.account.node_id), imageRef);
    } catch (err) {
      logger.debug({ err: errText(err) }, 'checkSwitch: image check skipped');
    }
    return { base, warnings: switchWarnings({ current: ctx.site.base, target: base, release, imagePresent, imageRef }) };
  },

  /**
   * Graceful reload of every running container of the site
   * (`docker exec <c> oblimint-reload`: re-renders the config from site.json,
   * reloads the web server, USR2 to php-fpm → opcache/realpath cache flushed).
   * Called by the release pipeline after the `current` switch. Never throws.
   */
  async reloadSite(siteId: number): Promise<{ ok: boolean; errors: string[] }> {
    try {
      const ctx = await requireContext(siteId);
      const docker = await engineFor(ctx.account.node_id);
      const r = await reloadSiteContainers(docker, siteId);
      if (!r.ok) logger.warn({ siteId, errors: r.errors }, 'Site reload finished with errors');
      return { ok: r.ok, errors: r.errors };
    } catch (err) {
      return { ok: false, errors: [errText(err)] };
    }
  },

  /** Restarts the existing containers of the site; missing ones are (re)created by a reconcile pass. */
  async restartSite(siteId: number): Promise<void> {
    const ctx = await requireContext(siteId);
    const errors: string[] = [];
    await withAccountLock(ctx.account.id, async () => {
      const docker = await engineFor(ctx.account.node_id).catch((err) => { throw backendError(err); });
      const names = [
        siteContainerName(siteId, 'primary', null),
        ...ctx.runtimes.map((r) => siteContainerName(siteId, 'secondary', r.id)),
        ...(ctx.site.preview_base ? [siteContainerName(siteId, 'preview', null)] : []),
      ];
      for (const name of names) {
        try {
          const info = await inspectContainer(docker, name);
          if (info?.State?.Running) await restartContainer(docker, name, 10);
        } catch (err) {
          errors.push(`${name}: ${errText(err)}`);
        }
      }
    });
    if (errors.length) throw new AppError(502, errors.join(' · ').slice(0, 500), 'backendUnavailable');
    await converge(ctx);
    emitRuntime(ctx);
  },

  /** Direct switch: sites.base = base, then recreate the primary container on the same release. */
  async switchBase(siteId: number, base: SiteBaseId): Promise<void> {
    const ctx = await requireContext(siteId);
    assertBaseAllowed(ctx, base);
    if (ctx.site.base === base) {
      await converge(ctx);
      emitRuntime(ctx);
      return;
    }
    await ensureBaseImage(ctx, base);
    const from = ctx.site.base;
    try {
      await applyRuntimeChange({
        apply: async () => {
          await db('sites').where({ id: siteId }).update({ base, updated_at: new Date() });
          logger.info({ siteId, from, to: base }, 'Site base switched');
        },
        revert: async () => { await db('sites').where({ id: siteId }).update({ base: from, updated_at: new Date() }); },
        converge: () => converge(ctx),
        verify: () => verifyPrimary(ctx),
      }, `Switching to ${base}`);
    } finally {
      emitRuntime(ctx);
    }
  },

  /** Blue/green: sites.preview_base = base, start the preview container, edge preview vhost. */
  async startPreview(siteId: number, base: SiteBaseId): Promise<{ previewUrl: string | null }> {
    const ctx = await requireContext(siteId);
    assertBaseAllowed(ctx, base);
    await ensureBaseImage(ctx, base);
    await db('sites').where({ id: siteId }).update({ preview_base: base, updated_at: new Date() });
    await converge(ctx);
    scheduleEdgeSync('preview');
    emitRuntime(ctx);
    return { previewUrl: await previewUrlOf({ ...ctx.site, preview_base: base }) };
  },

  /** base := preview_base, recreate primary, remove preview. */
  async promotePreview(siteId: number): Promise<void> {
    const ctx = await requireContext(siteId);
    const target = ctx.site.preview_base;
    if (!target) throw new AppError(409, 'This site has no preview runtime', 'noPreview');
    assertBaseAllowed(ctx, target);
    const from = ctx.site.base;
    try {
      await applyRuntimeChange({
        apply: async () => {
          await db('sites').where({ id: siteId }).update({ base: target, preview_base: null, updated_at: new Date() });
          logger.info({ siteId, from, to: target }, 'Preview runtime promoted');
        },
        // Back to the previous primary, the preview kept (it can be promoted again once fixed).
        revert: async () => { await db('sites').where({ id: siteId }).update({ base: from, preview_base: target, updated_at: new Date() }); },
        converge: () => converge(ctx),
        verify: () => verifyPrimary(ctx),
      }, `Promoting ${target}`);
    } finally {
      scheduleEdgeSync('preview');
      emitRuntime(ctx);
    }
  },

  async stopPreview(siteId: number): Promise<void> {
    const ctx = await requireContext(siteId);
    if (!ctx.site.preview_base) return;
    await db('sites').where({ id: siteId }).update({ preview_base: null, updated_at: new Date() });
    await converge(ctx);
    scheduleEdgeSync('preview');
    emitRuntime(ctx);
  },

  /** (Re)writes sites/<id>/runtime/*.json (SiteRuntimeConfig) from the DB; `changed` = content differs. */
  async writeRuntimeConfigs(siteId: number): Promise<{ changed: boolean }> {
    const ctx = await requireContext(siteId);
    const r = await writeSiteRuntimeConfigs(ctx);
    return { changed: r.changed };
  },
};
