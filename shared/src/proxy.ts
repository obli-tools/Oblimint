import type { CertificateStatus } from './hosting';

// =============================================================================
// Oblimint — P4b proxy hosts, redirections, dead hosts, streams, access lists,
// custom pages, forward-auth providers, imported certificates, edge units
// (docs/P4b-PLAN.md §6.3, §6.4, §7, §8). ARCHITECT FILE (frozen during the
// phase). Modules: proxy-hosts (server), edge-robustness (edge units),
// ui-proxy (client).
//
// Every proxy object belongs to ONE hosting account (streams may also belong
// to the platform). Its names are `domains` rows of that account, VERIFIED
// (P2 ownership), each bound to at most one consumer (sites routes, a proxy
// host, a redirection or a dead host: domains.served_by + edge_domain_bindings).
// Certificates: the domain certificates of P1/P2 (ACME HTTP-01 / DNS-01,
// wildcards) or an imported certificate.
// =============================================================================

export type ProxyTargetKind = 'app' | 'site' | 'external';
export type ProxyScheme = 'http' | 'https';

export interface ProxyTarget {
  kind: ProxyTargetKind;
  /** app: stack + service of the SAME account. */
  stackId?: number | null;
  service?: string | null;
  /** site: site of the SAME account (its primary container). */
  siteId?: number | null;
  /** external: public IPv4 / IPv6 / host name (plan proxyExternalTargets + tenant policy). */
  host?: string | null;
  port: number;
  scheme: ProxyScheme;
  /**
   * external only: the target may be a private / internal address (RFC 1918,
   * ULA, CGNAT, loopback-free). Settable by PLATFORM staff only (never the
   * platform's own Docker / panel ranges, even then).
   */
  allowPrivate?: boolean;
}

/** One domain bound to a proxy object (read). */
export interface ProxyBoundDomain {
  domainId: number;
  name: string;
  includeWww: boolean;
  wildcard: boolean;
  verified: boolean;
  /** Certificate of the domain (P1/P2), null = none yet. */
  certificate: { status: CertificateStatus; notAfter: string | null } | null;
}

export type ProxySslMode = 'auto' | 'imported' | 'none';

export interface ProxyHostSsl {
  /** auto = the domains' own certificates (ACME, domains.tls_mode letsencrypt); imported = importedCertificateId. */
  mode: ProxySslMode;
  importedCertificateId: number | null;
  forceSsl: boolean;
  http2: boolean;
  hsts: boolean;
  hstsSubdomains: boolean;
}

export interface ProxyHeaderRule {
  /** add = `add_header … always` on the response; remove = `proxy_hide_header` (response header of the upstream). */
  action: 'add' | 'remove';
  name: string;
  /** add only. */
  value: string;
}

export interface ProxyHostOptions {
  websocket: boolean;
  gzip: boolean;
  /** Cache of static assets (1 day, X-Cache-Status). */
  cache: boolean;
  /** CORS: '*' + OPTIONS 204 when corsOrigins is empty, else only those origins. */
  cors: boolean;
  corsOrigins: string[];
  /** null = platform default (settings edge.defaultBodySizeMb). */
  bodySizeMb: number | null;
  buffering: boolean;
  requestBuffering: boolean;
  connectTimeoutSec: number;
  sendTimeoutSec: number;
  readTimeoutSec: number;
  /** limit_req per client IP (nodelay). */
  rateLimit: { rps: number; burst: number } | null;
  headers: ProxyHeaderRule[];
  /** Extra request headers sent to the upstream (proxy_set_header). */
  upstreamHeaders: Array<{ name: string; value: string }>;
  /** Common exploit patterns answered 403 (SQLi / traversal / scanners, Oblihub list). */
  blockExploits: boolean;
  /** Host header sent upstream: the client's (default) or upstreamHostHeader. */
  preserveHost: boolean;
  upstreamHostHeader: string | null;
  /** https upstream: verify its certificate (default false for internal targets). */
  upstreamTlsVerify: boolean;
  /** custom_pages.id for the error codes (null = platform default page). */
  errorPageId: number | null;
  /** custom_pages.id shown while the target app stack wakes up (null = default). */
  wakingPageId: number | null;
  /** Activate even when the reachability probe of the upstream fails (docs §8.4). */
  skipUpstreamCheck: boolean;
}

