import type {
  ChangeAnalysisSummary, ChangedFileFinding, FindingEngine, ScanFinding, ScannerSettings, WindowChangeCounts,
} from '@oblimint/shared';
import type { AnalyzeInput, ChangeAnalysis, ChangedPath, FileAnalysis } from '../maintenance/contracts';
import {
  codeDirsOf, HEURISTIC_MAX_BYTES, inExpectedDir, isBinary, isExecutablePath, runHeuristics, skippedFinding, uninspectedExecFinding,
} from './heuristics';
import { ScandError, type ScandClient, type ScandScanResult } from './scandClient';
import {
  clamavFinding, compareFindings, fileRiskScore, isBlocked, levelOf, setRiskScore, verdictOf, yaraFinding,
} from './scoring';

// ─────────────────────────────────────────────────────────────────────────────
// analyze(AnalyzeInput) → ChangeAnalysis (docs/P3-PLAN.md §9). Reads every
// changed file ONLY through input.tree (ContentTree: lstat, O_NOFOLLOW, real
// parents — M12), runs the heuristics on its first 4 MiB and, when the
// scanner is enabled, sends it to scand (bounded concurrency + an in-flight
// byte budget, per-file timeout). An unreachable / erroring scanner never
// throws: heuristics only, summary.scannerUnavailable = true (M10: never
// auto-validated). Only input.signal aborts (AbortError).
// ─────────────────────────────────────────────────────────────────────────────

export const SCAN_CONCURRENCY = 4;
/** Bytes held in memory at once by the concurrent reads (a larger single file waits for an empty budget). */
export const IN_FLIGHT_BUDGET = 128 * 1024 * 1024;
/** Flattened findings kept in the release-shaped ScanSummary (most severe first). */
export const MAX_SUMMARY_FINDINGS = 1000;

export interface AnalyzeDeps {
  settings: ScannerSettings;
  /** scand client; null = the scanner is disabled in the settings (heuristics only, not "unavailable"). */
  engine: ScandClient | null;
  /** Enabled in the settings but no client could be built (no key / never deployed): heuristics only, scannerUnavailable. */
  engineUnavailable?: boolean;
  /**
   * Generic applications: does `dir` (or an ancestor, root excepted) hold an
   * executable file in the BASE release? undefined = unknown (only the change
   * set itself is evidence); the publication scanner answers from the live
   * release. null = no base at all (first publication): exec.new-outside-expected
   * is not evaluated.
   */
  baseCodeDir?: ((dir: string) => Promise<boolean>) | null;
  scanTimeoutMs?: number;
  now?: () => Date;
}

