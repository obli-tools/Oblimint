import { siteBaseDef, SITE_CONTAINER_PORT, type SiteBaseId } from '@oblimint/shared';
import { config } from '../../config';

// Docker object names and labels (docs/P1-PLAN.md §Conteneurs). Every module
// that names a container / network goes through this file.

/** Panel network created by the setup wizard (panel + its PostgreSQL + edge + hostd). */
export const PANEL_NETWORK = 'oblimint';
/** DNS alias of the panel container on every account network (file-server hooks, healthchecks). */
export const PANEL_ALIAS = 'oblimint-panel';
export const EDGE_CONTAINER = 'oblimint-edge';
export const HOSTD_CONTAINER = 'oblimint-hostd';

export const accountNetwork = (accountId: number): string => `oblimint-acct-${accountId}`;
/**
 * P2 — database network of an account (ARCHITECTURE §3.6): its database
 * instances + its site containers (TCP db-<id>) + phpMyAdmin / Adminer during
 * an SSO session. NEVER the edge (which joins every account network) nor the
 * panel (SQL runs through docker exec): an edge compromise must not reach the
 * tenants' databases.
 */
export const accountDbNetwork = (accountId: number): string => `oblimint-acct-${accountId}-db`;
/** Account networks (main or database) by name, e.g. for sweeps. */
export const ACCOUNT_NETWORK_RE = /^oblimint-acct-\d+(?:-db)?$/;

export const siteContainer = (siteId: number): string => `oblimint-site-${siteId}`;
export const secondaryContainer = (siteId: number, runtimeId: number): string => `oblimint-site-${siteId}-rt-${runtimeId}`;
export const previewContainer = (siteId: number): string => `oblimint-site-${siteId}-preview`;
export const fileServerContainer = (accountId: number): string => `oblimint-files-${accountId}`;
/**
 * Release / staging preview container (feature B): ONE per preview, so a stale
 * edge vhost (pv-<old id>, kept as last valid version) can never reach the
 * container of the next preview (502).
 */
export const releasePreviewContainer = (siteId: number, previewId: number): string => `oblimint-site-${siteId}-rpv-${previewId}`;
export const releasePreviewUpstream = (siteId: number, previewId: number): string =>
  `http://${releasePreviewContainer(siteId, previewId)}:${SITE_CONTAINER_PORT}`;

export const LABELS = {
  internal: 'oblimint.internal',
  account: 'oblimint.account',
  site: 'oblimint.site',
  runtime: 'oblimint.runtime',
  role: 'oblimint.role',
  /** sha256 of the normalized create spec: drift → recreate (reconcile). */
  specHash: 'oblimint.spec-hash',
  /** site_previews.id of a release / staging preview container (role site-rpreview). */
  preview: 'oblimint.preview',
} as const;

export type ContainerRole = 'site' | 'site-secondary' | 'site-preview'
  // Feature B: release / staging preview (sandbox, never restarted, never reloaded by a publication)
  | 'site-rpreview'
  | 'filesrv' | 'edge' | 'hostd' | 'panel-postgres'
  // P2
  | 'db' | 'pdns' | 'dbadmin'
  // P3: shared scanner (panel network), ephemeral adapter tools container (account networks)
  | 'scanner' | 'tools'
  // P4: mail engine containers (label oblimint.mail-part tells which), site relay, webmail
  | 'mail' | 'mail-relay' | 'webmail'
  // P4b: app containers (stacks), forward-auth sidecars (oauth2-proxy + redis)
  | 'app' | 'proxy-auth';

// ── P2 (docs/P2-PLAN.md §Conteneurs) ─────────────────────────────────────────

/** Database instance of an account (label oblimint.account + oblimint.db-instance, role db). */
export const dbInstanceContainer = (instanceId: number): string => `oblimint-db-${instanceId}`;
/** DNS alias of a database instance on the account database network (TCP access from the sites). */
export const dbInstanceAlias = (instanceId: number): string => `db-${instanceId}`;
/** Shared PowerDNS Authoritative (panel network; host port 53 tcp/udp). */
export const PDNS_CONTAINER = 'oblimint-pdns';
/** Shared DB admin UIs (panel network; reached through the edge on settings dbAdmin.hostname). */
export const PHPMYADMIN_CONTAINER = 'oblimint-phpmyadmin';
export const ADMINER_CONTAINER = 'oblimint-adminer';

export const P2_LABELS = {
  /** Database instance id (role db). */
  dbInstance: 'oblimint.db-instance',
  /**
   * Account id of an account DATABASE network. Deliberately NOT oblimint.account:
   * the edge is attached to every network carrying that label (infra.service).
   */
  dbNetwork: 'oblimint.db-network',
} as const;

/**
 * Roles carrying oblimint.account=<id> that the account reconcile planner
 * must NEVER remove as orphans: their owning module converges them itself
 * (databases: db). destroyAccount still removes them (label oblimint.account).
 */
export const EXTERNALLY_MANAGED_ROLES: readonly ContainerRole[] = ['db', 'tools', 'app'];

