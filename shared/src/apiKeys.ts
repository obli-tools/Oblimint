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
  | 'logs.read';

export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['files.read', 'files.write', 'releases.publish', 'sites.manage', 'sites.create', 'logs.read'];

export type ApiKeySiteScope = 'all' | 'selected';

export interface ApiKey {
  id: number;
  accountId: number;
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
}

export interface ApiKeyCreate {
  name: string;
  scopes: ApiKeyScope[];
  siteScope: ApiKeySiteScope;
  siteIds?: number[];
  allowedIps?: string[];
  /** ISO date; null / absent = never. */
  expiresAt?: string | null;
}

export type ApiKeyUpdate = Partial<ApiKeyCreate>;

/** Answer of a creation: the secret is shown once. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
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
