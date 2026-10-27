// =============================================================================
// Oblimint — P1 « Cœur immuable » shared types (docs/P1-PLAN.md)
//
// Plans, hosting accounts, client users, sites (bases, app profiles, data
// paths, secondary runtimes), domains + route table, releases, runtime,
// file server, edge / certificates. Every API shape of P1 lives here.
// =============================================================================

import type { TenantLimits } from './types';
import type { AccessMode } from './access';
import type { DbEngine, DbTuningProfile } from './databases';
import type { DnsZoneKind, DomainVerificationSummary } from './dns';
import type { OverQuotaAction, OverQuotaState } from './usage';

// ─── SITE BASES (ARCHITECTURE §3.1) ──────────────────────────────────────────

export type SiteBaseId =
  | 'apache-php5.6'
  | 'apache-php7.4'
  | 'apache-php8.1'
  | 'apache-php8.2'
  | 'apache-php8.3'
  | 'apache-php8.4'
  | 'nginx-php8.1'
  | 'nginx-php8.2'
  | 'nginx-php8.3'
  | 'nginx-php8.4'
  | 'nginx-static';

export type SiteEngine = 'apache' | 'nginx';

export interface SiteBaseDef {
  id: SiteBaseId;
  engine: SiteEngine;
  /** PHP version ('8.3'), null for the static base. */
  php: string | null;
  /**
   * DEFAULT image repository WITHOUT tag (DEFAULT_SITE_IMAGE_PREFIX + id). The
   * server builds the real reference from OBLIMINT_SITE_IMAGE_PREFIX + id +
   * ':' + OBLIMINT_IMAGE_TAG (test / private registries).
   */
  image: string;
  /** PHP branch out of security support → "unmaintained runtime" badge. */
  unmaintained: boolean;
  /** Honours .htaccess files (Apache bases only). */
  htaccess: boolean;
}

/** Default repository prefix of the site base images (images/build.sh REPO=meejay). */
export const DEFAULT_SITE_IMAGE_PREFIX = 'meejay/oblimint-';

const base = (id: SiteBaseId, engine: SiteEngine, php: string | null, unmaintained: boolean): SiteBaseDef => ({
  id, engine, php, image: `${DEFAULT_SITE_IMAGE_PREFIX}${id}`, unmaintained, htaccess: engine === 'apache',
});

/** Catalog of site bases, in display order. Images are built from images/. */
export const SITE_BASES: readonly SiteBaseDef[] = [
  base('apache-php8.4', 'apache', '8.4', false),
  base('apache-php8.3', 'apache', '8.3', false),
  base('apache-php8.2', 'apache', '8.2', false),
  base('apache-php8.1', 'apache', '8.1', true),
  base('apache-php7.4', 'apache', '7.4', true),
  // Legacy code only, while it is ported to PHP 8 (no security fix exists, PHPocalypse).
  base('apache-php5.6', 'apache', '5.6', true),
  base('nginx-php8.4', 'nginx', '8.4', false),
  base('nginx-php8.3', 'nginx', '8.3', false),
  base('nginx-php8.2', 'nginx', '8.2', false),
  base('nginx-php8.1', 'nginx', '8.1', true),
  base('nginx-static', 'nginx', null, false),
];

export const SITE_BASE_IDS: readonly SiteBaseId[] = SITE_BASES.map((b) => b.id);

export function isSiteBaseId(v: unknown): v is SiteBaseId {
  return typeof v === 'string' && (SITE_BASE_IDS as readonly string[]).includes(v);
}

export function siteBaseDef(id: SiteBaseId): SiteBaseDef {
  const def = SITE_BASES.find((b) => b.id === id);
  if (!def) throw new Error(`Unknown site base: ${id}`);
  return def;
}

/** Port every site base listens on inside its container (no capability needed). */
export const SITE_CONTAINER_PORT = 8080;

// ─── DATA PATHS + APP PROFILES (ARCHITECTURE §2.1) ───────────────────────────

export type DataPathPolicy = 'persistent' | 'typed' | 'ephemeral';

export interface DataPathTemplate {
  /** Relative to the release root, POSIX, no leading/trailing slash, no '..'. */
  path: string;
  policy: DataPathPolicy;
  /** `typed` only: lower-case extensions without dot (['jpg','png',…]). */
  allowedExtensions?: string[];
}

export type AppProfileId = 'wordpress' | 'joomla' | 'drupal' | 'prestashop' | 'laravel' | 'generic-php' | 'static';

export interface AppProfileDef {
  id: AppProfileId;
  /** Display name (proper nouns, not translated). */
  label: string;
  /** Document root relative to the release root ('' = the root itself). */
  docroot: string;
  recommendedBase: SiteBaseId;
  dataPaths: DataPathTemplate[];
  /** Detection markers: ALL of these relative paths exist in the staging. */
  markers: string[];
}

const MEDIA_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'pdf', 'mp4', 'webm', 'mp3', 'ogg', 'wav',
  'zip', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'json', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'css', 'js', 'map'];

