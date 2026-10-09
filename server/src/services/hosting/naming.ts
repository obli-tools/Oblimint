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

export type ContainerRole = 'site' | 'site-secondary' | 'site-preview' | 'filesrv' | 'edge' | 'hostd' | 'panel-postgres';

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

/** Blue/green preview host name: <slug>-<id>.preview.<panel hostname>. */
export function previewHostname(site: { id: number; slug: string }, panelHostname: string): string {
  return `${site.slug}-${site.id}.preview.${panelHostname.toLowerCase()}`;
}
