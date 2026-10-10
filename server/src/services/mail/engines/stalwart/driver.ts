import crypto from 'crypto';
import path from 'path';
import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { config } from '../../../../config';
import { logger } from '../../../../utils/logger';
import type {
  DesiredMailSettings, MailboxUsage, MailDesiredState, MailDriver, MailQueueEntry, MailSyncOptions, MailSyncResult,
} from '../../driver';
import { MailDriverError } from '../../driver';
import {
  containerState, ensureImage, inspectContainer, labelHash, recreateContainer, removeContainer, restartContainer, startContainer, stopContainer,
} from '../../../docker/dockerOps';
import { engineFor, localNodeId } from '../../../docker/engine';
import { withLock } from '../../../docker/locks';
import { specHashLabel } from '../../../docker/specs';
import { MAIL_CONTAINER } from '../../../hosting/naming';
import { hostingLayout, localPaths } from '../../../hosting/paths';
import { errText } from '../../../setup/docker';
import { StalwartApi, StalwartApiError } from './api';
import { DYNAMIC_SETTINGS, isDynamicSetting, renderStalwartConfig } from './config';
import {
  ADMIN_USER, MASTER_USER, PERM_LOGIN, SIEVE_SCRIPT_NAME, STALWART_GID, STALWART_PUBLIC_PORTS, STALWART_RELAY_PORT, STALWART_UID,
  STALWART_VERSION, SYNC_STATE_FILE,
} from './constants';
import { ensureDir, fileExists, readJsonFile, removeStale, writeIfChanged, type FileOwner } from './files';
import { desiredSendLimits, limitsCovered, limitsStale, NO_LIMITS, parseLimits, staleRestartDue, type SendLimits } from './limits';
import { parseLogLine } from './logs';
import { buildDesiredPrincipals, diffPrincipals, planSize, STALWART_PASSWORD_SCHEMES, type PrincipalOp } from './principals';
import { queueFromApi, QUEUE_ID_RE, usageFromPrincipals } from './runtime';
import { ensureAdminSecret, readAdminSecret, type StalwartAdminSecret } from './secret';
import { renderSieveScript } from './sieve';
import { stalwartContainerSpec } from './spec';
import { domainName, isDomainName, isMailAddress } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// stalwart engine (docs/P4-PLAN.md §5.3) — module engine-stalwart.
//
// Container oblimint-mail (spec.ts) running Stalwart (images/mail-stalwart)
// with its store under paths.mailEngineData('stalwart'); configuration
// rendered by the panel (config.ts) into paths.mailEngineConfig('stalwart')
// and applied by restarting the container (Stalwart 0.12.4 reads it at start
// only), the admin API (api.ts, mail network only, MA7) reporting errors;
// directory (domains, mailboxes, aliases) converged by DIFF through the same
// API (principals.ts; only ACTIVE domains get a domain principal, MA10);
// per-mailbox forwarding / autoresponder as a sieve script installed through
// JMAP (sieve.ts), login-disabled mailboxes included. A restart is retried
// until the engine accepted the files on disk (appliedConfig fingerprint).
//
// Report P4 (docs/P4b-PLAN.md §19) — data changes are LIVE: a mailbox
// create / delete, a password / app password, a quota, a send / receive /
// login toggle (disabledPermissions), an alias / list, a forward /
// autoresponder only go through the admin API (principals, secrets, quota,
// permissions, lists) and JMAP (sieve): no restart, open IMAP sessions kept;
// no /api/reload either, EXCEPT after a revocation (address / member removed,
// mailbox detached or deleted, permission disabled): Stalwart caches positive
// directory lookups and only a reload drops them (stale RCPT 250 otherwise,
// see sync — directoryReloadPending). The configuration file holds no mailbox: the hourly limits
// are per account rate on the mail DOMAINS + a strictest-rate fallback
// (limits.ts), so the file only changes with the structure (listeners, TLS,
// host name, settings) or when a limit must become stricter
// than what the running engine enforces (MA9) — the only immediate restarts.
// A mail domain, its DKIM keys, its message size and the site relay's
// addresses (relay / SPF / DMARC expressions, DSN signing) are LIVE too: those
// settings live in Stalwart's settings store (config.ts DYNAMIC_SETTINGS),
// diffed against what the engine holds, replaced through POST /api/settings
// and applied by GET /api/reload (no restart, open sessions kept); limits left STRICTER than
// desired restart in a quiet window after 6 h, at the latest after 24 h
// (limitsStaleSince, limits.ts). Otherwise the file on disk is kept equal to
// what the engine loaded (appliedLimits).
// Sync bookkeeping lives in the panel-only configuration directory, never in
// the container-writable store.
//
// Capabilities: sieve yes; app passwords are plain extra secrets without any
// source-network restriction (risk R-STALWART-APPPW, appPasswordNets=false);
// quota usage and queue through the API; NO ClamAV (clamav=false: the UI says
// so; Stalwart's own spam filter + SPF / DKIM / DMARC / ARC are on, MA14);
// greylisting through the spam filter.
//
// Every call is bounded (API timeouts, ready deadline); errors are
// MailDriverError with the raw backend text in `detail` (staff only, A6),
// hashes redacted (MA4). Nothing of a secret / hash / autoresponder body is
// ever logged.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_KEY = 'mail:stalwart';
const READY_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONFIG_FILE = 'config.toml';
const DKIM_DIR = 'dkim';
const DKIM_FILE_RE = /^k[0-9a-f]{16}\.pem$/;

