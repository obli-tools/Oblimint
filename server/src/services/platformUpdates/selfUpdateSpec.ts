import type Docker from 'dockerode';

// ─────────────────────────────────────────────────────────────────────────────
// Panel self-update — PURE part (selfUpdateSpec.test.ts). The panel container
// is recreated by a short-lived helper container (after Oblihub selfUpdate:
// a helper with the Docker socket outlives the panel), here the CURRENT panel
// image running selfUpdateHelper.js: no extra image to pull, and the Engine
// API (not a docker CLI command line) clones the configuration exactly.
//
// Clone rules (as watchtower does): the NAME, HostConfig (binds / mounts,
// ports, restart policy, capabilities, log driver…), networks + aliases and
// every setting the operator gave at `docker run` are kept; what came from
// the OLD IMAGE (its default Env entries, Cmd, Entrypoint, labels such as the
// version, WorkingDir, User, Healthcheck, exposed ports) is dropped so the
// NEW image's defaults apply. The hostname Docker derived from the old
// container id is dropped (the new process finds itself through HOSTNAME).
// ─────────────────────────────────────────────────────────────────────────────

/** Role label of the helper container. */
export const UPDATER_ROLE = 'panel-updater';
/** Label carrying the update run id on the helper. */
export const UPDATER_RUN_LABEL = 'oblimint.update-run';
/** Suffix of the previous panel container kept until the new one is healthy. */
export const oldPanelName = (name: string, at: number): string => `${name}-old-${at}`;
export const OLD_PANEL_RE = (name: string): RegExp => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-old-\\d+$`);

const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none', 'default']);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface NetworkAttachment {
  name: string;
  aliases: string[];
  ipv4: string | null;
  ipv6: string | null;
}

export interface ClonedPanel {
  name: string;
  create: Docker.ContainerCreateOptions;
  /** Networks connected after the creation (the first one is in `create`). */
  extraNetworks: NetworkAttachment[];
}

/** Aliases worth keeping: not the container id / name Docker adds by itself. */
function cleanAliases(aliases: readonly string[] | null | undefined, id: string, name: string): string[] {
  const shortId = id.slice(0, 12);
  return [...new Set((aliases ?? []).filter((a) => a && a !== shortId && !id.startsWith(a) && a !== name))];
}

/**
 * Creation options of the new panel container on `newImage`, from the
 * inspection of the running one and of its (old) image.
 */
export function clonePanelContainer(self: Docker.ContainerInspectInfo, oldImage: { Config?: Partial<Docker.ContainerInspectInfo['Config']> | null } | null, newImage: string): ClonedPanel {
  const name = String(self.Name ?? '').replace(/^\//, '');
  if (!name) throw new Error('the panel container has no name');
  const cfg = self.Config;
  const img = (oldImage?.Config ?? {}) as Partial<Docker.ContainerInspectInfo['Config']>;
  const imageEnv = new Set(img.Env ?? []);
  const imageLabels = img.Labels ?? {};
  const config: Docker.ContainerCreateOptions = { name, Image: newImage };

  const env = (cfg.Env ?? []).filter((e) => !imageEnv.has(e));
  if (env.length) config.Env = env;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.Labels ?? {})) if (imageLabels[k] !== v) labels[k] = v;
  if (Object.keys(labels).length) config.Labels = labels;
  if (cfg.Cmd && !sameJson(cfg.Cmd, img.Cmd)) config.Cmd = cfg.Cmd as string[];
  if (cfg.Entrypoint && !sameJson(cfg.Entrypoint, img.Entrypoint)) config.Entrypoint = cfg.Entrypoint as string | string[];
  if (cfg.WorkingDir && cfg.WorkingDir !== img.WorkingDir) config.WorkingDir = cfg.WorkingDir;
  if (cfg.User && cfg.User !== img.User) config.User = cfg.User;
  const healthcheck = (cfg as { Healthcheck?: unknown }).Healthcheck;
  if (healthcheck && !sameJson(healthcheck, (img as { Healthcheck?: unknown }).Healthcheck)) (config as { Healthcheck?: unknown }).Healthcheck = healthcheck;
  const imgPorts = img.ExposedPorts ?? {};
  const exposed: Record<string, object> = {};
  for (const p of Object.keys(cfg.ExposedPorts ?? {})) if (!(p in imgPorts)) exposed[p] = {};
  if (Object.keys(exposed).length) config.ExposedPorts = exposed;
  const shortId = self.Id.slice(0, 12);
  if (cfg.Hostname && cfg.Hostname !== shortId && !self.Id.startsWith(cfg.Hostname)) config.Hostname = cfg.Hostname;
  if (cfg.Domainname) config.Domainname = cfg.Domainname;
  if (cfg.Tty) config.Tty = true;
  if (cfg.OpenStdin) config.OpenStdin = true;
  const stopSignal = (cfg as { StopSignal?: string }).StopSignal;
  if (stopSignal && stopSignal !== (img as { StopSignal?: string }).StopSignal) (config as { StopSignal?: string }).StopSignal = stopSignal;
  const stopTimeout = (cfg as { StopTimeout?: number }).StopTimeout;
  if (typeof stopTimeout === 'number') (config as { StopTimeout?: number }).StopTimeout = stopTimeout;

  // HostConfig as inspected (binds, mounts, ports, restart policy, security options…).
  config.HostConfig = { ...(self.HostConfig as Docker.HostConfig) };

  const networks = Object.entries(self.NetworkSettings?.Networks ?? {}).map(([net, ep]): NetworkAttachment => {
    const ipam = (ep as { IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null }).IPAMConfig;
    return {
      name: net,
      aliases: DEFAULT_NETWORKS.has(net) ? [] : cleanAliases(ep.Aliases, self.Id, name),
      ipv4: ipam?.IPv4Address || null,
      ipv6: ipam?.IPv6Address || null,
    };
  });
  const mode = String(self.HostConfig?.NetworkMode ?? '');
  const first = networks.find((n) => n.name === mode) ?? networks[0] ?? null;
  if (first) config.NetworkingConfig = { EndpointsConfig: { [first.name]: endpointConfig(first) } };
  return { name, create: config, extraNetworks: networks.filter((n) => n !== first) };
}

export function endpointConfig(n: NetworkAttachment): Docker.EndpointSettings {
  const ep: Docker.EndpointSettings = {};
  if (n.aliases.length) ep.Aliases = n.aliases;
  if (n.ipv4 || n.ipv6) ep.IPAMConfig = { ...(n.ipv4 ? { IPv4Address: n.ipv4 } : {}), ...(n.ipv6 ? { IPv6Address: n.ipv6 } : {}) };
  return ep;
}

/** Bind source of the Docker socket the panel uses (the helper gets the same). */
export function dockerSocketBind(self: Docker.ContainerInspectInfo, socketPath = '/var/run/docker.sock'): string | null {
  for (const m of self.Mounts ?? []) {
    if (m.Destination === socketPath && m.Source) return `${m.Source}:${socketPath}`;
  }
  for (const b of self.HostConfig?.Binds ?? []) {
    const [src, dst] = b.split(':');
    if (dst === socketPath && src) return `${src}:${socketPath}`;
  }
  return null;
}

export interface HelperPlan {
  runId: string;
  /** Panel container (name). */
  target: string;
  newImage: string;
  /** Seconds the new container has to become healthy before the rollback. */
  healthTimeoutSec: number;
}

/**
 * Helper container: the CURRENT panel image (by id — always present, carries
 * the helper script), the Docker socket only, no network, auto-removal off
 * (the panel reads its result from its logs, then removes it).
 */
export function helperCreateOptions(self: Docker.ContainerInspectInfo, plan: HelperPlan, socketBind: string): Docker.ContainerCreateOptions {
  const name = String(self.Name ?? '').replace(/^\//, '');
  return {
    name: `${name}-updater-${plan.runId}`,
    Image: self.Image,
    Cmd: ['node', 'dist/src/services/platformUpdates/selfUpdateHelper.js'],
    WorkingDir: '/app/server',
    Env: [`OBLIMINT_SELF_UPDATE_PLAN=${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')}`],
    Labels: { 'oblimint.role': UPDATER_ROLE, [UPDATER_RUN_LABEL]: plan.runId, 'oblimint.internal': 'true' },
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      Binds: [socketBind],
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
  };
}

