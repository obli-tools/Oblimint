import { isIP } from 'net';
import type Docker from 'dockerode';
import {
  LABELS, MAIL_CONTAINER, MAIL_NETWORK, MAIL_REDIS_CONTAINER, MAIL_RSPAMD_CONTAINER, mailPostfixImage, mailRedisImage, mailRspamdImage,
  P4_LABELS,
} from '../../../hosting/naming';
import { hostingLayout } from '../../../hosting/paths';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, TMPFS_FLAGS, withSpecHash } from '../../../docker/specs';
import {
  C_CERTS, C_CONFIG, C_DKIM, C_RSPAMD_LOCAL, C_SPOOL, C_STATE, C_VMAIL, ENGINE, MAIL_CORE_NETWORK, PUBLIC_PORTS, REDIS_PORT, REDIS_UID,
  RSPAMD_GID, RSPAMD_UID,
} from './layout';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container specs of the postfix-dovecot engine (spec.test.ts), hardened
// after docs/P4-PLAN.md §4 / ARCHITECTURE §3.6 (H1 adapted, MA7):
//  - every container: CapDrop ALL (+ the minimal set below, justified),
//    no-new-privileges, read-only root, tmpfs /run /tmp, PidsLimit, memory
//    without swap, platform oom_score_adj, json-file log rotation,
//    RestartPolicy unless-stopped, labels oblimint.internal / role=mail /
//    mail-part / spec-hash; never the Docker socket, never an account tree,
//    nothing of mail/ but what the container needs;
//  - networks: oblimint-mail is created on MAIL_NETWORK (webmail, relay,
//    edge, panel reach IMAP / submission / the relay intake there) and the
//    driver also attaches it to MAIL_CORE_NETWORK; oblimint-mail-rspamd and
//    oblimint-mail-redis are on MAIL_CORE_NETWORK ONLY: the unauthenticated
//    milter (a client can claim any SASL user ⇒ DKIM signature for any
//    hosted domain) and Redis (send-limit counters, greylisting, Bayes) are
//    unreachable from the webmail / edge / panel / site relay;
//  - oblimint-mail publishes the public mail ports only (on
//    config.hosting.mailBind addresses, or every address); the relay intake
//    (10025) and every internal service stay unpublished;
//  - oblimint-mail-rspamd / -redis publish nothing (the Rspamd controller
//    11334 listens on 127.0.0.1 inside the container only).
//  - Redis: maxmemory with allkeys-lru (Bayes tokens can always be evicted;
//    a refused INCR would make the send limit soft-reject everything).
// ─────────────────────────────────────────────────────────────────────────────

export const ENGINE_MEMORY_BYTES = 768 * 1048576;
export const ENGINE_PIDS_LIMIT = 2048;
export const RSPAMD_MEMORY_BYTES = 512 * 1048576;
export const RSPAMD_PIDS_LIMIT = 256;
export const REDIS_MEMORY_BYTES = 192 * 1048576;
export const REDIS_PIDS_LIMIT = 64;
/** Redis keeps the Rspamd state (Bayes, greylisting, rate counters) under this cap. */
export const REDIS_MAXMEMORY = '128mb';
export const ENGINE_STOP_TIMEOUT_SEC = 30;

/**
 * Capabilities of oblimint-mail. Postfix's master and Dovecot's master start
 * as root and run every service under its own user, which needs:
 *  - NET_BIND_SERVICE: listen on 25 / 110 / 143 / 465 / 587 / 993 / 995;
 *  - SETUID / SETGID: drop to postfix / dovecot / dovenull / vmail (5000);
 *  - CHOWN / FOWNER: Postfix creates and fixes its queue directories, Dovecot
 *    its runtime sockets (owner postfix, mode 0600 / 0660);
 *  - DAC_OVERRIDE: root tools (postqueue, postsuper, doveadm, the reload
 *    script) read the postfix-owned queue (0700) and the vmail-owned homes;
 *  - KILL: the masters signal their children running under other users;
 *  - SYS_CHROOT: Dovecot chroots its pre-authentication login processes
 *    (imap-login, pop3-login, managesieve-login) — kept as a defence layer.
 * Nothing else (no NET_RAW, no SYS_ADMIN, no MKNOD, no AUDIT_WRITE).
 */
export const ENGINE_CAP_ADD = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'NET_BIND_SERVICE', 'SETGID', 'SETUID', 'SYS_CHROOT'] as const;

const labels = (part: 'engine' | 'rspamd' | 'redis') => ({
  [LABELS.internal]: 'true',
  [LABELS.role]: 'mail',
  [P4_LABELS.mailPart]: part,
  'oblimint.mail-engine': ENGINE,
});

/** Docker PortBindings of one mail port: one entry per bind address, or one without HostIp (every address). */
export function mailHostBindings(bindAddresses: string[] | undefined, port: number): Array<{ HostIp?: string; HostPort: string }> {
  const addrs = [...new Set((bindAddresses ?? []).map((a) => a.trim().replace(/^\[(.*)\]$/, '$1')).filter(Boolean))];
  for (const a of addrs) if (isIP(a) === 0) throw new Error(`invalid mail bind address "${a}" (OBLIMINT_MAIL_BIND expects IP addresses)`);
  return addrs.length ? addrs.map((HostIp) => ({ HostIp, HostPort: String(port) })) : [{ HostPort: String(port) }];
}

export interface EngineSpecInput {
  /** Host data root (config.hostDataDir). */
  hostDataDir: string;
  /** OBLIMINT_MAIL_BIND (config.hosting.mailBind). */
  bindAddresses: string[];
  image?: string;
}

