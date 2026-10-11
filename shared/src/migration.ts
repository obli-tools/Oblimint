// =============================================================================
// Oblimint — P5 « Migration depuis CentOS Web Panel » shared types
// (docs/P5-PLAN.md, docs/cwp/CWP-MAP.md). ARCHITECT FILE, frozen during the
// phase: modules code against these shapes, a defect is reported, not fixed.
//
// Layers:
//   sources      SSH connection to the CWP server (read-only executor)
//   discovery    CwpInventory: what exists on the source (NO secret inside)
//   plan         MigrationPlanChoices (staff input) → MigrationPlanResult
//                (fully resolved actions + warnings = the dry-run)
//   runs         per-account executions (initial / resync / final-sync),
//                resumable steps, events, reports
//   cutover      per-domain checklist (TTL, NS, final sync, switch)
// Every route lives under /api/system/migration (platform admin only).
// =============================================================================

import type { AppProfileId, DataPathTemplate, DomainKind, PlanLimits, SiteBaseId } from './hosting';
import type { DbEngine, DbTuningProfile } from './databases';
import type { DnsRecordType } from './dns';
import type { MailPasswordScheme } from './mail';
import type { MailEngine } from './types';
import type { ProxyScheme } from './proxy';

// ─── COMMON ──────────────────────────────────────────────────────────────────

/** A translatable message: the client renders t(`migration.codes.${code}`, params). */
export interface MigrationMessage {
  code: string;
  params?: Record<string, string | number | boolean | null>;
}

export type MigrationSeverity = 'info' | 'warning' | 'blocking';

export type MigrationScopeKind =
  | 'server' | 'package' | 'account' | 'domain' | 'site' | 'proxy' | 'zone' | 'database' | 'dbUser'
  | 'mailDomain' | 'mailbox' | 'alias' | 'dkim' | 'ftpUser' | 'cron' | 'certificate' | 'outside';

export interface MigrationScope {
  kind: MigrationScopeKind;
  /** Natural key on the source (fqdn, cwp username, database name, address…). */
  key: string;
  /** CWP account the object belongs to (null = server-wide / no account). */
  account?: string | null;
}

export interface MigrationWarning extends MigrationMessage {
  severity: MigrationSeverity;
  scope: MigrationScope;
}

export type MigrationFollowUpSuggestion = 'docker-app' | 'proxy-host' | 'manual' | 'client-login' | 'dns-registrar' | 'ignore';

/** Something the migration cannot do: listed in the report as a manual follow-up. */
export interface MigrationFollowUp extends MigrationMessage {
  scope: MigrationScope;
  suggestion: MigrationFollowUpSuggestion;
}

// ─── SOURCES ─────────────────────────────────────────────────────────────────

export type MigrationSourceAuth = 'key' | 'password';
export type MigrationSourceStatus = 'new' | 'ok' | 'error';

export interface MigrationHostKey {
  /** ssh-ed25519, ecdsa-sha2-nistp256, rsa-sha2-512… */
  algorithm: string;
  /** 'SHA256:' + base64 (no padding), as OpenSSH prints it. */
  fingerprint: string;
}

export interface MigrationSource {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: MigrationSourceAuth;
  /** Commands are prefixed with `sudo -n --` (user is not root). */
  useSudo: boolean;
  /** Pinned host key (null = never pinned: every connection is refused until pinned). */
  hostKey: MigrationHostKey | null;
  hostKeyPinnedAt: string | null;
  /** Key seen at the last test while nothing (or something else) was pinned. */
  pendingHostKey: MigrationHostKey | null;
  status: MigrationSourceStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  /** From the last successful test / discovery. */
  cwpVersion: string | null;
  osRelease: string | null;
  /** Credentials exist (never returned). */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /sources. Secrets are sealed (secretBox 'migration-source') and never returned. */
export interface MigrationSourceInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: MigrationSourceAuth;
  password?: string | null;
  /** OpenSSH / PEM private key. */
  privateKey?: string | null;
  passphrase?: string | null;
  useSudo?: boolean;
}

/** PUT /sources/:id — a changed host / port drops the pinned key. Omitted secret = unchanged. */
export type MigrationSourceUpdate = Partial<MigrationSourceInput>;

export interface MigrationSourceTestResult {
  ok: boolean;
  /** Key presented by the server during this test. */
  hostKey: MigrationHostKey | null;
  /** pinned = a key is pinned; matches = the presented key is the pinned one. */
  hostKeyState: 'unpinned' | 'match' | 'mismatch';
  latencyMs: number | null;
  /** `id -un` on the source (root expected unless useSudo). */
  remoteUser: string | null;
  cwpVersion: string | null;
  osRelease: string | null;
  /** hostKeyUnpinned | hostKeyMismatch | authFailed | connectFailed | timeout | notCwp | sudoFailed | commandFailed */
  errorCode: string | null;
  error: string | null;
}

export interface MigrationHostKeyPin {
  /** Must equal the pending key captured by the last test. */
  fingerprint: string;
}