/** Ordered: the first profile whose markers all exist wins (most specific first). */
export const APP_PROFILES: readonly AppProfileDef[] = [
  {
    id: 'wordpress', label: 'WordPress', docroot: '', recommendedBase: 'apache-php8.3',
    markers: ['wp-config.php', 'wp-includes/version.php'],
    dataPaths: [
      { path: 'wp-content/uploads', policy: 'persistent' },
      { path: 'wp-content/cache', policy: 'ephemeral' },
      { path: 'wp-content/upgrade', policy: 'ephemeral' },
    ],
  },
  {
    id: 'prestashop', label: 'PrestaShop', docroot: '', recommendedBase: 'apache-php8.1',
    markers: ['config/defines.inc.php', 'classes/PrestaShopAutoload.php'],
    dataPaths: [
      { path: 'img', policy: 'typed', allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico'] },
      { path: 'upload', policy: 'persistent' },
      { path: 'download', policy: 'persistent' },
      { path: 'var/cache', policy: 'ephemeral' },
      { path: 'var/logs', policy: 'persistent' },
      { path: 'app/config', policy: 'persistent' },
      { path: 'config/xml', policy: 'persistent' },
      { path: 'translations', policy: 'persistent' },
      { path: 'themes/cache', policy: 'ephemeral' },
    ],
  },
  {
    id: 'joomla', label: 'Joomla', docroot: '', recommendedBase: 'apache-php8.3',
    markers: ['configuration.php', 'libraries/src/Version.php'],
    dataPaths: [
      { path: 'images', policy: 'persistent' },
      { path: 'media', policy: 'persistent' },
      { path: 'cache', policy: 'ephemeral' },
      { path: 'administrator/cache', policy: 'ephemeral' },
      { path: 'administrator/logs', policy: 'persistent' },
      { path: 'tmp', policy: 'ephemeral' },
    ],
  },
  {
    id: 'drupal', label: 'Drupal', docroot: '', recommendedBase: 'nginx-php8.3',
    markers: ['core/lib/Drupal.php'],
    dataPaths: [
      { path: 'sites/default/files', policy: 'persistent' },
    ],
  },
  {
    id: 'laravel', label: 'Laravel', docroot: 'public', recommendedBase: 'nginx-php8.3',
    markers: ['artisan', 'bootstrap/app.php'],
    dataPaths: [
      { path: 'storage', policy: 'persistent' },
      { path: 'bootstrap/cache', policy: 'ephemeral' },
    ],
  },
  {
    id: 'generic-php', label: 'PHP', docroot: '', recommendedBase: 'apache-php8.3',
    markers: ['index.php'],
    dataPaths: [],
  },
  {
    id: 'static', label: 'Static', docroot: '', recommendedBase: 'nginx-static',
    markers: ['index.html'],
    dataPaths: [],
  },
];

/** Extensions offered by default for a new `typed` data path. */
export const DEFAULT_TYPED_EXTENSIONS: readonly string[] = MEDIA_EXT;

export function appProfileDef(id: AppProfileId): AppProfileDef {
  const def = APP_PROFILES.find((p) => p.id === id);
  if (!def) throw new Error(`Unknown app profile: ${id}`);
  return def;
}

export interface ProfileDetection {
  profile: AppProfileId | null;
  /** Markers found for the detected profile. */
  markers: string[];
  suggestedBase: SiteBaseId | null;
  suggestedDocroot: string | null;
  suggestedDataPaths: DataPathTemplate[];
}

/**
 * Pure profile detection: `exists(rel)` tells whether a relative POSIX path
 * exists in the staging (file or directory). First matching profile wins.
 */
export function detectAppProfile(exists: (relPath: string) => boolean): ProfileDetection {
  for (const p of APP_PROFILES) {
    if (p.markers.every((m) => exists(m))) {
      return {
        profile: p.id,
        markers: [...p.markers],
        suggestedBase: p.recommendedBase,
        suggestedDocroot: p.docroot,
        suggestedDataPaths: p.dataPaths.map((d) => ({ ...d, allowedExtensions: d.allowedExtensions ? [...d.allowedExtensions] : undefined })),
      };
    }
  }
  return { profile: null, markers: [], suggestedBase: null, suggestedDocroot: null, suggestedDataPaths: [] };
}

/**
 * Normalises a data path / docroot: POSIX, trimmed, no leading/trailing
 * slash, no empty / '.' / '..' segments, [A-Za-z0-9._@+-] segments only.
 * Returns null when invalid ('' is valid only when allowEmpty).
 */
export function normalizeRelPath(input: string, allowEmpty = false): string | null {
  const s = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (s === '') return allowEmpty ? '' : null;
  if (s.length > 255) return null;
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (!/^[A-Za-z0-9._@+-]+$/.test(seg)) return null;
  }
  return segs.join('/');
}

/** Normalises a route path prefix / site base path: '/', or '/a/b/' (leading AND trailing slash). */
export function normalizePathPrefix(input: string): string | null {
  const rel = normalizeRelPath(input, true);
  if (rel === null) return null;
  return rel === '' ? '/' : `/${rel}/`;
}

// ─── PLANS + ENVELOPE (ARCHITECTURE §4) ──────────────────────────────────────

