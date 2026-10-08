import './env';
import fs from 'fs';
import path from 'path';

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
  forceHttps: process.env.FORCE_HTTPS === 'true',
  appName: process.env.APP_NAME || 'Oblimint',
  appUrl: process.env.APP_URL || '',
  /** Express `trust proxy` hops (0 = the socket peer is the client: the panel
   *  is published directly on 8443). Set it when a reverse proxy fronts it. */
  trustProxyHops: Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '0', 10) || 0),
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || '',
  disable2faForce: process.env.DISABLE_2FA_FORCE === 'true',
  /** Docker Engine socket (setup host checks, deployments). */
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  /** Same path on the host as in the container (docker run -v /srv/oblimint:/srv/oblimint). */
  hostDataDir: path.resolve(process.env.OBLIMINT_HOST_DATA_DIR || dataDir),
  /** Static client build served in production. */
  // server/src (tsx) → ../../client/dist ; server/dist/src (compiled) → ../../../client/dist
  clientDist: process.env.CLIENT_DIST
    || [path.resolve(__dirname, '../../client/dist'), path.resolve(__dirname, '../../../client/dist')]
      .find((p) => fs.existsSync(path.join(p, 'index.html')))
    || path.resolve(__dirname, '../../../client/dist'),
};

const PLACEHOLDER_RE = /change[-_. ]?(?:me|this)|admin123/i;
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