export type MigrationCommandPhase = 'discovery' | 'transfer';
export type MigrationCommandStatus = 'ok' | 'error' | 'refused' | 'timeout';

/** One line of the per-source command log (GET /sources/:id/commands). */
export interface MigrationCommandLogEntry {
  id: number;
  sourceId: number;
  discoveryId: number | null;
  runId: number | null;
  template: string;
  /** Rendered remote command (arguments of sensitive templates are kept, OUTPUT never logged). */
  command: string;
  phase: MigrationCommandPhase;
  sensitive: boolean;
  status: MigrationCommandStatus;
  exitCode: number | null;
  bytesOut: number;
  durationMs: number | null;
  /** Refusal reason / error (no output). */
  error: string | null;
  createdAt: string;
}

export interface MigrationCommandTemplateInfo {
  id: string;
  phases: MigrationCommandPhase[];
  sensitive: boolean;
  /** i18n key suffix: migration.templates.<id> */
  description: string;
}

// ─── DISCOVERY: INVENTORY (no secret, ever) ──────────────────────────────────

export interface CwpServerInfo {
  hostname: string | null;
  osRelease: string | null;
  cwpVersion: string | null;
  cwpPro: boolean;
  /** web_servers.conf webserver_setup (nginx-varnish-apache…). */
  webserverSetup: string | null;
  publicIps: string[];
  privateIps: string[];
  mariadbVersion: string | null;
  /** Default PHP of suPHP / CLI (/usr/local/bin/php). */
  phpDefault: string | null;
  /** /opt/alt/php-fpmXX present ('5.6', '7.4'…). */
  phpFpmVersions: string[];
  /** rpm name → version-release. */
  packages: Record<string, string>;
  /** root_cwp.nameserver */
  nameservers: string[];
  /** mysql_user_prefix.conf additional prefixes. */
  extraDbPrefixes: string[];
}

export interface CwpPackage {
  /** root_cwp.packages.id (user.package stores it as text). */
  id: number;
  name: string;
  /** MiB; -1 / ≥ 999999 → null (unlimited). */
  diskQuotaMb: number | null;
  bandwidthMbPerMonth: number | null;
  ftpAccounts: number | null;
  emailAccounts: number | null;
  emailLists: number | null;
  databases: number | null;
  subDomains: number | null;
  parkedDomains: number | null;
  addonDomains: number | null;
  hourlyEmails: number | null;
  isReseller: boolean;
  nproc: number | null;
  inodes: number | null;
  accountCount: number;
}

export interface CwpAccount {
  username: string;
  uid: number | null;
  gid: number | null;
  homeDir: string;
  mainDomain: string;
  contactEmail: string | null;
  packageId: number | null;
  packageName: string | null;
  /** root_cwp.user.reseller ('' → null). */
  reseller: string | null;
  /** /usr/local/cwp/users/suspended/<user>/ exists. */
  suspended: boolean;
  setupDate: string | null;
  ipAddress: string | null;
  shell: string | null;
  /** Interactive shell (not nologin / false). */
  sshAccess: boolean;
  authorizedKeys: number;
  homeBytes: number | null;
  mailBytes: number | null;
  dbBytes: number | null;
  /** Versions having a PHP-FPM pool for this user ('7.4'…). */
  fpmPools: string[];
  /** php.ini / .user.ini files found (relative to the home). */
  phpIniFiles: string[];
  /** Directories of the home that are neither a docroot nor CWP internals (scripts/, node/…). */
  extraDirs: string[];
}

export type CwpDomainKind = 'main' | 'addon' | 'parked' | 'subdomain';
export type CwpServing = 'site' | 'proxy' | 'redirect' | 'disabled' | 'unknown';
export type CwpPhpHandler = 'suphp' | 'php-fpm' | 'nginx-fpm' | 'none';
export type CwpPhpSource = 'apache-vhost' | 'nginx-vhost' | 'htaccess' | 'webservers-json' | 'default';

export interface CwpPhpInfo {
  /** '8.3', '5.6'… null = no PHP (static / proxy). */
  version: string | null;
  handler: CwpPhpHandler;
  /** Where the effective version was read (vhost first, then .htaccess, then JSON). */
  source: CwpPhpSource;
  /** Sub-directories of the docroot whose .htaccess forces another version. */
  htaccessOverrides: Array<{ path: string; version: string }>;
}

export interface CwpProxyTarget {
  scheme: ProxyScheme;
  /** IP or host name. */
  host: string;
  port: number;
  /** Upgrade / Connection headers in the vhost (websocket templates). */
  websocket: boolean;
  via: 'nginx-vhost' | 'webservers-json' | 'varnish';
  /** RFC 1918 / ULA / loopback / CGNAT. */
  isPrivate: boolean;
}

export interface CwpAppDetection {
  profile: AppProfileId | null;
  markers: string[];
  /** From ~/.conf/.addons_wp. */
  wordpress: { path: string; database: string | null; dbUser: string | null; version: string | null } | null;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasComposerJson: boolean;
  htaccess: boolean;
  userIni: boolean;
}

