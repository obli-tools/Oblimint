import { riskLevelOf, type ChangedFileFinding, type RiskLevel, type ScanVerdict, type ScannerSettings } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Risk scoring of the change scanner (docs/P3-PLAN.md §9.2) — PURE.
//
//   file score = max points of its findings + 10 per additional warn /
//                critical finding, capped at 100; any ClamAV hit = 100;
//   set score  = max file score + 10 when ≥ 3 files reach reviewScore, capped;
//   level      = riskLevelOf(score, {reviewScore, blockScore}) (shared);
//   verdict    = ClamAV hit or score ≥ 90 → infected; ≥ reviewScore →
//                suspicious; else clean;
//   blocked    ⇔ score ≥ blockScore or a ClamAV hit (staff override only, M5).
//
// YARA rules carry their points in `meta.score` (images/scanner/rules); the
// php-malware-finder rule names have plan defaults; anything else scores 30.
// Severity of a YARA finding: critical from 60 points, warn below.
// ─────────────────────────────────────────────────────────────────────────────

export const EXTRA_FINDING_POINTS = 10;
export const MANY_RISKY_FILES = 3;
export const MANY_RISKY_FILES_BONUS = 10;
export const INFECTED_SCORE = 90;
export const CLAMAV_SCORE = 100;

/** php-malware-finder rule names → points (docs/P3-PLAN.md §9.2). */
export const YARA_DEFAULT_POINTS: Readonly<Record<string, number>> = {
  ObfuscatedPhp: 60,
  DodgyPhp: 40,
  DangerousPhp: 30,
  SuspiciousEncoding: 30,
  DodgyStrings: 30,
};
export const YARA_FALLBACK_POINTS = 30;
export const YARA_CRITICAL_FROM = 60;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Risk score of one file from its findings. */
export function fileRiskScore(findings: readonly ChangedFileFinding[]): number {
  if (findings.some((f) => f.engine === 'clamav')) return CLAMAV_SCORE;
  if (findings.length === 0) return 0;
  const max = Math.max(...findings.map((f) => f.score ?? 0));
  const significant = findings.filter((f) => f.severity !== 'info').length;
  return clamp(max + Math.max(0, significant - 1) * EXTRA_FINDING_POINTS);
}

/** Risk score of a change set from its file scores. */
export function setRiskScore(fileScores: readonly number[], reviewScore: number): number {
  if (fileScores.length === 0) return 0;
  const max = Math.max(...fileScores);
  const risky = fileScores.filter((s) => s >= reviewScore).length;
  return clamp(max + (risky >= MANY_RISKY_FILES ? MANY_RISKY_FILES_BONUS : 0));
}

export function levelOf(score: number, settings: Pick<ScannerSettings, 'reviewScore' | 'blockScore'>): RiskLevel {
  return riskLevelOf(score, { reviewScore: settings.reviewScore, blockScore: settings.blockScore });
}

export function verdictOf(score: number, clamavHit: boolean, settings: Pick<ScannerSettings, 'reviewScore'>): ScanVerdict {
  if (clamavHit || score >= INFECTED_SCORE) return 'infected';
  if (score >= settings.reviewScore) return 'suspicious';
  return 'clean';
}

export function isBlocked(score: number, clamavHit: boolean, settings: Pick<ScannerSettings, 'blockScore'>): boolean {
  return clamavHit || score >= settings.blockScore;
}

// ── engine hits → findings ───────────────────────────────────────────────────

/** Printable, single-line, bounded text from the scanner (A6: never raw multi-line output). */
export function cleanText(value: unknown, max = 200): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** YARA rule identifiers: [A-Za-z_][A-Za-z0-9_]* (≤ 128). */
export function cleanRuleName(value: unknown): string | null {
  const s = String(value ?? '');
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(s) ? s : null;
}

/** ClamAV signature names: letters, digits, . _ - : / (≤ 160). */
export function cleanSignature(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(s) ? s : null;
}

export function yaraPoints(rule: string, meta: Record<string, unknown> | undefined): number {
  const raw = meta?.score;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  return YARA_DEFAULT_POINTS[rule] ?? YARA_FALLBACK_POINTS;
}

export function yaraFinding(rule: string, meta: Record<string, unknown> | undefined): ChangedFileFinding {
  const points = yaraPoints(rule, meta);
  const description = cleanText(meta?.description);
  return {
    engine: 'yara',
    rule: `yara:${rule}`,
    severity: points >= YARA_CRITICAL_FROM ? 'critical' : 'warn',
    message: description ? `YARA ${rule}: ${description}` : `YARA rule ${rule} matched`,
    line: null,
    score: points,
  };
}

export function clamavFinding(signature: string): ChangedFileFinding {
  return {
    engine: 'clamav',
    rule: `clamav:${signature}`,
    severity: 'critical',
    message: `ClamAV signature ${signature}`,
    line: null,
    score: CLAMAV_SCORE,
  };
}

const SEVERITY_ORDER: Record<ChangedFileFinding['severity'], number> = { critical: 0, warn: 1, info: 2 };

/** Most severe first, then most points. */
export function compareFindings(a: Pick<ChangedFileFinding, 'severity' | 'score'>, b: Pick<ChangedFileFinding, 'severity' | 'score'>): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.score ?? 0) - (a.score ?? 0);
}
