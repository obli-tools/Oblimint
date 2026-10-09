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

export const LABELS = {
  internal: 'oblimint.internal',
  account: 'oblimint.account',
  site: 'oblimint.site',
  runtime: 'oblimint.runtime',
  role: 'oblimint.role',
  /** sha256 of the normalized create spec: drift → recreate (reconcile). */
  specHash: 'oblimint.spec-hash',
} as const;

export type ContainerRole = 'site' | 'site-secondary' | 'site-preview' | 'filesrv' | 'edge' | 'hostd' | 'panel-postgres'
  // P2
  | 'db' | 'pdns' | 'dbadmin'
  // P3: shared scanner (panel network), ephemeral adapter tools container (account networks)
  | 'scanner' | 'tools';

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
export const EXTERNALLY_MANAGED_ROLES: readonly ContainerRole[] = ['db', 'tools'];

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

/** Blue/green preview host on the dedicated preview domain (P2): <slug>-<id>.<previewDomain>. */
export function previewHost(site: { id: number; slug: string }, previewDomain: string): string {
  return `${site.slug}-${site.id}.${previewDomain.toLowerCase()}`;
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