/** Sync bookkeeping (fingerprints only) in the panel-only configuration directory (constants.ts). */
interface SyncState {
  version: 1;
  /** principal name → sha256 of its secrets as last pushed. */
  secrets: Record<string, string>;
  /** mailbox → sha256 of its sieve script as last installed ('' = none). */
  sieve: Record<string, string>;
  /**
   * Fingerprint of the STRUCTURE of config.toml (rendered without any sending
   * limit) + DKIM keys as last ACCEPTED after a restart ('' = unknown / a
   * restart or reload failed): the sync restarts whenever the structure
   * differs from it, so a failed restart is retried on the next pass.
   */
  appliedConfig: string;
  /** Hourly limits the running engine loaded at its last accepted restart (limits.ts). */
  appliedLimits: SendLimits;
  /** ISO time of the first sync that found appliedLimits STRICTER than desired (limitsStale), null = up to date. */
  limitsStaleSince: string | null;
  /** Domain settings written to the engine's store but not yet accepted by a reload (retried on the next pass). */
  settingsPending: boolean;
  /**
   * A revocation (address / member removed, mailbox detached, permission
   * disabled, list or domain deleted) reached the directory but the reload
   * that drops Stalwart's cached lookups has not succeeded yet (retried on the
   * next pass, see revokeCachedLookups).
   */
  directoryReloadPending: boolean;
}

export interface StalwartDriverDeps {
  /** Admin credentials; create=false → null when never generated. */
  credentials(create: boolean): Promise<StalwartAdminSecret | null>;
  /** Admin API client for these credentials. */
  api(creds: StalwartAdminSecret): StalwartApi;
  docker(): Promise<Docker>;
  ensureNetwork(log: (line: string) => void): Promise<void>;
  /** Node mail host name (contracts.mailHostname) for the bootstrap configuration. */
  hostname(): Promise<string | null>;
  /** Local (panel) paths. */
  configDir: string;
  dataDir: string;
  certsDir: string;
  /** Host directories that may prefix DesiredTlsCertificate paths. */
  certRoots: string[];
  /** Host data root for the container mounts. */
  hostDataDir: string;
  bindAddresses: string[];
  /** Owner of the engine files (null: no chown, tests / Windows). */
  owner: FileOwner | null;
  readyTimeoutMs?: number;
  now?: () => Date;
  /**
   * Restarts the engine container (default: docker restart of oblimint-mail).
   * Stalwart 0.12.4 reads config.toml at start only: /api/reload rebuilds from
   * the copy loaded at boot (the Linux test host), so a new file is applied by a restart.
   */
  restartEngine?: () => Promise<void>;
  /** Pause between readiness probes after a restart (tests: 0). */
  pollMs?: number;
}