/** Per-account allotment of a plan. `null` = unlimited. MiB for sizes. */
export interface PlanLimits {
  diskMb: number | null;
  trafficMbPerMonth: number | null;
  maxSites: number | null;
  maxDomains: number | null;
  maxMailboxes: number | null;
  maxDatabases: number | null;
  /** CPU cores (may be fractional). P1: applied to EACH site container. */
  cpuCores: number | null;
  /** Memory in MiB. P1: applied to EACH site container. */
  memoryMb: number | null;
  /** Max processes per container (null → server default 256). */
  pidsLimit: number | null;
  /** Bases the account may use (null = the whole catalog). */
  allowedBases: SiteBaseId[] | null;
  // ── P2 (docs/P2-PLAN.md §Plans) ──
  /** Database instances per account (null = unlimited, 0 = none). */
  maxDbInstances: number | null;
  /** Size of ONE database (MiB, measured: alert + no new database/user beyond). */
  dbMaxSizeMb: number | null;
  /** Default tuning profile of the account's instances (memory limit of each instance). */
  dbProfile: DbTuningProfile;
  /** Engines the account may run (null = all). */
  dbEngines: DbEngine[] | null;
  /** External SQL access (dedicated port behind the allow-list) allowed. */
  dbExternalAccess: boolean;
  /** Cron jobs per account (null = unlimited, 0 = none). */
  maxCronJobs: number | null;
  /** Minimum interval between two runs of a cron job (minutes, ≥ 1). */
  cronMinIntervalMin: number;
  /** At 100 % of a quota (disk / traffic): warn only, block uploads (SFTP read-only), or suspend the account. */
  overQuotaAction: OverQuotaAction;
  // ── P4 mail (docs/P4-PLAN.md §Plans) — maxMailboxes above ──
  /** Sum of the mailbox quotas of the account (MiB, null = unlimited). */
  mailQuotaMb: number | null;
  /** Largest quota of ONE mailbox (MiB, null = unlimited). */
  mailboxQuotaMaxMb: number | null;
  /** Aliases (forward-only addresses) per account (null = unlimited, 0 = none). */
  maxMailAliases: number | null;
  /** Largest message (MiB, 1 … 100), capped by the platform setting mail.maxMessageSizeMb. */
  mailMaxMessageSizeMb: number;
  /** Outbound messages per hour of the account (mailboxes + sites), null = unlimited. */
  mailOutboundPerHour: number | null;
  /** Outbound messages per hour of ONE site (PHP mail() through the relay), null = unlimited. */
  mailSiteOutboundPerHour: number | null;
  // ── P4b apps + proxy (docs/P4b-PLAN.md §3) ──
  /** App stacks per account (null = unlimited, 0 = apps off). */
  maxAppStacks: number | null;
  /** App containers (services) per account, all stacks together. */
  maxAppContainers: number | null;
  /** CPU cores of ALL the app containers of the account together (null = node ceiling). */
  appsCpuCores: number | null;
  /** Memory (MiB) of ALL the app containers of the account together (null = node ceiling). */
  appsMemoryMb: number | null;
  /** Max processes of ONE app container. */
  appsPidsPerContainer: number;
  /** Build images from source (compose `build:` of a git / zip source), also gated by the tenant policy / settings. */
  appsBuild: boolean;
  /** Interactive console (exec) in app containers (+ capability apps.console, settings, tenant policy). */
  appsConsole: boolean;
  /** Proxy hosts per account (null = unlimited). */
  maxProxyHosts: number | null;
  /** Redirections + dead hosts per account. */
  maxRedirections: number | null;
  /** Proxy hosts towards external ip:port / host names (also gated by the tenant policy). */
  proxyExternalTargets: boolean;
  /** Uptime monitors per account. */
  maxUptimeMonitors: number | null;
  /** Workflows per account (null = unlimited, 0 = none). */
  maxWorkflows: number | null;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  diskMb: 5120,
  trafficMbPerMonth: null,
  maxSites: 5,
  maxDomains: 10,
  maxMailboxes: 10,
  maxDatabases: 5,
  cpuCores: 1,
  memoryMb: 512,
  pidsLimit: 256,
  allowedBases: null,
  maxDbInstances: 2,
  dbMaxSizeMb: 1024,
  dbProfile: 'S',
  dbEngines: null,
  dbExternalAccess: false,
  maxCronJobs: 10,
  cronMinIntervalMin: 5,
  overQuotaAction: 'warn',
  mailQuotaMb: 5120,
  mailboxQuotaMaxMb: 2048,
  maxMailAliases: 50,
  mailMaxMessageSizeMb: 25,
  mailOutboundPerHour: 200,
  mailSiteOutboundPerHour: 100,
  maxAppStacks: 3,
  maxAppContainers: 10,
  appsCpuCores: 2,
  appsMemoryMb: 2048,
  appsPidsPerContainer: 512,
  appsBuild: false,
  appsConsole: false,
  maxProxyHosts: 10,
  maxRedirections: 10,
  proxyExternalTargets: false,
  maxUptimeMonitors: 10,
  maxWorkflows: 5,
};