export const DEFAULT_PROXY_HOST_OPTIONS: ProxyHostOptions = {
  websocket: true,
  gzip: true,
  cache: false,
  cors: false,
  corsOrigins: [],
  bodySizeMb: null,
  buffering: true,
  requestBuffering: true,
  connectTimeoutSec: 10,
  sendTimeoutSec: 60,
  readTimeoutSec: 60,
  rateLimit: null,
  headers: [],
  upstreamHeaders: [],
  blockExploits: true,
  preserveHost: true,
  upstreamHostHeader: null,
  upstreamTlsVerify: false,
  errorPageId: null,
  wakingPageId: null,
  skipUpstreamCheck: false,
};

export interface ProxyHostAuth {
  /** Access lists of the same account: UNION semantics (docs §8.6). */
  accessListIds: number[];
  /** Forward-auth provider (oauth2-proxy sidecar) of the same account, null = none. */
  authProviderId: number | null;
  /** Extra per-host restrictions on top of the provider's (AND). */
  allowedGroups: string[];
  /** Full addresses (with @) or domains. */
  allowedEmails: string[];
}

export interface ProxyHostHoneypot {
  enabled: boolean;
  /** Bait path prefixes (/wp-login.php, /.env…); a sub-route on the same path wins (the bait is ignored). */
  paths: string[];
  /** An IP refused by the host's IP access rules gets a 404 (disguise) and is banned. Never for basic-auth-only lists. */
  banAclViolations: boolean;
  /** null = escalation defaults of settings bans. */
  banDurationMinutes: number | null;
}

export type ProxyRouteAuthMode = 'inherit' | 'none';
export type ProxyRouteAccessMode = 'inherit' | 'none' | 'override';

export interface ProxyRoute {
  id: number;
  /** Incoming prefix, '/api/' form (leading + trailing slash) or an exact '/path'. */
  path: string;
  /** null = URI passed unchanged; else the prefix is replaced by this one. */
  rewritePrefix: string | null;
  target: ProxyTarget;
  authMode: ProxyRouteAuthMode;
  accessListMode: ProxyRouteAccessMode;
  /** override only. */
  accessListIds: number[];
  /** null = inherit the host option. */
  websocket: boolean | null;
  buffering: boolean | null;
  sortOrder: number;
}

export type ProxyRouteInput = Omit<ProxyRoute, 'id'> & { id?: number };

// ─── Edge units (module edge-robustness) ─────────────────────────────────────

/**
 * pending              not applied yet (first apply, retry scheduled);
 * active               the desired version is served;
 * quarantined          the desired version failed validation: the LAST GOOD version is served;
 * stub                 failed and no good version exists: a 503 page keeps the server names;
 * upstreamUnreachable  the reachability probe failed: previous version kept (or not activated yet);
 * disabled             the owner is disabled (a 503 stub keeps the names).
 */
export type EdgeUnitStatusKind = 'pending' | 'active' | 'quarantined' | 'stub' | 'upstreamUnreachable' | 'disabled';
export type EdgeUnitOwnerKind = 'site-domain' | 'platform' | 'contributed' | 'proxy-host' | 'redirection' | 'dead-host' | 'stream' | 'global';

export interface EdgeUnitUpstreamState {
  /** e.g. 'location /', 'route /api/', 'stream 5432/tcp'. */
  where: string;
  /** host:port (never a credential). */
  target: string;
  reachable: boolean | null;
  error: string | null;
}

export interface EdgeUnitState {
  unitId: string;
  ownerKind: EdgeUnitOwnerKind;
  ownerId: number | null;
  accountId: number | null;
  status: EdgeUnitStatusKind;
  /** nginx -t / lint / probe output (sanitized; generic label for a client, A6). */
  error: string | null;
  upstreams: EdgeUnitUpstreamState[];
  desiredHash: string | null;
  activeHash: string | null;
  checkedAt: string | null;
  appliedAt: string | null;
}

export type EdgeApplyResult = 'ok' | 'partial' | 'rolledBack' | 'failed' | 'skipped';