export function parseHelperPlan(raw: string | undefined): HelperPlan {
  if (!raw) throw new Error('OBLIMINT_SELF_UPDATE_PLAN is missing');
  const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as HelperPlan;
  if (!p || typeof p.target !== 'string' || !p.target || typeof p.newImage !== 'string' || !p.newImage || typeof p.runId !== 'string') {
    throw new Error('invalid self-update plan');
  }
  return { runId: p.runId, target: p.target, newImage: p.newImage, healthTimeoutSec: Number(p.healthTimeoutSec) > 0 ? Number(p.healthTimeoutSec) : 240 };
}

export type HelperOutcome = 'succeeded' | 'rolledBack' | 'failed';
export interface HelperResult { outcome: HelperOutcome; error: string | null; newImageId: string | null; finishedAt: string }
export const HELPER_RESULT_PREFIX = 'OBLIMINT_SELF_UPDATE_RESULT ';

/** Last result line of the helper's logs. */
export function parseHelperResult(logs: string): HelperResult | null {
  const lines = logs.split(/\r?\n/).filter((l) => l.includes(HELPER_RESULT_PREFIX));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const r = JSON.parse(last.slice(last.indexOf(HELPER_RESULT_PREFIX) + HELPER_RESULT_PREFIX.length)) as HelperResult;
    return r && (r.outcome === 'succeeded' || r.outcome === 'rolledBack' || r.outcome === 'failed') ? r : null;
  } catch {
    return null;
  }
}

/** Health verdict of the new container from its inspection. */
export function healthVerdict(state: { Running?: boolean; Status?: string; Health?: { Status?: string } | null } | undefined, elapsedMs: number, opts: { timeoutMs: number; noHealthcheckStableMs: number }): 'healthy' | 'failed' | 'wait' {
  if (!state) return 'failed';
  if (!state.Running && (state.Status === 'exited' || state.Status === 'dead')) return 'failed';
  const health = state.Health?.Status;
  if (health === 'healthy') return 'healthy';
  if (health === 'unhealthy') return 'failed';
  if (!health || health === 'none') {
    if (state.Running && elapsedMs >= opts.noHealthcheckStableMs) return 'healthy';
  }
  return elapsedMs >= opts.timeoutMs ? 'failed' : 'wait';
}

/**
 * Text of a non-TTY container log stream: Docker multiplexes stdout / stderr
 * in frames (8-byte header: stream, 0, 0, 0, big-endian size). A buffer that
 * is not framed (TTY) is returned as is.
 */
export function demuxDockerLogs(buf: Buffer): string {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    if ((stream !== 0 && stream !== 1 && stream !== 2) || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) return buf.toString('utf8');
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) break;
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return i === 0 && buf.length ? buf.toString('utf8') : Buffer.concat(parts).toString('utf8');
}
