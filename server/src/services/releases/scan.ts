import type { ScanSummary } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-publish scan hook (ARCHITECTURE §1 "Publication"). P1 ships the
// interface and a no-op scanner; ClamAV + YARA (php-malware-finder) plug in
// here in P3. OWNED BY MODULE `releases`.
//
// Verdict semantics in the pipeline:
//   clean       → continue;
//   suspicious  → mode auto/manual: the release waits for approval
//                 (status awaiting_approval); mode approval: unchanged;
//   infected    → the release fails (status failed), nothing goes live.
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
