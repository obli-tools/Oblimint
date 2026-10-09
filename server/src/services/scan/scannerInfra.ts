import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import type { InfraComponentStatus, ScannerSettings } from '@oblimint/shared';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import type { InfraComponentProvider } from '../docker/extensions';
import {
  containerState, ensureImage, inspectContainer, labelHash, recreateContainer, removeContainer, startContainer, stopContainer, type Log,
} from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { withLock } from '../docker/locks';
import { specHashLabel } from '../docker/specs';
import { SCANNER_CONTAINER, scannerImage } from '../hosting/naming';
import { hostPaths, localPaths } from '../hosting/paths';
import { platformSettings } from '../platformSettings';
import { errText, withTimeout } from '../setup/docker';
import { createScandClient } from './scandClient';
import { ensureScannerKey, readScannerKey } from './scannerKey';
import { SCANNER_UID, scannerContainerSpec } from './scannerSpec';

// ─────────────────────────────────────────────────────────────────────────────
// Infra component 'scanner' (module scanners, docs/P3-PLAN.md §4.2, §9.1):
// container oblimint-scanner (clamd + freshclam + YARA + scand on :8080),
// panel network only, no published port, shared key sealed in app_config.
// Deployed by POST /api/system/infra/scanner/deploy, at boot when
// settings scanner.enabled (reconcile), and by scanService.settingsChanged().
// ─────────────────────────────────────────────────────────────────────────────

export const SCANNER_LOCK_KEY = 'infra:scanner';
const READY_TIMEOUT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Signature directory (panel-only: root 0700 parent, the clamav dir belongs to the image's scand user). */
export function scannerClamavDir(root: 'host' | 'local'): string {
  const base = root === 'host' ? hostPaths.scannerDir() : localPaths.scannerDir();
  return path.posix.join(base.replace(/\\/g, '/'), 'clamav');
}

async function ensureStateDir(log: Log): Promise<void> {
  const parent = localPaths.scannerDir();
  const dir = scannerClamavDir('local');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    await fs.promises.chmod(parent, 0o700);
    await fs.promises.chown(dir, SCANNER_UID, SCANNER_UID);
    await fs.promises.chmod(dir, 0o700);
  } catch (err) {
    log(`Could not hand ${dir} to uid ${SCANNER_UID}: ${errText(err)}`);
    throw err;
  }
}

/** Desired spec from the settings (key generated on first use). */
export async function desiredScannerSpec(settings: ScannerSettings): Promise<Docker.ContainerCreateOptions> {
  return scannerContainerSpec({
    key: await ensureScannerKey(),
    clamav: settings.clamav,
    yara: settings.yara,
    signatureChecksPerDay: settings.signatureChecksPerDay,
    maxFileSizeMb: settings.maxFileSizeMb,
    clamavDir: scannerClamavDir('host'),
  });
}

async function ensureContainer(docker: Docker, spec: Docker.ContainerCreateOptions, log: Log): Promise<void> {
  const name = spec.name!;
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  if (!info) {
    log(`Creating ${name} (${spec.Image})`);
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
    return;
  }
  log(`${name} is up to date and running`);
}

/** scand client with the current key (null: no key yet = never deployed). */
export async function scandClientOrNull(): Promise<ReturnType<typeof createScandClient> | null> {
  const key = await readScannerKey();
  return key ? createScandClient({ baseUrl: config.hosting.scannerUrl, key }) : null;
}

/** Stops and removes the container (scanner disabled). Idempotent. */
export async function removeScannerContainer(log: Log): Promise<void> {
  await withLock(SCANNER_LOCK_KEY, async () => {
    const docker = await engineFor(await localNodeId());
    const info = await inspectContainer(docker, SCANNER_CONTAINER);
    if (!info) return;
    log(`Removing ${SCANNER_CONTAINER} (scanner disabled)`);
    if (info.State?.Running) await stopContainer(docker, SCANNER_CONTAINER, 20).catch(() => {});
    await removeContainer(docker, SCANNER_CONTAINER);
  });
}

