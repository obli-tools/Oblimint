import { isIP } from 'net';
import type Docker from 'dockerode';
import { LABELS, MAIL_CONTAINER, MAIL_NETWORK, mailStalwartImage, P4_LABELS } from '../../../hosting/naming';
import { hostingLayout } from '../../../hosting/paths';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, TMPFS_FLAGS, withSpecHash } from '../../../docker/specs';
import {
  ADMIN_HASH_ENV, STALWART_API_PORT, STALWART_GID, STALWART_PATHS, STALWART_PUBLIC_PORTS, STALWART_RELAY_PORT, STALWART_UID,
} from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// PURE spec of the oblimint-mail container for the stalwart engine
// (spec.test.ts). Hardening (docs/P4-PLAN.md §4, H1 adapted to a platform
// mail engine — same shape as oblimint-pdns):
//   - runs as 5000:5000 (image user `stalwart`), CapDrop ALL and NO capability
//     added: the privileged mail ports are bound thanks to the network
//     namespace sysctl net.ipv4.ip_unprivileged_port_start=25 (covers IPv6
//     too), so neither NET_BIND_SERVICE nor any setuid / chown capability is
//     needed (Stalwart is a single process that never changes user);
//   - no-new-privileges, read-only root, tmpfs /tmp and /run, Init (docker-init
//     as PID 1), PidsLimit (Stalwart + RocksDB threads), Memory = MemorySwap,
//     nofile 65536, oom_score_adj of a platform component, json-file logs;
//   - mounts: mail/config/stalwart RO (config.toml + DKIM keys), mail/certs RO,
//     mail/data/stalwart rw (store + blobs); tmpfs over the image VOLUME
//     /opt/stalwart (no anonymous volume). Never the Docker socket, never an
//     account tree;
//   - MAIL_NETWORK only; publishes the 8 public mail ports on
//     config.hosting.mailBind (every host address when empty); the internal
//     relay port 10025 and the admin API 8080 are exposed to the mail network
//     but NEVER published (MA7);
//   - the admin secret reaches Stalwart as a SHA512-CRYPT hash in the
//     environment (never the clear secret);
//   - labels oblimint.internal, role=mail, mail-part=engine, spec-hash.
// ─────────────────────────────────────────────────────────────────────────────

/** VOLUME declared by stalwartlabs/stalwart (covered by a tmpfs, see the spec). */
export const STALWART_IMAGE_VOLUME = '/opt/stalwart';

export const STALWART_MEMORY_BYTES = 1024 * 1048576;
export const STALWART_PIDS_LIMIT = 1024;
export const STALWART_NOFILE_LIMIT = 65536;

export interface StalwartContainerInput {
  /** Host data root (config.hostDataDir, POSIX). */
  hostDataDir: string;
  /** SHA512-CRYPT hash of the admin secret. */
  adminHash: string;
  /** Host addresses the mail ports are published on ([] = every address). */
  bindAddresses: string[];
  image?: string;
}

/** PortBindings entries of one port: one per host address, or one without HostIp. */
export function mailHostBindings(bindAddresses: string[], port: number): Array<{ HostIp?: string; HostPort: string }> {
  const addrs = [...new Set(bindAddresses.map((a) => a.trim().replace(/^\[(.*)\]$/, '$1')).filter(Boolean))];
  for (const a of addrs) if (isIP(a) === 0) throw new Error(`invalid mail bind address "${a}" (OBLIMINT_MAIL_BIND expects IP addresses)`);
  return addrs.length ? addrs.map((HostIp) => ({ HostIp, HostPort: String(port) })) : [{ HostPort: String(port) }];
}

export function stalwartContainerSpec(input: StalwartContainerInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  if (!/^\$6\$(rounds=\d{4,9}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/.test(input.adminHash)) throw new Error('invalid Stalwart admin secret hash');
  const exposed: Record<string, object> = {};
  const bindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
  for (const p of STALWART_PUBLIC_PORTS) {
    exposed[`${p}/tcp`] = {};
    bindings[`${p}/tcp`] = mailHostBindings(input.bindAddresses, p);
  }
  // Reachable on the mail network only: never in PortBindings.
  exposed[`${STALWART_RELAY_PORT}/tcp`] = {};
  exposed[`${STALWART_API_PORT}/tcp`] = {};
  return withSpecHash({
    name: MAIL_CONTAINER,
    Image: input.image ?? mailStalwartImage(),
    User: `${STALWART_UID}:${STALWART_GID}`,
    Env: [`${ADMIN_HASH_ENV}=${input.adminHash}`],
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'mail', [P4_LABELS.mailPart]: 'engine' },
    ExposedPorts: exposed,
    HostConfig: {
      PortBindings: bindings,
      Mounts: [
        { Type: 'bind', Source: layout.mailEngineConfig('stalwart'), Target: STALWART_PATHS.config, ReadOnly: true },
        { Type: 'bind', Source: layout.mailCerts(), Target: STALWART_PATHS.certs, ReadOnly: true },
        { Type: 'bind', Source: layout.mailEngineData('stalwart'), Target: STALWART_PATHS.data, ReadOnly: false },
      ],
      Tmpfs: {
        '/tmp': `${TMPFS_FLAGS},size=64m`,
        '/run': `${TMPFS_FLAGS},size=8m`,
        // The upstream image declares VOLUME /opt/stalwart: without a mount
        // there Docker adds an anonymous writable volume at every (re)creation
        // (leaked volumes, a writable path outside the read-only root). Nothing
        // is kept there: config, data and certificates are the mounts above.
        [STALWART_IMAGE_VOLUME]: `${TMPFS_FLAGS},size=16m`,
      },
      Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '25' },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      Init: true,
      PidsLimit: STALWART_PIDS_LIMIT,
      Memory: STALWART_MEMORY_BYTES,
      MemorySwap: STALWART_MEMORY_BYTES,
      Ulimits: [{ Name: 'nofile', Soft: STALWART_NOFILE_LIMIT, Hard: STALWART_NOFILE_LIMIT }],
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_NETWORK]: { Aliases: [MAIL_CONTAINER] } } },
  });
}
