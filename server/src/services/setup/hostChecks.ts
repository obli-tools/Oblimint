import fs from 'fs';
import type { HostCheck, HostCheckStatus } from '@oblimint/shared';
import { config, dataDir } from '../../config';
import { logger } from '../../utils/logger';
import { docker, errText, INTERNAL_LABELS, selfContainerRef, withTimeout } from './docker';
import { evaluatePorts } from './ports';

// First-run host checks (docs/P0-PLAN.md §Mode setup). Every check returns a
// HostCheck, whatever happens (socket missing, Docker down, timeouts): a
// check never throws — a failure to check IS a finding ('fail' + detail).

const MIN_DOCKER_MAJOR = 24;
const PORT_PROBE_IMAGE = 'alpine:3.20';

const DOCKER_RUN_HINT =
  'docker run -d --name oblimint --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock ' +
  '-v /srv/oblimint:/srv/oblimint -p 8443:8443 meejay/oblimint';

function check(id: string, status: HostCheckStatus, detail: string, fix?: { fixKey?: string; fixCommand?: string }): HostCheck {
  return {
    id,
    labelKey: `setup.checks.${id}`,
    status,
    detail,
    ...(status !== 'ok' ? { fixKey: fix?.fixKey ?? `setup.checks.${id}Fix` } : {}),
    ...(status !== 'ok' && fix?.fixCommand ? { fixCommand: fix.fixCommand } : {}),
  };
}

type Lazy<T> = () => Promise<T>;
function once<T>(fn: () => Promise<T>): Lazy<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

interface DockerInfo {
  OperatingSystem?: string;
  SecurityOptions?: string[];
  NCPU?: number;
  MemTotal?: number;
  ServerVersion?: string;
}

async function dockerCheck(version: Lazy<{ Version?: string; ApiVersion?: string }>): Promise<HostCheck> {
  try {
    const v = await version();
    const major = parseInt(String(v.Version ?? '').split('.')[0], 10);
    if (!Number.isFinite(major)) return check('docker', 'warn', `Docker version unreadable (${v.Version ?? '?'})`);
    if (major < MIN_DOCKER_MAJOR) {
      return check('docker', 'fail', `Docker ${v.Version} (API ${v.ApiVersion ?? '?'}): ${MIN_DOCKER_MAJOR} or newer required`, {
        fixCommand: 'curl -fsSL https://get.docker.com | sh',
      });
    }
    return check('docker', 'ok', `Docker ${v.Version} (API ${v.ApiVersion ?? '?'})`);
  } catch (err) {
    return check('docker', 'fail', `Docker Engine unreachable through ${config.dockerSocket}: ${errText(err)}`, {
      fixKey: 'setup.checks.dockerSocketFix',
      fixCommand: DOCKER_RUN_HINT,
    });
  }
}

async function osCheck(info: Lazy<DockerInfo>): Promise<HostCheck> {
  try {
    const os = (await info()).OperatingSystem || 'unknown';
    if (/debian|almalinux|alma linux|rocky/i.test(os)) return check('os', 'ok', os);
    return check('os', 'warn', `${os} (Debian, AlmaLinux or Rocky Linux expected)`);
  } catch (err) {
    return check('os', 'fail', `Host OS unknown (Docker unreachable: ${errText(err)})`);
  }
}

async function selinuxCheck(info: Lazy<DockerInfo>): Promise<HostCheck> {
  try {
    const opts = (await info()).SecurityOptions ?? [];
    const selinux = opts.find((o) => /name=selinux/.test(o));
    if (!selinux) return check('selinux', 'ok', `SELinux not enabled in Docker (${opts.map((o) => o.replace(/^name=/, '').split(',')[0]).join(', ') || 'no security options'})`);
    return check('selinux', 'warn', 'SELinux is enabled for containers: the panel labels its bind mounts (:Z / :z); host paths shared with other tools need a matching context', {
      fixCommand: 'sudo semanage fcontext -a -t container_file_t "/srv/oblimint(/.*)?" && sudo restorecon -R /srv/oblimint',
    });
  } catch (err) {
    return check('selinux', 'fail', `SELinux state unknown (Docker unreachable: ${errText(err)})`);
  }
}

