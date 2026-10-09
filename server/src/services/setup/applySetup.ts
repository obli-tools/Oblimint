import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { SetupApplyRequest, SetupProgress, SetupStep } from '@oblimint/shared';
import { isMailEngineSupported, MASTER_TENANT_ID } from '@oblimint/shared';
import { config, dataDir } from '../../config';
import { logger } from '../../utils/logger';
import { obligateUrlError } from '../obligateUrl';
import { docker, errText, INTERNAL_LABELS, selfContainerRef, withTimeout } from './docker';
import { attachWithAlias, ensureImage } from '../docker/dockerOps';
import { PLATFORM_OOM_SCORE_ADJ } from '../docker/specs';
import { PANEL_ALIAS } from '../hosting/naming';
import { writeFileAtomic0600, writePanelConfig } from './configFile';

// The first-run deployment (docs/P0-PLAN.md §Mode setup, apply steps).
// Runs once in the background; GET /api/setup/progress reports it. On
// success the process exits after 3 s: `--restart unless-stopped` starts the
// container again, which now finds config/oblimint.json → normal mode.

export const NETWORK_NAME = 'oblimint';
export const POSTGRES_CONTAINER = 'oblimint-postgres';
export const POSTGRES_IMAGE = 'postgres:16-alpine';
const PG_USER = 'oblimint';
const PG_DB = 'oblimint';

const hostname = z.string().trim().min(1).max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i, 'a fully qualified host name');
const ipv4 = z.string().trim().regex(/^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/, 'an IPv4 address');
const ipv6 = z.string().trim().min(2).max(45).regex(/^[0-9a-f:]+$/i, 'an IPv6 address').refine((s) => s.includes(':'), 'an IPv6 address');

export const setupApplySchema = z.object({
  panelHostname: hostname,
  publicIpv4: ipv4.nullable(),
  publicIpv6: ipv6.nullable(),
  nameservers: z.array(hostname).max(8),
  acmeEmail: z.string().trim().email().max(254),
  // P4: docker-mailserver / maddy are driver skeletons (shared MAIL_ENGINES_SUPPORTED): refused.
  mailEngine: z.enum(['postfix-dovecot', 'stalwart', 'docker-mailserver', 'maddy', 'external'])
    .refine((e) => isMailEngineSupported(e), { message: 'mailEngineNotSupported: this mail engine is not supported yet' }),
  // P2: registrable domain dedicated to the previews (never under the panel host).
  previewDomain: hostname.nullable().optional(),
  admin: z.object({
    username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, _, ., -')
      .refine((u) => !u.toLowerCase().startsWith('og_'), 'The og_ prefix is reserved for SSO accounts'),
    password: z.string().min(12).max(128),
    email: z.string().trim().email().max(254).nullable(),
  }).strict(),
  obligate: z.object({
    url: z.string().trim().url().max(512).refine((u) => /^https?:\/\//i.test(u), 'an http(s) URL')
      // SSO trust anchor: https, or plain http only on a local / private address.
      .superRefine((u, ctx) => { const e = obligateUrlError(u); if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e }); }),
    apiKey: z.string().trim().min(16).max(512),
  }).strict().nullable(),
}).strict();

const STEP_IDS = ['network', 'postgres', 'attach', 'config', 'migrate', 'admin', 'settings', 'edge', 'hostd', 'dns', 'mail'] as const;
type StepId = typeof STEP_IDS[number];
/** P4: every step is deployed now (mail included). Kept for a future phase. */
const LATER_STEPS: StepId[] = [];

function freshProgress(): SetupProgress {
  return {
    started: false,
    done: false,
    error: null,
    steps: STEP_IDS.map((id): SetupStep => ({ id, labelKey: `setup.steps.${id}`, status: 'pending', log: [] })),
  };
}

let progress: SetupProgress = freshProgress();
let running = false;

export function getProgress(): SetupProgress {
  return JSON.parse(JSON.stringify(progress)) as SetupProgress;
}

/** false when a run is in progress or already succeeded (409); a failed run may be retried. */
export function canStart(): boolean {
  return !running && !progress.done;
}

