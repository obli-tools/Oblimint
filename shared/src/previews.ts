import type { ScanSummary, SiteBaseId } from './hosting';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — live preview of a release or of the staging.
// The code of a release (or a scanned snapshot of the staging) runs in a
// throw-away container (role site-rpreview) on <host>.<previewDomain>, behind
// an access gate: data read-only, no database, no mail, secret env vars hidden.
// Never promoted, never live. At most ONE active preview per site.
// ─────────────────────────────────────────────────────────────────────────────

export type PreviewTarget = 'release' | 'staging';
export type PreviewStatus = 'building' | 'starting' | 'running' | 'failed' | 'stopping' | 'stopped';
export type PreviewStopReason = 'user' | 'expired' | 'replaced' | 'failed' | 'siteStopped' | 'suspended' | 'key' | 'siteDeleted';
export type PreviewEnvMode = 'public' | 'all';

export const PREVIEW_ACTIVE_STATUSES: readonly PreviewStatus[] = ['building', 'starting', 'running'];
/** Release statuses a preview can run (the live release is excluded by the UI only). */
export const PREVIEWABLE_RELEASE_STATUSES = ['awaiting_approval', 'ready', 'rejected', 'failed'] as const;

export interface PreviewOptions {
  env: PreviewEnvMode;
  allowBlockedScan: boolean;
}

export type PreviewWarningCode =
  | 'scanWarnings' | 'dataReadOnly' | 'ephemeralSkipped' | 'noDatabase' | 'secretsHidden'
  | 'noMail' | 'egressAllowed' | 'selfSignedCertificate' | 'notSegmented';

export interface SitePreview {
  id: number;
  siteId: number;
  accountId: number;
  target: PreviewTarget;
  releaseId: number | null;
  releaseNumber: number | null;
  commitSha: string | null;
  base: SiteBaseId;
  status: PreviewStatus;
  errorCode: string | null;
  error: string | null;
  host: string;
  /** https://<host>/ — opens only with the gate cookie (panel "Open" or a share link). */
  url: string;
  expiresAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: PreviewStopReason | null;
  createdAt: string;
  createdBy: { id: number; name: string } | null;
  createdByKey: { id: number; name: string } | null;
  options: PreviewOptions;
  scan: ScanSummary | null;
  warnings: PreviewWarningCode[];
}

/** One-shot share link: an interstitial page, consumed by its POST (10 min). */
export interface PreviewLink {
  url: string;
  expiresAt: string;
  kind: 'share';
}

/** Only with include_key (audited): send `header: value` to pass the gate without a cookie. */
export interface PreviewKey {
  header: string;
  value: string;
}

export interface PreviewStartRequest {
  target: PreviewTarget;
  releaseId?: number | null;
  ttlMinutes?: number;
  options?: Partial<PreviewOptions>;
}

export interface PreviewStartResult {
  preview: SitePreview;
  link: PreviewLink | null;
  key?: PreviewKey;
}

export interface PreviewFetchSide {
  status: number | null;
  error: 'timeout' | 'unreachable' | 'tooLarge' | 'protocol' | null;
  headers: Record<string, string>;
  location: string | null;
  setCookieNames: string[];
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  body: string | null;
  sha256: string | null;
  ms: number;
}

export interface PreviewFetchResult {
  path: string;
  host: string;
  preview: PreviewFetchSide;
  /** compare (sites.manage): the live PRIMARY container, the edge bypassed. */
  live?: PreviewFetchSide;
  sameStatus?: boolean;
  sameBody?: boolean;
}

export const PREVIEW_TTL_MINUTES = { min: 5, default: 60, max: 480 } as const;
export const PREVIEW_MAX_LIFETIME_MS = 24 * 3600_000;
export const PREVIEW_SHARE_LINK_TTL_MS = 10 * 60_000;
export const PREVIEW_OPEN_LINK_TTL_MS = 60_000;
export const previewCookieName = (previewId: number): string => `__Host-oblimint-pv-${previewId}`;
export const PREVIEW_KEY_HEADER = 'X-Oblimint-Preview-Key';
export const PREVIEW_CLAIM_PATH = '/__oblimint_preview/claim';
export const PREVIEW_FETCH_MAX_BYTES = 131_072;
export const PREVIEW_FETCH_MIN_BYTES = 1024;
export const PREVIEW_FETCH_DEFAULT_BYTES = 65_536;
/** A4: TEST-NET-1 — never private nor loopback (Require local / allow 127.0.0.1 guards stay closed). */
export const PREVIEW_FETCH_CLIENT_IP = '192.0.2.1';
export const PREVIEW_PATH_MAX = 2048;

/** Socket payload of HostingSocketEvents.PREVIEW_UPDATED. */
export interface PreviewUpdatedPayload {
  siteId: number;
  previewId: number;
  status: PreviewStatus;
}

/**
 * Path accepted by fetch / the claim redirect: 1..2048 chars, starts with '/',
 * no '//' prefix, no backslash, no '#', printable ASCII only (0x21-0x7e).
 */
export function isValidPreviewPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length < 1 || p.length > PREVIEW_PATH_MAX) return false;
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || p.includes('#')) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}
