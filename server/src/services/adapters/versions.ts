import type { UpdateLevel } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Version comparison of the adapters (pure). Versions come from CLI output
// (tenant content): parsed leniently, never trusted beyond "digits and dots".
//
//   classifyLevel('1.2.3', '2.0.0') → major ; ('1.2.3', '1.3.0') → minor ;
//   ('1.2.3', '1.2.4') → patch ; unreadable → unknown.
//
// WordPress core is the exception: x.Y is ITS major branch (6.5 → 6.6 is a
// "major release" for WordPress and for `wp core update --minor`), so
// wordpressCoreLevel() maps a branch change to 'major' and anything inside a
// branch to 'patch'.
// ─────────────────────────────────────────────────────────────────────────────

/** Numeric segments of a version ('v1.2.3-beta' → [1, 2, 3]); null when it does not start with a number. */
export function versionParts(raw: string | null | undefined): number[] | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(raw);
  if (!m) return null;
  const parts = m[1].split('.').slice(0, 6).map((p) => Number.parseInt(p, 10));
  return parts.every((n) => Number.isFinite(n)) ? parts : null;
}

/** -1 / 0 / 1 on the numeric segments (missing segments count as 0); null when either is unreadable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semantic level of the jump current → next (semver reading). */
export function classifyLevel(current: string | null | undefined, next: string | null | undefined): UpdateLevel {
  const a = versionParts(current);
  const b = versionParts(next);
  if (!a || !b) return 'unknown';
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major';
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return 'minor';
  return 'patch';
}

/** WordPress core: a change of the x.Y branch is a major release; inside a branch, a maintenance (patch) release. */
export function wordpressCoreLevel(current: string | null | undefined, next: string | null | undefined): UpdateLevel {
  const a = versionParts(current);
  const b = versionParts(next);
  if (!a || !b) return 'unknown';
  return (a[0] ?? 0) !== (b[0] ?? 0) || (a[1] ?? 0) !== (b[1] ?? 0) ? 'major' : 'patch';
}

/** minorOnly: everything but a major jump (an unknown level is left to the CLI flag, --minor / --patch-only). */
export function allowedByMinorOnly(level: UpdateLevel, minorOnly: boolean | undefined): boolean {
  return !minorOnly || level !== 'major';
}

/**
 * Composer `--patch-only` (Composer / Drupal minorOnly): only a jump known to
 * be a patch is reported as applied (minor and unknown jumps are left to
 * Composer, which may or may not take them; the candidate commit is the truth).
 */
export function allowedByPatchOnly(level: UpdateLevel, patchOnly: boolean | undefined): boolean {
  return !patchOnly || level === 'patch';
}