/** Host subdirectories of mail/data/postfix-dovecot bound into oblimint-mail. */
export function engineDataDirs(dataRoot: string): { vmail: string; spool: string; state: string } {
  const r = dataRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return { vmail: `${r}/vmail`, spool: `${r}/spool`, state: `${r}/state` };
}

export function engineContainerSpec(input: EngineSpecInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  const data = engineDataDirs(layout.mailEngineData(ENGINE));
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
  for (const p of PUBLIC_PORTS) {
    exposed[`${p}/tcp`] = {};
    bindings[`${p}/tcp`] = mailHostBindings(input.bindAddresses, p);
  }
  return withSpecHash({
    name: MAIL_CONTAINER,
    Image: input.image ?? mailPostfixImage(),
    Hostname: MAIL_CONTAINER,
    Labels: labels('engine'),
    ExposedPorts: exposed,
    StopTimeout: ENGINE_STOP_TIMEOUT_SEC,
    HostConfig: {
      PortBindings: bindings,
      Mounts: [
        { Type: 'bind', Source: data.vmail, Target: C_VMAIL, ReadOnly: false },
        { Type: 'bind', Source: data.spool, Target: C_SPOOL, ReadOnly: false },
        { Type: 'bind', Source: data.state, Target: C_STATE, ReadOnly: false },
        { Type: 'bind', Source: layout.mailEngineConfig(ENGINE), Target: C_CONFIG, ReadOnly: true },
        { Type: 'bind', Source: layout.mailCerts(), Target: C_CERTS, ReadOnly: true },
      ],
      Tmpfs: {
        // compiled configuration generations, sockets, pid files, self-signed fallback
        '/run': `${TMPFS_FLAGS},size=64m`,
        '/tmp': `${TMPFS_FLAGS},size=64m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [...ENGINE_CAP_ADD],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: ENGINE_PIDS_LIMIT,
      Memory: ENGINE_MEMORY_BYTES,
      MemorySwap: ENGINE_MEMORY_BYTES,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_NETWORK]: { Aliases: [MAIL_CONTAINER] } } },
  });
}

export interface SidecarSpecInput {
  hostDataDir: string;
  image?: string;
}

/** Networks oblimint-mail is attached to after creation (alias = its name). */
export const ENGINE_EXTRA_NETWORKS = [MAIL_CORE_NETWORK] as const;

/**
 * oblimint-mail-rspamd (MAIL_CORE_NETWORK only): runs directly as the image's rspamd user (fixed uid /
 * gid), so NO capability at all; reads its generated local.d and the DKIM
 * keys (0640 root:RSPAMD_GID) read-only.
 */
export function rspamdContainerSpec(input: SidecarSpecInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  return withSpecHash({
    name: MAIL_RSPAMD_CONTAINER,
    Image: input.image ?? mailRspamdImage(),
    User: `${RSPAMD_UID}:${RSPAMD_GID}`,
    Labels: labels('rspamd'),
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: `${layout.mailEngineConfig(ENGINE)}/rspamd`, Target: C_RSPAMD_LOCAL, ReadOnly: true },
        { Type: 'bind', Source: layout.mailDkim(), Target: C_DKIM, ReadOnly: true },
      ],
      Tmpfs: {
        '/run': `${TMPFS_FLAGS},size=16m,mode=1777`,
        '/tmp': `${TMPFS_FLAGS},size=128m,mode=1777`,
        // rspamd's dbdir (history, local caches): statistics and greylisting live in Redis
        '/var/lib/rspamd': `${TMPFS_FLAGS},size=64m,uid=${RSPAMD_UID},gid=${RSPAMD_GID},mode=0700`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: RSPAMD_PIDS_LIMIT,
      Memory: RSPAMD_MEMORY_BYTES,
      MemorySwap: RSPAMD_MEMORY_BYTES,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_CORE_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_CORE_NETWORK]: { Aliases: [MAIL_RSPAMD_CONTAINER] } } },
  });
}

/**
 * oblimint-mail-redis (official image, pinned in the configuration): runs as
 * REDIS_UID directly (the official entrypoint only switches user when started
 * as root), no capability, data in mail/redis, MAIL_CORE_NETWORK only (engine,
 * Rspamd, scanner): no password, no member reachable from the Internet-facing
 * containers.
 */
export function redisContainerSpec(input: SidecarSpecInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  return withSpecHash({
    name: MAIL_REDIS_CONTAINER,
    Image: input.image ?? mailRedisImage(),
    User: `${REDIS_UID}:${REDIS_UID}`,
    Cmd: [
      'redis-server',
      '--bind', '0.0.0.0',
      '--port', String(REDIS_PORT),
      '--protected-mode', 'no',
      '--dir', '/data',
      '--save', '300', '10',
      '--appendonly', 'no',
      '--maxmemory', REDIS_MAXMEMORY,
      '--maxmemory-policy', 'allkeys-lru',
    ],
    Labels: labels('redis'),
    HostConfig: {
      Mounts: [{ Type: 'bind', Source: layout.mailRedis(), Target: '/data', ReadOnly: false }],
      Tmpfs: { '/tmp': `${TMPFS_FLAGS},size=16m`, '/run': `${TMPFS_FLAGS},size=8m` },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: REDIS_PIDS_LIMIT,
      Memory: REDIS_MEMORY_BYTES,
      MemorySwap: REDIS_MEMORY_BYTES,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_CORE_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_CORE_NETWORK]: { Aliases: [MAIL_REDIS_CONTAINER] } } },
  });
}