/** Deployed / running state of the container. Never throws. */
export async function scannerContainerState(): Promise<{ deployed: boolean; running: boolean; error: string | null }> {
  try {
    const docker = await engineFor(await localNodeId());
    const info = await inspectContainer(docker, SCANNER_CONTAINER);
    return { deployed: !!info, running: !!info?.State?.Running, error: null };
  } catch (err) {
    return { deployed: false, running: false, error: errText(err) };
  }
}

export const scannerInfraComponent: InfraComponentProvider = {
  id: 'scanner',

  async ensure(log: (line: string) => void): Promise<void> {
    await withLock(SCANNER_LOCK_KEY, async () => {
      const settings = await platformSettings.section('scanner');
      if (!settings.enabled) log('Note: the scanner is disabled in the settings (heuristics only); deploying anyway');
      if (!settings.clamav && !settings.yara) log('Note: both ClamAV and YARA are off: scand only answers the status');
      await ensureStateDir(log);
      const docker = await engineFor(await localNodeId());
      const spec = await desiredScannerSpec(settings);
      await ensureContainer(docker, spec, log);
      // scand answers within seconds; clamd needs up to a minute to load the signatures (reported, not awaited).
      const client = await scandClientOrNull();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let last = '';
      for (;;) {
        try {
          const st = await client!.status({ timeoutMs: 5_000 });
          log(`scand ${st.version ?? '?'} is answering`
            + ` — ClamAV: ${!settings.clamav ? 'off' : st.clamav.available ? `${st.clamav.version ?? '?'} (daily ${st.clamav.signatureVersion ?? '?'})` : `starting${st.clamav.error ? ` (${st.clamav.error})` : ''}`}`
            + ` — YARA: ${!settings.yara ? 'off' : st.yara.available ? `${st.yara.ruleCount ?? '?'} rules` : `unavailable${st.yara.error ? ` (${st.yara.error})` : ''}`}`);
          break;
        } catch (err) {
          last = errText(err);
        }
        if (Date.now() > deadline) throw new Error(`scand not answering after ${READY_TIMEOUT_MS / 1000} s (${last})`);
        await sleep(2_000);
      }
    });
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'scanner', deployed: false, running: false, image: scannerImage(), version: null, detail: null };
    if (!docker) return { ...base, detail: dockerError };
    try {
      const info = await inspectContainer(docker, SCANNER_CONTAINER);
      if (!info) return base;
      const labels = info.Config?.Labels ?? {};
      const out: InfraComponentStatus = {
        ...base,
        deployed: true,
        running: !!info.State?.Running,
        image: info.Config?.Image ?? base.image,
        version: labels['org.opencontainers.image.version'] ?? null,
        detail: info.State?.Running ? null : `${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}`,
      };
      if (out.running) {
        try {
          const client = await scandClientOrNull();
          if (!client) out.detail = 'shared key missing: redeploy';
          else {
            const st = await withTimeout(client.status({ timeoutMs: 5_000 }), 6_000, 'scand');
            const problems: string[] = [];
            if (st.clamav.enabled && !st.clamav.available) problems.push(`ClamAV: ${st.clamav.error ?? 'unavailable'}`);
            if (st.yara.enabled && !st.yara.available) problems.push(`YARA: ${st.yara.error ?? 'unavailable'}`);
            if (st.clamav.available && st.clamav.version) out.version = `${out.version ? `${out.version} · ` : ''}ClamAV ${st.clamav.version}`;
            out.detail = problems.length ? problems.join(' · ') : null;
          }
        } catch (err) {
          out.detail = `scand: ${errText(err)}`;
        }
      }
      return out;
    } catch (err) {
      return { ...base, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      return (await platformSettings.section('scanner')).enabled;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'scanner: settings unreadable, not ensured at boot');
      return false;
    }
  },
};