export interface CwpDomain {
  fqdn: string;
  kind: CwpDomainKind;
  account: string;
  /** Parent domain (subdomain), null otherwise. */
  parent: string | null;
  /** root_cwp.subdomains.subdomain (may contain a dot). */
  subLabel: string | null;
  /** Effective docroot (vhost root / DocumentRoot, else DB path), absolute on the source. */
  docroot: string | null;
  /** Path stored by CWP (domains.path / subdomains.path; main = /home/<u>/public_html). */
  docrootFromDb: string | null;
  docrootNonStandard: boolean;
  serving: CwpServing;
  proxy: CwpProxyTarget | null;
  redirectTo: string | null;
  php: CwpPhpInfo | null;
  varnish: boolean;
  nginxTemplate: string | null;
  apacheTemplate: string | null;
  /** A non-stock CWP template is used (manual review). */
  customTemplate: boolean;
  /** www.<fqdn> is a server_name / ServerAlias. */
  wwwAlias: boolean;
  /** An SSL vhost exists. */
  ssl: boolean;
  /** /etc/pki/tls/certs/<name>.cert covering this fqdn. */
  certificate: string | null;
  /** DNS zone of the source containing this name (null = not hosted on the source). */
  dnsZone: string | null;
  app: CwpAppDetection | null;
  docrootBytes: number | null;
  vhostFiles: string[];
  /** Same fqdn listed twice in root_cwp (kept once, the other row is reported). */
  duplicateOf: CwpDomainKind | null;
  /**
   * Public DNS seen by the panel at discovery (absent = not checked): A / AAAA of the name and the NS of its
   * closest delegated zone. Proof that the domain is really served by the source (default 'force' verification).
   */
  publicDns?: CwpPublicDns | null;
}

export interface CwpPublicDns {
  a: string[];
  aaaa: string[];
  /** NS of the closest enclosing zone found (lower case, no trailing dot). */
  ns: string[];
  /** false = the lookups failed (timeout, SERVFAIL…): no proof either way. */
  resolved: boolean;
}

export interface CwpDnsRecord {
  /** FQDN, lower case, no trailing dot. */
  name: string;
  type: string;
  ttl: number;
  /** Presentation format (TXT: quoted strings joined as in the zone). */
  content: string;
  priority: number | null;
}

export interface CwpDnsZone {
  name: string;
  file: string | null;
  /** allow-update / update-policy in named.conf. */
  dynamic: boolean;
  /** <file>.jnl exists. */
  journal: boolean;
  /** How the records were read: journal applied (named-checkzone -j), AXFR, or the plain file. */
  readVia: 'checkzone' | 'axfr' | 'file';
  serial: number | null;
  defaultTtl: number | null;
  /** SOA excluded. */
  records: CwpDnsRecord[];
  account: string | null;
  /** Apex NS. */
  nameservers: string[];
  /** Declared in named.conf (false = orphan .db file). */
  declared: boolean;
}

export interface CwpDbObject {
  schema: string;
  name: string;
  kind: 'trigger' | 'view' | 'routine' | 'event';
  /** user@host as in information_schema. */
  definer: string;
  securityType: 'DEFINER' | 'INVOKER' | null;
}

export interface CwpDatabase {
  name: string;
  /** Owner by prefix (SUBSTRING_INDEX(name,'_',1)), extra prefixes included; null = orphan. */
  account: string | null;
  charset: string | null;
  collation: string | null;
  sizeBytes: number;
  tables: number;
  /** engine → table count. */
  engines: Record<string, number>;
  memoryTables: string[];
  /** table collation → table count. */
  tableCollations: Record<string, number>;
  /** Tables in a latin1 collation (double-encoding risk). */
  latin1Tables: number;
  objects: CwpDbObject[];
}

export type CwpDbHashKind = 'native' | 'old-password' | 'none' | 'other';

export interface CwpDbGrant {
  /** mysql.db.Db exactly as stored (escaped: acct1\_%). */
  dbPattern: string;
  /** Pattern with LIKE wildcards. */
  wildcard: boolean;
  /** SELECT, INSERT… (mysql.db columns set to 'Y', GRANT OPTION excluded). */
  privileges: string[];
  withGrantOption: boolean;
  /** Databases of the inventory matched by the pattern. */
  matches: string[];
}

export interface CwpDbUser {
  user: string;
  host: string;
  account: string | null;
  plugin: string;
  /** Kind of the stored hash (the hash itself is never in the inventory). */
  hashKind: CwpDbHashKind;
  /** Host is neither localhost / 127.0.0.1 / ::1. */
  remote: boolean;
  grants: CwpDbGrant[];
  /** Prefixed user whose prefix matches no CWP account. */
  orphan: boolean;
  maxUserConnections: number | null;
}

