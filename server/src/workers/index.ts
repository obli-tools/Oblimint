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
  // Oblimint webmail listener (settings mail.webmail = 'oblimint'; answers "not enabled" otherwise).
  try { (await import('../services/mail/webmail/oblimint/server')).startOblimintWebmail(); } catch (err) { logger.error({ err }, 'Oblimint webmail listener failed to start'); }

  // Results of a panel self-update (helper container): runs even with the workers off.
  try { (await import('../services/platformUpdates/platformUpdates.service')).scheduleSelfUpdateFinalization(); } catch (err) { logger.error({ err }, 'Self-update finalization failed to start'); }

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
  // Feature B: release / staging previews — expired ones out BEFORE the edge's first sync.
  const { previewWorker } = await import('../services/previews/previewExpiry');
  try { await previewWorker.recoverAtBoot(); } catch (err) { logger.error({ err }, 'Preview recovery failed'); }
  const starters: Array<[string, () => void]> = [
    ['reconcile', () => reconcileService.start()],
    ['filesrv', () => fileServerService.start()],
    ['publish', () => publishScheduler.start()],
    ['edge', () => edgeService.start()],
    ['certificates', () => certificateService.start()],
    ['usage', () => usageService.start()],
    ['previews', () => previewWorker.start()],
  ];
  // Platform updates (Nodes > Updates): registry checks, automatic updates in the window, self-update results.
  const { platformUpdatesWorker } = await import('../services/platformUpdates/platformUpdates.service');
  starters.push(['platform-updates', () => platformUpdatesWorker.start()]);
  // External backups (daily run at the configured hour, retention).
  const { backupService } = await import('../services/backups/backup.service');
  starters.push(['backups', () => backupService.start()]);
  // Outbound heartbeat (Settings > Health monitoring): a beat per minute while every deep check is green.
  const { healthMonitorService } = await import('../services/healthMonitor/healthMonitor.service');
  starters.push(['heartbeat', () => healthMonitorService.start()]);
  // P2 workers (docs/P2-PLAN.md §Workers): same contract (start returns at once, never throws).
  const p2 = await p2Workers();
  for (const [name, w] of p2) starters.push([name, () => w.start()]);
  // P3 workers (docs/P3-PLAN.md §Workers): same contract.
  for (const [name, w] of await p3Workers()) starters.push([name, () => w.start()]);
  // P4 workers (docs/P4-PLAN.md §Workers): same contract; OBLIMINT_MAIL_WORKERS=off skips them.
  if (config.hosting.mailWorkers) for (const [name, w] of await p4Workers()) starters.push([name, () => w.start()]);
  // P4b workers (docs/P4b-PLAN.md §17): same contract; OBLIMINT_P4B_WORKERS=off skips them.
  if (config.hosting.p4bWorkers) for (const [name, w] of await p4bWorkers()) starters.push([name, () => w.start()]);
  // P5 workers (docs/P5-PLAN.md §14): same contract; OBLIMINT_MIGRATION_WORKERS=off skips them.
  if (config.hosting.migrationWorkers) for (const [name, w] of await p5Workers()) starters.push([name, () => w.start()]);
  for (const [name, start] of starters) {
    try { start(); } catch (err) { logger.error({ err, worker: name }, 'Worker failed to start'); }
  }
}

interface Worker { start(): void; stop(): void }

