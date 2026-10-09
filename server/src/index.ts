import './env';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import type express from 'express';
import { config, dataDir, configFilePath, defaultAdminPasswordError, isWeakAdminPassword, readConfigFile, startupConfigErrors } from './config';
import { logger } from './utils/logger';
import { loadOrCreateSelfSignedCert } from './utils/tls';
import { serverVersion } from './utils/version';

/** HTTP (dev, :3025) or HTTPS with the persisted self-signed certificate (container, :8443). */
function createServer(app: express.Express): http.Server | https.Server {
  if (config.panelTls === 'selfsigned') {
    let hostnames: string[] = [];
    try { hostnames = [readConfigFile()?.panel?.hostname ?? ''].filter(Boolean); } catch { /* no file */ }
    return https.createServer(loadOrCreateSelfSignedCert(hostnames), app);
  }
  if (config.panelTls && config.panelTls !== 'off') {
    logger.warn({ PANEL_TLS: config.panelTls }, 'Unknown PANEL_TLS value — serving plain HTTP');
  }
  return http.createServer(app);
}

/**
 * Node cuts any request whose BODY is still arriving after `requestTimeout`
 * (300 s by default): a database restore (streamed upload, up to 2 GiB, 6 h
 * server-side limit) would be cut mid-stream. Bounded to that limit + margin;
 * slow headers stay bounded by `headersTimeout` (60 s), and in production the
 * edge's nginx bounds idle bodies (client_body_timeout) before they reach us.
 */
const REQUEST_TIMEOUT_MS = 6 * 60 * 60_000 + 30 * 60_000;

function listen(server: http.Server | https.Server, label: string): void {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.listen(config.port, () => {
    const scheme = server instanceof https.Server ? 'https' : 'http';
    logger.info({ port: config.port, scheme, env: config.nodeEnv, version: serverVersion }, `Oblimint ${label} listening on ${scheme}://0.0.0.0:${config.port}`);
  });
}

function installShutdown(server: http.Server | https.Server, onClose: () => Promise<void> | void): void {
  const shutdown = () => {
    logger.info('Shutting down...');
    server.close(async () => {
      try { await onClose(); } catch { /* exiting */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── SETUP mode ───────────────────────────────────────────────────────────────

function printSetupBanner(token: string): void {
  const lines = [
    'OBLIMINT — FIRST-RUN SETUP',
    '',
    'No configuration found: the panel runs in SETUP MODE.',
    `Open ${config.panelTls === 'selfsigned' ? 'https' : 'http'}://<this-host>:${config.port}/setup and enter this one-time token:`,
    '',
    `    ${token}`,
    '',
    `Configuration will be written to ${configFilePath}`,
    'The token is kept in memory only: it changes at every restart.',
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = `+${'='.repeat(width)}+`;
  const out = [bar, ...lines.map((l) => `|  ${l.padEnd(width - 4)}  |`), bar].join('\n');
  // Plain stdout (not JSON) so it stands out in `docker logs`.
  process.stdout.write(`\n${out}\n\n`);
}

async function startSetupMode(): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const { createSetupApp } = await import('./app');
  const app = createSetupApp(token);
  const server = createServer(app);
  installShutdown(server, () => {});
  logger.warn({ dataDir }, 'No DATABASE_URL and no config file: starting in SETUP MODE (no database)');
  printSetupBanner(token);
  listen(server, 'setup wizard');
}

// ── NORMAL mode ──────────────────────────────────────────────────────────────

/**
 * Break-glass administrator, created only while no administrator exists
 * (Obliance ensureDefaultAdmin): DEFAULT_ADMIN_USERNAME with
 * DEFAULT_ADMIN_PASSWORD when set, else a random password printed ONCE.
 */
async function ensureDefaultAdmin(): Promise<void> {
  const { db } = await import('./db');
  if (await db('users').where({ role: 'admin' }).first('id')) {
    if (config.defaultAdminPassword && isWeakAdminPassword(config.defaultAdminPassword)) {
      logger.warn('DEFAULT_ADMIN_PASSWORD holds a weak or default value; it is not used (an administrator exists): remove it from the environment.');
    }
    return;
  }
  const passwordError = defaultAdminPasswordError();
  if (passwordError) {
    logger.fatal(`${passwordError} Refusing to create the initial administrator: refusing to start.`);
    process.exit(1);
  }
  const username = config.defaultAdminUsername;
  if (await db('users').whereRaw('lower(username) = lower(?)', [username]).first('id')) {
    logger.warn({ username }, 'No administrator exists, but this username belongs to a non-admin account: no initial administrator created. Set DEFAULT_ADMIN_USERNAME to a free username.');
    return;
  }
  const { generatePassword, hashPassword } = await import('./utils/crypto');
  const generated = !config.defaultAdminPassword;
  const password = config.defaultAdminPassword || generatePassword();
  const hash = await hashPassword(password);
  await db.transaction(async (trx) => {
    const [row] = await trx('users').insert({
      username, password_hash: hash, display_name: 'Administrator', role: 'admin', kind: 'staff', is_active: true,
    }).returning('id');
    const userId = row?.id ?? row;
    await trx('user_tenants').insert({ user_id: userId, tenant_id: 1, role: 'admin' }).onConflict(['user_id', 'tenant_id']).ignore();
  });
  if (generated) {
    logger.warn({ username }, `Initial administrator "${username}" created: sign in, change the password and enable two-factor authentication. Generated password, shown only this once: ${password}`);
  } else {
    logger.info({ username }, 'Initial administrator created with DEFAULT_ADMIN_PASSWORD: change it and enable two-factor authentication at first sign-in');
  }
}

async function startNormalMode(): Promise<void> {
  const configErrors = startupConfigErrors();
  if (configErrors.length > 0) {
    for (const message of configErrors) logger.fatal(message);
    logger.fatal('Unsafe configuration: refusing to start.');
    process.exit(1);
  }
  logger.info({ source: config.configSource }, 'Panel configuration loaded');

  const { db } = await import('./db');
  const { waitForDatabase } = await import('./db/waitForDatabase');
  await waitForDatabase();
  logger.info('Running database migrations...');
  const [, applied] = await db.migrate.latest() as [number, string[]];
  logger.info({ applied }, 'Migrations complete');

  await ensureDefaultAdmin();

  const { createApp } = await import('./app');
  const { createSocketServer } = await import('./socket');
  const app = createApp();
  const server = createServer(app);
  createSocketServer(server);
  installShutdown(server, async () => {
    const { stopWorkers } = await import('./workers');
    await stopWorkers();
    await db.destroy();
  });
  listen(server, 'panel');

  // The edge container fronts the panel: trust its exact addresses for
  // X-Forwarded-For (rate-limit keys, audit IPs). Needs Docker.
  if (config.hosting.workersEnabled) {
    const { proxyTrustService } = await import('./services/proxyTrust');
    proxyTrustService.start();
  }

  // P1 hosting workers (reconcile, publish debounce, certificates, usage) +
  // the internal file-server hook listener.
  const { startWorkers } = await import('./workers');
  startWorkers().catch((err) => logger.error({ err }, 'Failed to start the hosting workers'));

  const { obligateService } = await import('./services/obligate.service');
  obligateService.announceSelfInfo().catch(() => {});
}

async function main(): Promise<void> {
  if (config.mode === 'setup') await startSetupMode();
  else await startNormalMode();
}

main().catch((err) => {
  logger.fatal(err, 'Fatal error during startup');
  process.exit(1);
});
