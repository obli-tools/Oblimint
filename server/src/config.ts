import './env';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_SITE_IMAGE_PREFIX } from '@oblimint/shared';

// ── Panel configuration ──────────────────────────────────────────────────────
//
// Two sources, in this order (docs/P0-PLAN.md §Mode setup):
//   1. the environment: DATABASE_URL (+ SESSION_SECRET) — development, or an
//      operator who runs his own PostgreSQL;
//   2. ${OBLIMINT_DATA_DIR:-/srv/oblimint}/config/oblimint.json — written by
//      the first-run setup wizard (0600), read at every start.
// Neither → SETUP MODE: no database at all, only /health, /api/setup/* and
// the static client answer (index.ts → setupApp.ts).

export type PanelMode = 'setup' | 'normal';

/** Content of config/oblimint.json (services/setup/configFile.ts writes it). */
export interface PanelConfigFile {
  databaseUrl: string;
  sessionSecret: string;
  panel?: {
    hostname?: string;
    publicIpv4?: string | null;
    publicIpv6?: string | null;
    nameservers?: string[];
    acmeEmail?: string;
    mailEngine?: string;
  };
  createdAt?: string;
}

const explicitDevelopment = process.env.NODE_ENV === 'development';
const DEV_SESSION_SECRET = 'change-this-secret';

export const dataDir = path.resolve(process.env.OBLIMINT_DATA_DIR || '/srv/oblimint');
export const configFilePath = path.join(dataDir, 'config', 'oblimint.json');

/** Reads config/oblimint.json, or null when absent. An unreadable or invalid
 *  file is fatal (better than silently falling back to setup mode, which
 *  would offer to deploy a second PostgreSQL over the first one). */