export interface CwpMailDomain {
  name: string;
  account: string | null;
  active: boolean;
  backupMx: boolean;
  mailboxes: number;
  aliases: number;
  hasDkim: boolean;
}

export interface CwpMailbox {
  address: string;
  localPart: string;
  domain: string;
  account: string | null;
  active: boolean;
  /** Bytes, null = unlimited (0 in CWP). */
  quotaBytes: number | null;
  /** quota2.bytes / messages. */
  usedBytes: number | null;
  messages: number | null;
  /** Relative maildir as stored (domain/local/). */
  maildir: string;
  /** Absolute on the source (/var/vmail/<maildir>). */
  maildirPath: string;
  /** Owner uid of the maildir in postfix.mailbox (account uid). */
  uid: number | null;
  /** Scheme of the stored hash ({SHA512-CRYPT} prefix, $6$, $1$…); null = unknown / empty. */
  hashScheme: MailPasswordScheme | null;
  hashPrefixed: boolean;
  hasSieve: boolean;
  displayName: string | null;
  maildirBytes: number | null;
}

export interface CwpMailAlias {
  address: string;
  domain: string;
  targets: string[];
  active: boolean;
  account: string | null;
  kind: 'forward' | 'catch-all' | 'local';
}

export interface CwpDkimKey {
  domain: string;
  selector: string;
  account: string | null;
  /** Private key path on the source (read only by the transfer stage). */
  keyPath: string;
  /** From the public part (default.txt): RSA modulus size. */
  bits: number | null;
  algorithm: 'rsa' | 'ed25519' | 'unknown';
  inSigningTable: boolean;
  /** p= of default.txt (public, safe). */
  publicKey: string | null;
}

export interface CwpFtpUser {
  login: string;
  account: string | null;
  uid: number | null;
  gid: number | null;
  /** Absolute directory (the /./ chroot marker removed). */
  directory: string;
  chroot: boolean;
  hashScheme: 'bcrypt' | 'sha512-crypt' | 'md5-crypt' | 'other';
}

export interface CwpCronEntry {
  /** Stable key: <owner>:<line number>. */
  key: string;
  /** Crontab owner (CWP username or root / another Linux user). */
  owner: string;
  account: string | null;
  schedule: string;
  command: string;
  /** PHP CLI binary named in the command (/usr/local/bin/php, /opt/alt/php73/usr/bin/php…). */
  phpBinary: string | null;
  phpVersion: string | null;
  /** Commented-out line. */
  disabled: boolean;
  /** root / non-CWP user: never migrated, listed as a follow-up. */
  system: boolean;
  lineNo: number;
}

export interface CwpCertificate {
  /** File base name (/etc/pki/tls/certs/<fqdn>.cert). */
  fqdn: string;
  certPath: string;
  keyPath: string;
  bundlePath: string | null;
  names: string[];
  notBefore: string | null;
  notAfter: string | null;
  issuer: string | null;
  selfSigned: boolean;
  expired: boolean;
  /** vhosts-ssl.json autossl. */
  autossl: boolean;
  account: string | null;
  keyType: 'rsa' | 'ec' | 'unknown';
}

export type CwpOutsideKind =
  | 'systemd-service' | 'linux-user' | 'nginx-template' | 'apache-template' | 'varnish-backend' | 'root-cron'
  | 'mysql-remote-user' | 'mysql-orphan' | 'ssh-access' | 'git-repo' | 'node-app' | 'python-app'
  | 'dns-orphan-zone' | 'dns-dynamic-zone' | 'domlogs' | 'other';

/** Things outside the CWP model: reported as manual follow-ups (P4b Docker apps suggested for Node / Python). */
export interface CwpOutsideItem {
  kind: CwpOutsideKind;
  key: string;
  account: string | null;
  /** i18n: migration.outside.<code> */
  code: string;
  params?: Record<string, string | number | boolean | null>;
  suggestion: MigrationFollowUpSuggestion;
  /** Raw facts (unit file name, ExecStart, user, ports…), NO secret. */
  details: Record<string, string | number | boolean | null>;
}

export interface CwpInventoryCounts {
  accounts: number;
  suspendedAccounts: number;
  packages: number;
  domains: number;
  mainDomains: number;
  addonDomains: number;
  parkedDomains: number;
  subDomains: number;
  proxyDomains: number;
  dnsZones: number;
  databases: number;
  dbUsers: number;
  mailDomains: number;
  mailboxes: number;
  mailAliases: number;
  dkimKeys: number;
  ftpUsers: number;
  crons: number;
  certificates: number;
  outside: number;
  filesBytes: number;
  dbBytes: number;
  mailBytes: number;
}

