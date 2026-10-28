import { MAIL_CONTAINER } from '../../../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// Constants of the stalwart engine (module engine-stalwart, docs/P4-PLAN.md
// §5.3). Shared by the pure renderers (config.ts, spec.ts), the API client
// (api.ts) and the driver. The pinned upstream version is also written in
// images/mail-stalwart/Dockerfile (keep both in sync).
// ─────────────────────────────────────────────────────────────────────────────

/** Upstream Stalwart release the image is built FROM (stalwartlabs/stalwart:v<this>). */
export const STALWART_VERSION = '0.12.4';

/**
 * uid / gid the engine runs as. Deliberately the same as the vmail user of the
 * postfix-dovecot engine (5000:5000): mail/certs and mail/dkim keep the right
 * group ("0640 root:<engine gid>", module mail-dns-tls) across an engine change.
 * images/mail-stalwart/Dockerfile creates the user and checks the ids.
 */
export const STALWART_UID = 5000;
export const STALWART_GID = 5000;

/** Paths inside the container (images/mail-stalwart contract). */
export const STALWART_PATHS = {
  /** paths.mailEngineConfig('stalwart'), READ-ONLY: config.toml rendered by the panel (DKIM keys: settings store, config.ts DYNAMIC_SETTINGS; dkim/ stays empty). */
  config: '/etc/oblimint/stalwart',
  configFile: '/etc/oblimint/stalwart/config.toml',
  dkim: '/etc/oblimint/stalwart/dkim',
  /** paths.mailCerts(), READ-ONLY: <name>/{fullchain,privkey}.pem (mail-dns-tls). */
  certs: '/etc/oblimint/certs',
  /** paths.mailEngineData('stalwart'), rw: RocksDB store + blobs. */
  data: '/var/lib/stalwart',
} as const;

/** Environment variable carrying the SHA512-CRYPT hash of the admin secret (never the secret itself). */
export const ADMIN_HASH_ENV = 'OBLIMINT_STALWART_ADMIN_HASH';
/** Fallback administrator of the admin API (authentication.fallback-admin). */
export const ADMIN_USER = 'oblimint-admin';
/** Master user (authentication.master): JMAP impersonation "<address>%<master>" to manage sieve scripts. */
export const MASTER_USER = 'oblimint-master';
/** app_config key of the sealed admin credentials (secretBox 'mail-admin'). */
export const ADMIN_SECRET_CONFIG = 'mail.stalwart_admin';

/** Admin HTTP API: listens on the mail network only, NEVER published (MA7). */
export const STALWART_API_PORT = 8080;
/** Internal SMTP port the site relay hands its messages to (trusted by exact address, never published). */
export const STALWART_RELAY_PORT = 10025;

/** Public mail ports published on config.hosting.mailBind. */
export const STALWART_PUBLIC_PORTS = [25, 465, 587, 143, 993, 110, 995, 4190] as const;

export const STALWART_API_URL = `http://${MAIL_CONTAINER}:${STALWART_API_PORT}`;

/** Name of the per-mailbox sieve script managed by the panel (forwarding + autoresponder). */
export const SIEVE_SCRIPT_NAME = 'oblimint';
/** List principals managed by the panel: aliases and catch-alls. */
export const LIST_PREFIX = 'oblimint-';
export const aliasListName = (aliasId: number): string => `${LIST_PREFIX}alias-${aliasId}`;
export const catchAllListName = (domainId: number): string => `${LIST_PREFIX}catchall-${domainId}`;

/** Permissions the panel toggles on individual principals (others are left alone). */
export const PERM_LOGIN = 'authenticate';
export const PERM_SEND = 'email-send';
export const PERM_RECEIVE = 'email-receive';
/**
 * JMAP EmailSubmission/set. Stalwart 0.12.4 checks email-send on SMTP
 * submission only: a principal without email-send still SENDS through JMAP
 * (its own password, or the webmail's impersonation) — verified on the Linux
 * test host. Revoked together with email-send (send toggle off, outbound
 * suspended, login off); refused there with "forbidden" while drafts
 * (Email/set) keep working.
 */
export const PERM_JMAP_SUBMIT = 'jmap-email-submission-set';
export const MANAGED_PERMISSIONS = [PERM_LOGIN, PERM_SEND, PERM_JMAP_SUBMIT, PERM_RECEIVE] as const;

/**
 * Sync bookkeeping (fingerprints only, never a secret), kept in the
 * panel-written configuration directory (root-owned, 0600, read-only in the
 * container) — NEVER in the container-writable store (a compromised engine
 * could swap it for a symbolic link). A wiped store is handled by the sync:
 * a principal it has to (re)create gets its sieve fingerprint reset.
 */
export const SYNC_STATE_FILE = 'oblimint-sync.json';
