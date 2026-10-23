// ─── PHP SECURITY (advisories, end of life) ─────────────────────────────────
// A site base is a PHP BRANCH (8.2); the image of a running container carries
// the exact PATCH version (PHP_VERSION=8.2.35 of the official php images).
// A flaw is judged on the exact version: the branch is fixed from a given
// patch, a container started on an older image stays vulnerable until it is
// recreated on the updated image (Nodes > Updates, site images).

export interface PhpAdvisory {
  id: string;
  name: string;
  cves: readonly string[];
  /** Publication date (YYYY-MM-DD). */
  published: string;
  /** First affected branch ('5.4'): older branches are not affected. */
  since: string;
  /** First fixed patch per branch; a branch absent here never got a fix. */
  fixed: Readonly<Record<string, string>>;
}

export const PHP_ADVISORIES: readonly PhpAdvisory[] = [
  {
    id: 'phpocalypse',
    name: 'PHPocalypse',
    cves: ['CVE-2026-109618', 'CVE-2026-109619'],
    published: '2026-10-21',
    since: '5.4',
    fixed: { '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' },
  },
];

/** End of security support of each PHP branch (YYYY-MM-DD, php.net). */
export const PHP_BRANCH_EOL: Readonly<Record<string, string>> = {
  '5.6': '2018-12-31',
  '7.0': '2019-01-10',
  '7.1': '2019-12-01',
  '7.2': '2020-11-30',
  '7.3': '2021-12-06',
  '7.4': '2022-11-28',
  '8.0': '2023-11-26',
  '8.1': '2025-12-31',
  '8.2': '2026-12-31',
  '8.3': '2027-12-31',
  '8.4': '2028-12-31',
  '8.5': '2029-12-31',
};

/** A branch whose end of support is closer than this is flagged « soon end of life ». */
export const PHP_EOL_SOON_DAYS = 180;

function parts(v: string): number[] {
  return v.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** Compares two PHP versions ('8.2', '8.2.35'); missing parts count as 0. */
export function comparePhpVersion(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** '8.2.35' → '8.2'. */
export function phpBranchOf(version: string): string {
  return parts(version).slice(0, 2).join('.');
}

/** Advisories affecting an EXACT version ('8.2.34'). */
export function phpAdvisoriesForVersion(version: string): PhpAdvisory[] {
  const branch = phpBranchOf(version);
  return PHP_ADVISORIES.filter((a) => {
    if (comparePhpVersion(branch, a.since) < 0) return false;
    const fix = a.fixed[branch];
    return !fix || comparePhpVersion(version, fix) < 0;
  });
}

/** Advisories no patch of the BRANCH ('8.1') fixes: only a branch change helps. */
export function phpAdvisoriesUnfixedOnBranch(branch: string): PhpAdvisory[] {
  return PHP_ADVISORIES.filter((a) => comparePhpVersion(branch, a.since) >= 0 && !a.fixed[branch]);
}

export type PhpEolState = 'eol' | 'soon' | null;

export function phpEolState(branch: string, now: Date = new Date()): PhpEolState {
  const eol = PHP_BRANCH_EOL[branch];
  if (!eol) return null;
  const end = Date.parse(`${eol}T23:59:59Z`);
  if (now.getTime() > end) return 'eol';
  return end - now.getTime() < PHP_EOL_SOON_DAYS * 86_400_000 ? 'soon' : null;
}

/** Exact PHP version of a running site container (GET /api/sites/php-runtime). */
export interface SitePhpRuntime {
  siteId: number;
  role: 'site' | 'site-secondary' | 'site-preview';
  container: string;
  /** PHP_VERSION of the container's image; null: not a PHP image or unknown. */
  version: string | null;
  /** Advisory ids affecting that version. */
  advisories: string[];
  /** A fixed patch exists on the branch: recreating the container on the updated image fixes it. */
  fixable: boolean;
}
