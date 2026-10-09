import fs from 'fs';
import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import type { InfraComponentProvider } from '../docker/extensions';
import {
  containerState, ensureImage, inspectContainer, inspectNetwork, labelHash, recreateContainer, startContainer, type Log,
} from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { withLock } from '../docker/locks';
import { specHashLabel } from '../docker/specs';
import { PANEL_NETWORK, PDNS_CONTAINER } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { platformSettings } from '../platformSettings';
import { errText, withTimeout } from '../setup/docker';
import { ensureApiKey, invalidatePdnsClient, pdns } from './pdnsClient';
import { defaultSoaContent, networkSubnets, pdnsContainerSpec, PDNS_UID, withBindHint } from './pdnsSpec';

// ─────────────────────────────────────────────────────────────────────────────
// PowerDNS infra component (module dns, docs/P2-PLAN.md §9.1). Deployed by the
// setup wizard step 'dns' (applySetup.ts), by POST /api/system/infra/dns/deploy
// and at boot when settings dns.enabled. Container PDNS_CONTAINER on the panel
// network, host ports 53/udp + 53/tcp, API on 8081 reachable ONLY on the panel
// network (never published), API key sealed (secretBox 'pdns-api') in
// app_config. AXFR / NOTIFY are per-zone metadata pushed by the sync (no
// restart when the settings change).
// ─────────────────────────────────────────────────────────────────────────────

const API_READY_TIMEOUT_MS = 60_000;
const LOCK_KEY = 'infra:dns';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostRoot(): string {
  return config.hostDataDir.replace(/\\/g, '/');
}

/** /srv/oblimint/dns owned by the pdns user, 0700 (gsqlite3 writes its journal next to the database). */
async function ensureStateDir(log: Log): Promise<void> {
  const dir = localPaths.dnsDir();
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    await fs.promises.chown(dir, PDNS_UID, PDNS_UID);
    await fs.promises.chmod(dir, 0o700);
  } catch (err) {
    log(`Could not hand ${dir} to uid ${PDNS_UID}: ${errText(err)}`);
    throw err;
  }
}

async function panelHostname(): Promise<string | null> {
  const row = await db('app_config').where({ key: 'panel_hostname' }).first('value') as { value: string } | undefined;
  return row?.value?.trim().toLowerCase() || null;
}

/** (Re)creates the container when missing or drifted, starts it. */
async function ensureContainer(docker: Docker, spec: Docker.ContainerCreateOptions, log: Log): Promise<'created' | 'recreated' | 'started' | 'unchanged'> {
  const name = spec.name!;
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  if (!info) {
    log(`Creating ${name} (${spec.Image})`);
    await recreateContainer(docker, spec, true);
    return 'created';
  }
  if (labelHash(info.Config?.Labels) !== specHashLabel(spec)) {
    log(`${name}: specification changed, recreating`);
    await recreateContainer(docker, spec, true);
    return 'recreated';
  }
  if (!info.State?.Running) {
    log(`Starting ${name}`);
    await startContainer(docker, name);
    return 'started';
  }
  log(`${name} is up to date and running`);
  return 'unchanged';
}

export const dnsInfraComponent: InfraComponentProvider = {
  id: 'dns',

  async ensure(log: (line: string) => void): Promise<void> {
    await withLock(LOCK_KEY, async () => {
      const settings = await platformSettings.section('dns');
      if (!settings.enabled) log('Note: the platform DNS is disabled in the settings (zones are "hosted elsewhere"); deploying anyway');
      await ensureStateDir(log);
      const docker = await engineFor(await localNodeId());
      const net = await inspectNetwork(docker, PANEL_NETWORK);
      if (!net) throw new Error(`network ${PANEL_NETWORK} not found`);
      const subnets = networkSubnets(net);
      const apiKey = await ensureApiKey();
      const spec = pdnsContainerSpec({
        hostDataDir: hostRoot(),
        apiKey,
        apiAllowFrom: subnets,
        defaultSoaContent: defaultSoaContent(settings.nameservers, settings.hostmasterEmail, await panelHostname()),
        bindAddresses: config.hosting.pdnsBind,
        hostPort: config.hosting.pdnsPort,
      });
      log(`Publishing DNS on ${config.hosting.pdnsBind.length ? config.hosting.pdnsBind.join(', ') : 'every host address'} port ${config.hosting.pdnsPort} (udp + tcp)`);
      let what: Awaited<ReturnType<typeof ensureContainer>>;
      try {
        what = await ensureContainer(docker, spec, log);
      } catch (err) {
        throw new Error(withBindHint(errText(err)));
      }
      invalidatePdnsClient();
      log('Waiting for the PowerDNS API…');
      const deadline = Date.now() + API_READY_TIMEOUT_MS;
      let lastError = '';
      for (;;) {
        try {
          const info = await withTimeout((await pdns()).serverInfo(), 5_000, 'PowerDNS API');
          log(`PowerDNS ${info.version ?? '?'} is answering`);
          break;
        } catch (err) {
          lastError = errText(err);
        }
        if (Date.now() > deadline) throw new Error(`PowerDNS API not answering after ${API_READY_TIMEOUT_MS / 1000} s (${lastError})`);
        await sleep(2_000);
      }
      if (what !== 'unchanged') {
        const { dnsService } = await import('./dns.service');
        dnsService.requestSyncAll('pdns-deployed');
      }
    });
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'dns', deployed: false, running: false, image: null, version: null, detail: null };
    if (!docker) return { ...base, detail: dockerError };
    try {
      const info = await inspectContainer(docker, PDNS_CONTAINER);
      if (!info) return base;
      const labels = info.Config?.Labels ?? {};
      const out: InfraComponentStatus = {
        ...base,
        deployed: true,
        running: !!info.State?.Running,
        image: info.Config?.Image ?? null,
        version: labels['org.opencontainers.image.version'] ?? null,
        detail: info.State?.Running ? null : `${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}${info.State?.Error ? `: ${info.State.Error}` : ''}`,
      };
      if (out.running) {
        try {
          const v = (await withTimeout((await pdns()).serverInfo(), 5_000, 'PowerDNS API')).version;
          if (v && !out.version) out.version = v;
        } catch (err) {
          out.detail = `API: ${errText(err)}`;
        }
      }
      return out;
    } catch (err) {
      return { ...base, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      return (await platformSettings.section('dns')).enabled;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'dns: settings unreadable, PowerDNS not ensured at boot');
      return false;
    }
  },
};