class ByteBudget {
  private used = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly total: number) {}
  async acquire(n: number): Promise<number> {
    const want = Math.min(Math.max(0, n), this.total);
    while (this.used + want > this.total) await new Promise<void>((r) => this.waiters.push(r));
    this.used += want;
    return want;
  }
  release(n: number): void {
    this.used -= n;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('analysis aborted');
  err.name = 'AbortError';
  return err;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

interface EngineOutcome {
  clamavRan: boolean;
  yaraRan: boolean;
  failed: boolean;
  findings: ChangedFileFinding[];
}

function mapEngineResult(r: ScandScanResult, settings: ScannerSettings): EngineOutcome {
  const out: EngineOutcome = { clamavRan: false, yaraRan: false, failed: false, findings: [] };
  if (settings.clamav) {
    if (r.clamav.status === 'ok' || r.clamav.status === 'found') out.clamavRan = true;
    else out.failed = true; // 'error', or 'disabled' while the settings expect it (container not reconfigured yet)
    if (r.clamav.status === 'found' && r.clamav.signature) out.findings.push(clamavFinding(r.clamav.signature));
  }
  if (settings.yara) {
    if (r.yara.error || r.yara.disabled) out.failed = true;
    else out.yaraRan = true;
    const seen = new Set<string>();
    for (const m of r.yara.matches) {
      if (seen.has(m.rule)) continue;
      seen.add(m.rule);
      out.findings.push(yaraFinding(m.rule, m.meta));
    }
  }
  return out;
}

export function emptyCounts(): WindowChangeCounts {
  return { added: 0, modified: 0, deleted: 0, total: 0, executable: 0, ignored: 0, bytes: 0 };
}

export async function analyzeChanges(input: AnalyzeInput, deps: AnalyzeDeps): Promise<ChangeAnalysis> {
  const { settings } = deps;
  const signal = input.signal;
  if (signal?.aborted) throw abortError(signal);
  const engineLimit = Math.max(1, settings.maxFileSizeMb) * 1024 * 1024;
  const wantEngines = settings.enabled && (settings.clamav || settings.yara);
  const engine = wantEngines ? deps.engine : null;
  let scannerUnavailable = wantEngines && (!engine || !!deps.engineUnavailable);
  let circuitOpen = scannerUnavailable;
  let clamavRan = false;
  let yaraRan = false;
  let skipped = 0;

  // Code-dir evidence for generic applications (exec.new-outside-expected).
  const evidence = codeDirsOf(input.files.filter((f) => f.change !== 'added' && f.change !== 'deleted' && f.type !== 'dir').map((f) => f.path));
  const baseCache = new Map<string, Promise<boolean>>();
  const baseCodeDir = deps.baseCodeDir;
  const expectedDirs = async (files: ChangedPath[]): Promise<Set<string> | null> => {
    if (baseCodeDir === null) return null;
    if (input.appProfile === 'wordpress' || !baseCodeDir) return evidence;
    const dirs = new Set(evidence);
    for (const f of files) {
      if (f.change !== 'added' || !isExecutablePath(f.path)) continue;
      if (inExpectedDir(f.path, dirs)) continue;
      // Ask the base about the directory and its ancestors (root excepted).
      for (let d = dirOf(f.path); d; d = dirOf(d)) {
        let p = baseCache.get(d);
        if (!p) {
          p = baseCodeDir(d).catch(() => false);
          baseCache.set(d, p);
        }
        if (await p) {
          dirs.add(d);
          break;
        }
      }
    }
    return dirs;
  };
  const codeDirs = await expectedDirs(input.files);
  const ctx = { appProfile: input.appProfile, dataPaths: input.dataPaths, codeDirs };

  const budget = new ByteBudget(IN_FLIGHT_BUDGET);
  const results: FileAnalysis[] = new Array(input.files.length);

  const analyzeOne = async (f: ChangedPath): Promise<FileAnalysis> => {
    const executable = isExecutablePath(f.path) && f.type !== 'dir';
    const base: FileAnalysis = {
      path: f.path, change: f.change, type: f.type, size: f.size, executable, binary: false,
      risk: 0, level: 'none', findings: [], ignored: f.ignored ?? null,
    };
    if (f.change === 'deleted' || f.type === 'dir') return base;
    // Ignored paths do not go into the release; a data path entry only gets the
    // typed-path check (bootstrap copy): the code heuristics would score content
    // that is never published (and block the set on, e.g., a PHP cache).
    const dataOnly = !!f.ignored;
    if (dataOnly && f.ignored !== 'dataPath') return base;
    const keep = (found: ChangedFileFinding[]): ChangedFileFinding[] =>
      (dataOnly ? found.filter((x) => x.rule === 'datapath.code') : found);

    if (f.type === 'symlink') {
      base.findings = keep(runHeuristics({ path: f.path, change: f.change, data: null, mode: null }, ctx));
      return score(base);
    }

    const st = await input.tree.stat(f.path);
    const size = st?.type === 'file' ? st.size : f.size ?? 0;
    const mode = typeof f.mode === 'number' ? f.mode : f.mode === undefined && st && process.platform !== 'win32' ? st.mode : null;
    const toEngines = !!engine && !dataOnly && size <= engineLimit;
    const want = toEngines ? Math.min(size, engineLimit) : Math.min(size, HEURISTIC_MAX_BYTES);
    const held = await budget.acquire(want);
    try {
      if (signal?.aborted) throw abortError(signal);
      const read = st?.type === 'file' ? await input.tree.read(f.path, Math.max(want, 1)) : null;
      const data = read?.data ?? null;
      const head = data ? data.subarray(0, HEURISTIC_MAX_BYTES) : null;
      if (head) base.binary = isBinary(head);
      if (read) base.size = read.size;
      const findings = keep(runHeuristics({ path: f.path, change: f.change, data: head, mode }, ctx));
      /** The engines (ClamAV / YARA) read the WHOLE file and answered. */
      let engineCovered = false;

      if (wantEngines && !dataOnly) {
        if (!data) {
          skipped++;
          findings.push(skippedFinding('unreadable'));
        } else if (read!.size > engineLimit) {
          skipped++;
          findings.push(skippedFinding('size', settings.maxFileSizeMb));
        } else if (circuitOpen || !engine) {
          skipped++;
          findings.push(skippedFinding('scanner'));
        } else {
          try {
            const res = await engine.scan(f.path, data, { signal, timeoutMs: deps.scanTimeoutMs });
            const o = mapEngineResult(res, settings);
            clamavRan ||= o.clamavRan;
            yaraRan ||= o.yaraRan;
            if (o.failed) scannerUnavailable = true;
            engineCovered = !o.failed && (o.clamavRan || o.yaraRan);
            findings.push(...o.findings);
          } catch (err) {
            const e = err instanceof ScandError ? err : new ScandError('protocol', 'scanner request failed');
            if (e.kind === 'aborted' && signal?.aborted) throw abortError(signal);
            if (e.kind === 'tooLarge') {
              skipped++;
              findings.push(skippedFinding('size', settings.maxFileSizeMb));
            } else {
              scannerUnavailable = true;
              if (e.fatal) circuitOpen = true;
              skipped++;
              findings.push(skippedFinding('scanner'));
            }
          }
        }
      }
      // An executable whose content was not inspected in full never goes through without a human.
      if (executable && !dataOnly && !engineCovered && (!data || (read?.size ?? size) > HEURISTIC_MAX_BYTES)) {
        findings.push(uninspectedExecFinding(settings.reviewScore));
      }
      base.findings = findings;
      return score(base);
    } finally {
      budget.release(held);
    }
  };

  const score = (fa: FileAnalysis): FileAnalysis => {
    fa.findings.sort(compareFindings);
    fa.risk = fileRiskScore(fa.findings);
    fa.level = levelOf(fa.risk, settings);
    return fa;
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const i = next++;
      if (i >= input.files.length) return;
      results[i] = await analyzeOne(input.files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, input.files.length)) }, worker));
  if (signal?.aborted) throw abortError(signal);

  return summarize(results, {
    settings,
    engines: ['heuristic', ...(yaraRan ? ['yara' as const] : []), ...(clamavRan ? ['clamav' as const] : [])],
    scannerUnavailable,
    skipped,
    now: (deps.now ?? (() => new Date()))(),
  });
}

