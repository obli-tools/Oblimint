// =============================================================================
// Oblimint — anti brute force of the CMS logins, read from the edge access log
// (server/src/services/security/cmsGuard/). The edge already logs every request
// of a site with its site / account / tenant: repeated failed logins on the
// login URLs of the common CMS (WordPress, Joomla, Drupal, PrestaShop,
// phpMyAdmin hosted in a site) from one address (IPv4, or IPv6 /64) on one
// site within a sliding window ⇒ an ACCOUNT web ban (source cms-bruteforce,
// the escalation ladder of settings bans), enforced by nginx on the hosts of
// that account only.
//
// Platform switch (settings bans.cmsGuardMode):
//   auto  journal only ("would have banned", audit cmsGuard.wouldBan) for
//         48 h from the guard's first run on the install (cmsGuardAutoAt,
//         stored), then on — like the strict mode of the access keys;
//   off   nothing; log  journal only; on  bans.
// Per site (sites.cms_guard_*): off switch and thresholds (null = platform).
// =============================================================================

export type CmsGuardMode = 'auto' | 'off' | 'log' | 'on';
export const CMS_GUARD_MODES: readonly CmsGuardMode[] = ['auto', 'off', 'log', 'on'];
export type CmsGuardEffective = 'off' | 'log' | 'on';

/** Hours of journal-only before 'auto' bans. */
export const CMS_GUARD_LOG_HOURS = 48;

export const CMS_GUARD_DEFAULT_MAX_FAILURES = 10;
export const CMS_GUARD_DEFAULT_WINDOW_MINUTES = 5;
/** Bounds of the thresholds (platform and site). */
export const CMS_GUARD_MAX_FAILURES_RANGE = { min: 3, max: 1000 } as const;
export const CMS_GUARD_WINDOW_RANGE = { min: 1, max: 1440 } as const;

/** CMS families recognised by the rules. */
export type CmsKind = 'wordpress' | 'wordpress-xmlrpc' | 'joomla' | 'drupal' | 'prestashop' | 'phpmyadmin';
export const CMS_KINDS: readonly CmsKind[] = ['wordpress', 'wordpress-xmlrpc', 'joomla', 'drupal', 'prestashop', 'phpmyadmin'];

/** Per-site settings of the guard (Site.cmsGuard). */
export interface CmsGuardSiteSettings {
  /** false = the site is never protected (its logins are not counted). */
  enabled: boolean;
  /** null = the platform default (bans.cmsGuardMaxFailures). */
  maxFailures: number | null;
  /** null = the platform default (bans.cmsGuardWindowMinutes). */
  windowMinutes: number | null;
}

export const DEFAULT_CMS_GUARD_SITE: CmsGuardSiteSettings = { enabled: true, maxFailures: null, windowMinutes: null };

/** What the platform switch amounts to right now. */
export function effectiveCmsGuardMode(s: { cmsGuardMode: CmsGuardMode; cmsGuardAutoAt: string | null }, now: number = Date.now()): CmsGuardEffective {
  if (s.cmsGuardMode !== 'auto') return s.cmsGuardMode;
  if (!s.cmsGuardAutoAt) return 'log';
  const at = Date.parse(s.cmsGuardAutoAt);
  return Number.isFinite(at) && now >= at ? 'on' : 'log';
}

/**
 * Does `next` protect the site less than `cur` (switched off, more failures
 * tolerated, a shorter window)? Relaxing takes proxy.manage on top of
 * sites.manage (the right that manages the account's bans).
 */
export function cmsGuardRelaxes(
  cur: CmsGuardSiteSettings,
  next: CmsGuardSiteSettings,
  platform: { maxFailures: number; windowMinutes: number },
): boolean {
  if (cur.enabled && !next.enabled) return true;
  const curMax = cur.maxFailures ?? platform.maxFailures;
  const nextMax = next.maxFailures ?? platform.maxFailures;
  const curWin = cur.windowMinutes ?? platform.windowMinutes;
  const nextWin = next.windowMinutes ?? platform.windowMinutes;
  return nextMax > curMax || nextWin < curWin;
}
