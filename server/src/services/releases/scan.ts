import type { ScanSummary } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-publish scan hook (ARCHITECTURE §1 "Publication"). P1 shipped the
// interface and a no-op scanner; in P3 the scanners module registers its
// analyser (heuristics + YARA + ClamAV) here at scanService.start().
// OWNED BY MODULE `releases` (P3: module `windows`).
//
// Semantics in the pipeline (docs/P3-PLAN.md §9.3):
//   blocked     → summary.blocked (risk ≥ scanner.blockScore or a ClamAV hit;
//                 a verdict 'infected' without the flag counts as blocked):
//                 the release waits in awaiting_approval, BLOCKED — only a
//                 staff member holding releases.approve can approve it, with
//                 an override (audited 'release.approve.override', recorded in
//                 scan.override); notify('scan.threat');
//   suspicious  → mode auto/manual: the release waits for approval
//                 (status awaiting_approval); mode approval: unchanged;
//   clean       → continue (mode approval still waits).
// publishCommit (windows / adapters) may pass a precomputed summary: same gates,
// the decision of the caller counting as the approval (approvedBy).
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanContext {
  siteId: number;
  accountId: number;
  /** Local path of the staging directory (read-only use!). */
  stagingDir: string;
  commitSha: string;
  /** Relative POSIX paths added or modified by this commit. */
  changedFiles: string[];
}

export interface PrePublishScanner {
  readonly name: string;
  scan(ctx: ScanContext): Promise<ScanSummary>;
}

export const noopScanner: PrePublishScanner = {
  name: 'none',
  async scan(): Promise<ScanSummary> {
    return { scanner: 'none', verdict: 'clean', findings: [] };
  },
};

let current: PrePublishScanner = noopScanner;

/** The scanner used by the pipeline. */
export function getScanner(): PrePublishScanner {
  return current;
}

/** Replaces the scanner (P3: ClamAV/YARA; tests: fakes). */
export function setScanner(scanner: PrePublishScanner): void {
  current = scanner;
}
