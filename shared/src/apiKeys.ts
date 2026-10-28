import type { DbConnectionInfo, DbDatabase, DbEngine, DbFamily, DbInstanceStatus, DbUser } from './databases';
import type { CurrentReleaseVia, SiteUpdate } from './hosting';

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
 * Domains given to a key: with routes.manage it sets their path routes
 * (towards its own sites), even a domain serving nothing yet. Without a
 * grant, a key only manages the domains whose routes all lead to its sites.
 */
export type ApiKeyDomainScope = 'all' | 'selected';

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
  domainScope: ApiKeyDomainScope;
  /** Domains given to a 'selected' key. */
  domainIds: number[];
  /** Subdomains the key attached itself. */
  createdDomainIds: number[];
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
  /** Default 'selected' (none given). Granting needs domains.manage on the account. */
  domainScope?: ApiKeyDomainScope;
  domainIds?: number[];
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

/** GET /api/accounts/:id/api-keys/grantable: what the caller may put in a key of the account (the server re-checks every save). */
export interface ApiKeyGrantable {
  /** Scopes whose right the caller holds on the account (SCOPE_NEED). */
  scopes: ApiKeyScope[];
  /** The caller holds domains.manage: he may give domains to a key. */
  canGrantDomains: boolean;
}

// ── Presets of the key form ─────────────────────────────────────────────────
// One click fills the rights, the sites and the domains of a usual profile.
// They only prefill the form: the scopes are cut down to the grantable ones,
// and the server (apiKeys.service normalize) stays the only authority. No
// preset gives more than its name says (presets.test.ts). A domain given to a
// key is a parent of its subdomains AND a domain it routes (keyApi
// manageableDomain): a preset that asks for domains ('pick') therefore has no
// routes.manage, or the key would route paths of the sites they serve.

export type ApiKeyPresetId = 'readonly' | 'update' | 'site' | 'multisite' | 'autonomous' | 'all';

export interface ApiKeyPreset {
  id: ApiKeyPresetId;
  /** Scopes it checks (among the grantable ones); 'all' checks every grantable scope. */
  scopes: readonly ApiKeyScope[] | 'all';
  /** Site scopes it allows; the first one is set when the current one is not allowed. */
  siteScopes: readonly ApiKeySiteScope[];
  /** With 'selected': sites chosen by hand (the ones the key created aside), at least / at most. */
  minSites: number;
  maxSites: number | null;
  /**
   * Domains given to the key: 'none' (it only works on the domains serving
   * its sites alone), 'optional' (none set, the user may give some), 'pick'
   * (chosen by the user: parents of its subdomains), 'all' (every domain when
   * the user may give them, none otherwise).
   */
  domains: 'none' | 'optional' | 'pick' | 'all';
}

/** Rights of a site's daily management (both « Gestion » presets). */
const SITE_MANAGEMENT_SCOPES: readonly ApiKeyScope[] = [
  'files.read', 'files.write', 'releases.publish', 'sites.manage', 'logs.read', 'databases.manage', 'routes.manage', 'cron.manage',
];

export const API_KEY_PRESETS: readonly ApiKeyPreset[] = [
  // Supervision: reads code, data and logs; writes nothing.
  { id: 'readonly', scopes: ['files.read', 'logs.read'], siteScopes: ['selected', 'all'], minSites: 1, maxSites: null, domains: 'none' },
  // CI: pushes files to staging and publishes; no setting (publish mode, env, data paths), cron, database, route or subdomain.
  { id: 'update', scopes: ['files.read', 'files.write', 'releases.publish'], siteScopes: ['selected'], minSites: 1, maxSites: null, domains: 'none' },
  // One site end to end; no site creation, no subdomain, no domain given (routes only on the domains serving it alone).
  { id: 'site', scopes: SITE_MANAGEMENT_SCOPES, siteScopes: ['selected'], minSites: 1, maxSites: 1, domains: 'none' },
  { id: 'multisite', scopes: SITE_MANAGEMENT_SCOPES, siteScopes: ['selected', 'all'], minSites: 2, maxSites: null, domains: 'optional' },
  // Creates its own sites and works on them only (no existing site); subdomains under the domains given (attached to
  // its site on creation); no route (the domains given would be routed too, existing sites' paths included), no cron.
  {
    id: 'autonomous', scopes: ['sites.create', 'files.read', 'files.write', 'releases.publish', 'sites.manage', 'logs.read', 'databases.manage', 'domains.subdomain'],
    siteScopes: ['selected'], minSites: 0, maxSites: 0, domains: 'pick',
  },
  { id: 'all', scopes: 'all', siteScopes: ['all'], minSites: 0, maxSites: null, domains: 'all' },
];