interface MountEntry { device: string; mountPoint: string; fsType: string; options: string[] }

function parseProcMounts(text: string): MountEntry[] {
  const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4)
    .map(([device, mountPoint, fsType, options]) => ({ device, mountPoint: unescape(mountPoint), fsType, options: options.split(',') }));
}

/** The mount that holds `dir` (longest mount point prefix). */
function mountOf(entries: MountEntry[], dir: string): MountEntry | null {
  let best: MountEntry | null = null;
  for (const e of entries) {
    const mp = e.mountPoint.endsWith('/') && e.mountPoint !== '/' ? e.mountPoint.slice(0, -1) : e.mountPoint;
    if (dir === mp || dir.startsWith(mp === '/' ? '/' : `${mp}/`)) {
      if (!best || mp.length > best.mountPoint.length) best = e;
    }
  }
  return best;
}

async function dataDirFsCheck(): Promise<HostCheck> {
  let text: string;
  try {
    text = await fs.promises.readFile('/proc/mounts', 'utf-8');
  } catch (err) {
    return check('datadir_fs', 'fail', `Cannot read /proc/mounts (${errText(err)}): the panel must run in a Linux container`, { fixCommand: DOCKER_RUN_HINT });
  }
  const m = mountOf(parseProcMounts(text), dataDir);
  if (!m) return check('datadir_fs', 'fail', `${dataDir}: no mount found`, { fixCommand: DOCKER_RUN_HINT });
  if (m.fsType === 'overlay' || m.mountPoint === '/') {
    return check('datadir_fs', 'fail', `${dataDir} is not mounted from the host (inside the container layer: ${m.fsType}) — data would be lost`, {
      fixKey: 'setup.checks.datadirNotMountedFix', fixCommand: DOCKER_RUN_HINT,
    });
  }
  const prjquota = m.options.some((o) => o === 'prjquota' || o === 'pquota');
  if (m.fsType === 'xfs' && prjquota) return check('datadir_fs', 'ok', `${m.mountPoint}: xfs with project quotas (hard quotas available)`);
  // hostd refuses disk limits it cannot enforce unless the operator opts in.
  const policy = config.hosting.allowMeasuredQuota
    ? 'disk limits accepted but only measured (OBLIMINT_ALLOW_MEASURED_QUOTA=1: an account can fill the disk)'
    : 'accounts with a disk limit are refused (set OBLIMINT_ALLOW_MEASURED_QUOTA=1 on the panel to accept measured-only limits)';
  const detail = m.fsType === 'xfs'
    ? `${m.mountPoint}: xfs without prjquota — no hard quota; ${policy}`
    : `${m.mountPoint}: ${m.fsType} — no hard quota; ${policy}. XFS with prjquota gives hard quotas`;
  return check('datadir_fs', 'warn', detail, {
    fixCommand: m.fsType === 'xfs'
      ? `# add prjquota to the mount options of ${m.mountPoint} in /etc/fstab, then reboot (XFS needs it at mount time)`
      : '# dedicate an XFS volume to /srv/oblimint mounted with defaults,prjquota (see the documentation)',
  });
}