export interface CwpInventory {
  schemaVersion: 1;
  collectedAt: string;
  server: CwpServerInfo;
  packages: CwpPackage[];
  accounts: CwpAccount[];
  domains: CwpDomain[];
  dnsZones: CwpDnsZone[];
  databases: CwpDatabase[];
  dbUsers: CwpDbUser[];
  mailDomains: CwpMailDomain[];
  mailboxes: CwpMailbox[];
  mailAliases: CwpMailAlias[];
  dkimKeys: CwpDkimKey[];
  ftpUsers: CwpFtpUser[];
  crons: CwpCronEntry[];
  certificates: CwpCertificate[];
  outside: CwpOutsideItem[];
  warnings: MigrationWarning[];
  counts: CwpInventoryCounts;
}

export type MigrationDiscoveryStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type MigrationDiscoveryPhase =
  | 'connect' | 'server' | 'cwp-db' | 'accounts' | 'vhosts' | 'docroots' | 'dns' | 'databases' | 'mail' | 'dkim'
  | 'ftp' | 'cron' | 'certificates' | 'outside' | 'sizes' | 'finalize';

export interface MigrationDiscovery {
  id: number;
  sourceId: number;
  status: MigrationDiscoveryStatus;
  phase: MigrationDiscoveryPhase | null;
  progress: { done: number; total: number };
  counts: CwpInventoryCounts | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdBy: number | null;
}

// ─── PLAN: CHOICES (staff input) ─────────────────────────────────────────────

export interface MigrationGlobalChoices {
  /** Default target tenant of the accounts (1 = Default). */
  defaultTenantId: number;
  /** Node of the new accounts (null = local node). */
  nodeId: number | null;
  /** Addresses of the CWP server rewritten in the zones (default: server.publicIps + ip_address of the accounts). */
  sourceIps: string[];
  /** New addresses (default: platform public IPv4 / IPv6). */
  targetIpv4: string | null;
  targetIpv6: string | null;
  /** TTL forced on the imported records until the cutover (null = keep). */
  importTtl: number | null;
  /** Default database engine / version of the account instances (version ≥ source, native hashes supported). */
  dbEngine: DbEngine;
  dbVersion: string;
  /** suspended accounts: migrate suspended (default), active, or skip. */
  suspendedAccounts: 'keep-suspended' | 'activate' | 'skip';
  include: {
    files: boolean;
    databases: boolean;
    mail: boolean;
    dns: boolean;
    crons: boolean;
    certificates: boolean;
    proxies: boolean;
    ftp: boolean;
  };
  /** Publish even if the scan blocks (staff override, audited). */
  scanOverride: boolean;
}

export interface MigrationPackageChoice {
  action: 'create' | 'existing';
  /** existing: plan id in the target tenant(s) — one per tenant: tenantId → planId. */
  planIds?: Record<string, number>;
  /** create: plan name (default 'CWP <package>') and limit overrides on top of the mapping. */
  name?: string | null;
  limits?: Partial<PlanLimits> | null;
}

export interface MigrationSecondaryRuntimeChoice {
  pathPrefix: string;
  base: SiteBaseId;
}

export interface MigrationDomainChoice {
  selected?: boolean;
  /** site = hosted code, proxy = P4b proxy host (external target), alias = served by another site, skip. */
  as?: 'site' | 'proxy' | 'alias' | 'skip';
  /** Domains sharing a site key share one site (default: grouped by docroot). */
  siteKey?: string | null;
  base?: SiteBaseId | null;
  profile?: AppProfileId | null;
  /** Directory copied from the source (absolute, default = docroot or its parent for public/ layouts). */
  sourceRoot?: string | null;
  /** Docroot relative to sourceRoot ('' = sourceRoot itself). */
  docroot?: string | null;
  secondaryRuntimes?: MigrationSecondaryRuntimeChoice[] | null;
  /** Extra rsync excludes (relative patterns). */
  excludes?: string[] | null;
  proxy?: { host: string; port: number; scheme: ProxyScheme; websocket: boolean } | null;
  /**
   * Staff confirmation that this proxied domain may target a PRIVATE address (RFC1918 / CGNAT / ULA): the
   * target comes from config the CWP client controls, so it is blocking (proxyPrivateTarget) until set.
   */
  proxyAllowPrivate?: boolean | null;
  /**
   * force = ownership marked verified by the staff (audited); txt = TXT record needed. Default: force only when
   * the PUBLIC DNS of the domain points at the source (CwpDomain.publicDns), txt otherwise (a CWP zone proves nothing).
   */
  verification?: 'force' | 'txt' | null;
}

export interface MigrationDbInstanceChoice {
  mode: 'create' | 'existing';
  instanceId?: number | null;
  engine?: DbEngine | null;
  version?: string | null;
  name?: string | null;
}