/** Summary + release-shaped ScanSummary of analysed files (exported for the tests / the digest). */
export function summarize(
  files: FileAnalysis[],
  o: { settings: ScannerSettings; engines: FindingEngine[]; scannerUnavailable: boolean; skipped: number; now: Date },
): ChangeAnalysis {
  const counts = emptyCounts();
  let findings = 0;
  let criticalFindings = 0;
  let clamavHit = false;
  const scores: number[] = [];
  const flat: ScanFinding[] = [];

  for (const f of files) {
    if (f.type !== 'dir') {
      if (f.ignored) counts.ignored++;
      else {
        counts.total++;
        if (f.change === 'added') counts.added++;
        else if (f.change === 'modified') counts.modified++;
        else if (f.change === 'deleted') counts.deleted++;
        if (f.change !== 'deleted') {
          if (f.executable) counts.executable++;
          counts.bytes += Math.max(0, f.size ?? 0);
        }
      }
    }
    scores.push(f.risk);
    for (const x of f.findings) {
      findings++;
      if (x.severity === 'critical') criticalFindings++;
      if (x.engine === 'clamav') clamavHit = true;
      flat.push({ path: f.path, rule: x.rule, severity: x.severity, message: x.message, engine: x.engine, line: x.line ?? null });
    }
  }

  const score = setRiskScore(scores, o.settings.reviewScore);
  const level = levelOf(score, o.settings);
  const verdict = verdictOf(score, clamavHit, o.settings);
  const blocked = isBlocked(score, clamavHit, o.settings);
  const summary: ChangeAnalysisSummary = {
    engines: o.engines,
    verdict,
    risk: { score, level },
    counts,
    findings,
    criticalFindings,
    scannerUnavailable: o.scannerUnavailable,
    skipped: o.skipped,
    blocked,
    analyzedAt: o.now.toISOString(),
  };
  flat.sort((a, b) => compareFindings(a, b) || a.path.localeCompare(b.path));
  return {
    summary,
    files,
    scan: {
      scanner: o.engines.join('+'),
      verdict,
      findings: flat.slice(0, MAX_SUMMARY_FINDINGS),
      risk: { score, level },
      skipped: o.skipped,
      scannerUnavailable: o.scannerUnavailable,
      blocked,
    },
  };
}