export function apiKeyPreset(id: ApiKeyPresetId): ApiKeyPreset {
  return API_KEY_PRESETS.find((p) => p.id === id) ?? API_KEY_PRESETS[0];
}

/** Scopes a preset checks for someone who may grant `grantable`, in API_KEY_SCOPES order. */
export function apiKeyPresetScopes(preset: ApiKeyPreset, grantable: readonly ApiKeyScope[]): ApiKeyScope[] {
  return API_KEY_SCOPES.filter((s) => grantable.includes(s) && (preset.scopes === 'all' || preset.scopes.includes(s)));
}

/** State of a key form, as the presets see it. */
export interface ApiKeyPresetState {
  scopes: readonly ApiKeyScope[];
  siteScope: ApiKeySiteScope;
  /** Sites selected by hand (the ones the key created not counted). */
  siteCount: number;
  domainScope: ApiKeyDomainScope;
  /** Domains given (the subdomains the key created not counted). */
  domainCount: number;
}

/**
 * The state still is what the preset sets (scopes, site scope, at most
 * maxSites, domains). minSites is not part of it: it is what the user has
 * left to choose after the click.
 */
export function apiKeyPresetMatches(preset: ApiKeyPreset, state: ApiKeyPresetState, grantable: readonly ApiKeyScope[], canGrantDomains: boolean): boolean {
  const want = apiKeyPresetScopes(preset, grantable);
  if (state.scopes.length !== want.length || want.some((s) => !state.scopes.includes(s))) return false;
  if (!preset.siteScopes.includes(state.siteScope)) return false;
  if (state.siteScope === 'selected' && preset.maxSites !== null && state.siteCount > preset.maxSites) return false;
  const noDomain = state.domainScope === 'selected' && state.domainCount === 0;
  switch (preset.domains) {
    case 'none': return noDomain;
    case 'pick': return state.domainScope === 'selected';
    case 'all': return canGrantDomains ? state.domainScope === 'all' : noDomain;
    default: return true;
  }
}

/**
 * The preset gives subdomains under the domains chosen ('pick'), the user may
 * give domains and has chosen none yet: the subdomain right does nothing.
 */
export function apiKeyPresetNeedsParents(preset: ApiKeyPreset, state: ApiKeyPresetState, grantable: readonly ApiKeyScope[], canGrantDomains: boolean): boolean {
  return preset.domains === 'pick' && canGrantDomains && state.scopes.includes('domains.subdomain')
    && apiKeyPresetScopes(preset, grantable).includes('domains.subdomain')
    && state.domainScope === 'selected' && state.domainCount === 0;
}

/**
 * A new key's form once the grantable rights are known (it may have been
 * touched before): drops the scopes the user does not hold, and the domains
 * given when he may not give any — the save would be refused otherwise.
 */
export function apiKeyFormCutToGrantable<T extends { scopes: readonly ApiKeyScope[]; domainScope: ApiKeyDomainScope; domainIds: readonly number[] }>(form: T, g: ApiKeyGrantable): T {
  return {
    ...form,
    scopes: form.scopes.filter((s) => g.scopes.includes(s)),
    ...(g.canGrantDomains ? {} : { domainScope: 'selected' as const, domainIds: [] }),
  };
}

/** First preset the state matches, with its minimum of sites met (null: « Personnalisé »). */
export function matchApiKeyPreset(state: ApiKeyPresetState, grantable: readonly ApiKeyScope[], canGrantDomains: boolean): ApiKeyPresetId | null {
  const p = API_KEY_PRESETS.find((x) => apiKeyPresetMatches(x, state, grantable, canGrantDomains)
    && (state.siteScope !== 'selected' || state.siteCount >= x.minSites));
  return p?.id ?? null;
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
  liveRelease: ApiV1LiveRelease | null;
  /** Newest published release (informative). */
  latestRelease: { id: number; number: number; publishedAt: string | null } | null;
  /** A human rolled the site back and nobody published from the staging (or restored it) since: publishing would undo it. Never set by an automatic revert. */
  rolledBack: boolean;
  /** The release abandoned by that rollback. */
  rolledBackFrom: { id: number; number: number } | null;
}

/** How the live release of a site became live. */
export interface ApiV1LiveRelease {
  id: number;
  number: number;
  since: string | null;
  via: CurrentReleaseVia | null;
  /** Who did it (a staff member or an automatic revert: null). */
  by: string | null;
  byKind: 'user' | 'staff' | 'system' | null;
  /** Made live through this very key. */
  byThisKey: boolean;
  /** Automatic revert: its reason. */
  reason: string | null;
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