const MAX_LOG_LINES = 200;
function stepOf(id: StepId): SetupStep {
  return progress.steps.find((s) => s.id === id)!;
}
function log(id: StepId, line: string): void {
  const s = stepOf(id);
  s.log.push(line);
  if (s.log.length > MAX_LOG_LINES) s.log.splice(0, s.log.length - MAX_LOG_LINES);
  logger.info({ step: id }, line);
}

/** A step whose failure does not abort the setup (status 'error' + log, the run goes on). */
async function runOptionalStep(id: StepId, fn: () => Promise<void>): Promise<void> {
  try {
    await runStep(id, fn);
  } catch {
    log(id, 'This component can be redeployed later from the Nodes page');
  }
}

async function runStep(id: StepId, fn: () => Promise<void>): Promise<void> {
  const s = stepOf(id);
  s.status = 'running';
  try {
    await fn();
    s.status = 'done';
  } catch (err) {
    s.status = 'error';
    log(id, `ERROR: ${errText(err)}`);
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Steps ────────────────────────────────────────────────────────────────────

async function stepNetwork(): Promise<void> {
  const d = docker();
  const existing = (await withTimeout(d.listNetworks({ filters: { name: [NETWORK_NAME] } }), 15_000, 'list networks'))
    .find((n) => n.Name === NETWORK_NAME);
  if (existing) {
    log('network', `Network ${NETWORK_NAME} already exists (${existing.Id.slice(0, 12)})`);
    return;
  }
  const net = await withTimeout(d.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge', Labels: { ...INTERNAL_LABELS } }), 15_000, 'create network');
  log('network', `Network ${NETWORK_NAME} created (${net.id.slice(0, 12)})`);
}

/** Password of the panel database: generated once, kept 0600 next to the
 *  config so a retried setup reuses it (the data directory may already be
 *  initialised with it). */
async function postgresPassword(): Promise<string> {
  const file = path.join(dataDir, 'config', 'postgres.password');
  try {
    const existing = (await fs.promises.readFile(file, 'utf-8')).trim();
    if (existing.length >= 32) return existing;
  } catch { /* first run */ }
  const pw = crypto.randomBytes(32).toString('base64url');
  await writeFileAtomic0600(file, `${pw}\n`);
  return pw;
}

async function stepPostgres(): Promise<string> {
  const d = docker();
  // Pulled ONLY when absent: postgres:16-alpine is a shared tag — a pull would move it
  // under other containers of the host (and re-pull on every setup retry).
  if (!(await ensureImage(d, POSTGRES_IMAGE, (line) => log('postgres', line)))) {
    log('postgres', `${POSTGRES_IMAGE} already present locally (not pulled)`);
  }
  const password = await postgresPassword();
  const pgDir = path.join(dataDir, 'panel', 'postgres');
  await fs.promises.mkdir(pgDir, { recursive: true, mode: 0o700 });
  const hostPgDir = path.join(config.hostDataDir, 'panel', 'postgres').replace(/\\/g, '/');

  const old = d.getContainer(POSTGRES_CONTAINER);
  const oldInfo = await old.inspect().catch(() => null);
  if (oldInfo) {
    log('postgres', `Removing the previous ${POSTGRES_CONTAINER} container (data kept in ${hostPgDir})`);
    await withTimeout(old.remove({ force: true }), 60_000, `remove ${POSTGRES_CONTAINER}`);
  }
  const container = await withTimeout(d.createContainer({
    name: POSTGRES_CONTAINER,
    Image: POSTGRES_IMAGE,
    Env: [`POSTGRES_USER=${PG_USER}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${PG_DB}`],
    Labels: { ...INTERNAL_LABELS, 'oblimint.role': 'panel-postgres' },
    Healthcheck: {
      Test: ['CMD-SHELL', `pg_isready -U ${PG_USER} -d ${PG_DB}`],
      Interval: 2_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 30,
      StartPeriod: 5_000_000_000,
    },
    HostConfig: {
      Binds: [`${hostPgDir}:/var/lib/postgresql/data`],
      // Host memory pressure (a tenant site): the kernel kills tenant processes first (specs.ts).
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NETWORK_NAME,
    },
  }), 30_000, `create ${POSTGRES_CONTAINER}`);
  await withTimeout(container.start(), 30_000, `start ${POSTGRES_CONTAINER}`);
  log('postgres', `Container ${POSTGRES_CONTAINER} started, waiting for pg_isready…`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const info = await container.inspect();
    const health = info.State?.Health?.Status;
    if (health === 'healthy') break;
    if (!info.State?.Running) throw new Error(`${POSTGRES_CONTAINER} stopped (exit code ${info.State?.ExitCode})`);
    if (Date.now() > deadline) throw new Error(`${POSTGRES_CONTAINER} not healthy after 180 s (status: ${health ?? 'unknown'})`);
    await sleep(2_000);
  }
  log('postgres', `${POSTGRES_CONTAINER} is healthy`);
  return `postgres://${PG_USER}:${encodeURIComponent(password)}@${POSTGRES_CONTAINER}:5432/${PG_DB}`;
}

/** Panel container on the panel network with the alias oblimint-panel (the
 *  edge proxies the panel host name to https://oblimint-panel:<port>). */
async function stepAttach(): Promise<void> {
  const ref = selfContainerRef();
  if (!ref) throw new Error('HOSTNAME is not set: cannot find the panel container');
  await withTimeout(attachWithAlias(docker(), NETWORK_NAME, ref, PANEL_ALIAS, (line) => log('attach', line)), 240_000, 'attach panel'); // disconnect + up to 3 connect attempts (30 s each) + fallback connect
}

/** oblimint-edge and oblimint-hostd (P1): imported lazily, they need the panel database (nodes). */
async function stepEdge(): Promise<void> {
  const { infraService } = await import('../docker/infra.service');
  await infraService.ensureEdge((line) => log('edge', line));
}

async function stepHostd(): Promise<void> {
  const { infraService } = await import('../docker/infra.service');
  await infraService.ensureHostd((line) => log('hostd', line));
}

/** P2: shared PowerDNS (module dns, services/dns/infra.ts). Non-fatal like edge / hostd. */
async function stepDns(): Promise<void> {
  const { dnsInfraComponent } = await import('../dns/infra');
  await dnsInfraComponent.ensure((line) => log('dns', line));
}

/**
 * P4: the mail engine chosen in the form (module mail-core,
 * services/mail/infra.ts: deploys the active driver's containers). 'external'
 * deploys nothing (step skipped). Non-fatal like edge / hostd / dns.
 */
async function stepMail(engine: SetupApplyRequest['mailEngine']): Promise<void> {
  if (engine === 'external') {
    log('mail', 'External mail engine: nothing to deploy (the panel manages the DNS records only)');
    return;
  }
  const { mailInfraComponent } = await import('../mail/infra');
  await mailInfraComponent.ensure((line) => log('mail', line));
}

/**
 * SESSION_SECRET of the normal-mode boot that follows the wizard: the
 * environment wins over config/oblimint.json (config.ts), else the secret
 * just written to the file.
 */
export function effectiveSessionSecret(written: string, env: string | undefined): string {
  return env || written;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export function startApply(req: SetupApplyRequest, opts: { exitOnDone?: boolean } = {}): void {
  progress = freshProgress();
  progress.started = true;
  running = true;
  void (async () => {
    try {
      await runStep('network', stepNetwork);
      let databaseUrl = '';
      await runStep('postgres', async () => { databaseUrl = await stepPostgres(); });
      await runStep('attach', stepAttach);
      await runStep('config', async () => {
        const sessionSecret = crypto.randomBytes(48).toString('base64url');
        const file = await writePanelConfig({
          databaseUrl,
          sessionSecret,
          panel: {
            hostname: req.panelHostname,
            publicIpv4: req.publicIpv4,
            publicIpv6: req.publicIpv6,
            nameservers: req.nameservers,
            acmeEmail: req.acmeEmail,
            mailEngine: req.mailEngine,
          },
          createdAt: new Date().toISOString(),
        });
        config.databaseUrl = databaseUrl;
        // The later steps (edge, hostd, dns) seal values with secretBox: they
        // must use the secret of the next (normal-mode) boot, never the
        // empty setup-mode one (which fell back to a public constant).
        config.sessionSecret = effectiveSessionSecret(sessionSecret, process.env.SESSION_SECRET);
        log('config', `Configuration written to ${file} (0600)`);
      });
      await runPostDeploySteps(req);
      // Non-fatal: the panel works without them; the operator redeploys from the Nodes page.
      await runOptionalStep('edge', stepEdge);
      await runOptionalStep('hostd', stepHostd);
      await runOptionalStep('dns', stepDns);
      await runOptionalStep('mail', () => stepMail(req.mailEngine));
      for (const id of LATER_STEPS) {
        stepOf(id).status = 'skipped';
        log(id, 'Deployed in a later phase (P2+)');
      }
      progress.done = true;
      logger.info('Setup complete — restarting in normal mode in 3 s');
      if (opts.exitOnDone !== false) setTimeout(() => process.exit(0), 3_000).unref();
    } catch (err) {
      progress.error = errText(err);
      logger.error({ err }, 'Setup failed');
    } finally {
      running = false;
    }
  })();
}

/** migrate, admin, settings — on the database named by config.databaseUrl. */
export async function runPostDeploySteps(req: SetupApplyRequest): Promise<void> {
  const { db } = await import('../../db');
  const { waitForDatabase } = await import('../../db/waitForDatabase');
  await runStep('migrate', async () => {
    await waitForDatabase({ timeoutMs: 60_000 });
    const [, applied] = await db.migrate.latest() as [number, string[]];
    log('migrate', applied.length ? `Migrations applied: ${applied.join(', ')}` : 'Schema already up to date');
  });
  await runStep('admin', async () => {
    const { hashPassword } = await import('../../utils/crypto');
    const hash = await hashPassword(req.admin.password);
    await db.transaction(async (trx) => {
      const existing = await trx('users').whereRaw('lower(username) = lower(?)', [req.admin.username]).first('id');
      let userId: number;
      if (existing) {
        userId = existing.id;
        await trx('users').where({ id: userId }).update({
          password_hash: hash, role: 'admin', kind: 'staff', is_active: true, email: req.admin.email, updated_at: new Date(),
        });
        log('admin', `Administrator "${req.admin.username}" already existed: password and role reset`);
      } else {
        const [row] = await trx('users').insert({
          username: req.admin.username,
          password_hash: hash,
          display_name: 'Administrator',
          role: 'admin',
          kind: 'staff',
          is_active: true,
          email: req.admin.email,
        }).returning('id');
        userId = row?.id ?? row;
        log('admin', `Administrator "${req.admin.username}" created (break-glass local account)`);
      }
      await trx('user_tenants').insert({ user_id: userId, tenant_id: MASTER_TENANT_ID, role: 'admin' })
        .onConflict(['user_id', 'tenant_id']).merge({ role: 'admin' });
    });
  });
  await runStep('settings', async () => {
    const { appConfigService } = await import('../appConfig.service');
    await appConfigService.set('panel_hostname', req.panelHostname);
    if (req.publicIpv4) await appConfigService.set('public_ipv4', req.publicIpv4);
    if (req.publicIpv6) await appConfigService.set('public_ipv6', req.publicIpv6);
    await appConfigService.set('nameservers', JSON.stringify(req.nameservers));
    await appConfigService.set('acme_email', req.acmeEmail);
    await appConfigService.set('mail_engine', req.mailEngine);
    // P2: seeds settings preview.previewDomain (services/platformSettings.ts reads it until the section is saved).
    if (req.previewDomain) await appConfigService.set('preview_domain', req.previewDomain.toLowerCase());
    log('settings', 'Panel settings saved');
    if (req.obligate) {
      await appConfigService.patchObligateConfig({ url: req.obligate.url.replace(/\/+$/, ''), apiKey: req.obligate.apiKey, enabled: true });
      log('settings', `Obligate SSO configured (${req.obligate.url})`);
    }
  });
}

