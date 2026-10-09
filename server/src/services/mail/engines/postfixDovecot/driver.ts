import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import type {
  MailDesiredState, MailDriver, MailEngineCapabilities, MailQueueEntry, MailSyncOptions, MailSyncResult, MailboxUsage,
} from '../../driver';
import { MailDriverError } from '../../driver';
import { config } from '../../../../config';
import { logger } from '../../../../utils/logger';
import {
  connectNetwork, createNetwork, disconnectNetwork, ensureImage, inspectContainer, inspectNetwork, labelHash, recreateContainer,
  removeContainer, removeNetwork, restartContainer, startContainer, stopContainer, type Log,
} from '../../../docker/dockerOps';
import { engineFor, execWith, localNodeId, type ExecResult } from '../../../docker/engine';
import { withLock } from '../../../docker/locks';
import { specHashLabel } from '../../../docker/specs';
import {
  LABELS, MAIL_CONTAINER, MAIL_NETWORK, MAIL_REDIS_CONTAINER, MAIL_RSPAMD_CONTAINER, SCANNER_CONTAINER,
} from '../../../hosting/naming';
import { hostPaths, localPaths, type HostingLayout } from '../../../hosting/paths';
import { errText } from '../../../setup/docker';
import { applyRender, readManifest, type ReloadPart } from './apply';
import {
  CTL_OUT_DIR, ENGINE, MAIL_CORE_NETWORK, MAIL_CTL, RELAY_INTAKE_PORT, REDIS_UID, RSPAMD_CTL, RSPAMD_GID, VMAIL_GID, VMAIL_UID,
} from './layout';
import { parseMailLogLine } from './logs';
import { purgeMailData } from './purge';
import { renderConfig } from './render';
import { parseDoveadmQuotaJson, parsePostqueueJson } from './runtime';
import { clamdTcpNetsOf, normalizeClamdTcpNets } from '../../../scan/scannerSpec';
import { ENGINE_EXTRA_NETWORKS, engineContainerSpec, engineDataDirs, redisContainerSpec, rspamdContainerSpec } from './spec';
import { firstHost, QUEUE_ID_RE, RenderError } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// postfix-dovecot engine (docs/P4-PLAN.md §5.2) — module engine-postfix.
// Implements services/mail/driver.ts (frozen contract; its rules apply here:
// never log a hash / key / credential / autoresponder body / message content
// (MA4); every value validated and escaped for its format; sync() never
// deletes mail DATA; mass-removal guard; idempotent through the render
// fingerprint; MailDriverError with `detail` for the staff only, A6).
//
// Containers (spec.ts): oblimint-mail (Postfix + Dovecot, public mail ports),
// oblimint-mail-rspamd, oblimint-mail-redis. oblimint-mail is on MAIL_NETWORK
// (clients: webmail, relay, edge, panel) AND on MAIL_CORE_NETWORK; Rspamd and
// Redis are on MAIL_CORE_NETWORK only (unauthenticated milter / Redis never
// reachable from the Internet-facing members of MAIL_NETWORK).
// Configuration: render.ts (pure) → apply.ts (atomic files + manifest) →
// `oblimint-mail-ctl reload` (compile into a new generation, postfix check +
// doveconf, switch, postfix reload + doveadm reload) and
// `oblimint-rspamd-ctl configtest`, then a restart of oblimint-mail-rspamd
// (Rspamd -f writes no pid file and 3.10 crashes on SIGHUP: no in-place
// reload) — only when a non-map rspamd/ file or a DKIM key changed: the
// limits maps that every mailbox / alias change rewrites are file maps Rspamd
// reloads by itself (apply.ts reloadPartOf), so they never open the ~30 s
// window where Postfix tempfails every SMTP session. A failed check keeps the
// running configuration and restores the previous files; a failed Rspamd
// restart after every check passed keeps the (checked) files and leaves
// Rspamd unconfirmed, retried at the next sync.
// ClamAV: the P3 scanner, reached over clamd TCP on MAIL_CORE_NETWORK (it is
// attached here at ensure / every sync while settings.clamav is on, because
// a scanner recreation drops the attachment).
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_KEY = 'mail:engine:postfix-dovecot';
const READY_TIMEOUT_MS = 120_000;
const RELOAD_TIMEOUT_MS = 120_000;
const CTL_TIMEOUT_MS = 60_000;
const QUEUE_MAX = 1000;
const DETAIL_MAX = 2_000;