// ── P3 (docs/P3-PLAN.md §Conteneurs) ─────────────────────────────────────────

/** Shared change scanner: ClamAV daemon + YARA + scand HTTP API (panel network only, no published port). */
export const SCANNER_CONTAINER = 'oblimint-scanner';
export const scannerImage = (): string => `${config.hosting.scannerImage}:${config.hosting.imageTag}`;
/** Ephemeral tools container of one adapter step (labels oblimint.account + oblimint.adapter-run, role tools). */
export const toolsContainer = (runId: number, step: string): string => `oblimint-tools-${runId}-${step.replace(/[^a-z0-9-]/g, '')}`;
/** Tools image for a PHP version ('8.3' → meejay/oblimint-tools-php8.3:latest). */
export const toolsImage = (php: string): string => `${config.hosting.toolsImagePrefix}${php}:${config.hosting.imageTag}`;

export const P3_LABELS = {
  /** adapter_runs.id of a tools container (role tools). */
  adapterRun: 'oblimint.adapter-run',
} as const;

// ── P4 (docs/P4-PLAN.md §4) ─────────────────────────────────────────────────

/**
 * Mail network: the engine containers, rspamd / redis, the site relay, the
 * webmail; the edge (webmail vhosts) and the panel (internal hooks, alias
 * oblimint-panel) are attached to it; the scanner too when the postfix engine
 * uses ClamAV. NEVER the panel PostgreSQL network members otherwise; NEVER a
 * tenant site (sites reach the relay on their own account network).
 */
export const MAIL_NETWORK = 'oblimint-mail';
/** Main engine container (postfix + dovecot, or stalwart): publishes the public mail ports. */
export const MAIL_CONTAINER = 'oblimint-mail';
/** postfix-dovecot only. */
export const MAIL_RSPAMD_CONTAINER = 'oblimint-mail-rspamd';
export const MAIL_REDIS_CONTAINER = 'oblimint-mail-redis';
/** Site relay of PHP mail(): joins the mail network AND every account network (alias MAIL_RELAY_ALIAS). */
export const MAIL_RELAY_CONTAINER = 'oblimint-mail-relay';
/** DNS name of the relay seen from the site containers (msmtp host). */
export const MAIL_RELAY_ALIAS = 'oblimint-mail-relay';
/** SMTP port of the relay on the account networks (AUTH required, no TLS inside the Docker network). */
export const MAIL_RELAY_PORT = 2525;
/** Shared webmail (Roundcube or SnappyMail, one at a time), reached by the edge on WEBMAIL_PORT. */
export const WEBMAIL_CONTAINER = 'oblimint-webmail';
export const WEBMAIL_PORT = 8080;

export const P4_LABELS = {
  /** Which part of the mail service a container is: engine | rspamd | redis | relay | webmail. */
  mailPart: 'oblimint.mail-part',
} as const;

export const mailPostfixImage = (): string => `${config.hosting.mailPostfixImage}:${config.hosting.imageTag}`;
export const mailRspamdImage = (): string => `${config.hosting.mailRspamdImage}:${config.hosting.imageTag}`;
/** Official image, pinned by tag in the configuration (no Oblimint tag). */
export const mailRedisImage = (): string => config.hosting.mailRedisImage;
export const mailStalwartImage = (): string => `${config.hosting.mailStalwartImage}:${config.hosting.imageTag}`;
export const mailRelayImage = (): string => `${config.hosting.mailRelayImage}:${config.hosting.imageTag}`;
export const webmailImage = (kind: 'roundcube' | 'snappymail'): string =>
  `${kind === 'roundcube' ? config.hosting.roundcubeImage : config.hosting.snappymailImage}:${config.hosting.imageTag}`;
/**
 * clamd TCP port of the shared scanner (P3) on the MAIL network, opened only
 * when the postfix-dovecot engine uses ClamAV (module engine-postfix: scanner
 * env OBLIMINT_CLAMD_TCP=1 + attachment to MAIL_NETWORK).
 */
export const SCANNER_CLAMD_PORT = 3310;
/** SASL user of a site on the relay. */
export const siteRelayUsername = (siteId: number): string => `site-${siteId}`;

/** Blue/green preview host on the dedicated preview domain (P2): <slug>-<id>.<previewDomain>. */
export function previewHost(site: { id: number; slug: string }, previewDomain: string): string {
  return `${site.slug}-${site.id}.${previewDomain.toLowerCase()}`;
}

const DNS_LABEL_MAX = 63;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Feature B — host of a release / staging preview on the preview domain:
 * <slugpart>-<siteId>-r<n>-pv.<previewDomain> (release n) or
 * <slugpart>-<siteId>-s-pv.<previewDomain> (staging). Ends with "-pv": never
 * collides with the blue/green host (<slug>-<id>, ends with digits). Unique per
 * (site, target) since the site id is in it, whatever the slug truncation; one
 * DNS label (≤ 63 chars, no "--"), so the wildcard *.previewDomain covers it.
 * null when the result is not a valid host name.
 */
