import { config } from '../config';
import { logger } from '../utils/logger';

// Background workers of the hosting core (docs/P1-PLAN.md §Workers), started
// by index.ts once the HTTP server listens (normal mode only). Every start()
// must return immediately, never throw, and survive an absent Docker / hostd
// (log, retry later). OBLIMINT_WORKERS=off disables them (dev box without
// Docker); the internal hook listener runs regardless (internalPort 0 = off).

export async function startWorkers(): Promise<void> {
  const { startInternalServer } = await import('../internal/internalServer');
  try { startInternalServer(); } catch (err) { logger.error({ err }, 'Internal hook server failed to start'); }

  if (!config.hosting.workersEnabled) {
    logger.warn('OBLIMINT_WORKERS=off: reconcile, publish, renewal and usage workers are disabled');
    return;
  }
  const { releaseService } = await import('../services/releases/release.service');
  const { publishScheduler } = await import('../services/releases/publishScheduler');
  const { reconcileService } = await import('../services/docker/reconcile.service');
  const { fileServerService } = await import('../services/docker/filesrv.service');
  const { edgeService } = await import('../services/edge/edge.service');
  const { certificateService } = await import('../services/edge/certificate.service');
  const { usageService } = await import('../services/hosting/usage.service');

  try { await releaseService.recoverInterrupted(); } catch (err) { logger.error({ err }, 'Release recovery failed'); }
  const starters: Array<[string, () => void]> = [
    ['reconcile', () => reconcileService.start()],
    ['filesrv', () => fileServerService.start()],
    ['publish', () => publishScheduler.start()],
    ['edge', () => edgeService.start()],
    ['certificates', () => certificateService.start()],
    ['usage', () => usageService.start()],
  ];
  for (const [name, start] of starters) {
    try { start(); } catch (err) { logger.error({ err, worker: name }, 'Worker failed to start'); }
  }
}

export async function stopWorkers(): Promise<void> {
  const mods = await Promise.all([
    import('../services/docker/reconcile.service').then((m) => m.reconcileService),
    import('../services/docker/filesrv.service').then((m) => m.fileServerService),
    import('../services/releases/publishScheduler').then((m) => m.publishScheduler),
    import('../services/edge/edge.service').then((m) => m.edgeService),
    import('../services/edge/certificate.service').then((m) => m.certificateService),
    import('../services/hosting/usage.service').then((m) => m.usageService),
  ]);
  for (const m of mods) { try { m.stop(); } catch { /* exiting */ } }
  const { stopInternalServer } = await import('../internal/internalServer');
  try { stopInternalServer(); } catch { /* exiting */ }
}