export interface MigrationAccountChoice {
  selected?: boolean;
  tenantId?: number | null;
  targetUsername?: string | null;
  /** Override of the package mapping for this account. */
  planId?: number | null;
  suspended?: boolean | null;
  domains?: Record<string, MigrationDomainChoice>;
  dbInstance?: MigrationDbInstanceChoice | null;
  databases?: Record<string, { selected?: boolean; dumpCharset?: 'utf8mb4' | 'latin1' | 'binary' }>;
  dbUsers?: Record<string, { selected?: boolean }>;
  zones?: Record<string, { selected?: boolean; rewriteIps?: boolean }>;
  mailDomains?: Record<string, { selected?: boolean }>;
  mailboxes?: Record<string, { selected?: boolean }>;
  aliases?: Record<string, { selected?: boolean }>;
  dkim?: Record<string, { import?: boolean }>;
  ftpUsers?: Record<string, { action?: 'adopt-password' | 'skip' }>;
  crons?: Record<string, { selected?: boolean; siteKey?: string | null; command?: string | null; schedule?: string | null }>;
  certificates?: Record<string, { selected?: boolean }>;
}

export interface MigrationPlanChoices {
  global: MigrationGlobalChoices;
  /** CWP package id (text) → choice. */
  packages: Record<string, MigrationPackageChoice>;
  /** CWP username → choice (absent = defaults). */
  accounts: Record<string, MigrationAccountChoice>;
  /** Zones of the source attached to no account (forge, ns3/ns4, hostname): username to attach to, or skip. */
  orphanZones?: Record<string, { account: string | null }>;
}

// ─── PLAN: RESULT (dry-run, fully resolved actions) ─────────────────────────

export interface PlannedPackage {
  /** '<cwp package id>@<tenantId>' — object map key of the plan. */
  key: string;
  cwpPackageId: number;
  tenantId: number;
  action: 'create' | 'existing';
  planId: number | null;
  name: string;
  limits: PlanLimits;
}

export interface PlannedDomain {
  fqdn: string;
  cwpKind: CwpDomainKind;
  kind: DomainKind;
  includeWww: boolean;
  servedBy: 'site' | 'proxy' | 'none';
  siteKey: string | null;
  proxyKey: string | null;
  verification: 'force' | 'txt';
  /**
   * DNS of the domain on the target: 'migrated' = a PlannedZone of the same name is imported (the domain is created
   * with dnsZone 'none', mail-dns creates the zone and attaches it); 'parent' = the name lives inside another
   * migrated zone (dnsZone 'none'); 'external' = hosted elsewhere (dnsZone 'external').
   */
  dnsZone: 'migrated' | 'parent' | 'external';
  /** Domain already exists on the platform (other account / tenant) → blocking unless mapped to this run. */
  existingDomainId: number | null;
}

export interface PlannedSite {
  /** Stable key (object map): the first fqdn of the group. */
  key: string;
  name: string;
  slug: string;
  base: SiteBaseId;
  unmaintained: boolean;
  profile: AppProfileId | null;
  /** Absolute directory copied from the source. */
  sourceRoot: string;
  docroot: string;
  /** fqdn → path prefix ('/'). */
  routes: Array<{ fqdn: string; pathPrefix: string }>;
  dataPaths: DataPathTemplate[];
  secondaryRuntimes: MigrationSecondaryRuntimeChoice[];
  excludes: string[];
  php: CwpPhpInfo | null;
  estimatedBytes: number | null;
  scanOverride: boolean;
}

export interface PlannedProxyHost {
  key: string;
  name: string;
  fqdns: string[];
  target: { host: string; port: number; scheme: ProxyScheme; allowPrivate: boolean };
  websocket: boolean;
  certificateFqdn: string | null;
}

export interface PlannedDbInstance {
  mode: 'create' | 'existing';
  instanceId: number | null;
  name: string;
  engine: DbEngine;
  version: string;
  /**
   * Tuning profile of a created instance, sized from the selected databases (migrationDbProfile): an import into an
   * instance whose buffer pool / memory limit is far below the data thrashes for hours. Absent = 'S' (older results).
   */
  profile?: DbTuningProfile;
}

/** Profile of an instance created by the migration for `bytes` of data (on-disk size reported by the source). */
export function migrationDbProfile(bytes: number): DbTuningProfile {
  if (bytes > 4 * 1024 ** 3) return 'L';
  if (bytes > 64 * 1024 ** 2) return 'M';
  return 'S';
}

export interface PlannedDatabase {
  name: string;
  charset: string | null;
  collation: string | null;
  dumpCharset: 'utf8mb4' | 'latin1' | 'binary';
  sizeBytes: number;
  definerObjects: number;
  memoryTables: string[];
}

export interface PlannedDbUser {
  username: string;
  sourceHosts: string[];
  /** Host part on the target ('%' — sockets + account network; remote hosts reported). */
  targetHost: string;
  grants: Array<{ database: string; privileges: string[]; level: 'all' | 'readonly' }>;
  hashKind: CwpDbHashKind;
}

export interface PlannedDnsRecord {
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  priority: number | null;
}

export interface PlannedZone {
  name: string;
  /** Domain (fqdn) of this run the zone is attached to (dns_zones.domain_id), null = account zone without domain row. */
  domain: string | null;
  defaultTtl: number;
  records: PlannedDnsRecord[];
  /** Records not imported (SOA, apex NS, unsupported types, managed by the mail DNS contributor…). */
  dropped: Array<{ record: CwpDnsRecord; reason: string }>;
  rewritten: number;
}