export interface Plan {
  id: number;
  tenantId: number;
  tenantName: string | null;
  name: string;
  description: string | null;
  limits: PlanLimits;
  isActive: boolean;
  /** Hosting accounts on this plan. */
  accountCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  name: string;
  description?: string | null;
  limits: PlanLimits;
  isActive?: boolean;
}

/** Envelope dimensions checked at allocation (sum over the tenant's accounts). */
export type EnvelopeDimension = 'diskMb' | 'trafficMbPerMonth' | 'maxAccounts' | 'maxSites' | 'maxDomains'
  | 'maxMailboxes' | 'maxDatabases' | 'cpuCores' | 'memoryMb';

/** GET /api/plans/envelope */
export interface TenantEnvelopeUsage {
  tenantId: number;
  limits: TenantLimits;
  /** Sum of the plans of the tenant's accounts (null when any is unlimited). */
  allocated: Record<EnvelopeDimension, number | null>;
  /** Real usage where measured (accounts, sites, domains, disk). */
  used: { accounts: number; sites: number; domains: number; diskMb: number | null };
}

/** 409 `envelopeExceeded` details. */
export interface EnvelopeViolation {
  dimension: EnvelopeDimension;
  limit: number;
  requested: number | null;
}

// ─── HOSTING ACCOUNTS ────────────────────────────────────────────────────────

export type HostingAccountStatus = 'provisioning' | 'active' | 'suspended' | 'error' | 'deleting';
export type QuotaMode = 'xfs' | 'measured';

export interface HostingAccount {
  id: number;
  tenantId: number;
  tenantName: string | null;
  nodeId: number;
  planId: number;
  planName: string | null;
  /** System / SFTP user name: ^[a-z][a-z0-9-]{2,31}$, unique platform-wide, immutable. */
  username: string;
  displayName: string | null;
  status: HostingAccountStatus;
  statusMessage: string | null;
  uid: number;
  gid: number;
  diskQuotaMb: number | null;
  /** Bases the plan allows (PlanLimits.allowedBases; null = the whole catalog). */
  allowedBases: SiteBaseId[] | null;
  diskUsedMb: number | null;
  quotaMode: QuotaMode | null;
  usageCheckedAt: string | null;
  siteCount: number;
  domainCount: number;
  /** Name of the primary domain of the account (lists group by account under this name; null = none yet). */
  primaryDomain?: string | null;
  /** P2: access allow-list mode of the account's ports (SFTP, external SQL). */
  accessMode: AccessMode;
  /** P2: quota enforcement state (usage module). */
  overQuota: OverQuotaState;
  createdAt: string;
  updatedAt: string;
}

export interface HostingAccountCreate {
  username: string;
  displayName?: string | null;
  planId: number;
  /** Default: the local node. */
  nodeId?: number;
  /** Optional first client user created with the account. */
  owner?: ClientUserCreate | null;
}

export interface HostingAccountUpdate {
  displayName?: string | null;
  planId?: number;
}

// ─── CLIENT USERS (users.kind = 'client') ────────────────────────────────────

/**
 * P4: mail.manage (mail domains, mailboxes, aliases, forwarders,
 * autoresponders, DKIM / mail DNS, site relay, webmail single sign-on).
 * P2: databases.manage (instances, databases, users, admin UI) and
 * dns.manage (zone editor). Cron jobs need sites.manage; the account access
 * allow-list needs files.manage; logs and usage need read (membership).
 */
export type ClientCapability = 'sites.manage' | 'releases.publish' | 'releases.approve' | 'domains.manage' | 'files.manage'
  | 'databases.manage' | 'dns.manage'
  // P4
  | 'mail.manage'
  // P4b (docs/P4b-PLAN.md §12): apps (stacks, catalog, registries, links), the app
  // console (exec, also gated by settings / tenant policy), proxy objects (hosts,
  // redirections, dead hosts, access lists, pages, auth providers, account bans),
  // monitoring (uptime monitors, status pages, workflows, SFTP targets, windows).
  | 'apps.manage' | 'apps.console' | 'proxy.manage' | 'monitoring.manage';

export const CLIENT_CAPABILITIES: readonly ClientCapability[] = [
  'sites.manage', 'releases.publish', 'releases.approve', 'domains.manage', 'files.manage', 'databases.manage', 'dns.manage', 'mail.manage',
  'apps.manage', 'apps.console', 'proxy.manage', 'monitoring.manage',
];

/** One client user of an account (GET /api/accounts/:id/users). */
export interface AccountClientUser {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  capabilities: ClientCapability[];
  /** Other accounts this user also belongs to. */
  otherAccountCount: number;
  createdAt: string;
}

/** GET /accounts/:id/users/candidates: active client users of the account's tenant not attached to it yet. */
export interface ClientUserCandidate {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  /** Accounts of the tenant this login already belongs to (0 = detached from every account). */
  accountCount: number;
}

export interface ClientUserCreate {
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  capabilities: ClientCapability[];
}

/** POST /api/accounts/:id/users — create a new client user OR attach an existing one. */
export type AccountClientUserAdd =
  | ({ mode: 'create' } & ClientUserCreate)
  | { mode: 'attach'; userId: number; capabilities: ClientCapability[] };