/** P2 workers, in start order. */
async function p2Workers(): Promise<Array<[string, Worker]>> {
  const [dns, ownership, databases, firewall, usage, cron, logs, phpErrors, inbox, pendingActions] = await Promise.all([
    import('../services/dns/dns.service').then((m) => m.dnsService),
    import('../services/ownership/ownership.service').then((m) => m.ownershipService),
    import('../services/databases/databases.service').then((m) => m.databaseService),
    import('../services/firewall/firewall.service').then((m) => m.firewallService),
    import('../services/usage/usage.service'),
    import('../services/cron/cron.service').then((m) => m.cronService),
    import('../services/logs/logs.service').then((m) => m.logsService),
    import('../services/siteErrors/siteErrors.service').then((m) => m.siteErrorsService),
    import('../services/usage/userNotifications.service').then((m) => m.userNotificationsWorker),
    import('../services/restrictions/pendingActions.service').then((m) => m.pendingActionsWorker),
  ]);
  const list: Array<[string, Worker]> = [
    ['dns', dns],
    ['ownership', ownership],
    ['databases', databases],
    ['firewall', firewall],
    ['cron', cron],
    ['logs', logs],
    // PHP errors grouped by release: stderr of the live site containers every minute, retention hourly.
    ['php-errors', phpErrors],
    ['usage-enforcement', usage.enforcementService],
    // Notification center: 90-day / 500-per-user retention, transactional mail journal.
    ['user-notifications', inbox],
    // Sensitive actions: pending confirmations / approvals expired every minute (audited, requester notified), 90-day purge.
    ['pending-actions', pendingActions],
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

/**
 * P4b workers, in start order: segments (Docker events → segment policy, legacy migration), apps
 * (reconcile, git poll, digest checks / auto-updates in windows, sleep / wake, retention), proxy (edge
 * unit provider, forward-auth sidecars), bans (edge unit provider g-bans, honeypot log worker, hostd web
 * firewall, Obliguard), traffic (per-host aggregation), uptime (checks, status pages, certificate expiry),
 * workflows (scheduler, cert-renewal trigger). The edge units pipeline itself runs in edgeService (P1
 * worker 'edge', rebuilt by edge-robustness).
 */
async function p4bWorkers(): Promise<Array<[string, Worker]>> {
  const [segments, apps, proxy, bans, monitoring, uptime] = await Promise.all([
    import('../services/network/segments.service').then((m) => m.segmentService),
    import('../services/apps/apps.service').then((m) => m.appsService),
    import('../services/proxy/worker').then((m) => m.proxyWorker),
    import('../services/security/bans.service').then((m) => m.webBanService),
    import('../services/monitoring/worker'),
    import('../services/monitoring/uptime.service').then((m) => m.uptimeService),
  ]);
  return [
    ['segments', segments],
    ['apps', apps],
    ['proxy', proxy],
    ['bans', bans],
    ['traffic', monitoring.trafficWorker],
    ['uptime', uptime],
    ['workflows', monitoring.workflowWorker],
  ];
}

/**
 * P5 workers, in start order: migration-discovery (marks the discoveries interrupted by a restart),
 * migration-runs (resumes the runs whose lease expired, executes the queued runs). The cutover service has no
 * worker (its checklists are refreshed by the run-finished hook and on demand).
 */
async function p5Workers(): Promise<Array<[string, Worker]>> {
  const [discovery, runs] = await Promise.all([
    import('../services/migration/discovery/discovery.service').then((m) => m.discoveryService),
    import('../services/migration/execution/runs.service').then((m) => m.migrationRunsService),
  ]);
  return [
    ['migration-discovery', discovery],
    ['migration-runs', runs],
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
    import('../services/platformUpdates/platformUpdates.service').then((m) => m.platformUpdatesWorker),
    import('../services/backups/backup.service').then((m) => m.backupService),
    import('../services/previews/previewExpiry').then((m) => m.previewWorker),
    import('../services/healthMonitor/healthMonitor.service').then((m) => m.healthMonitorService),
  ]);
  for (const m of mods) { try { m.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p2Workers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p3Workers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p4Workers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p4bWorkers()) { try { w.stop(); } catch { /* exiting */ } }
  for (const [, w] of await p5Workers()) { try { w.stop(); } catch { /* exiting */ } }
  const { stopInternalServer } = await import('../internal/internalServer');
  try { stopInternalServer(); } catch { /* exiting */ }
  try { (await import('../services/mail/webmail/oblimint/server')).stopOblimintWebmail(); } catch { /* exiting */ }
}
