import type { DbConnectionInfo, DbDatabase, DbEngine, DbFamily, DbInstanceStatus, DbUser } from './databases';
import type { SiteUpdate } from './hosting';

// ─────────────────────────────────────────────────────────────────────────────
// API access keys of a hosting account (« Clés d'accès »): a script, a CI or an
// AI agent (Claude through the panel's MCP server) acts on ONE account through
// /api/v1 and /mcp with `Authorization: Bearer obk_…`.
//
//  - Scopes are opt-in (nothing destructive by default); site deletion and
//    every other account are never reachable.
//  - Sites: every site of the account, or only the selected ones — the sites
//    the key creates are added to its selection automatically, so a key with
//    `sites.create` and no selection works only on its own sites.
//  - The key acts on behalf of its creator: its effective rights are its
//    scopes AND what the creator still holds on the account (a creator removed,
//    deactivated or stripped of a right disarms the key at once).
//  - Optional expiry and allowed source addresses; every action is audited
//    under the creator with the key's name.
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyScope =
  | 'files.read'
  | 'files.write'
  | 'releases.publish'
  | 'sites.manage'
  | 'sites.create'
  | 'logs.read'
  /** Attach to its sites subdomains of a domain already in the account (never a new root domain); remove the ones it created. */
  | 'domains.subdomain'
  /** Cron jobs of its sites (create, change, delete, run, read the runs). */
  | 'cron.manage'
  /**
   * Databases: the account's instances (create one within the plan), databases
   * and users — every one of the account for a key on every site, only the ones
   * it created for a key limited to some sites; it deletes only what it created.
   */
  | 'databases.manage'
  /**
   * Path routes of the account's domains (which site serves exampl.com/uploads/…):
   * on a domain whose routes all lead to sites of the key, towards a site of the key.
   */
  | 'routes.manage';

export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'files.read', 'files.write', 'releases.publish', 'sites.manage', 'sites.create', 'cron.manage', 'databases.manage', 'routes.manage', 'domains.subdomain', 'logs.read',
];

export type ApiKeySiteScope = 'all' | 'selected';

/**
 * 'key': a bearer secret (obk_…) for scripts, CI and agents that take a header.
 * 'connector': an OAuth client (« Connecteur Claude ») for claude.ai custom
 * connectors and other OAuth MCP clients — no secret travels in a header the
 * user pastes; the panel user who authorizes it in the panel lends his rights
 * (within the connector's scopes and sites) and can disconnect it at any time.
 */
export type ApiKeyKind = 'key' | 'connector';

export interface ApiKey {
  id: number;
  accountId: number;
  kind: ApiKeyKind;
  name: string;
  /** First characters of the key (obk_<id>_xxxxxx), to recognize it. */
  prefix: string;
  scopes: ApiKeyScope[];
  siteScope: ApiKeySiteScope;
  /** Sites of a 'selected' key (the ones it created included). */
  siteIds: number[];
  /** Sites created through the key. */
  createdSiteIds: number[];
  /** Allowed source addresses / CIDR (empty: any). */
  allowedIps: string[];
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  /** Scopes the creator no longer holds (inactive until restored). */
  inactiveScopes: ApiKeyScope[];
  /** Connector: OAuth client id (public). */
  oauthClientId: string | null;
  /** Connector: live authorizations (unexpired refresh tokens), with who authorized them. */
  connections: ApiKeyConnection[];
}

export interface ApiKeyConnection {
  /** Authorization family (disconnect target). */
  id: string;
  userName: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyCreate {
  /** Default 'key'. Fixed at creation. */
  kind?: ApiKeyKind;
  name: string;
  scopes: ApiKeyScope[];
  siteScope: ApiKeySiteScope;
  siteIds?: number[];
  allowedIps?: string[];
  /** ISO date; null / absent = never. */
  expiresAt?: string | null;
}

export type ApiKeyUpdate = Partial<Omit<ApiKeyCreate, 'kind'>>;

/** Answer of a creation (or a connector secret rotation): the secret is shown once. */
export interface ApiKeyCreated extends ApiKey {
  /** Bearer key (kind 'key'); null for a connector. */
  key: string | null;
  /** OAuth client secret (kind 'connector'); null for a key. */
  clientSecret: string | null;
}

/**
 * OAuth redirect URIs a connector accepts: Claude's callbacks (claude.ai /
 * claude.com, personal and organization connectors) and loopback addresses of
 * native clients (Claude Desktop / Code, RFC 8252: any port, any path).
 */
export const CONNECTOR_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://claude.ai/api/organizations/custom-connectors/oauth/callback',
  'https://claude.com/api/organizations/custom-connectors/oauth/callback',
];

