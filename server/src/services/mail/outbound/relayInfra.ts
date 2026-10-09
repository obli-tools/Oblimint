import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { logger } from '../../../utils/logger';
import type { InfraComponentProvider } from '../../docker/extensions';
import {
  containerState, ensureImage, inspectContainer, labelHash, recreateContainer, startContainer, type Log,
} from '../../docker/dockerOps';
import { withLock } from '../../docker/locks';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, specHashLabel, TMPFS_FLAGS, withSpecHash } from '../../docker/specs';
import { LABELS, MAIL_NETWORK, MAIL_RELAY_ALIAS, MAIL_RELAY_CONTAINER, mailRelayImage, P4_LABELS } from '../../hosting/naming';
import { hostPaths } from '../../hosting/paths';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { ensureMailNetwork } from '../network';
import { RELAY_CONFIG_DIR, RELAY_CONTAINER_CONFIG, RELAY_CONTAINER_SPOOL, RELAY_SPOOL_DIR } from './relayConfig';
import { attachRelayToAllAccounts, relayEngine, writeRelayFiles } from './relaySync';

// ─────────────────────────────────────────────────────────────────────────────
// Infra component 'mail-relay' (oblimint-mail-relay, docs/P4-PLAN.md §4,
// §9.5, MA7) — module outbound-security. Hardening, and why:
//
//  - root PID 1 (tini): Postfix's master and Dovecot drop privileges
//    themselves. CapDrop ALL, then only: CHOWN / FOWNER / DAC_OVERRIDE
//    (Postfix fixes its queue ownership at start, the master opens the
//    postfix-owned queue files), SETUID / SETGID (master → postfix, Dovecot
//    auth → dovecot, su-exec → relayd), KILL (the master signals its
//    children running under another uid). No NET_BIND_SERVICE: every port
//    is > 1024 (2525, and 10026 / 10027 / 10031 on loopback).
//  - no-new-privileges; ReadonlyRootfs with tmpfs /etc/postfix (configuration
//    copied + panel overrides applied at start), /var/lib/postfix, /run, /tmp.
//  - mounts: mail/relay/config read-only (hashes, policy, overrides),
//    mail/relay/spool read-write (queue). Never the Docker socket, never an
//    account tree.
//  - networks: MAIL_NETWORK (engine 10025), then EVERY account network with
//    the alias MAIL_RELAY_ALIAS (attachRelayToAllAccounts / the reconcile
//    hook) — never a database network, NO published port.
//  - memory bounded (no swap), PidsLimit, platform OOM score, json-file logs
//    (the panel follows them: mail_log), RestartPolicy unless-stopped.
// ─────────────────────────────────────────────────────────────────────────────

export const RELAY_LOCK_KEY = 'infra:mail-relay';
export const RELAY_MEMORY_BYTES = 256 * 1048576;
export const RELAY_PIDS_LIMIT = 256;
export const RELAY_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID'] as const;

export interface RelayContainerInput {
  /** Host path of mail/relay (hostPaths.mailRelay()). */
  relayDir: string;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** PURE container spec (relayInfra.test.ts). */
export function relayContainerSpec(input: RelayContainerInput): Docker.ContainerCreateOptions {
  const dir = posix(input.relayDir);
  return withSpecHash({
    name: MAIL_RELAY_CONTAINER,
    Image: mailRelayImage(),
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'mail-relay', [P4_LABELS.mailPart]: 'relay' },
    StopTimeout: 20,
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: `${dir}/${RELAY_CONFIG_DIR}`, Target: RELAY_CONTAINER_CONFIG, ReadOnly: true },
        { Type: 'bind', Source: `${dir}/${RELAY_SPOOL_DIR}`, Target: RELAY_CONTAINER_SPOOL, ReadOnly: false },
      ],
      Tmpfs: {
        '/etc/postfix': `${TMPFS_FLAGS},size=8m`,
        '/var/lib/postfix': `${TMPFS_FLAGS},size=16m`,
        '/run': `${TMPFS_FLAGS},size=16m`,
        '/tmp': `${TMPFS_FLAGS},size=32m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [...RELAY_CAPS],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      Memory: RELAY_MEMORY_BYTES,
      MemorySwap: RELAY_MEMORY_BYTES,
      PidsLimit: RELAY_PIDS_LIMIT,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_NETWORK]: { Aliases: [MAIL_RELAY_ALIAS] } } },
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

export const mailRelayInfraComponent: InfraComponentProvider = {
  id: 'mail-relay',

  async ensure(log: (line: string) => void): Promise<void> {
    await withLock(RELAY_LOCK_KEY, async () => {
      const settings = await platformSettings.section('mail');
      if (!settings.siteRelay) log('Note: the site relay is disabled in the settings (mail.siteRelay): deploying anyway, it refuses every site');
      // Files first: the container must never start on a missing configuration.
      const { changed } = await writeRelayFiles();
      if (changed.length) log(`Relay files written: ${changed.join(', ')}`);
      await ensureMailNetwork(log);
      const docker = await relayEngine();
      await ensureContainer(docker, relayContainerSpec({ relayDir: hostPaths.mailRelay() }), log);
      await attachRelayToAllAccounts(docker, log);
      log(`${MAIL_RELAY_CONTAINER} attached to the account networks (alias ${MAIL_RELAY_ALIAS})`);
    });
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'mail-relay', deployed: false, running: false, image: mailRelayImage(), version: null, detail: null };
    if (!docker) return { ...base, detail: dockerError };
    try {
      const info = await inspectContainer(docker, MAIL_RELAY_CONTAINER);
      if (!info) return base;
      const labels = info.Config?.Labels ?? {};
      const health = (info.State as { Health?: { Status?: string } } | undefined)?.Health?.Status;
      return {
        ...base,
        deployed: true,
        running: !!info.State?.Running,
        image: info.Config?.Image ?? base.image,
        version: labels['org.opencontainers.image.version'] ?? null,
        detail: !info.State?.Running
          ? `${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}`
          : health === 'unhealthy' ? 'unhealthy (Postfix not answering)' : null,
      };
    } catch (err) {
      return { ...base, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      return (await platformSettings.section('mail')).siteRelay;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'mail-relay: settings unreadable, not ensured at boot');
      return false;
    }
  },
};