export interface PlannedMailDomain {
  name: string;
  domain: string;
}

export interface PlannedMailbox {
  address: string;
  localPart: string;
  domain: string;
  quotaMb: number | null;
  enabled: boolean;
  hashScheme: MailPasswordScheme | null;
  maildirPath: string;
  sizeBytes: number | null;
}

export interface PlannedAlias {
  address: string;
  domain: string;
  targets: string[];
  enabled: boolean;
}

export interface PlannedDkimKey {
  domain: string;
  selector: string;
  import: boolean;
  bits: number | null;
}

export interface PlannedCron {
  key: string;
  siteKey: string;
  name: string;
  schedule: string;
  command: string;
  originalCommand: string;
  enabled: boolean;
}

export interface PlannedCertificate {
  fqdn: string;
  names: string[];
  notAfter: string | null;
  target: 'site-domain' | 'proxy-host';
  /** Domains (fqdn) of this run the certificate is installed for. */
  domains: string[];
}

export interface PlannedFtpCredential {
  login: string;
  /** The bcrypt hash becomes the file-server password of the account (login = account username). */
  adopt: boolean;
}

export interface MigrationAccountPlan {
  cwpUsername: string;
  selected: boolean;
  tenantId: number;
  targetUsername: string;
  /** Account already created by an earlier run (object map), null = to create. */
  existingAccountId: number | null;
  packageKey: string;
  planId: number | null;
  suspended: boolean;
  domains: PlannedDomain[];
  sites: PlannedSite[];
  proxies: PlannedProxyHost[];
  dbInstance: PlannedDbInstance | null;
  databases: PlannedDatabase[];
  dbUsers: PlannedDbUser[];
  zones: PlannedZone[];
  mailDomains: PlannedMailDomain[];
  mailboxes: PlannedMailbox[];
  aliases: PlannedAlias[];
  dkim: PlannedDkimKey[];
  crons: PlannedCron[];
  certificates: PlannedCertificate[];
  ftp: PlannedFtpCredential | null;
  warnings: MigrationWarning[];
  followUps: MigrationFollowUp[];
  /** At least one 'blocking' warning: the account cannot be executed. */
  blocked: boolean;
  estimates: { filesBytes: number; dbBytes: number; mailBytes: number };
}

export interface MigrationPlanResult {
  computedAt: string;
  /** Hash of the choices the result was computed from (stale detection). */
  choicesHash: string;
  discoveryId: number;
  packages: PlannedPackage[];
  accounts: MigrationAccountPlan[];
  warnings: MigrationWarning[];
  followUps: MigrationFollowUp[];
  totals: { accounts: number; selected: number; blocked: number; filesBytes: number; dbBytes: number; mailBytes: number };
}

export type MigrationPlanStatus = 'draft' | 'active' | 'archived';