export function releasePreviewHost(site: { id: number; slug: string }, target: { kind: 'release'; number: number } | { kind: 'staging' },
  previewDomain: string): string | null {
  const suffix = target.kind === 'release' ? `-${site.id}-r${Math.trunc(target.number)}-pv` : `-${site.id}-s-pv`;
  let slug = String(site.slug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '');
  slug = slug.slice(0, Math.max(0, DNS_LABEL_MAX - suffix.length)).replace(/-+$/, '');
  if (!slug) slug = 'site';
  const label = `${slug}${suffix}`.slice(0, DNS_LABEL_MAX);
  const host = `${label}.${previewDomain.trim().toLowerCase().replace(/\.$/, '')}`;
  return HOST_RE.test(host) && label.length <= DNS_LABEL_MAX ? host : null;
}

/** Image reference of a site base: OBLIMINT_SITE_IMAGE_PREFIX + base id + OBLIMINT_IMAGE_TAG. */
export function siteImage(base: SiteBaseId): string {
  return `${config.hosting.siteImagePrefix}${siteBaseDef(base).id}:${config.hosting.imageTag}`;
}

export const edgeImage = (): string => `${config.hosting.edgeImage}:${config.hosting.imageTag}`;
export const hostdImage = (): string => `${config.hosting.hostdImage}:${config.hosting.imageTag}`;
export const fileServerImage = (): string => `${config.hosting.filesrvImage}:${config.hosting.imageTag}`;

/** Upstream URL of one container of a site (edge proxy_pass, panel healthcheck). */
export function siteUpstream(siteId: number, role: 'primary' | 'secondary' | 'preview' = 'primary', runtimeId?: number | null): string {
  const name = role === 'secondary' ? secondaryContainer(siteId, Number(runtimeId)) : role === 'preview' ? previewContainer(siteId) : siteContainer(siteId);
  return `http://${name}:${SITE_CONTAINER_PORT}`;
}

/**
 * P1 preview host name: <slug>-<id>.preview.<panel hostname>. DEPRECATED in P2
 * (audit R-SAMESITE): previews move to settings preview.previewDomain —
 * previewHost() / platformSettings.previewHostFor(). Kept only until the
 * edge-ownership module switched every caller.
 */
export function previewHostname(site: { id: number; slug: string }, panelHostname: string): string {
  return `${site.slug}-${site.id}.preview.${panelHostname.toLowerCase()}`;
}

// ── P4b (docs/P4b-PLAN.md §4, §5, §8) ────────────────────────────────────────

/**
 * App containers: oblimint-app-<stackId>-<service> (service names are
 * validated [a-z0-9][a-z0-9_-]{0,62} by apps-core; the Docker name never uses
 * the stack slug). Labels: oblimint.internal, oblimint.account, oblimint.app,
 * oblimint.app-service, oblimint.role=app.
 */
export const appContainer = (stackId: number, service: string): string => `oblimint-app-${stackId}-${service.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
/** DNS alias of an app service on the account FRONT / BACK fabric (edge upstream, link target): app-<stackId>-<service>. */
export const appServiceAlias = (stackId: number, service: string): string => `app-${stackId}-${service.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
/** Private network of a stack: oblimint-app-<stackId>-<compose network name> (panel-allocated subnet, label oblimint.app-network). */
export const appPrivateNetwork = (stackId: number, name: string): string => `oblimint-app-${stackId}-${name.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
/** Named volume of a stack (local driver, bind to accounts/<id>/apps/<stackId>/volumes/<name>). */
export const appVolume = (stackId: number, name: string): string => `oblimint-app-${stackId}-${name.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
/** Image built from a stack's source: oblimint-build/<stackId>-<service>:<deployment id>. */
export const appBuildImage = (stackId: number, service: string, tag: string): string =>
  `oblimint-build/${stackId}-${service.toLowerCase().replace(/[^a-z0-9_-]/g, '')}:${tag}`;

/** Forward-auth: oauth2-proxy sidecar of one provider + their shared Redis, on AUTH_NETWORK with the edge. */
export const AUTH_NETWORK = 'oblimint-auth';
export const authSidecarContainer = (providerId: number): string => `oblimint-oauth2-${providerId}`;
export const AUTH_SIDECAR_PORT = 4180;
export const AUTH_REDIS_CONTAINER = 'oblimint-auth-redis';

export const P4B_LABELS = {
  /** app_stacks.id of an app container / volume / private network. */
  app: 'oblimint.app',
  /** Compose service name of an app container. */
  appService: 'oblimint.app-service',
  /** app_stacks.id of a PRIVATE app network (never oblimint.account: the edge joins those). */
  appNetwork: 'oblimint.app-network',
  /** front | back on an account fabric created by the segmentation module. */
  fabric: 'oblimint.fabric',
  /** auth_providers.id of an oauth2-proxy sidecar. */
  authProvider: 'oblimint.auth-provider',
} as const;

export const oauth2ProxyImage = (): string => config.hosting.oauth2ProxyImage;
export const authRedisImage = (): string => config.hosting.mailRedisImage;