export const POSTFIX_DOVECOT_CAPABILITIES: MailEngineCapabilities = {
  supported: true,
  mailboxes: true,
  sieve: true,
  appPasswordNets: true,
  quotaUsage: true,
  queue: true,
  clamav: true,
  greylisting: true,
  passwordSchemes: ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT', 'SSHA512', 'SSHA256', 'SSHA'],
};

/** Settings the deployment needs outside a sync (bootstrap configuration, scanner attachment). */
export interface EngineBootSettings {
  hostname: string | null;
  maxMessageSizeMb: number;
  spamTagScore: number;
  spamRejectScore: number;
  greylisting: boolean;
  clamav: boolean;
}

/** Everything with a side effect, injectable (driver.test.ts). */
export interface PostfixDovecotDeps {
  docker: () => Promise<Docker>;
  exec: (docker: Docker, container: string, cmd: string[], timeoutMs: number) => Promise<ExecResult>;
  ensureNetwork: (log: Log) => Promise<void>;
  bootSettings: () => Promise<EngineBootSettings>;
  local: HostingLayout;
  host: HostingLayout;
  hostDataDir: () => string;
  bindAddresses: () => string[];
  /** settings scanner.maxFileSizeMb (clamd's stream limit); null when unknown. */
  scannerMaxFileSizeMb: () => Promise<number | null>;
  /**
   * Re-ensures the P3 scanner so its clamd TCP socket matches what the mail
   * engine needs (scannerInfra: on only for postfix-dovecot ∧ mail.clamav,
   * bound to the oblimint-mail-core address). Started in the background.
   */
  refreshScanner: (log: Log) => Promise<void>;
  /** chown / chmod for real (Linux as root). */
  setOwners: boolean;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): PostfixDovecotDeps => ({
  docker: async () => engineFor(await localNodeId()),
  exec: (docker, container, cmd, timeoutMs) => execWith(docker, container, cmd, { timeoutMs }),
  ensureNetwork: async (log) => (await import('../../network')).ensureMailNetwork(log),
  bootSettings: async () => {
    const { platformSettings } = await import('../../../platformSettings');
    const { mailHostname } = await import('../../contracts');
    const s = await platformSettings.section('mail');
    return {
      hostname: await mailHostname(),
      maxMessageSizeMb: s.maxMessageSizeMb,
      spamTagScore: s.spamTagScore,
      spamRejectScore: s.spamRejectScore,
      greylisting: s.greylisting,
      clamav: s.clamav,
    };
  },
  local: localPaths,
  host: hostPaths,
  hostDataDir: () => config.hostDataDir,
  bindAddresses: () => config.hosting.mailBind,
  scannerMaxFileSizeMb: async () => {
    try {
      const { platformSettings } = await import('../../../platformSettings');
      return (await platformSettings.section('scanner')).maxFileSizeMb;
    } catch {
      return null;
    }
  },
  refreshScanner: async (log) => (await import('../../../scan/scannerInfra')).scannerInfraComponent.ensure(log),
  setOwners: process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const capDetail = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s);
const execDetail = (r: ExecResult): string => capDetail(`${r.stdout}\n${r.stderr}`.trim());

/** Subnets + gateways of MAIL_NETWORK (IPAM). Missing network ⇒ empty lists. */
export async function mailNetworkTopology(docker: Docker): Promise<{ subnets: string[]; gateways: string[] }> {
  const net = await inspectNetwork(docker, MAIL_NETWORK);
  const cfg = ((net?.IPAM?.Config ?? []) as Array<{ Subnet?: string; Gateway?: string }>);
  const subnets: string[] = [];
  const gateways: string[] = [];
  for (const c of cfg) {
    const subnet = c.Subnet?.trim();
    if (!subnet || !/^[0-9a-f:.]+\/\d{1,3}$/i.test(subnet)) continue;
    subnets.push(subnet);
    const gw = c.Gateway?.trim() || firstHost(subnet);
    if (gw) gateways.push(gw);
  }
  return { subnets, gateways };
}

async function isRunning(docker: Docker, name: string): Promise<boolean> {
  const info = await inspectContainer(docker, name);
  return !!info?.State?.Running;
}

/**
 * MAIL_CORE_NETWORK (back end: engine, Rspamd, Redis, scanner). A plain bridge
 * (Rspamd needs DNS), labelled internal, never oblimint.account.
 */
export async function ensureCoreNetwork(docker: Docker, log: Log): Promise<void> {
  const existing = await inspectNetwork(docker, MAIL_CORE_NETWORK);
  if (!existing) {
    await createNetwork(docker, MAIL_CORE_NETWORK, { [LABELS.internal]: 'true', 'oblimint.mail-engine': ENGINE });
    log(`Network ${MAIL_CORE_NETWORK} created`);
  } else if (existing.Labels?.[LABELS.account] !== undefined) {
    throw new MailDriverError('invalidState', `Network ${MAIL_CORE_NETWORK} carries the ${LABELS.account} label: remove it by hand (docker network rm ${MAIL_CORE_NETWORK})`);
  }
}

/**
 * Creates / recreates (spec drift) / starts one container. extraNetworks are
 * connected (alias = container name) BEFORE a new container starts, and
 * re-checked on an existing one.
 */
async function ensureContainer(
  docker: Docker, spec: Docker.ContainerCreateOptions, log: Log, extraNetworks: readonly string[] = [],
): Promise<'created' | 'recreated' | 'started' | 'unchanged'> {
  const name = spec.name!;
  const attach = async () => {
    for (const net of extraNetworks) {
      if (await connectNetwork(docker, net, name, [name])) log(`${name} attached to ${net}`);
    }
  };
  const fresh = async (): Promise<void> => {
    await recreateContainer(docker, spec, false);
    await attach();
    await startContainer(docker, name);
  };
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  if (!info) {
    log(`Creating ${name} (${spec.Image})`);
    await fresh();
    return 'created';
  }
  if (labelHash(info.Config?.Labels) !== specHashLabel(spec)) {
    log(`${name}: specification changed, recreating`);
    await fresh();
    return 'recreated';
  }
  const attached = info.NetworkSettings?.Networks ?? {};
  if (extraNetworks.some((n) => !attached[n])) await attach();
  if (!info.State?.Running) {
    log(`Starting ${name}`);
    await startContainer(docker, name);
    return 'started';
  }
  log(`${name} is up to date and running`);
  return 'unchanged';
}

/**
 * clamd of the shared scanner on MAIL_CORE_NETWORK while ClamAV is wanted,
 * detached otherwise (R-CLAMD-TCP: exposure kept to what is used — never on
 * MAIL_NETWORK, where the webmail / edge / relay are; an attachment left there
 * by an earlier version is removed). Never throws.
 *
 * `available`: ClamAV is wanted and the scanner runs attached to
 * MAIL_CORE_NETWORK, so its name resolves from Rspamd. Rspamd resolves the
 * antivirus servers when it loads its configuration: a ClamAV rule naming a
 * scanner that is not deployed (settings scanner.enabled off, the default) or
 * stopped makes configtest fail and blocks every sync, so the rule is only
 * rendered while available (withScanner).
 */
async function syncScannerAttachment(docker: Docker, wanted: boolean, log: Log): Promise<{ stale: boolean; available: boolean }> {
  let stale = false;
  let available = false;
  try {
    const info = await inspectContainer(docker, SCANNER_CONTAINER);
    if (!info) {
      if (wanted) log(`ClamAV: ${SCANNER_CONTAINER} is not deployed, inbound mail is not scanned for viruses`);
      return { stale: false, available: false };
    }
    // R-CLAMD-TCP: the scanner's clamd TCP socket exists only for this engine
    // with ClamAV, bound inside oblimint-mail-core (scannerSpec / scand).
    const core = wanted ? await inspectNetwork(docker, MAIL_CORE_NETWORK) : null;
    const wantNets = normalizeClamdTcpNets(((core?.IPAM?.Config ?? []) as Array<{ Subnet?: string }>).map((c) => c.Subnet ?? ''));
    const haveNets = clamdTcpNetsOf(info.Config?.Env);
    stale = wantNets.join(',') !== haveNets.join(',') && (wantNets.length > 0 || haveNets.length > 0);
    if (stale) log(`ClamAV: ${SCANNER_CONTAINER} clamd TCP socket ${wantNets.length > 0 ? 'missing / outdated' : 'no longer needed'}: the scanner is redeployed`);
    const nets = info.NetworkSettings?.Networks ?? {};
    if (wanted && !nets[MAIL_CORE_NETWORK]) {
      await connectNetwork(docker, MAIL_CORE_NETWORK, SCANNER_CONTAINER, [SCANNER_CONTAINER]);
      log(`ClamAV: ${SCANNER_CONTAINER} attached to ${MAIL_CORE_NETWORK}`);
    }
    if (wanted) {
      available = !!info.State?.Running;
      if (!available) log(`ClamAV: ${SCANNER_CONTAINER} is not running, inbound mail is not scanned for viruses`);
    } else if (!wanted && nets[MAIL_CORE_NETWORK]) {
      await disconnectNetwork(docker, MAIL_CORE_NETWORK, SCANNER_CONTAINER);
      log(`ClamAV off: ${SCANNER_CONTAINER} detached from ${MAIL_CORE_NETWORK}`);
    }
    if (nets[MAIL_NETWORK]) {
      // left by an earlier version; kept only while an Rspamd of that version
      // (still on MAIL_NETWORK, not recreated by ensure yet) needs it
      const rspamd = await inspectContainer(docker, MAIL_RSPAMD_CONTAINER);
      const legacyRspamd = wanted && !!rspamd?.NetworkSettings?.Networks?.[MAIL_NETWORK];
      if (!legacyRspamd) {
        await disconnectNetwork(docker, MAIL_NETWORK, SCANNER_CONTAINER);
        log(`ClamAV: ${SCANNER_CONTAINER} detached from ${MAIL_NETWORK}`);
      }
    }
  } catch (err) {
    log(`ClamAV: could not ${wanted ? 'attach' : 'detach'} ${SCANNER_CONTAINER}: ${errText(err)}`);
    available = false;
  }
  return { stale, available };
}

/** The state actually rendered: no ClamAV rule while the scanner cannot be reached. */
function withScanner(state: MailDesiredState, available: boolean): MailDesiredState {
  if (available || !state.settings?.clamdAddress) return state;
  return { ...state, settings: { ...state.settings, clamdAddress: null } };
}

function emptyState(s: EngineBootSettings, now: Date): MailDesiredState {
  return {
    generatedAt: now.toISOString(),
    settings: {
      hostname: s.hostname || 'localhost',
      maxMessageSizeMb: s.maxMessageSizeMb,
      spamTagScore: s.spamTagScore,
      spamRejectScore: s.spamRejectScore,
      greylisting: s.greylisting,
      clamav: false,
      clamdAddress: null,
    },
    domains: [],
    mailboxes: [],
    aliases: [],
    appPasswords: [],
    dkim: [],
    tls: [],
    relay: { relayHost: '', relayAddresses: [] },
  };
}

export function createPostfixDovecotDriver(overrides: Partial<PostfixDovecotDeps> = {}): MailDriver {
  const d: PostfixDovecotDeps = { ...defaultDeps(), ...overrides };
  const configDir = () => d.local.mailEngineConfig(ENGINE);
  const dataDirs = () => engineDataDirs(d.local.mailEngineData(ENGINE));

  let scannerRefresh: Promise<void> | null = null;
  /** Background scanner redeploy (one at a time; never blocks / fails a sync). */
  function refreshScanner(log: Log): Promise<void> {
    if (scannerRefresh) return scannerRefresh;
    scannerRefresh = (async () => {
      try {
        await d.refreshScanner(log);
      } catch (err) {
        log(`ClamAV: scanner redeploy failed: ${errText(err)}`);
      } finally {
        scannerRefresh = null;
      }
    })();
    return scannerRefresh;
  }

  async function dockerOrThrow(): Promise<Docker> {
    try {
      return await d.docker();
    } catch (err) {
      throw new MailDriverError('unavailable', 'Docker is unreachable', errText(err));
    }
  }

  /** Runs a ctl command; non-running container ⇒ notDeployed / unavailable. */
  async function ctl(docker: Docker, container: string, cmd: string[], timeoutMs = CTL_TIMEOUT_MS): Promise<ExecResult> {
    const info = await inspectContainer(docker, container).catch((err) => {
      throw new MailDriverError('unavailable', 'Docker is unreachable', errText(err));
    });
    if (!info) throw new MailDriverError('notDeployed', `${container} is not deployed`);
    if (!info.State?.Running) throw new MailDriverError('unavailable', `${container} is not running`);
    try {
      return await d.exec(docker, container, cmd, timeoutMs);
    } catch (err) {
      const text = errText(err);
      throw new MailDriverError(/timed out/i.test(text) ? 'timeout' : 'unavailable', `${container}: command failed`, capDetail(text));
    }
  }

  /** Directories of the engine (Linux: owners / modes for the containers' users). */
  function prepareDirs(): void {
    const data = dataDirs();
    const dirs: Array<[string, number, number, number]> = [
      [d.local.mailRoot(), 0o711, 0, 0],
      [d.local.mailEngineData(ENGINE), 0o711, 0, 0],
      [data.vmail, 0o700, VMAIL_UID, VMAIL_GID],
      [data.spool, 0o755, 0, 0],
      [data.state, 0o755, 0, 0],
      [configDir(), 0o700, 0, 0],
      [path.posix.join(configDir(), 'rspamd'), 0o755, 0, 0],
      [d.local.mailDkim(), 0o750, 0, RSPAMD_GID],
      [d.local.mailCerts(), 0o750, 0, 0],
      [d.local.mailRedis(), 0o700, REDIS_UID, REDIS_UID],
    ];
    for (const [dir, mode, uid, gid] of dirs) {
      fs.mkdirSync(dir, { recursive: true, mode });
      if (!d.setOwners) continue;
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new MailDriverError('invalidState', `${dir} is not a plain directory`);
      fs.chownSync(dir, uid, gid);
      fs.chmodSync(dir, mode);
    }
  }

  /**
   * Checks + reloads; returns the parts not applied (container not running:
   * written, NOT checked; or Rspamd not restarted after its check): apply.ts
   * keeps them unconfirmed and applies them again at the next sync.
   * Every check runs before anything is reloaded; once the engine has
   * reloaded the new generation nothing may throw any more (apply.ts would
   * restore files the running engine no longer matches).
   */
  async function reloadParts(docker: Docker, parts: Set<ReloadPart>): Promise<ReloadPart[]> {
    const rspamdUp = parts.has('rspamd') && await isRunning(docker, MAIL_RSPAMD_CONTAINER);
    const engineUp = parts.has('engine') && await isRunning(docker, MAIL_CONTAINER);
    const skipped: ReloadPart[] = [];
    if (parts.has('rspamd') && !rspamdUp) skipped.push('rspamd');
    if (parts.has('engine') && !engineUp) skipped.push('engine');
    if (rspamdUp) {
      const r = await ctl(docker, MAIL_RSPAMD_CONTAINER, [RSPAMD_CTL, 'configtest'], RELOAD_TIMEOUT_MS);
      if (r.exitCode !== 0) throw new MailDriverError('applyFailed', 'Rspamd refused the new configuration', execDetail(r));
    }
    if (engineUp) {
      const r = await ctl(docker, MAIL_CONTAINER, [MAIL_CTL, 'reload'], RELOAD_TIMEOUT_MS);
      if (r.exitCode !== 0) throw new MailDriverError('applyFailed', 'Postfix / Dovecot refused the new configuration', execDetail(r));
    }
    if (rspamdUp) {
      // Rspamd reads its configuration at start only (no pid file in the
      // foreground, SIGHUP crashes 3.10): the container is restarted. Postfix
      // tempfails every SMTP session (milter_default_action) until Rspamd is
      // ready again (~30 s on the Linux test host): apply.ts asks for it only when a
      // non-map rspamd/ file or a DKIM key changed (settings, domains, keys),
      // never for the limits maps a mailbox / alias change rewrites.
      try {
        await restartContainer(docker, MAIL_RSPAMD_CONTAINER);
      } catch (err) {
        logger.warn({ engine: ENGINE, err: capDetail(errText(err)) }, 'Rspamd could not be restarted: its configuration is applied again at the next sync');
        skipped.push('rspamd');
      }
    }
    return skipped;
  }

  async function renderAndApply(docker: Docker, state: MailDesiredState, opts: { allowMassRemoval?: boolean }) {
    const topo = await mailNetworkTopology(docker).catch((err) => {
      throw new MailDriverError('unavailable', 'Docker is unreachable', errText(err));
    });
    const clamdMaxFileSizeMb = await d.scannerMaxFileSizeMb().catch(() => null);
    let out;
    try {
      out = renderConfig(state, {
        now: d.now(),
        mailSubnets: topo.subnets,
        mailGateways: topo.gateways,
        hostCertsDir: d.host.mailCerts(),
        clamdMaxFileSizeMb,
      });
    } catch (err) {
      if (err instanceof RenderError) throw new MailDriverError('invalidState', `Invalid mail state: ${err.message}`);
      throw err;
    }
    const outcome = await applyRender(out, {
      configDir: configDir(),
      dkimDir: d.local.mailDkim(),
      setOwners: d.setOwners,
      reload: (parts) => reloadParts(docker, parts),
      now: d.now,
    }, opts);
    return { out, outcome };
  }

  async function waitReady(docker: Docker, log: Log): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = '';
    for (;;) {
      try {
        const r = await d.exec(docker, MAIL_CONTAINER, [MAIL_CTL, 'ping'], 15_000);
        if (r.exitCode === 0) {
          log(`${MAIL_CONTAINER}: Postfix and Dovecot are running`);
          return;
        }
        last = execDetail(r);
      } catch (err) {
        last = errText(err);
      }
      if (Date.now() > deadline) throw new MailDriverError('timeout', `${MAIL_CONTAINER} is not ready after ${READY_TIMEOUT_MS / 1000} s`, capDetail(last));
      await d.sleep(2_000);
    }
  }

  async function containerStatus(docker: Docker | null, name: string, part: string): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'mail', deployed: false, running: false, image: null, version: null, detail: null };
    if (!docker) return { ...base, detail: `${name}: Docker is unreachable` };
    try {
      const info = await inspectContainer(docker, name);
      if (!info) return { ...base, detail: `${name} (${part}): not deployed` };
      const running = !!info.State?.Running;
      return {
        ...base,
        deployed: true,
        running,
        image: info.Config?.Image ?? null,
        version: info.Config?.Labels?.['org.opencontainers.image.version'] ?? null,
        detail: running ? null : `${name} (${part}): ${info.State?.Status ?? 'stopped'}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}`,
      };
    } catch (err) {
      return { ...base, detail: `${name}: ${capDetail(errText(err))}` };
    }
  }

  const driver: MailDriver = {
    engine: ENGINE,
    capabilities: POSTFIX_DOVECOT_CAPABILITIES,

    async ensure(log) {
      await withLock(LOCK_KEY, async () => {
        await d.ensureNetwork(log);
        const docker = await dockerOrThrow();
        await ensureCoreNetwork(docker, log);
        const settings = await d.bootSettings();
        prepareDirs();
        if (!readManifest(configDir())) {
          // first deployment: a valid configuration with no domain (refuses all mail) until mail-core syncs
          log('Writing the initial mail configuration (no domain yet)');
          await renderAndApply(docker, emptyState(settings, d.now()), { allowMassRemoval: true });
        }
        const hostDataDir = d.hostDataDir();
        await ensureContainer(docker, redisContainerSpec({ hostDataDir }), log);
        await ensureContainer(docker, rspamdContainerSpec({ hostDataDir }), log);
        await ensureContainer(docker, engineContainerSpec({ hostDataDir, bindAddresses: d.bindAddresses() }), log, ENGINE_EXTRA_NETWORKS);
        if ((await syncScannerAttachment(docker, settings.clamav, log)).stale) void refreshScanner(log);
        await waitReady(docker, log);
      });
    },

    async status() {
      let docker: Docker | null = null;
      try {
        docker = await d.docker();
      } catch { /* reported per container */ }
      return Promise.all([
        containerStatus(docker, MAIL_CONTAINER, 'Postfix + Dovecot'),
        containerStatus(docker, MAIL_RSPAMD_CONTAINER, 'Rspamd'),
        containerStatus(docker, MAIL_REDIS_CONTAINER, 'Redis'),
      ]);
    },

    async version() {
      try {
        const docker = await d.docker();
        if (!(await isRunning(docker, MAIL_CONTAINER))) return null;
        const r = await d.exec(docker, MAIL_CONTAINER, [MAIL_CTL, 'version'], 15_000);
        const v = r.exitCode === 0 ? r.stdout.trim().split('\n')[0]?.trim() : '';
        return v ? v.slice(0, 200) : null;
      } catch {
        return null;
      }
    },

    async remove(log) {
      await withLock(LOCK_KEY, async () => {
        const docker = await dockerOrThrow();
        for (const name of [MAIL_CONTAINER, MAIL_RSPAMD_CONTAINER, MAIL_REDIS_CONTAINER]) {
          const info = await inspectContainer(docker, name);
          if (!info) continue;
          log(`Removing ${name} (mail data kept)`);
          if (info.State?.Running) await stopContainer(docker, name, name === MAIL_CONTAINER ? 30 : 10).catch(() => {});
          await removeContainer(docker, name);
        }
        const { stale } = await syncScannerAttachment(docker, false, log);
        try {
          await removeNetwork(docker, MAIL_CORE_NETWORK);
        } catch (err) {
          log(`${MAIL_CORE_NETWORK} not removed: ${errText(err)}`);
        }
        // after the network is gone: the redeployed scanner has no clamd TCP socket
        if (stale) void refreshScanner(log);
      });
    },

    async sync(state: MailDesiredState, opts: MailSyncOptions): Promise<MailSyncResult> {
      const started = Date.now();
      return withLock(LOCK_KEY, async () => {
        const docker = await dockerOrThrow();
        const slog = (l: string) => logger.info({ engine: ENGINE }, l);
        const scanner = await syncScannerAttachment(docker, !!state.settings?.clamav, slog);
        if (scanner.stale) void refreshScanner(slog);
        const { out, outcome } = await renderAndApply(docker, withScanner(state, scanner.available),{ allowMassRemoval: opts.allowMassRemoval });
        if (outcome.changed) {
          logger.info({ engine: ENGINE, reason: opts.reason, parts: outcome.parts, ...out.counts, errors: Object.keys(out.domainErrors).length }, 'mail engine configuration applied');
        }
        if (outcome.unconfirmed.length > 0) {
          // Written, never checked: reported (lastSyncError) and checked again at every sync until the container runs.
          const names = outcome.unconfirmed.map((p) => (p === 'engine' ? MAIL_CONTAINER : MAIL_RSPAMD_CONTAINER)).join(', ');
          throw new MailDriverError('unavailable', `${names} not running (or not restarted): the mail configuration is written but not checked yet (checked again at the next sync)`);
        }
        return {
          ok: Object.keys(out.domainErrors).length === 0,
          changed: outcome.changed,
          domains: out.counts.domains,
          mailboxes: out.counts.mailboxes,
          aliases: out.counts.aliases,
          domainErrors: out.domainErrors,
          durationMs: Date.now() - started,
        };
      });
    },

    async reloadTls() {
      await withLock(LOCK_KEY, async () => {
        const docker = await dockerOrThrow();
        if (!(await isRunning(docker, MAIL_CONTAINER))) return; // the next start reads the certificates
        const r = await ctl(docker, MAIL_CONTAINER, [MAIL_CTL, 'reload'], RELOAD_TIMEOUT_MS);
        if (r.exitCode !== 0) throw new MailDriverError('applyFailed', 'Postfix / Dovecot could not reload the certificates', execDetail(r));
      });
    },

    async purge(target) {
      const removed = await purgeMailData(dataDirs().vmail, target);
      logger.info({ engine: ENGINE, kind: target.kind, name: target.name, removed }, 'mail data purge');
    },

    async usage(): Promise<MailboxUsage[]> {
      const docker = await dockerOrThrow();
      const r = await ctl(docker, MAIL_CONTAINER, [MAIL_CTL, 'usage'], 120_000);
      if (r.exitCode !== 0) throw new MailDriverError('unavailable', 'The mailbox usage could not be read', execDetail(r));
      const file = path.join(dataDirs().state, CTL_OUT_DIR, 'usage.json');
      try {
        return parseDoveadmQuotaJson(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new MailDriverError('unavailable', 'The mailbox usage could not be read', capDetail(errText(err)));
      }
    },

    async queue(opts): Promise<MailQueueEntry[]> {
      const limit = Math.min(QUEUE_MAX, Math.max(1, Math.floor(Number(opts?.limit) || 100)));
      const docker = await dockerOrThrow();
      const r = await ctl(docker, MAIL_CONTAINER, [MAIL_CTL, 'queue', String(limit)]);
      if (r.exitCode !== 0) throw new MailDriverError('unavailable', 'The mail queue could not be read', execDetail(r));
      const file = path.join(dataDirs().state, CTL_OUT_DIR, 'queue.jsonl');
      try {
        return parsePostqueueJson(fs.readFileSync(file, 'utf8'), limit);
      } catch (err) {
        throw new MailDriverError('unavailable', 'The mail queue could not be read', capDetail(errText(err)));
      }
    },

    async queueAction(queueId, action) {
      if (typeof queueId !== 'string' || !QUEUE_ID_RE.test(queueId)) throw new MailDriverError('notFound', 'Unknown queue item');
      if (action !== 'retry' && action !== 'delete') throw new MailDriverError('invalidState', 'Unknown queue action');
      const docker = await dockerOrThrow();
      const r = await ctl(docker, MAIL_CONTAINER, [MAIL_CTL, action, queueId]);
      if (r.exitCode === 3) throw new MailDriverError('notFound', 'Unknown queue item');
      if (r.exitCode !== 0) throw new MailDriverError('unavailable', `The queue item could not be ${action === 'retry' ? 'retried' : 'deleted'}`, execDetail(r));
    },

    logContainers() {
      return [MAIL_CONTAINER, MAIL_RSPAMD_CONTAINER];
    },

    parseLogLine(container, line) {
      try {
        return parseMailLogLine(container, line);
      } catch {
        return null;
      }
    },

    imapEndpoint() { return { host: MAIL_CONTAINER, port: 143, tls: 'none' }; },
    submissionEndpoint() { return { host: MAIL_CONTAINER, port: 587, tls: 'starttls' }; },
    sieveEndpoint() { return { host: MAIL_CONTAINER, port: 4190, tls: 'none' }; },
    relayTarget() { return { host: MAIL_CONTAINER, port: RELAY_INTAKE_PORT, tls: 'none' }; },
  };
  return driver;
}

export const postfixDovecotDriver: MailDriver = createPostfixDovecotDriver();