export interface MigrationPlanSummary {
  id: number;
  sourceId: number;
  discoveryId: number;
  name: string;
  status: MigrationPlanStatus;
  computedAt: string | null;
  /** Choices changed after the last compute. */
  stale: boolean;
  totals: MigrationPlanResult['totals'] | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationPlan extends MigrationPlanSummary {
  choices: MigrationPlanChoices;
  result: MigrationPlanResult | null;
}

export interface MigrationPlanCreate {
  discoveryId: number;
  name: string;
}

/** GET /targets — what the plan editor offers. */
export interface MigrationTargetCatalog {
  tenants: Array<{ id: number; name: string }>;
  plans: Array<{ id: number; tenantId: number; name: string; limits: PlanLimits }>;
  nodes: Array<{ id: number; name: string }>;
  bases: SiteBaseId[];
  dbVersions: Array<{ engine: DbEngine; version: string; nativeHashes: boolean }>;
  mailEngine: MailEngine | null;
  mailPasswordSchemes: MailPasswordScheme[];
  platformIpv4: string | null;
  platformIpv6: string | null;
  nameservers: string[];
  dnsEnabled: boolean;
}

// ─── RUNS ────────────────────────────────────────────────────────────────────

export type MigrationRunKind = 'initial' | 'resync' | 'final-sync';
export type MigrationResyncPart = 'files' | 'data' | 'databases' | 'maildirs';
export type MigrationRunStatus = 'queued' | 'running' | 'paused' | 'failed' | 'done' | 'cancelled';
export type MigrationStepStatus = 'pending' | 'running' | 'done' | 'warning' | 'skipped' | 'failed';

export interface MigrationRunRequest {
  /** CWP usernames (selected, not blocked, in the plan result). */
  accounts: string[];
  kind: MigrationRunKind;
  /** resync / final-sync: what to sync again (default: everything). */
  parts?: MigrationResyncPart[];
  /** resync: delete on the target what disappeared on the source (staging / maildirs before switch). Default false. */
  mirrorDeletes?: boolean;
}

export interface MigrationRun {
  id: number;
  planId: number;
  sourceId: number;
  cwpUsername: string;
  kind: MigrationRunKind;
  parts: MigrationResyncPart[];
  mirrorDeletes: boolean;
  status: MigrationRunStatus;
  targetTenantId: number;
  targetAccountId: number | null;
  currentStep: string | null;
  progress: { done: number; total: number; bytes: number | null };
  error: string | null;
  createdBy: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationRunStep {
  id: number;
  runId: number;
  key: string;
  provider: 'web-db' | 'mail-dns';
  phase: number;
  label: MigrationMessage;
  status: MigrationStepStatus;
  attempts: number;
  /** Target ids created / reused ({ siteId, domainIds… }). */
  result: Record<string, unknown> | null;
  warnings: MigrationWarning[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MigrationRunDetail extends MigrationRun {
  steps: MigrationRunStep[];
}

export type MigrationEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MigrationRunEvent {
  id: number;
  runId: number;
  stepKey: string | null;
  level: MigrationEventLevel;
  code: string;
  params: Record<string, string | number | boolean | null> | null;
  /** Free text (French), for details the codes do not cover (never a secret). */
  message: string | null;
  createdAt: string;
}

export interface MigrationAccountStatus {
  cwpUsername: string;
  targetAccountId: number | null;
  targetUsername: string | null;
  lastRun: MigrationRun | null;
  initialDone: boolean;
  lastSyncAt: string | null;
  cutover: { domains: number; switched: number };
}

export interface MigrationAccountReport {
  cwpUsername: string;
  targetAccountId: number | null;
  targetUsername: string | null;
  tenantId: number;
  generatedAt: string;
  runs: MigrationRun[];
  /** What exists on the target for this account (object map), per kind. */
  migrated: Array<{ kind: MigrationObjectKind; sourceKey: string; targetId: number; label: string }>;
  skipped: Array<{ scope: MigrationScope; reason: MigrationMessage }>;
  warnings: MigrationWarning[];
  followUps: MigrationFollowUp[];
}

export interface MigrationReport {
  planId: number;
  sourceId: number;
  generatedAt: string;
  accounts: MigrationAccountReport[];
  serverFollowUps: MigrationFollowUp[];
}

/** Kinds of the source → target object map (migration_object_map.kind). */
export type MigrationObjectKind =
  | 'plan' | 'account' | 'domain' | 'site' | 'dataPath' | 'runtime' | 'dbInstance' | 'database' | 'dbUser'
  | 'zone' | 'dnsRecord' | 'mailDomain' | 'mailbox' | 'alias' | 'dkimKey' | 'proxyHost' | 'cron' | 'certificate'
  | 'importedCertificate' | 'ftpCredential' | 'release';

// ─── CUTOVER ─────────────────────────────────────────────────────────────────

export type MigrationCutoverState = 'pending' | 'prepared' | 'synced' | 'switched' | 'rolled-back';

export type MigrationCutoverItemCode =
  | 'ttlLowered' | 'targetReady' | 'finalSync' | 'nsChanged' | 'aRecordsChanged' | 'mxChanged' | 'verified'
  | 'certificateIssued' | 'sourceDisabled';

export interface MigrationCutoverItem {
  code: MigrationCutoverItemCode;
  /** Checked by the staff (manual) or by a live check. */
  done: boolean;
  auto: boolean;
  checkedAt: string | null;
  /** Live check detail (resolved values, TTL seen…). */
  detail: Record<string, string | number | boolean | null> | null;
}

export interface MigrationCutoverDomain {
  id: number;
  planId: number;
  cwpUsername: string;
  fqdn: string;
  targetDomainId: number | null;
  /** The zone was migrated to our DNS (NS change at the registrar) vs records to change at the current DNS host. */
  mode: 'ns-delegation' | 'records';
  state: MigrationCutoverState;
  items: MigrationCutoverItem[];
  /** Records to set at the registrar / DNS host (mode 'records') or NS to delegate to (mode 'ns-delegation'). */
  instructions: Array<{ name: string; type: DnsRecordType; value: string; ttl: number | null }>;
  /** Live: TTL currently served by the source NS for the apex A / MX. */
  observedTtl: number | null;
  notes: string | null;
  switchedAt: string | null;
  updatedAt: string;
}

export interface MigrationCutoverUpdate {
  items?: Partial<Record<MigrationCutoverItemCode, boolean>>;
  notes?: string | null;
}

export interface MigrationCutoverSwitch {
  /** Must equal the fqdn (typed confirmation). */
  confirm: string;
}

// ─── SOCKET ──────────────────────────────────────────────────────────────────

/** HostingSocketEvents.MIGRATION_UPDATED — room role:admin only; ids only, clients refetch. */
export interface MigrationUpdatedPayload {
  entity: 'source' | 'discovery' | 'plan' | 'run' | 'step' | 'cutover';
  id: number;
  sourceId?: number | null;
  planId?: number | null;
  runId?: number | null;
  status?: string | null;
  progress?: { done: number; total: number } | null;
}
