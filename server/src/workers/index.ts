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
  // P2 workers (docs/P2-PLAN.md §Workers): same contract (start returns at once, never throws).
  const p2 = await p2Workers();
  for (const [name, w] of p2) starters.push([name, () => w.start()]);
  // P3 workers (docs/P3-PLAN.md §Workers): same contract.
  for (const [name, w] of await p3Workers()) starters.push([name, () => w.start()]);
  // P4 workers (docs/P4-PLAN.md §Workers): same contract; OBLIMINT_MAIL_WORKERS=off skips them.
  if (config.hosting.mailWorkers) for (const [name, w] of await p4Workers()) starters.push([name, () => w.start()]);
  for (const [name, start] of starters) {
    try { start(); } catch (err) { logger.error({ err, worker: name }, 'Worker failed to start'); }
  }
}

interface Worker { start(): void; stop(): void }

/** P2 workers, in start order. */
async function p2Workers(): Promise<Array<[string, Worker]>> {
  const [dns, ownership, databases, firewall, usage, cron, logs] = await Promise.all([
    import('../services/dns/dns.service').then((m) => m.dnsService),
    import('../services/ownership/ownership.service').then((m) => m.ownershipService),
    import('../services/databases/databases.service').then((m) => m.databaseService),
    import('../services/firewall/firewall.service').then((m) => m.firewallService),
    import('../services/usage/usage.service'),
    import('../services/cron/cron.service').then((m) => m.cronService),
    import('../services/logs/logs.service').then((m) => m.logsService),
  ]);
  const list: Array<[string, Worker]> = [
    ['dns', dns],
    ['ownership', ownership],
    ['databases', databases],
    ['firewall', firewall],
    ['cron', cron],
    ['logs', logs],
    ['usage-enforcement', usage.enforcementService],
  ];
  if (config.hosting.usageCollector) list.push(['usage-collector', usage.usageCollector]);
  return list;
}

/**
 * P3 workers, in start order: scan first (registers the pre-publish scanner
 * of the release pipeline), then windows (boot recovery of the overlays,
 * scheduler, expiries), snapshots (retention), adapters (schedules, recovery),
 * quarantine (hostd events, watch specs, supervision digests).
 */
async function p3Workers(): Promise<Array<[string, Worker]>> {
  const [scan, windows, snapshots, adapters, quarantine] = await Promise.all([
    import('../services/scan/scan.service').then((m) => m.scanService),
    import('../services/windows/window.service').then((m) => m.windowService),
    import('../services/snapshots/snapshot.service').then((m) => m.snapshotService),
    import('../services/adapters/adapter.service').then((m) => m.adapterService),
    import('../services/quarantine/quarantine.service').then((m) => m.quarantineService),
  ]);
  return [
    ['scan', scan],
    ['windows', windows],
    ['snapshots', snapshots],
    ['adapters', adapters],
    ['quarantine', quarantine],
  ];
}

/**
 * P4 workers, in start order: mail (engine sync + usage + purge queue; also
 * resolves the active driver), mail-dns (registers the DNS zone + edge
 * contributors, DKIM rotation, periodic DNS checks), mail-outbound (log
 * follower, abuse protection, bans → hostd, relay config), webmail (session
 * credential expiry, edge contributor).
 */
async function p4Workers(): Promise<Array<[string, Worker]>> {
  const [mail, mailDns, outbound, webmail] = await Promise.all([
    import('../services/mail/mail.service').then((m) => m.mailService),
    import('../services/mail/dns/mailDns.service').then((m) => m.mailDnsService),
    import('../services/mail/outbound/outbound.service').then((m) => m.outboundService),
    import('../services/mail/webmail/webmail.service').then((m) => m.webmailService),
  ]);
  return [
    ['mail', mail],
    ['mail-dns', mailDns],
    ['mail-outbound', outbound],
    ['webmail', webmail],
  ];
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
  for (const [, w] of await p2Workers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p3Workers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p4Workers()) { try { w.stop(); } catch { /* exiting */ } }
  const { stopInternalServer } = await import('../internal/internalServer');
  try { stopInternalServer(); } catch { /* exiting */ }
}