export function readConfigFile(): PanelConfigFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configFilePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read ${configFilePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configFilePath} is not valid JSON`);
  }
  const f = parsed as Partial<PanelConfigFile>;
  if (!f || typeof f.databaseUrl !== 'string' || !f.databaseUrl || typeof f.sessionSecret !== 'string') {
    throw new Error(`${configFilePath} lacks databaseUrl / sessionSecret`);
  }
  return f as PanelConfigFile;
}

let fileConfig: PanelConfigFile | null = null;
let fileError: string | null = null;
if (!process.env.DATABASE_URL) {
  try {
    fileConfig = readConfigFile();
  } catch (err) {
    fileError = (err as Error).message;
  }
}

function resolveMode(): PanelMode {
  if (process.env.DATABASE_URL) return 'normal';
  if (fileConfig || fileError) return 'normal'; // fileError: refused at start
  return 'setup';
}

const defaultPort = process.env.PANEL_TLS === 'selfsigned' ? '8443' : '3025';

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function numEnv(name: string, fallback: number): number {
  const n = parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Node ceiling of ONE site container (docs/P1-PLAN.md §18): 3/4 of the host
 * RAM (os.totalmem reads the host's /proc/meminfo, also from the panel
 * container) and of its CPUs, so that a site never takes the whole host from
 * the panel, its PostgreSQL, the edge and the other tenants.
 */
const DEFAULT_SITE_MAX_MEMORY_MB = Math.max(256, Math.floor((os.totalmem() / 1048576) * 0.75));
const DEFAULT_SITE_MAX_CPUS = Math.max(1, Math.floor(((typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1) * 0.75));

export const config = {
  mode: resolveMode() as PanelMode,
  /** Where the panel configuration came from (logs only). */
  configSource: process.env.DATABASE_URL ? 'env' : fileConfig ? 'file' : 'none',
  configFileError: fileError,
  port: parseInt(process.env.PORT || defaultPort, 10),
  /** 'selfsigned' → HTTPS with a self-signed certificate kept in the data dir. */
  panelTls: (process.env.PANEL_TLS || '').trim().toLowerCase(),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  /** Mutable: the setup wizard sets it once PostgreSQL is deployed (knexfile). */
  databaseUrl: process.env.DATABASE_URL || fileConfig?.databaseUrl || '',
  sessionSecret: process.env.SESSION_SECRET || fileConfig?.sessionSecret || (explicitDevelopment ? DEV_SESSION_SECRET : ''),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  /**
   * Extra browser origins allowed to send state-changing requests and open a
   * socket (ALLOWED_ORIGINS, comma-separated, e.g. "https://panel.example").
   * The origin of the request's own Host and clientOrigin are always allowed
   * (middleware/originGuard.ts).
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean),
  forceHttps: process.env.FORCE_HTTPS === 'true',
  appName: process.env.APP_NAME || 'Oblimint',
  appUrl: process.env.APP_URL || '',
  /** Max proxies chained in front of the panel whose X-Forwarded-For entries
   *  are believed (min 1). Only TRUSTED addresses count — the edge container
   *  (read from Docker) and TRUSTED_PROXIES —, never any peer: port 8443 stays
   *  published directly (utils/clientIp.ts expressTrustProxy). */
  trustProxyHops: Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '0', 10) || 0),
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || '',
  disable2faForce: process.env.DISABLE_2FA_FORCE === 'true',
  /** Docker Engine socket (setup host checks, deployments). */
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  /** Same path on the host as in the container (docker run -v /srv/oblimint:/srv/oblimint). */
  hostDataDir: path.resolve(process.env.OBLIMINT_HOST_DATA_DIR || dataDir),
  /** P1 hosting core (docs/P1-PLAN.md §Configuration). */
  hosting: {
    /** OBLIMINT_WORKERS=off: no reconcile / publish / renewal / usage worker
     *  (development on a box without Docker). The API still answers. */
    workersEnabled: process.env.OBLIMINT_WORKERS !== 'off',
    /**
     * Ceiling of every site container (memory MiB / CPUs): applied when the
     * plan leaves the value unlimited (null) and when the plan asks for more
     * (a reseller's "unlimited" plan never means "the whole host"). 0 = no
     * ceiling (previous behaviour). Defaults: 3/4 of the host RAM / CPUs.
     */
    siteMaxMemoryMb: intEnv('OBLIMINT_SITE_MAX_MEMORY_MB', DEFAULT_SITE_MAX_MEMORY_MB),
    siteMaxCpus: numEnv('OBLIMINT_SITE_MAX_CPUS', DEFAULT_SITE_MAX_CPUS),
    /** Internal HTTP listener for the file-server hooks (never published on the host; 0 = disabled). */
    internalPort: intEnv('OBLIMINT_INTERNAL_PORT', 8081),
    /** Hook calls accepted only from the account's own file server address
     *  (services/docker/hookSource.ts). 'off' = token only (escape hatch). */
    hookSourceCheck: process.env.OBLIMINT_HOOK_SOURCE_CHECK !== 'off',
    /** uid/gid range of hosting accounts (gid = uid). */
    uidMin: intEnv('OBLIMINT_UID_MIN', 20000),
    uidMax: intEnv('OBLIMINT_UID_MAX', 59999),
    /** Host ports of the per-account file servers (SFTP). */
    filesrvPortMin: intEnv('OBLIMINT_FILESRV_PORT_MIN', 30000),
    filesrvPortMax: intEnv('OBLIMINT_FILESRV_PORT_MAX', 32767),
    /** Tag of every managed image (site bases, edge, hostd, filesrv). */
    imageTag: process.env.OBLIMINT_IMAGE_TAG || 'latest',
    edgeImage: process.env.OBLIMINT_EDGE_IMAGE || 'meejay/oblimint-edge',
    hostdImage: process.env.OBLIMINT_HOSTD_IMAGE || 'meejay/oblimint-hostd',
    filesrvImage: process.env.OBLIMINT_FILESRV_IMAGE || 'meejay/oblimint-filesrv',
    /** Repository prefix of the site base images: <prefix><base id>:<imageTag>
     *  ('meejay/oblimint-' → meejay/oblimint-nginx-php8.3:latest). A private or
     *  test registry sets e.g. 'registry.example:5000/oblimint-'. */
    siteImagePrefix: process.env.OBLIMINT_SITE_IMAGE_PREFIX || DEFAULT_SITE_IMAGE_PREFIX,
    /** hostd API socket (same path in the panel container and on the host). */
    hostdSocket: process.env.OBLIMINT_HOSTD_SOCKET || path.join(dataDir, 'run', 'hostd.sock'),
    /** Default Let's Encrypt directory (app_config `acme_directory` overrides it). */
    acmeDirectory: (process.env.ACME_DIRECTORY === 'staging' ? 'staging' : 'production') as 'production' | 'staging',
    /** Releases kept materialized on disk per site (+ the current one). */
    releasesKeep: intEnv('OBLIMINT_RELEASES_KEEP', 10),
    /** git executable used by the release pipeline. */
    gitBinary: process.env.OBLIMINT_GIT || 'git',
    /** Forwarded to hostd: without XFS project quotas, accept disk limits that
     *  are only measured (not enforced). Off by default: hostd refuses them. */
    allowMeasuredQuota: ['1', 'true', 'yes', 'on'].includes((process.env.OBLIMINT_ALLOW_MEASURED_QUOTA || '').trim().toLowerCase()),
    // ── P2 (docs/P2-PLAN.md §Configuration) ──
    /**
     * Port gateway (hostd): the file servers publish NO host port; hostd
     * listens on each account's SFTP port, applies the allow-list / bans,
     * starts the file server on demand (socket activation) and proxies with
     * the PROXY protocol. 'off' = P1 behaviour (Docker publishes the port).
     */
    portGateway: process.env.OBLIMINT_PORT_GATEWAY !== 'off',
    /** Host ports of the external SQL access of database instances. */
    dbPortMin: intEnv('OBLIMINT_DB_PORT_MIN', 33000),
    dbPortMax: intEnv('OBLIMINT_DB_PORT_MAX', 34999),
    /** Registry prefix of the official database images ('' = Docker Hub): <prefix>mariadb:11.4. */
    dbImagePrefix: process.env.OBLIMINT_DB_IMAGE_PREFIX || '',
    /** PowerDNS Authoritative image (module dns). */
    pdnsImage: process.env.OBLIMINT_PDNS_IMAGE || 'meejay/oblimint-pdns',
    /**
     * Host addresses PowerDNS publishes port 53 on (comma / space separated
     * IPs, e.g. the LAN or public address). Empty = every address, which
     * Docker cannot do while systemd-resolved's stub holds 127.0.0.53:53.
     */
    pdnsBind: (process.env.OBLIMINT_PDNS_BIND || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    /** Host port of PowerDNS (container side always 53). */
    pdnsPort: intEnv('OBLIMINT_PDNS_PORT', 53),
    /** phpMyAdmin / Adminer images with the panel single sign-on (module databases). */
    phpMyAdminImage: process.env.OBLIMINT_PMA_IMAGE || 'meejay/oblimint-phpmyadmin',
    adminerImage: process.env.OBLIMINT_ADMINER_IMAGE || 'meejay/oblimint-adminer',
    /** Per-site persisted access logs (module cron-logs): <data>/logs. */
    logsDir: process.env.OBLIMINT_LOGS_DIR || path.join(dataDir, 'logs'),
    /** Usage collector + enforcement workers (module usage). 'off' = no collection. */
    usageCollector: process.env.OBLIMINT_USAGE_COLLECTOR !== 'off',
    // ── P3 (docs/P3-PLAN.md §Configuration) ──
    /** Shared change scanner (ClamAV + YARA + scand, module scanners). */
    scannerImage: process.env.OBLIMINT_SCANNER_IMAGE || 'meejay/oblimint-scanner',
    /** Base URL of scand on the panel network (never published). */
    scannerUrl: process.env.OBLIMINT_SCANNER_URL || 'http://oblimint-scanner:8080',
    /** Repository prefix of the adapter tools images: <prefix><php version>:<imageTag> (meejay/oblimint-tools-php8.3:latest). */
    toolsImagePrefix: process.env.OBLIMINT_TOOLS_IMAGE_PREFIX || 'meejay/oblimint-tools-php',
    /**
     * After mounting a window overlay, check through hostd (/proc/<pid>/mountinfo)
     * that every running container of the site sees it; a container that does not
     * is restarted (fallback, docs/P3-PLAN.md §5). 'off' = trust the propagation.
     */
    windowPropagationCheck: process.env.OBLIMINT_WINDOW_PROPAGATION_CHECK !== 'off',
    // ── P4 (docs/P4-PLAN.md §Configuration) ──
    /** postfix-dovecot engine: Postfix + Dovecot (one image), Rspamd, Redis (official image, pinned). */
    mailPostfixImage: process.env.OBLIMINT_MAIL_POSTFIX_IMAGE || 'meejay/oblimint-mail-postfix',
    mailRspamdImage: process.env.OBLIMINT_MAIL_RSPAMD_IMAGE || 'meejay/oblimint-mail-rspamd',
    mailRedisImage: process.env.OBLIMINT_MAIL_REDIS_IMAGE || 'redis:7.4-alpine',
    /** stalwart engine (Stalwart Mail Server + Oblimint bootstrap). */
    mailStalwartImage: process.env.OBLIMINT_MAIL_STALWART_IMAGE || 'meejay/oblimint-mail-stalwart',
    /** Site relay of PHP mail() (Postfix relay-only + policy daemon). */
    mailRelayImage: process.env.OBLIMINT_MAIL_RELAY_IMAGE || 'meejay/oblimint-mail-relay',
    /** Shared webmail containers. */
    roundcubeImage: process.env.OBLIMINT_ROUNDCUBE_IMAGE || 'meejay/oblimint-webmail-roundcube',
    snappymailImage: process.env.OBLIMINT_SNAPPYMAIL_IMAGE || 'meejay/oblimint-webmail-snappymail',
    /**
     * Host addresses the mail ports (25, 465, 587, 143, 993, 110, 995, 4190)
     * are published on (comma / space separated). Empty = every address.
     */
    mailBind: (process.env.OBLIMINT_MAIL_BIND || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    /** 'off': the mail workers (engine sync, log follower, DNS checks) do not run (dev box). */
    mailWorkers: process.env.OBLIMINT_MAIL_WORKERS !== 'off',
  },
  /** Static client build served in production. */
  // server/src (tsx) → ../../client/dist ; server/dist/src (compiled) → ../../../client/dist
  clientDist: process.env.CLIENT_DIST
    || [path.resolve(__dirname, '../../client/dist'), path.resolve(__dirname, '../../../client/dist')]
      .find((p) => fs.existsSync(path.join(p, 'index.html')))
    || path.resolve(__dirname, '../../../client/dist'),
};

/** The session cookie is Secure in production (TLS served by the container), HTTP allowed in dev. */
export const sessionCookieSecure = config.nodeEnv === 'production' ? true : config.forceHttps;
/**
 * Session cookie name. With Secure, the `__Host-` prefix makes browsers refuse
 * any variant set with a Domain or a Path other than / — a page on a
 * subdomain of the panel host (blue/green previews, tenant domains) cannot
 * toss or shadow the panel session. Plain HTTP (dev) cannot use the prefix.
 */
export const SESSION_COOKIE_NAME = sessionCookieSecure ? '__Host-oblimint.sid' : 'oblimint.sid';

const PLACEHOLDER_RE =/change[-_. ]?(?:me|this)|admin123/i;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

function isWeakSecret(value: string, minLength: number): boolean {
  return value.length < minLength || PLACEHOLDER_RE.test(value);
}

export const DATABASE_URL_MISSING =
  'No database configured: set DATABASE_URL (postgres://user:password@host:5432/name) or run the setup wizard.';

export function isWeakAdminPassword(password: string): boolean {
  return isWeakSecret(password, MIN_ADMIN_PASSWORD_LENGTH);
}

export function defaultAdminPasswordError(): string | null {
  if (explicitDevelopment || !config.defaultAdminPassword) return null;
  if (!isWeakAdminPassword(config.defaultAdminPassword)) return null;
  return 'DEFAULT_ADMIN_PASSWORD is too weak: use at least 12 characters and not a default value, or leave it ' +
    'empty to get a random password printed once in the startup logs.';
}

export function sessionSecretError(): string | null {
  if (explicitDevelopment) return null;
  if (!config.sessionSecret) {
    return 'SESSION_SECRET is not set: set it to a random value of at least 32 characters ' +
      '(e.g. openssl rand -hex 32). The built-in development secret is only accepted with NODE_ENV=development.';
  }
  if (isWeakSecret(config.sessionSecret, MIN_SESSION_SECRET_LENGTH)) {
    return 'SESSION_SECRET is too weak: use a random value of at least 32 characters, not a placeholder ' +
      '(e.g. openssl rand -hex 32).';
  }
  return null;
}

/**
 * Settings the server refuses to start with in NORMAL mode (empty: none).
 * Checked by index.ts before anything touches the database.
 */
export function startupConfigErrors(): string[] {
  const errors: string[] = [];
  if (config.configFileError) errors.push(config.configFileError);
  if (explicitDevelopment) return errors;
  if (!config.databaseUrl) errors.push(DATABASE_URL_MISSING);
  const secretError = sessionSecretError();
  if (secretError) errors.push(secretError);
  return errors;
}