export function connectorRedirectAllowed(uri: string): boolean {
  if (CONNECTOR_REDIRECT_URIS.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') && !u.username && !u.password && !u.hash;
}

/** GET /api/oauth/authorize: what the consent page shows. */
export interface OAuthAuthorizeInfo {
  connector: { id: number; name: string; accountId: number; accountUsername: string; primaryDomain: string | null };
  /** Host of the client that will receive the authorization (claude.ai, localhost…). */
  redirectHost: string;
  /** The connector's scopes the signed-in user holds (what the client will get). */
  scopes: ApiKeyScope[];
  /** Scopes of the connector the user does not hold (left out). */
  missingScopes: ApiKeyScope[];
  siteScope: ApiKeySiteScope;
  sites: Array<{ id: number; name: string }>;
}

export const MAX_API_KEYS_PER_ACCOUNT = 20;

/** GET /api/v1/me */
export interface ApiV1Me {
  key: { id: number; name: string; scopes: ApiKeyScope[]; siteScope: ApiKeySiteScope; expiresAt: string | null };
  account: { id: number; username: string; primaryDomain: string | null };
}

/** A site as the key API shows it. */
export interface ApiV1Site {
  id: number;
  name: string;
  slug: string;
  status: string;
  base: string;
  docroot: string;
  publishMode: string;
  primaryDomain: string | null;
  domains: string[];
  currentRelease: number | null;
  /** Created through this key. */
  createdByKey: boolean;
}

/** PATCH /api/v1/sites/:id (scope sites.manage): the platform-only settings (custom nginx, base path, profile) stay in the panel. */
export type ApiV1SiteUpdate = Pick<SiteUpdate, 'name' | 'docroot' | 'publishMode' | 'publishDebounceSec' | 'healthcheckPath' | 'php'>;

/** A domain of the account a key can create subdomains under. */
export interface ApiV1ParentDomain {
  name: string;
  /** Ownership verified: its subdomains are verified too (certificate issued at once). */
  verified: boolean;
  /** DNS zone hosted by the panel (the subdomain's records are added to it). */
  hostedZone: boolean;
}

/** A subdomain attached through a key. */
export interface ApiV1Subdomain {
  id: number;
  name: string;
  siteId: number;
  verified: boolean;
  /** https://<name>/ once the certificate is issued. */
  url: string;
}

/** A database as the key API shows it. */
export interface ApiV1Database extends DbDatabase {
  /** Created through this key (it may delete it). */
  createdByKey: boolean;
}

/** A database user as the key API shows it (its password is never shown again). */
export interface ApiV1DbUser extends DbUser {
  createdByKey: boolean;
}

/** GET /api/v1/databases: a database server of the account, with the databases and users the key reaches. */
export interface ApiV1DbInstance {
  id: number;
  name: string;
  engine: DbEngine;
  version: string;
  family: DbFamily;
  status: DbInstanceStatus;
  /** Account default of its family: the sites reach it as localhost (MySQL family) / the default socket. */
  isDefault: boolean;
  connection: DbConnectionInfo;
  databases: ApiV1Database[];
  users: ApiV1DbUser[];
}

/**
 * Optional on a database user creation / password reset: the credentials go
 * straight into the environment variables of a site of the key (password as a
 * secret) and never back to the caller (needs sites.manage; the site restarts).
 */
export interface ApiV1DbEnvTarget {
  siteId: number;
  /** Name prefix (default "DB_"): DB_HOST, DB_SOCKET, DB_NAME, DB_USER, DB_PASSWORD. */
  prefix?: string;
  /** Database put in <prefix>NAME (default: the first database granted). */
  databaseId?: number;
}

/** Answer of a database user creation / password reset. */
export interface ApiV1DbCredentials {
  user: ApiV1DbUser;
  /** null when the credentials went into a site's environment (env). */
  password: string | null;
  /** Variables written in the site's environment. */
  env?: { siteId: number; names: string[] };
}

/** A path route of a domain: requests for https://<domain><pathPrefix>… go to the site (longest prefix wins). */
export interface ApiV1Route {
  id: number;
  domain: string;
  /** '/' or '/uploads/' (leading and trailing slash). */
  pathPrefix: string;
  /** 0: a site outside the key. */
  siteId: number;
  /** Secondary runtime of the site serving it (another container / engine, same code); null = its main one. */
  runtimeId: number | null;
}

/** GET /api/v1/routes: a domain of the account and its routes. */
export interface ApiV1RouteDomain {
  domain: string;
  /** The key may add / change / remove routes on it (all its routes lead to sites of the key). */
  manageable: boolean;
  routes: ApiV1Route[];
}