/** GET /api/hosting/me — what the caller may do (drives the client-space UI). */
export interface HostingMe {
  kind: 'staff' | 'client';
  /** Staff: hosting capabilities on the current tenant ('*' = platform admin). */
  staffCapabilities: string[] | '*';
  /** Client: capabilities per account id. Staff: {}. */
  accounts: Record<number, ClientCapability[]>;
}

// ─── FILE SERVER (ARCHITECTURE §3.3) ─────────────────────────────────────────

export type FileServerMode = 'always' | 'on-demand' | 'off';

export interface AccountSshKey {
  id: number;
  name: string;
  /** 'SHA256:…' (OpenSSH format). */
  fingerprint: string;
  algorithm: string;
  createdAt: string;
}

/** GET /api/accounts/:id/file-access */
export interface FileAccessInfo {
  accountId: number;
  mode: FileServerMode;
  protocol: 'sftp';
  /** Host name to connect to (panel hostname, else public IPv4). */
  host: string | null;
  port: number | null;
  username: string;
  hasPassword: boolean;
  sshKeys: AccountSshKey[];
  running: boolean;
  /** On-demand activation deadline (ISO), null when not activated / mode always. */
  activeUntil: string | null;
  /** SFTP layout shown to the user: /staging/<site>/ and /data/<site>/. */
  layout: Array<{ siteId: number; siteName: string; stagingPath: string; dataPath: string }>;
}

export interface FileAccessUpdate {
  mode?: FileServerMode;
}

/** POST /api/accounts/:id/file-access/password → the generated password, shown ONCE. */
export interface FileAccessPasswordResult {
  password: string;
}

export interface SshKeyInput {
  name: string;
  /** One OpenSSH public key line: "ssh-ed25519 AAAA… comment". */
  publicKey: string;
}

/** GET/POST /api/accounts/:id/filesrv[/activate|/deactivate] */
export interface FileServerStatus {
  accountId: number;
  mode: FileServerMode;
  running: boolean;
  port: number | null;
  activeUntil: string | null;
}

export interface FileServerActivateRequest {
  /** 15 … 1440 minutes (default 120). */
  minutes: number;
}

// ─── SITES ───────────────────────────────────────────────────────────────────

export type SiteStatus = 'provisioning' | 'active' | 'stopped' | 'error';
export type PublishMode = 'auto' | 'manual' | 'approval';

export interface PhpSettings {
  memoryLimitMb?: number;
  uploadMaxFilesizeMb?: number;
  postMaxSizeMb?: number;
  maxExecutionTime?: number;
}

