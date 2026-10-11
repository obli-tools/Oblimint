import type { AppMaintenanceSchedule } from './monitoring';

// ─────────────────────────────────────────────────────────────────────────────
// Platform updates (Nodes > Updates): the images of the platform components of
// a node (panel, hostd, edge, filesrv, pdns, scanner, mail, webmail, dbadmin,
// site bases / tools in use) compared with the registry digest of the
// configured tag (OBLIMINT_IMAGE_TAG), and the update runs that pull them and
// recreate the containers through the reconcile / infra code paths.
// Platform administrator on the master tenant only.
// ─────────────────────────────────────────────────────────────────────────────

export type PlatformComponentKind =
  | 'panel' | 'hostd' | 'edge' | 'filesrv' | 'dns' | 'scanner' | 'mail' | 'mail-relay' | 'webmail' | 'dbadmin' | 'site-base' | 'tools';

/** Order of the kinds on screen and in an update run (panel always last). */
export const PLATFORM_COMPONENT_KINDS: readonly PlatformComponentKind[] = [
  'hostd', 'edge', 'dns', 'scanner', 'mail', 'mail-relay', 'webmail', 'dbadmin', 'filesrv', 'site-base', 'tools', 'panel',
];

export type PlatformImageGroup = 'platform' | 'sites' | 'tools';

export type PlatformUpdateStatus =
  | 'unchecked'        // never compared with the registry
  | 'upToDate'         // local digest = remote digest, every container runs it
  | 'updateAvailable'  // the registry serves another digest for the tag
  | 'pendingRecreate'  // pulled, some containers still run the previous image
  | 'updating'         // in the current run
  | 'failed'           // the last run failed for this image
  | 'unknown';         // registry unreachable / no local digest (local build)

export interface PlatformImageStatus {
  /** Image reference the containers are created from (repository:tag). */
  image: string;
  kind: PlatformComponentKind;
  group: PlatformImageGroup;
  /** Containers of the node created from this reference. */
  containers: string[];
  /** Containers running an older image than the local one (pulled, not recreated yet). */
  outdatedContainers: string[];
  /** Local image id (sha256:…) of the reference, null when the image is missing locally. */
  localImageId: string | null;
  /** Registry digest the local image was pulled with (RepoDigests), null for a local build. */
  localDigest: string | null;
  /** org.opencontainers.image.version of the local image. */
  version: string | null;
  /** Digest the registry serves for the tag (last check). */
  remoteDigest: string | null;
  status: PlatformUpdateStatus;
  /** Last check / run error (French, short). */
  error: string | null;
  checkedAt: string | null;
}

export interface PlatformUpdatePolicy {
  /** Periodic registry checks. */
  autoCheck: boolean;
  /** Minutes between two checks (min 30). */
  checkIntervalMin: number;
  /** Apply updates automatically inside the window (off by default). Never the site containers. */
  autoUpdate: boolean;
  /** Maintenance window of the automatic updates (null = automatic updates never run). */
  window: AppMaintenanceSchedule | null;
  /** Notify (update available / applied / failed). */
  notify: boolean;
}

export const DEFAULT_PLATFORM_UPDATE_POLICY: PlatformUpdatePolicy = {
  autoCheck: true,
  checkIntervalMin: 720,
  autoUpdate: false,
  window: { days: [0], start: '03:00', durationMinutes: 120, timezone: 'UTC' },
  notify: true,
};

export type PlatformUpdateRunStatus = 'running' | 'succeeded' | 'failed' | 'rolledBack';
export type PlatformUpdateTrigger = 'manual' | 'auto' | 'forced';

export interface PlatformUpdateRun {
  id: string;
  nodeId: number;
  trigger: PlatformUpdateTrigger;
  /** Image references targeted (empty = every image with an update). */
  images: string[];
  redeploySites: boolean;
  status: PlatformUpdateRunStatus;
  /** Current step (French, short). */
  step: string | null;
  log: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  userId: number | null;
}

export interface PlatformUpdatesState {
  nodeId: number;
  /** OBLIMINT_IMAGE_TAG. */
  tag: string;
  images: PlatformImageStatus[];
  checkedAt: string | null;
  checking: boolean;
  run: PlatformUpdateRun | null;
  lastRun: PlatformUpdateRun | null;
  policy: PlatformUpdatePolicy;
  /** The automatic window is open now / next opening. */
  windowOpen: boolean;
  nextWindowAt: string | null;
  summary: PlatformUpdatesSummary;
}

export interface PlatformUpdatesSummary {
  nodeId: number;
  available: number;
  failed: number;
  updating: boolean;
  checkedAt: string | null;
}

export interface PlatformUpdateRequest {
  /** Image references to update (absent / empty = every image with an update). */
  images?: string[];
  /** Also recreate the site / file server containers running an older site base image. */
  redeploySites?: boolean;
}

/** HostingSocketEvents.PLATFORM_UPDATES */
export interface PlatformUpdatesEvent {
  nodeId: number;
  kind: 'state' | 'log';
  line?: string;
  runId?: string | null;
}