function toDriverError(err: unknown, what: string): MailDriverError {
  if (err instanceof MailDriverError) return err;
  if (err instanceof StalwartApiError) {
    if (err.status === 0) return new MailDriverError('unavailable', `stalwart: ${what}: the engine API is unreachable`, err.message);
    if (err.status === 404) return new MailDriverError('notFound', `stalwart: ${what}: not found`, err.message);
    return new MailDriverError('applyFailed', `stalwart: ${what} failed`, err.message);
  }
  return new MailDriverError('applyFailed', `stalwart: ${what} failed`, errText(err));
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** Fingerprint of what a restart loads from the panel (config.toml; the domain settings are applied live). */
function configFingerprint(rendered: { toml: string }): string {
  return crypto.createHash('sha256').update('config.toml\0').update(rendered.toml).digest('hex');
}

/** Same keys, same values. */
function sameSettings(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}

/** Bootstrap settings (first start, before the first sync rewrites everything). */
function bootstrapSettings(hostname: string): DesiredMailSettings {
  return {
    hostname, maxMessageSizeMb: 50, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: false, clamdAddress: null,
  };
}

export function createStalwartDriver(deps: StalwartDriverDeps): MailDriver {
  const configFile = path.join(deps.configDir, CONFIG_FILE);
  const dkimDir = path.join(deps.configDir, DKIM_DIR);
  // Never in deps.dataDir: that store is writable by the container (MA7).
  const stateFile = path.join(deps.configDir, SYNC_STATE_FILE);
  const owner = deps.owner;
  const now = deps.now ?? (() => new Date());

  async function client(): Promise<{ api: StalwartApi; creds: StalwartAdminSecret }> {
    const creds = await deps.credentials(false);
    if (!creds) throw new MailDriverError('notDeployed', 'stalwart: the engine has not been deployed yet (no admin secret)');
    return { api: deps.api(creds), creds };
  }

  async function ensureDirs(): Promise<void> {
    const group = owner ? { uid: 0, gid: owner.gid } : null;
    await ensureDir(deps.configDir, 0o750, group);
    await ensureDir(dkimDir, 0o750, group);
    await ensureDir(deps.certsDir, 0o750, group);
    await ensureDir(deps.dataDir, 0o700, owner);
  }

  /** Writes config.toml; true when anything changed. */
  async function writeConfig(rendered: ReturnType<typeof renderStalwartConfig>): Promise<boolean> {
    const group = owner ? { uid: 0, gid: owner.gid } : null;
    let changed = false;
    if (await writeIfChanged(configFile, rendered.toml, 0o640, group)) changed = true;
    // DKIM keys live in the engine's settings store now: key files of an earlier version are removed.
    if (await removeStale(dkimDir, DKIM_FILE_RE, new Set())) changed = true;
    return changed;
  }

  /** The domain settings the engine's store holds (config.ts DYNAMIC_SETTINGS), full keys. */
  async function engineSettings(api: StalwartApi): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const d of DYNAMIC_SETTINGS) {
      for (const [k, v] of Object.entries(await api.listSettings(d.list))) if (isDynamicSetting(k)) out[k] = v;
    }
    return out;
  }

  async function readSyncState(): Promise<SyncState> {
    const j = await readJsonFile<Partial<SyncState>>(stateFile);
    return {
      version: 1,
      secrets: j?.secrets && typeof j.secrets === 'object' ? { ...j.secrets } : {},
      sieve: j?.sieve && typeof j.sieve === 'object' ? { ...j.sieve } : {},
      appliedConfig: typeof j?.appliedConfig === 'string' ? j.appliedConfig : '',
      appliedLimits: parseLimits(j?.appliedLimits),
      limitsStaleSince: typeof j?.limitsStaleSince === 'string' ? j.limitsStaleSince : null,
      settingsPending: j?.settingsPending === true,
      directoryReloadPending: j?.directoryReloadPending === true,
    };
  }

  async function writeSyncState(s: SyncState): Promise<void> {
    await writeIfChanged(stateFile, `${JSON.stringify(s)}\n`, 0o600, null);
  }

  /** Waits until the admin API answers again (after a restart). */
  async function waitApi(api: StalwartApi, what: string): Promise<void> {
    const timeout = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    let last = '';
    for (;;) {
      try {
        await api.listPrincipals('domain');
        return;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() > deadline) {
        throw new MailDriverError('timeout', `stalwart: ${what}: the admin API is not answering ${Math.round(timeout / 1000)} s after the restart`, last);
      }
      await sleep(deps.pollMs ?? 1_000);
    }
  }

  /**
   * Applies the files on disk: restart (Stalwart 0.12.4 reads config.toml at
   * start only — H8 refuted), wait for the API, then /api/reload to collect
   * the errors / warnings of the configuration it loaded (applyFailed when
   * rejected: the fingerprint is not recorded and the next sync restarts again).
   */
  async function reloadConfig(api: StalwartApi, what: string): Promise<void> {
    try {
      if (deps.restartEngine) await deps.restartEngine();
      else await restartContainer(await deps.docker(), MAIL_CONTAINER, 30);
    } catch (err) {
      throw new MailDriverError('applyFailed', `stalwart: ${what}: ${MAIL_CONTAINER} could not be restarted`, errText(err));
    }
    await waitApi(api, what);
    try {
      const { warnings } = await api.reload();
      for (const w of warnings.slice(0, 20)) logger.warn(`mail stalwart: configuration warning: ${w}`);
    } catch (err) {
      throw toDriverError(err, what);
    }
  }

  async function containerInfo(): Promise<Docker.ContainerInspectInfo | null> {
    return inspectContainer(await deps.docker(), MAIL_CONTAINER);
  }

  async function applyOp(api: StalwartApi, op: PrincipalOp): Promise<void> {
    if (op.kind === 'create') await api.createPrincipal(op.create!);
    else if (op.kind === 'update') await api.updatePrincipal(op.name, op.ops ?? []);
    else await api.deletePrincipal(op.name);
  }

  /**
   * Runs `fn` (a JMAP call impersonating `name`) — when `lift` is set, with the
   * `authenticate` permission of the mailbox lifted for the duration of the
   * call (H10b: the master impersonation of a login-disabled principal is
   * refused). Safe because such a mailbox holds NO secret (principals.ts:
   * loginEnabled=false → secrets []), so nobody but the master can log in
   * meanwhile. The permission is always disabled again; if that fails the
   * error is raised (and the next sync's diff disables it again anyway).
   */
  async function withImpersonation(api: StalwartApi, name: string, lift: boolean, fn: () => Promise<void>): Promise<void> {
    if (!lift) return fn();
    const perm = (action: 'addItem' | 'removeItem') => api.updatePrincipal(name, [{ action, field: 'disabledPermissions', value: PERM_LOGIN }]);
    await perm('removeItem');
    let failure: unknown = null;
    try {
      await fn();
    } catch (err) {
      failure = err;
    }
    try {
      await perm('addItem');
    } catch (err) {
      logger.error({ mailbox: name }, 'mail stalwart: login permission could not be disabled again after a sieve update (next sync retries)');
      throw failure ?? err;
    }
    if (failure) throw failure;
  }

  async function deploy(log: (line: string) => void): Promise<void> {
    await deps.ensureNetwork(log);
    await ensureDirs();
    const creds = await deps.credentials(true);
    if (!creds) throw new MailDriverError('applyFailed', 'stalwart: the admin secret could not be created');
    if (!(await fileExists(configFile))) {
      const host = (await deps.hostname().catch(() => null)) ?? '';
      const hostname = isDomainName(host) ? host : 'localhost.localdomain';
      log(`Writing the initial Stalwart configuration (host name ${hostname})`);
      await writeConfig(renderStalwartConfig({
        settings: bootstrapSettings(hostname), domains: [], sendLimits: NO_LIMITS, dkim: [], tls: [], relayAddresses: [], certRoots: deps.certRoots,
      }));
    }
    const docker = await deps.docker();
    const spec = stalwartContainerSpec({ hostDataDir: deps.hostDataDir, adminHash: creds.hash, bindAddresses: deps.bindAddresses });
    log(`Publishing the mail ports ${STALWART_PUBLIC_PORTS.join(', ')} on ${deps.bindAddresses.length ? deps.bindAddresses.join(', ') : 'every host address'} (admin API and relay port ${STALWART_RELAY_PORT} stay on the mail network)`);
    await ensureImage(docker, spec.Image!, log);
    const info = await inspectContainer(docker, MAIL_CONTAINER);
    try {
      if (!info) {
        log(`Creating ${MAIL_CONTAINER} (${spec.Image})`);
        await recreateContainer(docker, spec, true);
      } else if (labelHash(info.Config?.Labels) !== specHashLabel(spec)) {
        log(`${MAIL_CONTAINER}: specification changed, recreating (data kept)`);
        await recreateContainer(docker, spec, true);
      } else if (!info.State?.Running) {
        log(`Starting ${MAIL_CONTAINER}`);
        await startContainer(docker, MAIL_CONTAINER);
      } else {
        log(`${MAIL_CONTAINER} is up to date and running`);
      }
    } catch (err) {
      const msg = errText(err);
      throw new MailDriverError('applyFailed', `stalwart: ${MAIL_CONTAINER} could not be started`,
        /address already in use|port is already allocated/i.test(msg)
          ? `${msg} — a mail port is already taken on the host (another MTA?): free it or set OBLIMINT_MAIL_BIND`
          : msg);
    }
    log('Waiting for the Stalwart admin API…');
    const api = deps.api(creds);
    const deadline = Date.now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    let last = '';
    for (;;) {
      try {
        await api.listPrincipals('domain');
        log('Stalwart is answering');
        return;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() > deadline) {
        throw new MailDriverError('timeout', `stalwart: the admin API is not answering after ${Math.round((deps.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} s`, last);
      }
      await sleep(2_000);
    }
  }

  const driver: MailDriver = {
    engine: 'stalwart',
    capabilities: {
      supported: true,
      mailboxes: true,
      sieve: true,
      appPasswordNets: false,
      quotaUsage: true,
      queue: true,
      clamav: false,
      greylisting: true,
      passwordSchemes: STALWART_PASSWORD_SCHEMES,
    },

    // ── deployment ──
    async ensure(log) {
      // Every failure (network, directories, image pull, spec validation…) is a MailDriverError.
      await withLock(LOCK_KEY, () => deploy(log).catch((err) => { throw toDriverError(err, 'deployment'); }));
    },

    async status(): Promise<InfraComponentStatus[]> {
      const base: InfraComponentStatus = { id: 'mail', deployed: false, running: false, image: null, version: null, detail: null };
      try {
        const info = await containerInfo();
        if (!info) return [{ ...base, detail: 'stalwart: not deployed' }];
        const labels = info.Config?.Labels ?? {};
        const out: InfraComponentStatus = {
          ...base,
          deployed: true,
          running: !!info.State?.Running,
          image: info.Config?.Image ?? null,
          version: labels['org.oblimint.stalwart.version'] ?? null,
          detail: info.State?.Running ? null
            : `${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}${info.State?.Error ? `: ${info.State.Error}` : ''}`,
        };
        if (out.running) {
          try {
            const { api } = await client();
            await api.listPrincipals('domain');
          } catch (err) {
            out.detail = `API: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        return [out];
      } catch (err) {
        return [{ ...base, detail: errText(err) }];
      }
    },

    async version() {
      try {
        const info = await containerInfo();
        if (!info?.State?.Running) return null;
        return info.Config?.Labels?.['org.oblimint.stalwart.version'] ?? STALWART_VERSION;
      } catch {
        return null;
      }
    },

    async remove(log) {
      await withLock(LOCK_KEY, async () => {
        try {
          const docker = await deps.docker();
          if (!(await inspectContainer(docker, MAIL_CONTAINER))) {
            log(`${MAIL_CONTAINER} is not deployed`);
            return;
          }
          log(`Stopping ${MAIL_CONTAINER} (Stalwart data kept under mail/data/stalwart)`);
          await stopContainer(docker, MAIL_CONTAINER, 30);
          await removeContainer(docker, MAIL_CONTAINER);
        } catch (err) {
          throw toDriverError(err, `removal of ${MAIL_CONTAINER}`);
        }
      });
    },

    // ── convergence ──
    async sync(state: MailDesiredState, opts: MailSyncOptions): Promise<MailSyncResult> {
      const started = Date.now();
      return withLock(LOCK_KEY, async () => {
        const { api, creds } = await client();
        // Pure part first: an invalid state changes nothing.
        const desired = buildDesiredPrincipals(state, now());
        const desiredLimits = desiredSendLimits(state);
        const render = (sendLimits: SendLimits) => renderStalwartConfig({
          settings: state.settings,
          domains: state.domains,
          sendLimits,
          dkim: state.dkim,
          tls: state.tls,
          relayAddresses: state.relay.relayAddresses,
          certRoots: deps.certRoots,
        });
        const rendered = render(desiredLimits);
        // Fingerprint of the structure only (no limit): a mailbox change never moves it.
        const structureFp = configFingerprint(render(NO_LIMITS));
        for (const w of rendered.warnings) logger.warn(`mail stalwart: ${w}`);

        let current;
        try {
          const [domains, individuals, lists] = [
            await api.listPrincipals('domain'), await api.listPrincipals('individual'), await api.listPrincipals('list'),
          ];
          current = { domains, individuals, lists };
        } catch (err) {
          throw toDriverError(err, 'listing the directory');
        }
        // Local files (panel-only directory): any failure is a MailDriverError.
        const local = <T>(what: string, fn: () => Promise<T>): Promise<T> =>
          fn().catch((err) => { throw toDriverError(err, what); });
        const syncState = await local('reading the sync bookkeeping', readSyncState);
        let saved = JSON.stringify(syncState);
        const persist = async (): Promise<void> => {
          const cur = JSON.stringify(syncState);
          if (cur === saved) return;
          await local('writing the sync bookkeeping', () => writeSyncState(syncState));
          saved = cur;
        };
        // Throws massRemoval before anything is written.
        const plan = diffPrincipals(desired, current, { allowMassRemoval: !!opts.allowMassRemoval, knownSecrets: syncState.secrets });

        await local('preparing the engine directories', ensureDirs);
        // Restart only when the structure differs from what the engine
        // ACCEPTED (a failed or rejected restart is retried on the next pass
        // even though the files are unchanged by then), or when a sending limit
        // must become stricter than what it enforces (MA9). Otherwise the file
        // stays what the engine loaded: the data changes are live (header).
        let reloaded = false;
        let configChanged: boolean;
        let loaded: ReturnType<typeof renderStalwartConfig> | null = null;
        // Stricter than desired (safe) is tolerated for a bounded time only (limits.ts).
        const stale = limitsStale(syncState.appliedLimits, desiredLimits);
        if (!stale) syncState.limitsStaleSince = null;
        else syncState.limitsStaleSince ??= now().toISOString();
        const staleDue = stale && staleRestartDue(syncState.limitsStaleSince ? new Date(syncState.limitsStaleSince) : null, now());
        if (staleDue) logger.info({ since: syncState.limitsStaleSince }, 'mail stalwart: restart to load the exact sending limits (stricter limits kept too long)');
        const restart = syncState.appliedConfig !== structureFp || !limitsCovered(syncState.appliedLimits, desiredLimits) || staleDue;
        if (!restart) {
          try {
            loaded = render(syncState.appliedLimits);
          } catch {
            loaded = null; // bookkeeping no longer renderable: apply the desired limits
          }
        }
        // Domain settings (DKIM signatures + signing rule, message sizes): diffed against the engine's
        // store, replaced there when they differ, then loaded by the restart below or by a reload — never a
        // restart of their own (report P4, §19).
        let held: Record<string, string>;
        try {
          held = await engineSettings(api);
        } catch (err) {
          throw toDriverError(err, 'reading the domain settings');
        }
        let settingsChanged = false;
        if (!sameSettings(held, rendered.settings)) {
          syncState.settingsPending = true;
          await persist();
          try {
            await api.replaceSettings(DYNAMIC_SETTINGS.map((d) => (d.root === 'signature' ? 'signature.' : d.root)), rendered.settings);
          } catch (err) {
            throw toDriverError(err, 'writing the domain settings');
          }
          settingsChanged = true;
        }
        if (loaded) {
          configChanged = await local('writing the configuration', () => writeConfig(loaded!));
          if (syncState.settingsPending) {
            try {
              const { warnings } = await api.reload();
              for (const w of warnings.slice(0, 20)) logger.warn(`mail stalwart: configuration warning: ${w}`);
            } catch (err) {
              throw toDriverError(err, 'reloading the domain settings');
            }
            syncState.settingsPending = false;
            await persist();
            settingsChanged = true; // applied now (written by this pass or by an interrupted one)
            logger.info({ reason: opts.reason }, 'mail stalwart: domain settings applied live (no restart)');
          }
        } else {
          configChanged = await local('writing the configuration', () => writeConfig(rendered));
          await reloadConfig(api, 'reloading the configuration');
          reloaded = true;
          // Keys that were LOCAL before this restart (an upgrade moving them to
          // the store, e.g. the relay expressions) may have been listed with
          // their file values above and thus not written: the engine now reads
          // them from its store, so it is checked again (a stale or missing
          // value would fall back to Stalwart's defaults — site relay refused).
          let after: Record<string, string>;
          try {
            after = await engineSettings(api);
          } catch (err) {
            throw toDriverError(err, 'reading the domain settings');
          }
          if (!sameSettings(after, rendered.settings)) {
            try {
              await api.replaceSettings(DYNAMIC_SETTINGS.map((d) => (d.root === 'signature' ? 'signature.' : d.root)), rendered.settings);
              const { warnings } = await api.reload();
              for (const w of warnings.slice(0, 20)) logger.warn(`mail stalwart: configuration warning: ${w}`);
            } catch (err) {
              syncState.appliedConfig = ''; // retried (restart included) on the next pass
              await persist();
              throw toDriverError(err, 'writing the domain settings after the restart');
            }
            settingsChanged = true;
          }
          syncState.appliedConfig = structureFp;
          syncState.appliedLimits = desiredLimits;
          syncState.limitsStaleSince = null;
          syncState.settingsPending = false;
          await persist();
        }
        if (settingsChanged) configChanged = true;

        const domainErrors: Record<string, string> = {};
        const failedDomains = new Set<string>();
        /** Domains where a principal write failed (their sieve scripts wait for the next pass). */
        const opFailedDomains = new Set<string>();
        const fail = (domain: string, e: MailDriverError) => {
          domainErrors[domain] ??= e.detail ? `${e.message}: ${e.detail}` : e.message;
        };
        let writes = 0;
        const run = async (ops: PrincipalOp[]) => {
          for (const op of ops) {
            // A domain that could not be created: its principals would fail too.
            if (failedDomains.has(op.domain) && op.kind !== 'delete') continue;
            try {
              await applyOp(api, op);
              writes++;
              if (op.secretsFp !== undefined) syncState.secrets[op.name] = op.secretsFp;
              // A (re)created mailbox has no script (e.g. wiped store): forget the old fingerprint.
              if (op.kind === 'create' && op.create?.type === 'individual') delete syncState.sieve[op.name];
            } catch (err) {
              const e = toDriverError(err, `${op.kind} ${op.name}`);
              if (e.code === 'unavailable') throw e;
              fail(op.domain, e);
              opFailedDomains.add(op.domain);
              if (op.create?.type === 'domain') failedDomains.add(op.domain);
            }
          }
        };
        await run(plan.domains);
        // Revocations ahead: the directory reload below becomes due before the
        // first of them is written, so an interrupted pass still reloads next time.
        if ((plan.removals.length || plan.domainRemovals.length) && !syncState.directoryReloadPending) {
          syncState.directoryReloadPending = true;
          await persist();
        }
        await run(plan.removals);
        await run(plan.additions);
        // Domains leaving the active set (MA10): only once every managed address
        // on them is released (no failure reported for that domain this pass).
        await run(plan.domainRemovals.filter((op) => !opFailedDomains.has(op.domain)));
        // Stalwart caches POSITIVE directory lookups in memory (RCPT TO, logins):
        // a removed address / detached mailbox / disabled permission stays
        // accepted until the entry expires — RCPT answers 250, the message is
        // queued, then bounced to a possibly forged sender (backscatter),
        // the Linux test host 0.12.4. Neither the principal update nor DELETE invalidates
        // it; GET /api/reload does (no restart, open sessions kept). So a
        // reload follows every pass that REVOKED something — additions, secrets,
        // quotas and sieve scripts stay reload-free (report P4, §19).
        let directoryReloaded = false;
        if (syncState.directoryReloadPending) {
          try {
            const { warnings } = await api.reload();
            for (const w of warnings.slice(0, 20)) logger.warn(`mail stalwart: configuration warning: ${w}`);
          } catch (err) {
            throw toDriverError(err, 'reloading the directory after a revocation');
          }
          syncState.directoryReloadPending = false;
          directoryReloaded = true;
          await persist();
        }
        for (const d of plan.domainsKept) logger.warn({ domain: d }, 'mail stalwart: inactive domain kept: a principal not managed by the panel still uses it');
        for (const name of plan.detached) logger.info({ mailbox: name, reason: opts.reason }, 'mail stalwart: mailbox detached (login and delivery removed, data kept until purge)');
        // Unverifiable password hashes (mailbox kept without login), never the hash itself (MA4).
        for (const [domain, msg] of Object.entries(desired.secretErrors)) domainErrors[domain] ??= msg;

        // Sieve scripts (forwarding / autoresponder) of every mailbox of an
        // active domain, including login-disabled ones (suspended account,
        // disabled mailbox): removing a forward / autoresponder must apply
        // whatever the login state (MA9).
        const activeDomains = new Set(desired.domains);
        let sieveWrites = 0;
        for (const mb of state.mailboxes) {
          const name = mb.address.toLowerCase();
          const domain = mb.domain.toLowerCase();
          if (!activeDomains.has(domain) || failedDomains.has(domain) || opFailedDomains.has(domain)) continue;
          let script: string | null;
          try {
            script = renderSieveScript(mb);
          } catch (err) {
            domainErrors[domain] ??= err instanceof Error ? err.message : String(err);
            continue;
          }
          const fp = script === null ? '' : sha256(script);
          if ((syncState.sieve[name] ?? '') === fp) continue;
          try {
            await withImpersonation(api, name, !mb.loginEnabled, () =>
              api.setSieveScript(name, MASTER_USER, creds.secret, SIEVE_SCRIPT_NAME, script));
            sieveWrites++;
            if (fp) syncState.sieve[name] = fp;
            else delete syncState.sieve[name];
          } catch (err) {
            const e = toDriverError(err, `sieve script of ${name}`);
            if (e.code === 'unavailable') throw e;
            fail(domain, e);
          }
        }

        await persist();
        const changed = reloaded || configChanged || writes > 0 || sieveWrites > 0;
        if (changed) {
          logger.info({
            reason: opts.reason, configChanged, reloaded, directoryReloaded, principalWrites: writes, sieveWrites, planned: planSize(plan),
          }, 'mail stalwart: synchronized');
        }
        return {
          ok: Object.keys(domainErrors).length === 0,
          changed,
          domains: desired.domains.length,
          mailboxes: desired.individuals.length,
          aliases: state.aliases.length,
          domainErrors,
          durationMs: Date.now() - started,
        };
      });
    },

    async reloadTls() {
      await withLock(LOCK_KEY, async () => {
        const { api } = await client();
        try {
          await reloadConfig(api, 'reloading the certificates');
        } catch (err) {
          // Not applied: the next sync reloads even with unchanged files.
          const s = await readSyncState();
          if (s.appliedConfig) {
            s.appliedConfig = '';
            await writeSyncState(s).catch((e) => logger.warn(`mail stalwart: sync bookkeeping not written: ${errText(e)}`));
          }
          throw err;
        }
      });
    },

    async purge(target) {
      await withLock(LOCK_KEY, async () => {
        const { api } = await client();
        try {
          if (target.kind === 'mailbox') {
            const name = String(target.name ?? '').toLowerCase();
            if (!isMailAddress(name)) throw new MailDriverError('invalidState', 'stalwart: invalid mailbox name to purge');
            const p = await api.getPrincipal(name);
            if (!p) return;
            if (p.emails.length > 0 || !p.disabledPermissions.includes('authenticate')) {
              throw new MailDriverError('invalidState', `stalwart: ${name} is still in use: not purged`);
            }
            await api.deletePrincipal(name);
            await forgetState([name]);
            logger.info({ mailbox: name }, 'mail stalwart: mailbox data purged');
            return;
          }
          const domain = domainName(target.name);
          const suffix = `@${domain}`;
          const individuals = (await api.listPrincipals('individual')).filter((p) => p.name.toLowerCase().endsWith(suffix));
          const inUse = individuals.filter((p) => p.emails.length > 0 || !p.disabledPermissions.includes('authenticate'));
          if (inUse.length) throw new MailDriverError('invalidState', `stalwart: ${domain} still has ${inUse.length} mailbox(es) in use: not purged`);
          for (const p of individuals) await api.deletePrincipal(p.name);
          await api.deletePrincipal(domain);
          await forgetState(individuals.map((p) => p.name.toLowerCase()));
          logger.info({ domain, mailboxes: individuals.length }, 'mail stalwart: domain data purged');
        } catch (err) {
          throw toDriverError(err, `purge of ${target.kind}`);
        }
      });
    },

    // ── runtime ──
    async usage(): Promise<MailboxUsage[]> {
      const { api } = await client();
      try {
        return usageFromPrincipals(await api.listPrincipals('individual'));
      } catch (err) {
        throw toDriverError(err, 'reading the quota usage');
      }
    },

    async queue(opts): Promise<MailQueueEntry[]> {
      const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit) || 100));
      const { api } = await client();
      try {
        return queueFromApi(await api.listQueue(limit), limit);
      } catch (err) {
        throw toDriverError(err, 'reading the queue');
      }
    },

    async queueAction(queueId, action) {
      if (!QUEUE_ID_RE.test(String(queueId ?? ''))) throw new MailDriverError('notFound', 'stalwart: unknown queue id');
      const { api } = await client();
      try {
        if (action === 'retry') await api.retryQueued(queueId);
        else if (!(await api.deleteQueued(queueId))) throw new MailDriverError('notFound', 'stalwart: the message is no longer in the queue');
      } catch (err) {
        throw toDriverError(err, `queue ${action}`);
      }
    },

    logContainers() { return [MAIL_CONTAINER]; },
    parseLogLine(container, line) { return parseLogLine(container, line); },

    // ── endpoints on the mail network ──
    // IMAP / ManageSieve refuse plain-text authentication without TLS (MA1, no
    // per-network exception in Stalwart): the webmail uses STARTTLS inside the
    // mail network (certificate name not verifiable for 'oblimint-mail').
    imapEndpoint() { return { host: MAIL_CONTAINER, port: 143, tls: 'starttls' }; },
    submissionEndpoint() { return { host: MAIL_CONTAINER, port: 587, tls: 'starttls' }; },
    sieveEndpoint() { return { host: MAIL_CONTAINER, port: 4190, tls: 'starttls' }; },
    relayTarget() { return { host: MAIL_CONTAINER, port: STALWART_RELAY_PORT, tls: 'none' }; },
  };

  async function forgetState(names: string[]): Promise<void> {
    const s = await readSyncState();
    let changed = false;
    for (const n of names) {
      if (n in s.secrets) { delete s.secrets[n]; changed = true; }
      if (n in s.sieve) { delete s.sieve[n]; changed = true; }
    }
    if (changed) await writeSyncState(s);
  }

  return driver;
}

// ── production wiring ────────────────────────────────────────────────────────

const hostRoot = (): string => config.hostDataDir.replace(/\\/g, '/');

export const stalwartDriver: MailDriver = createStalwartDriver({
  credentials: (create) => (create ? ensureAdminSecret() : readAdminSecret()),
  api: (creds) => new StalwartApi({ user: ADMIN_USER, secret: creds.secret }),
  docker: async () => engineFor(await localNodeId()),
  ensureNetwork: async (log) => (await import('../../network')).ensureMailNetwork(log),
  hostname: async () => (await import('../../contracts')).mailHostname(),
  get configDir() { return localPaths.mailEngineConfig('stalwart'); },
  get dataDir() { return localPaths.mailEngineData('stalwart'); },
  get certsDir() { return localPaths.mailCerts(); },
  get certRoots() { return [...new Set([localPaths.mailCerts(), hostingLayout(hostRoot()).mailCerts()])]; },
  get hostDataDir() { return hostRoot(); },
  get bindAddresses() { return config.hosting.mailBind; },
  owner: process.platform === 'win32' ? null : { uid: STALWART_UID, gid: STALWART_GID },
});