export interface Site {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  name: string;
  /** ^[a-z0-9][a-z0-9-]{0,39}$, unique per account, immutable (SFTP folder name). */
  slug: string;
  base: SiteBaseId;
  appProfile: AppProfileId | null;
  /** Relative to the release root ('' = root). */
  docroot: string;
  /** '/' or '/blog/' — the sub-site prefix the application expects. */
  basePath: string;
  publishMode: PublishMode;
  publishDebounceSec: number;
  healthcheckPath: string;
  status: SiteStatus;
  statusMessage: string | null;
  currentReleaseId: number | null;
  currentReleaseNumber: number | null;
  /** Blue/green candidate base, null when no preview runs. */
  previewBase: SiteBaseId | null;
  previewUrl: string | null;
  php: PhpSettings;
  customNginx: string | null;
  /** First domain routed to this site at '/', if any. */
  primaryDomain: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteCreate {
  accountId: number;
  name: string;
  slug: string;
  base: SiteBaseId;
  appProfile?: AppProfileId | null;
  docroot?: string;
  basePath?: string;
  publishMode?: PublishMode;
  publishDebounceSec?: number;
  healthcheckPath?: string;
  /** Create the data paths of the app profile (default true). */
  applyProfileDataPaths?: boolean;
}

/** Base changes go through the runtime endpoints, never through PUT /sites/:id. */
export interface SiteUpdate {
  name?: string;
  appProfile?: AppProfileId | null;
  docroot?: string;
  basePath?: string;
  publishMode?: PublishMode;
  publishDebounceSec?: number;
  healthcheckPath?: string;
  php?: PhpSettings;
  customNginx?: string | null;
}

export interface SiteDataPath {
  id: number;
  siteId: number;
  path: string;
  policy: DataPathPolicy;
  allowedExtensions: string[] | null;
  source: 'profile' | 'manual';
  createdAt: string;
}

export interface SiteDataPathInput {
  path: string;
  policy: DataPathPolicy;
  allowedExtensions?: string[] | null;
}

/** Secondary runtime: another engine serving a path prefix of the SAME release. */
export interface SiteRuntime {
  id: number;
  siteId: number;
  base: SiteBaseId;
  /** Route prefixes served by this runtime. */
  routes: Array<{ routeId: number; domainName: string; pathPrefix: string }>;
  createdAt: string;
}

export interface SiteRuntimeInput {
  base: SiteBaseId;
}

// ─── DOMAINS + ROUTE TABLE (ARCHITECTURE §3.1 bis) ───────────────────────────

export type DomainKind = 'primary' | 'addon' | 'alias' | 'subdomain';
export type TlsMode = 'letsencrypt' | 'none';

export type CertificateStatus = 'pending' | 'valid' | 'failed' | 'expired';
export type CertificateIssuer = 'letsencrypt' | 'letsencrypt-staging' | 'selfsigned';

export interface CertificateSummary {
  id: number;
  status: CertificateStatus;
  issuer: CertificateIssuer;
  names: string[];
  notBefore: string | null;
  notAfter: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface CertificateLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CertificateDetail extends CertificateSummary {
  domainId: number | null;
  log: CertificateLogLine[];
}

export interface SiteRoute {
  id: number;
  domainId: number;
  domainName: string;
  /** '/' or '/shop/' (leading + trailing slash). Longest prefix wins. */
  pathPrefix: string;
  siteId: number;
  siteName: string;
  /** null = the site's primary runtime. */
  runtimeId: number | null;
  runtimeBase: SiteBaseId | null;
  createdAt: string;
}

export interface SiteRouteInput {
  pathPrefix: string;
  siteId: number;
  runtimeId?: number | null;
}

export interface Domain {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  /** Lower-case FQDN (IDN in punycode), unique platform-wide. */
  name: string;
  kind: DomainKind;
  /** Also serve www.<name> (and include it in the certificate). */
  includeWww: boolean;
  tlsMode: TlsMode;
  forceHttps: boolean;
  certificate: CertificateSummary | null;
  routes: SiteRoute[];
  /** P2: also serve *.<name> (wildcard certificate through DNS-01: needs a hosted zone). */
  wildcard: boolean;
  /** P2: ownership proof (unverified = placeholder page, no certificate). */
  verification: DomainVerificationSummary;
  /** P2: DNS zone holding this name (its own or a parent zone of the account), null = none. */
  zone: { id: number; name: string; kind: DnsZoneKind } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainCreate {
  accountId: number;
  name: string;
  kind?: DomainKind;
  includeWww?: boolean;
  tlsMode?: TlsMode;
  forceHttps?: boolean;
  /** Creates the '/' route to this site. */
  siteId?: number | null;
  /** P2 */
  wildcard?: boolean;
  /** P2: create the DNS zone (default: hosted when DNS is enabled, for primary / addon / alias kinds). */
  dnsZone?: DnsZoneKind | 'none';
}

export interface DomainUpdate {
  kind?: DomainKind;
  includeWww?: boolean;
  tlsMode?: TlsMode;
  forceHttps?: boolean;
  /** P2 */
  wildcard?: boolean;
}

// ─── RELEASES (ARCHITECTURE §1) ──────────────────────────────────────────────

export type ReleaseStatus = 'queued' | 'scanning' | 'awaiting_approval' | 'publishing' | 'ready' | 'failed' | 'rejected';
/** P3: 'window' = validated modification window, 'adapter' = application adapter run (docs/P3-PLAN.md). */
export type ReleaseTrigger = 'auto' | 'manual' | 'api' | 'window' | 'adapter';

export type ScanVerdict = 'clean' | 'suspicious' | 'infected';

export interface ScanFinding {
  path: string;
  rule: string;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  /** P3: engine of the finding ('heuristic' | 'yara' | 'clamav' | 'checksum'). */
  engine?: 'heuristic' | 'yara' | 'clamav' | 'checksum';
  /** P3: 1-based line when known. */
  line?: number | null;
}

export interface ScanSummary {
  scanner: string;
  verdict: ScanVerdict;
  findings: ScanFinding[];
  /** P3: risk score of the change set (0–100) and its level (riskLevelOf). */
  risk?: { score: number; level: 'none' | 'low' | 'medium' | 'high' | 'critical' };
  /** P3: files not scanned by the engines (too large, unreadable). */
  skipped?: number;
  /** P3: the scanner container was expected but unreachable (heuristics only). */
  scannerUnavailable?: boolean;
  /**
   * P3: risk ≥ settings scanner.blockScore (or a ClamAV hit) when scanned: the
   * release waits for approval and only a staff override (audited) publishes it.
   */
  blocked?: boolean;
  /** P3: staff override of a blocked scan (who / when / why). */
  override?: { by: string; at: string; reason: string | null } | null;
}

export interface ReleaseLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Release {
  id: number;
  siteId: number;
  /** 1, 2, 3… per site. */
  number: number;
  commitSha: string | null;
  status: ReleaseStatus;
  trigger: ReleaseTrigger;
  message: string | null;
  authorUserId: number | null;
  authorName: string | null;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  /** sites.current_release_id === id. */
  isCurrent: boolean;
  /** Materialized under releases/<number>/ (false once pruned). */
  onDisk: boolean;
  scan: ScanSummary | null;
  error: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface ReleaseDetail extends Release {
  log: ReleaseLogLine[];
}

export interface PublishRequest {
  message?: string | null;
}

/** POST /sites/:id/releases/:rid/approve (P3: override of a high-risk scan, staff only, audited). */
export interface ApproveRequest {
  override?: boolean;
  reason?: string | null;
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'typechange';

export interface ReleaseDiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff of this file (only when requested with ?file= or small enough). */
  patch: string | null;
  patchTruncated: boolean;
}

/** GET /api/sites/:id/releases/:rid/diff[?against=<rid>][&file=<path>] */
export interface ReleaseDiff {
  /** null = diff against the empty tree (first release). */
  fromReleaseId: number | null;
  toReleaseId: number;
  fromCommit: string | null;
  toCommit: string;
  files: ReleaseDiffFile[];
  totalFiles: number;
  truncated: boolean;
  /**
   * The caller may only read names and stats (no code right: files.manage, or
   * sites.manage for staff): every `patch` is null and ?file= is refused.
   */
  contentHidden: boolean;
}

/** GET /api/sites/:id/staging — pending changes of the staging vs the last commit. */
export interface StagingStatus {
  siteId: number;
  pendingChanges: number;
  files: Array<{ path: string; status: DiffFileStatus }>;
  truncated: boolean;
  lastUploadAt: string | null;
  /** Deadline of the auto-publish debounce, null when none is pending. */
  autoPublishAt: string | null;
  /** Warnings found in the staging (nested .git, symlinks…), French text (legacy; prefer warningItems). */
  warnings: string[];
  /** Same warnings as codes + parameters (the UI translates them). */
  warningItems: StagingWarning[];
}

export type StagingWarningCode = 'stagingMissing' | 'nestedRepo' | 'symlink' | 'moreSymlinks';

export interface StagingWarning {
  code: StagingWarningCode;
  /** Path relative to the staging of the site (nestedRepo, symlink). */
  path?: string;
  /** moreSymlinks: number of symlinks not listed. */
  count?: number;
}

// ─── RUNTIME / CONTAINERS (ARCHITECTURE §3.1, §3.6) ──────────────────────────

export type ContainerState = 'running' | 'stopped' | 'missing' | 'restarting' | 'error' | 'unknown';
export type RuntimeRole = 'primary' | 'secondary' | 'preview';

export interface RuntimeContainerStatus {
  role: RuntimeRole;
  /** site_runtimes.id for a secondary runtime. */
  runtimeId: number | null;
  name: string;
  base: SiteBaseId;
  image: string;
  state: ContainerState;
  startedAt: string | null;
  health: string | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  /** Exact PHP version of the image the container was created from (PHP_VERSION); null: static or unknown. */
  phpVersion: string | null;
}

export type RuntimeWarningCode = 'htaccessIgnored' | 'unmaintainedRuntime' | 'vulnerableRuntime' | 'phpDowngrade' | 'phpMajorChange' | 'staticBaseWithPhp' | 'imageMissing';

export interface RuntimeWarning {
  code: RuntimeWarningCode;
  /** English fallback; the client translates `runtime.warnings.<code>`. */
  message: string;
}

/** GET /api/sites/:id/runtime */
export interface SiteRuntimeStatus {
  siteId: number;
  base: SiteBaseId;
  previewBase: SiteBaseId | null;
  previewUrl: string | null;
  containers: RuntimeContainerStatus[];
}

/** POST /api/sites/:id/runtime/check {base} → warnings before a switch. */
export interface RuntimeSwitchCheck {
  base: SiteBaseId;
  warnings: RuntimeWarning[];
}

export interface RuntimeSwitchRequest {
  base: SiteBaseId;
  /** 'preview' = start the candidate next to the current one (blue/green). */
  mode: 'direct' | 'preview';
}

/**
 * Written by the panel to sites/<id>/runtime/<role>.json, mounted read-only
 * at /etc/oblimint/site/site.json in the site container; read by the image
 * entrypoint and by `oblimint-reload` (images/ contract).
 */
export interface SiteRuntimeConfig {
  version: 1;
  siteId: number;
  accountId: number;
  role: RuntimeRole;
  base: SiteBaseId;
  /** Absolute container path, e.g. /srv/releases/current/public */
  docroot: string;
  basePath: string;
  /** Secondary runtime: the prefixes it serves (informational). */
  servedPrefixes: string[];
  dataPaths: Array<{ path: string; policy: DataPathPolicy; allowedExtensions: string[] | null }>;
  php: Required<PhpSettings>;
  customNginx: string | null;
  healthcheckPath: string;
}

// ─── INFRA / EDGE ────────────────────────────────────────────────────────────

/**
 * P3: + scanner (ClamAV + YARA, module scanners).
 * P4: + mail (the engine containers: postfix-dovecot + rspamd + redis, or
 * stalwart), mail-relay (site relay of PHP mail()), webmail (Roundcube or
 * SnappyMail) — docs/P4-PLAN.md.
 */
export type InfraComponentId = 'edge' | 'hostd' | 'dns' | 'dbadmin' | 'scanner' | 'mail' | 'mail-relay' | 'webmail'
  // P4b: forward-auth sidecars (oauth2-proxy per provider + their Redis), module proxy-hosts.
  | 'proxy-auth';

export interface InfraComponentStatus {
  /** P2: + dns (PowerDNS), dbadmin (phpMyAdmin + Adminer). */
  id: InfraComponentId;
  deployed: boolean;
  running: boolean;
  image: string | null;
  version: string | null;
  detail: string | null;
}

/** GET /api/system/infra */
export interface InfraStatus {
  nodeId: number;
  components: InfraComponentStatus[];
  /** hostd /v1/fs of /srv/oblimint (null when hostd unreachable). */
  quotaMode: QuotaMode | null;
}

/** GET /api/system/edge */
export interface EdgeStatus {
  running: boolean;
  vhostCount: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  acmeDirectory: 'production' | 'staging';
  certificates: { valid: number; pending: number; failed: number; expiringSoon: number };
  /** P4b (edge-robustness): configuration units by status + last apply. */
  units?: { total: number; active: number; quarantined: number; stub: number; pending: number; upstreamUnreachable: number };
  lastApply?: { result: string; at: string; error: string | null } | null;
}

export interface EdgeSyncResult {
  ok: boolean;
  vhostCount: number;
  /** `nginx -t` output when it failed. */
  error: string | null;
}

// ─── SOCKET EVENTS (payloads carry ids only: clients refetch) ────────────────

export const HostingSocketEvents = {
  /** { entity: 'plan'|'account'|'site'|'domain', id, accountId? } */
  HOSTING_CHANGED: 'HOSTING_CHANGED',
  /** { siteId, releaseId, status } */
  RELEASE_UPDATED: 'RELEASE_UPDATED',
  /** { siteId } */
  RUNTIME_UPDATED: 'RUNTIME_UPDATED',
  /** { domainId, status } */
  CERTIFICATE_UPDATED: 'CERTIFICATE_UPDATED',
  /** { accountId, running } */
  FILESRV_UPDATED: 'FILESRV_UPDATED',
  // ── P2 (payloads: ids only, clients refetch) ──
  /** { zoneId, domainId|null, accountId } */
  DNS_ZONE_UPDATED: 'DNS_ZONE_UPDATED',
  /** { domainId, status } — ownership verification changed */
  DOMAIN_VERIFICATION_UPDATED: 'DOMAIN_VERIFICATION_UPDATED',
  /** { instanceId, accountId, status } */
  DB_INSTANCE_UPDATED: 'DB_INSTANCE_UPDATED',
  /** { accountId } — mode / rules / grants / bans / applied state */
  ACCESS_UPDATED: 'ACCESS_UPDATED',
  /** { jobId, runId, siteId, status } */
  CRON_RUN_UPDATED: 'CRON_RUN_UPDATED',
  /** { alertId, accountId|null, tenantId, level } */
  USAGE_ALERT: 'USAGE_ALERT',
  // ── P3 (payloads: ids only, clients refetch — maintenance.ts) ──
  /** WindowUpdatedPayload { siteId, windowId, status } */
  WINDOW_UPDATED: 'WINDOW_UPDATED',
  /** AdapterRunUpdatedPayload { siteId, runId, status } */
  ADAPTER_RUN_UPDATED: 'ADAPTER_RUN_UPDATED',
  /** QuarantineUpdatedPayload { accountId, itemId, status } */
  QUARANTINE_UPDATED: 'QUARANTINE_UPDATED',
  // ── P4 (payloads: ids only, clients refetch — mail.ts) ──
  /** MailUpdatedPayload { entity, id, accountId, action } */
  MAIL_UPDATED: 'MAIL_UPDATED',
  // ── P4b (payloads: ids only, clients refetch — apps.ts, proxy.ts, monitoring.ts) ──
  /** AppUpdatedPayload */
  APP_UPDATED: 'APP_UPDATED',
  /** AppDeployOutputPayload (room app-deploy:<deploymentId>) */
  APP_DEPLOY_OUTPUT: 'APP_DEPLOY_OUTPUT',
  /** ProxyUpdatedPayload (hosts, redirections, dead hosts, streams, lists, pages, providers, certificates, edge units) */
  PROXY_UPDATED: 'PROXY_UPDATED',
  /** { accountId, linkId|null } — links / policy applied */
  NETWORK_UPDATED: 'NETWORK_UPDATED',
  /** { banId, accountId|null, action } */
  BAN_UPDATED: 'BAN_UPDATED',
  /** MonitoringUpdatedPayload */
  MONITORING_UPDATED: 'MONITORING_UPDATED',
  // ── P5 (payloads: ids only, room role:admin — migration.ts) ──
  /** MigrationUpdatedPayload (sources, discoveries, plans, runs, steps, cutover) */
  MIGRATION_UPDATED: 'MIGRATION_UPDATED',
  /** Platform updates of a node (images, checks, update runs): PlatformUpdatesEvent — role:admin room only. */
  PLATFORM_UPDATES: 'PLATFORM_UPDATES',
} as const;
export type HostingSocketEventName = typeof HostingSocketEvents[keyof typeof HostingSocketEvents];

export interface HostingChangedPayload {
  entity: 'plan' | 'account' | 'site' | 'domain' | 'dbInstance' | 'dnsZone' | 'cronJob';
  id: number;
  accountId?: number;
  action: 'created' | 'updated' | 'deleted';
}
