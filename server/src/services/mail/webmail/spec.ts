import type Docker from 'dockerode';
import type { MailEndpoint } from '../driver';
import { LABELS, MAIL_NETWORK, P4_LABELS, WEBMAIL_CONTAINER, WEBMAIL_PORT } from '../../hosting/naming';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, TMPFS_SHARED_FLAGS, withSpecHash } from '../../docker/specs';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container spec of the shared webmail (docs/P4-PLAN.md §4 / §9.7,
// invariants MA7 / MA13; spec.test.ts). One container, oblimint-webmail,
// running Roundcube OR SnappyMail (settings mail.webmail; a kind change
// recreates it: the image is part of the spec hash).
//
// Hardening (H1 adapted) and why each choice:
//  - MAIL_NETWORK ONLY: the webmail talks to the engine (IMAP / submission /
//    ManageSieve) and to the panel's internal listener (alias oblimint-panel,
//    redeem / logout); the edge reaches it there on WEBMAIL_PORT. Never the
//    panel network (MA7: a webmail compromise must not reach the panel's
//    PostgreSQL), never an account network. No published port.
//  - Non-root (images/webmail-*: USER www-data, Apache on 8080) → CapDrop ALL
//    and no capability at all; no-new-privileges.
//  - Read-only root: the images are built with the code in place and a
//    config that reads the environment (no first-run copy); Apache / PHP
//    state goes to /tmp and /run (tmpfs); the only writable bind is the
//    state directory (Roundcube SQLite database / SnappyMail data), never
//    the Docker socket, never a tenant tree.
//  - Memory = MemorySwap bounded; /tmp (uploads of attachments) bounded and
//    counted in it; PidsLimit; platform OOM score; restart unless-stopped.
// ─────────────────────────────────────────────────────────────────────────────

export type WebmailKindName = 'roundcube' | 'snappymail';

/** www-data in the php:*-apache based images (owner of the state directory). */
export const WEBMAIL_UID = 33;
export const WEBMAIL_GID = 33;
export const WEBMAIL_BASE_MEMORY_MB = 256;
export const WEBMAIL_PIDS_LIMIT = 256;

/** State directory inside the container, per kind (images/webmail-<kind>/). */
export const WEBMAIL_STATE_PATHS: Record<WebmailKindName, string> = {
  roundcube: '/var/roundcube/db',
  snappymail: '/var/lib/snappymail',
};

export interface WebmailContainerInput {
  kind: WebmailKindName;
  image: string;
  /** Host path of the state directory (hostPaths.webmailData(kind)). */
  stateDir: string;
  /** HMAC(sessionSecret, 'oblimint-webmail'): sent with every redeem / logout call. */
  key: string;
  /** http://oblimint-panel:<internalPort>/internal/mail/webmail — the image appends /redeem and /logout. */
  panelUrl: string;
  imap: MailEndpoint;
  submission: MailEndpoint | null;
  sieve: MailEndpoint | null;
  /** Roundcube des_key (24 characters, sealed in app_config): cookie / session password encryption. */
  desKey: string;
  /** Mail network subnet(s): the edge's X-Forwarded-For is trusted from there only. */
  trustedProxies: string[];
  /** Platform message size ceiling (MiB): upload limits of the webmail. */
  maxMessageSizeMb: number;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const NET_RE = /^[0-9A-Fa-f:.]+\/\d{1,3}$/;

/** Endpoint → env triple; throws on a value that would not be a plain host / port (never reaches an env line). */
function endpointEnv(prefix: string, e: MailEndpoint | null): string[] {
  if (!e) return [];
  if (!HOST_RE.test(e.host) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || !['none', 'starttls', 'tls'].includes(e.tls)) {
    throw new Error(`invalid ${prefix} endpoint`);
  }
  return [`OBLIMINT_${prefix}_HOST=${e.host}`, `OBLIMINT_${prefix}_PORT=${e.port}`, `OBLIMINT_${prefix}_TLS=${e.tls}`];
}

/** /tmp size: room for a few uploads of the largest message, bounded. */
export function webmailTmpfsMb(maxMessageSizeMb: number): number {
  const m = Number.isFinite(maxMessageSizeMb) && maxMessageSizeMb > 0 ? Math.ceil(maxMessageSizeMb) : 50;
  return Math.min(512, Math.max(128, m * 2 + 64));
}

export function webmailContainerSpec(input: WebmailContainerInput): Docker.ContainerCreateOptions {
  const tmpfsMb = webmailTmpfsMb(input.maxMessageSizeMb);
  const memory = (WEBMAIL_BASE_MEMORY_MB + tmpfsMb) * 1048576;
  if (!/^[0-9a-f]{64}$/.test(input.key)) throw new Error('invalid webmail key');
  if (!/^[A-Za-z0-9_-]{24}$/.test(input.desKey)) throw new Error('invalid des_key');
  const nets = input.trustedProxies.filter((n) => NET_RE.test(n));
  const env = [
    `OBLIMINT_WEBMAIL_KIND=${input.kind}`,
    `OBLIMINT_WEBMAIL_KEY=${input.key}`,
    `OBLIMINT_PANEL_URL=${input.panelUrl}`,
    ...endpointEnv('IMAP', input.imap),
    ...endpointEnv('SMTP', input.submission),
    ...endpointEnv('SIEVE', input.sieve),
    `OBLIMINT_TRUSTED_PROXIES=${nets.join(',')}`,
    `OBLIMINT_MAX_MESSAGE_MB=${Math.max(1, Math.ceil(input.maxMessageSizeMb) || 1)}`,
  ];
  if (input.kind === 'roundcube') env.push(`OBLIMINT_DES_KEY=${input.desKey}`);

  return withSpecHash({
    name: WEBMAIL_CONTAINER,
    Image: input.image,
    Env: env,
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.role]: 'webmail',
      [P4_LABELS.mailPart]: 'webmail',
    },
    ExposedPorts: { [`${WEBMAIL_PORT}/tcp`]: {} },
    HostConfig: {
      Mounts: [{ Type: 'bind', Source: posix(input.stateDir), Target: WEBMAIL_STATE_PATHS[input.kind], ReadOnly: false }],
      Tmpfs: {
        '/tmp': `${TMPFS_SHARED_FLAGS},size=${tmpfsMb}m`,
        '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: WEBMAIL_PIDS_LIMIT,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: MAIL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [MAIL_NETWORK]: { Aliases: [WEBMAIL_CONTAINER] } } },
  });
}