export interface EdgeApplyRecord {
  id: number;
  trigger: string;
  result: EdgeApplyResult;
  unitsTotal: number;
  unitsChanged: number;
  unitsQuarantined: number;
  canary: { ok: boolean; checked: number; failures: Array<{ host: string; status: number | null; error: string | null }> } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** POST /api/proxy/advanced-config/lint (staff) — also run at save and at apply. */
export interface AdvancedConfigLintResult {
  ok: boolean;
  issues: Array<{ line: number; directive: string | null; code: 'forbiddenDirective' | 'unbalancedBraces' | 'forbiddenPath' | 'tooLong' | 'syntax'; message: string }>;
}

// ─── Proxy hosts ─────────────────────────────────────────────────────────────

export interface ProxyHost {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  name: string;
  enabled: boolean;
  domains: ProxyBoundDomain[];
  target: ProxyTarget;
  /** Readable label of the target (stack/service, site name, host:port). */
  targetLabel: string;
  ssl: ProxyHostSsl;
  options: ProxyHostOptions;
  auth: ProxyHostAuth;
  honeypot: ProxyHostHoneypot;
  routes: ProxyRoute[];
  /** Staff only (null for a client, who only sees hasAdvancedConfig). */
  advancedConfig: string | null;
  hasAdvancedConfig: boolean;
  autoMonitor: boolean;
  monitorId: number | null;
  edge: EdgeUnitState | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHostInput {
  accountId: number;
  name: string;
  enabled?: boolean;
  domainIds: number[];
  target: ProxyTarget;
  ssl?: Partial<ProxyHostSsl>;
  options?: Partial<ProxyHostOptions>;
  auth?: Partial<ProxyHostAuth>;
  honeypot?: Partial<ProxyHostHoneypot>;
  routes?: ProxyRouteInput[];
  /** Platform staff only (settings edge.allowAdvancedConfig), linted. */
  advancedConfig?: string | null;
  autoMonitor?: boolean;
}

export type ProxyHostUpdate = Partial<Omit<ProxyHostInput, 'accountId'>>;

/** POST /proxy/hosts/quick-setup — from an app stack. */
export interface ProxyQuickSetupRequest {
  stackId: number;
  service: string;
  port: number;
  domainIds: number[];
  /** Turn letsencrypt on for the domains (domains.tls_mode). Default true. */
  letsencrypt?: boolean;
  autoMonitor?: boolean;
}

// ─── Redirections / dead hosts ───────────────────────────────────────────────

export interface ProxyRedirection {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  enabled: boolean;
  domains: ProxyBoundDomain[];
  /** 'auto' = the scheme of the request. */
  targetScheme: 'http' | 'https' | 'auto';
  targetDomain: string;
  targetPath: string | null;
  /** Append $request_uri. */
  preservePath: boolean;
  statusCode: 301 | 302 | 307 | 308;
  ssl: { forceSsl: boolean; http2: boolean; hsts: boolean };
  edge: EdgeUnitState | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyRedirectionInput {
  accountId: number;
  enabled?: boolean;
  domainIds: number[];
  targetScheme?: 'http' | 'https' | 'auto';
  targetDomain: string;
  targetPath?: string | null;
  preservePath?: boolean;
  statusCode?: 301 | 302 | 307 | 308;
  ssl?: Partial<{ forceSsl: boolean; http2: boolean; hsts: boolean }>;
}

export type ProxyRedirectionUpdate = Partial<Omit<ProxyRedirectionInput, 'accountId'>>;

export interface ProxyDeadHost {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  enabled: boolean;
  domains: ProxyBoundDomain[];
  ssl: { forceSsl: boolean; http2: boolean };
  /** custom page for the 404 (null = platform default). */
  customPageId: number | null;
  edge: EdgeUnitState | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyDeadHostInput {
  accountId: number;
  enabled?: boolean;
  domainIds: number[];
  ssl?: Partial<{ forceSsl: boolean; http2: boolean }>;
  customPageId?: number | null;
}

export type ProxyDeadHostUpdate = Partial<Omit<ProxyDeadHostInput, 'accountId'>>;

// ─── Streams (TCP / UDP, platform-approved ports, staff) ─────────────────────

export interface ProxyStream {
  id: number;
  tenantId: number;
  /** null = platform stream. */
  accountId: number | null;
  accountUsername: string | null;
  name: string;
  enabled: boolean;
  /** One of settings edge.streamPorts (published by the edge). */
  incomingPort: number;
  tcp: boolean;
  udp: boolean;
  /** kind app (same account) or external. */
  target: ProxyTarget;
  edge: EdgeUnitState | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyStreamInput {
  accountId: number | null;
  name: string;
  enabled?: boolean;
  incomingPort: number;
  tcp?: boolean;
  udp?: boolean;
  target: ProxyTarget;
}

export type ProxyStreamUpdate = Partial<Omit<ProxyStreamInput, 'accountId'>>;

// ─── Access lists ────────────────────────────────────────────────────────────

export interface AccessListRule {
  action: 'allow' | 'deny';
  /** IPv4 / IPv6 address or CIDR ('all' is not accepted: use an empty allow list). */
  cidr: string;
}

export interface AccessList {
  id: number;
  tenantId: number;
  accountId: number;
  name: string;
  /** satisfy any: IP rule OR password is enough (else both when both exist). */
  satisfyAny: boolean;
  /** Pass the Authorization header to the upstream. */
  passAuth: boolean;
  rules: AccessListRule[];
  /** Basic-auth users (password hashes never returned). */
  users: Array<{ username: string }>;
  /** Proxy hosts / routes using it. */
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccessListUserInput {
  username: string;
  /** Required for a new user; absent = keep the current password (rename via previousUsername). */
  password?: string;
  previousUsername?: string;
}

export interface AccessListInput {
  accountId: number;
  name: string;
  satisfyAny?: boolean;
  passAuth?: boolean;
  rules?: AccessListRule[];
  /** Full list (users absent from it are removed). */
  users?: AccessListUserInput[];
}

export type AccessListUpdate = Partial<Omit<AccessListInput, 'accountId'>>;

// ─── Custom pages ────────────────────────────────────────────────────────────

export const CUSTOM_PAGE_CODES = [400, 401, 403, 404, 500, 502, 503, 504] as const;
export type CustomPageCode = typeof CUSTOM_PAGE_CODES[number];
/** Placeholders replaced at render time (escaped HTML). */
export const CUSTOM_PAGE_PLACEHOLDERS = ['{{CODE}}', '{{MESSAGE}}', '{{APP_NAME}}', '{{PROXY_HOST_ID}}', '{{HOST}}', '{{WAKE_ETA_SEC}}'] as const;

export interface CustomPage {
  id: number;
  tenantId: number;
  /** null = platform page (staff), usable by every account of the tenant (or of the platform: tenant 1). */
  accountId: number | null;
  name: string;
  description: string | null;
  codes: CustomPageCode[];
  html: string;
  theme: 'obli' | 'light' | 'dark' | 'custom';
  /** Waking page (sleeping app): polls and reloads; placeholders {{WAKE_ETA_SEC}}. */
  isWakingPage: boolean;
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomPageInput {
  accountId: number | null;
  name: string;
  description?: string | null;
  codes?: CustomPageCode[];
  /** ≤ 256 KiB; no server-side include, rendered as a static file. */
  html: string;
  theme?: CustomPage['theme'];
  isWakingPage?: boolean;
}

export type CustomPageUpdate = Partial<Omit<CustomPageInput, 'accountId'>>;

/** POST /proxy/custom-pages/preview */
export interface CustomPagePreviewRequest {
  html: string;
  code: number;
  host?: string;
}

// ─── Forward-auth providers (Azure AD, oauth2-proxy sidecar) ─────────────────

export interface AuthProvider {
  id: number;
  tenantId: number;
  accountId: number;
  name: string;
  kind: 'azure-ad';
  azureTenantId: string;
  clientId: string;
  hasSecret: boolean;
  allowedEmailDomains: string[];
  allowedGroups: string[];
  /** Callback URLs to register in Azure: https://<each protected domain>/oauth2/callback. */
  redirectUris: string[];
  /** Sidecar container state. */
  sidecar: { deployed: boolean; running: boolean; detail: string | null };
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthProviderInput {
  accountId: number;
  name: string;
  azureTenantId: string;
  clientId: string;
  /** Required at creation; absent = keep. Sealed (secretBox 'proxy-auth'). */
  clientSecret?: string;
  allowedEmailDomains?: string[];
  allowedGroups?: string[];
}

export type AuthProviderUpdate = Partial<Omit<AuthProviderInput, 'accountId'>>;

// ─── Certificates ────────────────────────────────────────────────────────────

export interface ImportedCertificate {
  id: number;
  tenantId: number;
  accountId: number;
  name: string;
  names: string[];
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportedCertificateInput {
  accountId: number;
  name: string;
  certificatePem: string;
  /** Sealed (secretBox 'proxy-cert'), never returned. */
  privateKeyPem: string;
  chainPem?: string | null;
}

/** GET /proxy/certificates — every certificate visible (ACME rows of the domains + imported). */
export interface CertificateListItem {
  kind: 'acme' | 'imported';
  id: number;
  tenantId: number;
  accountId: number | null;
  accountUsername: string | null;
  primaryName: string;
  names: string[];
  status: CertificateStatus;
  issuer: string | null;
  notAfter: string | null;
  lastError: string | null;
  domainId: number | null;
  usedBy: Array<{ kind: 'site-domain' | 'proxy-host' | 'redirection' | 'dead-host' | 'workflow'; id: number; name: string }>;
}

// ─── Socket.io (payloads: ids only) ──────────────────────────────────────────

/** HostingSocketEvents.PROXY_UPDATED */
export interface ProxyUpdatedPayload {
  entity: 'host' | 'redirection' | 'deadHost' | 'stream' | 'accessList' | 'customPage' | 'authProvider' | 'certificate' | 'edgeUnit';
  id: number | string;
  accountId: number | null;
  action: 'created' | 'updated' | 'deleted' | 'status';
}
