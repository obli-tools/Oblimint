import crypto from 'crypto';
import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { open, seal } from '../../utils/secretBox';
import { appConfigService } from '../appConfig.service';
import type { InfraComponentProvider } from '../docker/extensions';
import {
  containerState, createNetwork, ensureImage, inspectContainer, inspectNetwork, labelHash, listByLabel, recreateContainer, removeContainer,
  startContainer,
} from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { withLock } from '../docker/locks';
import { specHashLabel } from '../docker/specs';
import { AUTH_NETWORK, AUTH_REDIS_CONTAINER, LABELS, P4B_LABELS, authRedisImage, authSidecarContainer, oauth2ProxyImage } from '../hosting/naming';
import { errText } from '../setup/docker';
import { authRedisSpec, authSidecarSpec } from './authSpec';
import { stringArray, type AuthProviderDbRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Forward-auth infrastructure component 'proxy-auth' (docs/P4b-PLAN.md §8.8,
// PX5): one oauth2-proxy sidecar per auth provider (oblimint-oauth2-<id>) and
// their shared Redis, on AUTH_NETWORK with the edge (infraService.ensureEdge
// attaches the edge once the network exists). Converged at worker start, after
// every provider / protected-host change (debounced) and from the Nodes page;
// sidecars of deleted providers are removed, everything is removed when no
// provider is left (the network stays). A provider whose secrets cannot be
// opened (SESSION_SECRET rotated) is skipped and reported, never fatal.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK = 'infra:proxy-auth';
const REDIS_PASSWORD_CONFIG = 'proxy_auth_redis_password';
const CONVERGE_DEBOUNCE_MS = 2_000;

export interface SidecarState { deployed: boolean; running: boolean; detail: string | null }

const states = new Map<number, SidecarState>();
const problems = new Map<number, string>();

/** Last known state of a provider's sidecar (AuthProvider.sidecar). */
export function sidecarStateOf(providerId: number): SidecarState {
  const s = states.get(providerId) ?? { deployed: false, running: false, detail: null };
  const p = problems.get(providerId);
  return p ? { ...s, detail: p } : s;
}

/** Redis password of the session store: generated once, sealed in app_config (regenerated when unreadable). */
export async function authRedisPassword(): Promise<string> {
  const sealed = await appConfigService.get(REDIS_PASSWORD_CONFIG);
  if (sealed) {
    try {
      const v = open('proxy-auth', sealed);
      if (/^[A-Za-z0-9_-]{24,128}$/.test(v)) return v;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'proxy-auth: redis password unreadable, regenerated');
    }
  }
  const fresh = crypto.randomBytes(24).toString('base64url');
  await appConfigService.set(REDIS_PASSWORD_CONFIG, seal('proxy-auth', fresh));
  return fresh;
}

async function ensureContainer(docker: Docker, spec: Docker.ContainerCreateOptions, log: (line: string) => void): Promise<void> {
  const name = spec.name!;
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  if (!info) {
    log(`Creating ${name}`);
    await recreateContainer(docker, spec, true);
    return;
  }
  if (labelHash(info.Config?.Labels) !== specHashLabel(spec)) {
    log(`${name}: specification changed, recreating`);
    await recreateContainer(docker, spec, true);
    return;
  }
  if (!info.State?.Running) {
    log(`Starting ${name}`);
    await startContainer(docker, name);
  }
}

/** Providers served by this node (accounts of the local node, not being deleted). */
async function localProviders(): Promise<AuthProviderDbRow[]> {
  const nodeId = await localNodeId();
  return db('auth_providers as p').join('hosting_accounts as a', 'a.id', 'p.account_id')
    .where('a.node_id', nodeId).whereNot('a.status', 'deleting').select('p.*') as Promise<AuthProviderDbRow[]>;
}

/** Protected host names per provider (whitelist of the redirects). */
async function whitelistFor(ids: number[]): Promise<Map<number, string[]>> {
  const { providerHostNames } = await import('./authProviders.service');
  return providerHostNames(ids);
}

/** Converges every sidecar (idempotent). Throws on a Docker failure (callers log / report). */
export async function convergeAuth(log: (line: string) => void = () => undefined): Promise<void> {
  await withLock(LOCK, async () => {
    const docker = await engineFor(await localNodeId());
    const providers = await localProviders();
    const wanted = new Set(providers.map((p) => Number(p.id)));
    const existing = await listByLabel(docker, `${LABELS.role}=proxy-auth`);

    if (!providers.length) {
      for (const c of existing) {
        const name = (c.Names?.[0] ?? '').replace(/^\//, '');
        if (!name) continue;
        log(`Removing ${name} (no auth provider left)`);
        await removeContainer(docker, name);
      }
      states.clear();
      problems.clear();
      return;
    }

    if (!(await inspectNetwork(docker, AUTH_NETWORK))) {
      log(`Creating network ${AUTH_NETWORK}`);
      await createNetwork(docker, AUTH_NETWORK, { [LABELS.internal]: 'true' });
      try {
        const { infraService } = await import('../docker/infra.service');
        await infraService.ensureEdge(log);
      } catch (err) {
        log(`The edge could not be attached to ${AUTH_NETWORK} yet: ${errText(err)}`);
      }
    }

    const redisPassword = await authRedisPassword();
    await ensureContainer(docker, authRedisSpec(authRedisImage(), redisPassword), log);

    const whitelist = await whitelistFor([...wanted]);
    problems.clear();
    for (const p of providers) {
      const id = Number(p.id);
      let clientSecret: string;
      let cookieSecret: string;
      try {
        if (!p.client_secret_sealed || !p.cookie_secret_sealed) throw new Error('missing secret');
        clientSecret = open('proxy-auth', p.client_secret_sealed);
        cookieSecret = open('proxy-auth', p.cookie_secret_sealed);
      } catch (err) {
        problems.set(id, 'secret unreadable: enter the client secret again');
        log(`Provider ${id}: secrets unreadable (${errText(err)}), sidecar skipped`);
        continue;
      }
      try {
        await ensureContainer(docker, authSidecarSpec({
          providerId: id, image: oauth2ProxyImage(), azureTenantId: p.azure_tenant_id, clientId: p.client_id, clientSecret, cookieSecret,
          allowedEmailDomains: stringArray(p.allowed_email_domains), allowedGroups: stringArray(p.allowed_groups),
          whitelistDomains: whitelist.get(id) ?? [], redisPassword,
        }), log);
      } catch (err) {
        problems.set(id, errText(err));
        log(`Provider ${id}: ${errText(err)}`);
      }
    }

    for (const c of existing) {
      const pid = Number(c.Labels?.[P4B_LABELS.authProvider]);
      if (!Number.isInteger(pid) || pid <= 0 || wanted.has(pid)) continue;
      const name = authSidecarContainer(pid);
      log(`Removing ${name} (provider deleted)`);
      await removeContainer(docker, name);
    }
    await refreshStates(docker);
  });
}

/** Re-reads the sidecar states (Docker). Never throws. */
export async function refreshStates(dockerArg?: Docker): Promise<void> {
  try {
    const docker = dockerArg ?? await engineFor(await localNodeId());
    const list = await listByLabel(docker, `${LABELS.role}=proxy-auth`);
    states.clear();
    for (const c of list) {
      const pid = Number(c.Labels?.[P4B_LABELS.authProvider]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const running = c.State === 'running';
      states.set(pid, { deployed: true, running, detail: running ? null : containerState(c.State) });
    }
  } catch (err) {
    logger.debug({ err: errText(err) }, 'proxy-auth: state refresh failed');
  }
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let again = false;

/** Debounced convergence (provider / protected host changed). Never throws. */
export function requestAuthConverge(reason: string): void {
  try {
    logger.debug({ reason }, 'proxy-auth converge requested');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (running) { again = true; return; }
      running = convergeAuth((line) => logger.info({ component: 'proxy-auth' }, line))
        .catch((err) => logger.warn({ err: errText(err) }, 'proxy-auth: convergence failed'))
        .finally(() => {
          running = null;
          if (again) { again = false; requestAuthConverge('coalesced'); }
        });
    }, CONVERGE_DEBOUNCE_MS);
    timer.unref?.();
  } catch { /* never throws */ }
}

/** Tests: drop timers / cached states. */
export function resetAuthInfraForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  again = false;
  states.clear();
  problems.clear();
}

export const proxyAuthInfraComponent: InfraComponentProvider = {
  id: 'proxy-auth',

  async ensure(log: (line: string) => void): Promise<void> {
    await convergeAuth(log);
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'proxy-auth', deployed: false, running: false, image: null, version: null, detail: null };
    if (!docker) return { ...base, detail: dockerError };
    try {
      const providers = await localProviders();
      const list = await listByLabel(docker, `${LABELS.role}=proxy-auth`);
      const sidecars = list.filter((c) => c.Labels?.[P4B_LABELS.authProvider]);
      const redis = list.find((c) => (c.Names ?? []).includes(`/${AUTH_REDIS_CONTAINER}`));
      const issues: string[] = [];
      for (const p of providers) {
        const c = sidecars.find((x) => Number(x.Labels?.[P4B_LABELS.authProvider]) === Number(p.id));
        if (!c) issues.push(`${authSidecarContainer(Number(p.id))}: absent`);
        else if (c.State !== 'running') issues.push(`${authSidecarContainer(Number(p.id))}: ${containerState(c.State)}`);
      }
      if (providers.length && (!redis || redis.State !== 'running')) issues.push(`${AUTH_REDIS_CONTAINER}: ${redis ? containerState(redis.State) : 'absent'}`);
      const runningCount = sidecars.filter((c) => c.State === 'running').length;
      return {
        ...base,
        deployed: list.length > 0,
        running: providers.length > 0 && issues.length === 0,
        image: sidecars[0]?.Image ?? null,
        detail: [
          `${runningCount}/${providers.length} sidecar(s) running`,
          ...issues,
        ].join(' · '),
      };
    } catch (err) {
      return { ...base, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      return (await localProviders()).length > 0;
    } catch {
      return false;
    }
  },
};
