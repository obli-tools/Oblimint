// ─── PHP ERRORS GROUPED BY RELEASE ───────────────────────────────────────────
//
// The panel reads the stderr of the live site containers (primary and
// secondaries) every minute, keeps the PHP errors / warnings / fatals and the
// refusals of the immutable model (guard, oblimint_exec, read-only code),
// groups them by fingerprint (level + normalized message + file:line relative
// to the release) and attributes each occurrence to the release that served
// it (the release number in the path, otherwise the release live at that
// time). Bounded storage: SITE_ERROR_RETENTION_DAYS, SITE_ERROR_MAX_GROUPS per
// site, one masked sample (message + stack) per group.

export type SiteErrorLevel = 'fatal' | 'parse' | 'warning' | 'notice' | 'deprecated';

/**
 * Errors explained by the immutable model:
 *  readOnlyWrite  the code wrote into the release (read-only): declare the
 *                 folder as a data path (add_data_path);
 *  execRefused    PHP refused to run a script outside the release (guard /
 *                 oblimint_exec): a data path or /tmp never runs code.
 */
export type SiteErrorClass = 'readOnlyWrite' | 'execRefused';

export const SITE_ERROR_RETENTION_DAYS = 30;
export const SITE_ERROR_MAX_GROUPS = 500;
export const SITE_ERROR_LIST_MAX = 200;

export interface SiteErrorGroup {
  id: number;
  siteId: number;
  /** Release that served the occurrences (null: unknown or deleted since). */
  releaseId: number | null;
  /** Its number (0: unknown). */
  releaseNumber: number;
  fingerprint: string;
  level: SiteErrorLevel;
  errorClass: SiteErrorClass | null;
  /** Message without its location, release paths made relative, sensitive values masked. */
  message: string;
  /** File relative to the release (absolute when outside it), null when PHP gave none. */
  file: string | null;
  line: number | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Container role of the last occurrence: primary | secondary-<id>. */
  container: string | null;
  /** First time this fingerprint appears in a known release of the site. */
  newInRelease: boolean;
  /** What to do, for the classes of the immutable model (English, for agents). */
  hint: string | null;
}

export interface SiteErrorGroupDetail extends SiteErrorGroup {
  /** Last occurrence: message and stack trace (masked, cut at 8 KB). */
  sample: string;
  sampleAt: string;
  /** Same fingerprint in the other releases of the site, newest first. */
  otherReleases: Array<{ groupId: number; releaseId: number | null; releaseNumber: number; count: number; lastSeen: string }>;
}

export interface SiteErrorReleaseSummary {
  releaseId: number | null;
  releaseNumber: number;
  groups: number;
  occurrences: number;
  fatals: number;
  newGroups: number;
  lastSeen: string;
  live: boolean;
}

/** GET /api/sites/:id/errors · /api/v1/sites/:id/errors */
export interface SiteErrorList {
  siteId: number;
  liveReleaseId: number | null;
  liveReleaseNumber: number | null;
  /** Releases that have errors, newest first (at most 20). */
  releases: SiteErrorReleaseSummary[];
  groups: SiteErrorGroup[];
  /** Groups matching the filters (groups holds at most `limit`). */
  total: number;
  /** Last collection of the site's container logs (null: never yet). */
  collectedAt: string | null;
}