/** Host listeners: a throw-away alpine container in the host network namespace runs netstat. */
async function portsCheck(): Promise<HostCheck> {
  try {
    const d = docker();
    const images = await withTimeout(d.listImages({ filters: { reference: [PORT_PROBE_IMAGE] } }), 10_000, 'list images');
    if (images.length === 0) {
      const stream = await withTimeout(d.pull(PORT_PROBE_IMAGE), 30_000, `pull ${PORT_PROBE_IMAGE}`);
      await withTimeout(new Promise<void>((resolve, reject) => {
        d.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
      }), 120_000, `pull ${PORT_PROBE_IMAGE}`);
    }
    const container = await withTimeout(d.createContainer({
      Image: PORT_PROBE_IMAGE,
      Cmd: ['netstat', '-ltnu'],
      Tty: true,
      Labels: { ...INTERNAL_LABELS, 'oblimint.role': 'setup-port-probe' },
      HostConfig: { NetworkMode: 'host', AutoRemove: false },
    }), 15_000, 'create port probe');
    let output = '';
    try {
      await withTimeout(container.start(), 15_000, 'start port probe');
      await withTimeout(container.wait(), 30_000, 'port probe');
      const logs = await withTimeout(container.logs({ stdout: true, stderr: true }) as Promise<Buffer>, 10_000, 'port probe logs');
      output = Buffer.isBuffer(logs) ? logs.toString('utf-8') : String(logs);
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
    // 80/443 busy → fail; 53 (DNS, P2) / 25 (mail, P4) busy → warn only (ports.ts).
    const v = evaluatePorts(output);
    return check('ports', v.status, v.detail, { fixCommand: v.fixCommand });
  } catch (err) {
    return check('ports', 'fail', `Host ports not checked: ${errText(err)}`);
  }
}

async function resourcesCheck(info: Lazy<DockerInfo>): Promise<HostCheck> {
  try {
    const i = await info();
    const cpus = Number(i.NCPU ?? 0);
    const memGb = Number(i.MemTotal ?? 0) / 1024 ** 3;
    const detail = `${cpus} CPU, ${memGb.toFixed(1)} GiB RAM`;
    if (cpus >= 2 && memGb >= 3.5) return check('resources', 'ok', detail);
    return check('resources', 'warn', `${detail} (2 CPU and 4 GiB RAM recommended)`);
  } catch (err) {
    return check('resources', 'fail', `Host resources unknown (Docker unreachable: ${errText(err)})`);
  }
}

async function selfCheck(): Promise<HostCheck> {
  const ref = selfContainerRef();
  if (!ref) return check('self', 'fail', 'HOSTNAME is not set: is the panel running in a Docker container?', { fixCommand: DOCKER_RUN_HINT });
  try {
    const info = await withTimeout(docker().getContainer(ref).inspect(), 10_000, 'inspect self');
    const mounts = (info.Mounts ?? []) as Array<{ Source?: string; Destination?: string; RW?: boolean }>;
    const sock = mounts.find((m) => m.Destination === config.dockerSocket);
    const data = mounts.find((m) => m.Destination === dataDir);
    const problems: string[] = [];
    if (!sock) problems.push(`${config.dockerSocket} not mounted`);
    if (!data) problems.push(`${dataDir} not mounted`);
    else if (data.RW === false) problems.push(`${dataDir} mounted read-only`);
    else if (data.Source && data.Source !== dataDir) problems.push(`${dataDir} must be mounted from the same host path (found ${data.Source})`);
    const name = String(info.Name ?? ref).replace(/^\//, '');
    if (problems.length) return check('self', 'fail', `Container ${name}: ${problems.join('; ')}`, { fixCommand: DOCKER_RUN_HINT });
    return check('self', 'ok', `Container ${name} (${String(info.Id).slice(0, 12)}): Docker socket and ${dataDir} mounted`);
  } catch (err) {
    return check('self', 'fail', `The panel container could not find itself (${ref}): ${errText(err)}`, { fixCommand: DOCKER_RUN_HINT });
  }
}

/** Runs every check; never throws. */
export async function runHostChecks(): Promise<HostCheck[]> {
  const version = once(() => withTimeout(docker().version() as Promise<{ Version?: string; ApiVersion?: string }>, 8_000, 'docker version'));
  const info = once(() => withTimeout(docker().info() as Promise<DockerInfo>, 8_000, 'docker info'));
  const safe = async (id: string, fn: () => Promise<HostCheck>): Promise<HostCheck> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ err, id }, 'setup: host check crashed');
      return check(id, 'fail', `Check failed: ${errText(err)}`);
    }
  };
  // The port probe needs Docker: skipped (fail) at once when it is unreachable.
  const dockerOk = await version().then(() => true, () => false);
  return Promise.all([
    safe('docker', () => dockerCheck(version)),
    safe('os', () => osCheck(info)),
    safe('selinux', () => selinuxCheck(info)),
    safe('datadir_fs', dataDirFsCheck),
    safe('ports', () => (dockerOk ? portsCheck() : Promise.resolve(check('ports', 'fail', 'Host ports not checked: Docker unreachable')))),
    safe('resources', () => resourcesCheck(info)),
    safe('self', selfCheck),
  ]);
}
