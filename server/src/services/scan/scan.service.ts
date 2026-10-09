import type { FindingEngine, ScanTestResult, ScannerEngineStatus, ScannerSettings, ScannerStatus } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { AnalyzeInput, ChangeAnalysis } from '../maintenance/contracts';
import { platformSettings } from '../platformSettings';
import { setScanner } from '../releases/scan';
import { errText } from '../setup/docker';
import { analyzeChanges, type AnalyzeDeps } from './analyze';
import { HEURISTIC_RULE_COUNT, runHeuristics } from './heuristics';
import { createPrePublishScanner, liveBaseCodeDir, loadPublishSite } from './prePublish';
import { eicarSample, webshellSample } from './samples';
import { ScandError, type ScandClient } from './scandClient';
import { removeScannerContainer, scandClientOrNull, scannerContainerState, scannerInfraComponent } from './scannerInfra';

// ─────────────────────────────────────────────────────────────────────────────
// Change scanner (ARCHITECTURE §1 "Publication", §2.2; docs/P3-PLAN.md §9).
// OWNED BY MODULE `scanners`.
//
// analyze(): heuristics (always, in the panel) + YARA + ClamAV through scand
// (container oblimint-scanner, when settings.scanner.enabled) → per-file
// findings, risk score 0–100 and level, ScanSummary for releases (analyze.ts).
// start() registers the pre-publish scanner of the release pipeline
// (releases/scan.ts setScanner) so EVERY publication is analysed, and a light
// health probe of scand (availability transitions are logged).
// A6: scand / Docker errors are summarized (kinds), never forwarded raw.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_INTERVAL_MS = 5 * 60_000;

interface ScanServiceDeps {
  settings(): Promise<ScannerSettings>;
  /** scand client with the current key, null when no key exists (never deployed). */
  client(): Promise<ScandClient | null>;
  containerState(): Promise<{ deployed: boolean; running: boolean; error: string | null }>;
  /** Code-dir probe of the site's live release (exec.new-outside-expected, §9.2); undefined = unknown. */
  baseCodeDir(siteId: number, accountId: number): Promise<((dir: string) => Promise<boolean>) | undefined>;
}

const realDeps: ScanServiceDeps = {
  settings: () => platformSettings.section('scanner'),
  client: () => scandClientOrNull(),
  containerState: () => scannerContainerState(),
  baseCodeDir: (siteId, accountId) => liveBaseCodeDir(siteId, accountId),
};
let deps: ScanServiceDeps = realDeps;

/** Tests: replace settings / scand client / container state (null restores the real ones). */
export function setScanDepsForTests(d: Partial<ScanServiceDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

let lastScanAt: string | null = null;
let probeTimer: NodeJS.Timeout | null = null;
let firstProbe: NodeJS.Timeout | null = null;
let lastAvailable: boolean | null = null;
let settingsQueue: Promise<void> = Promise.resolve();

async function engineDeps(settings: ScannerSettings): Promise<Pick<AnalyzeDeps, 'engine' | 'engineUnavailable'>> {
  if (!settings.enabled || (!settings.clamav && !settings.yara)) return { engine: null };
  try {
    const client = await deps.client();
    return client ? { engine: client } : { engine: null, engineUnavailable: true };
  } catch (err) {
    logger.warn({ err: errText(err) }, 'scanner: shared key unreadable, heuristics only');
    return { engine: null, engineUnavailable: true };
  }
}

async function analyzeWith(input: AnalyzeInput, extra: Pick<AnalyzeDeps, 'baseCodeDir'>): Promise<ChangeAnalysis> {
  const settings = await deps.settings();
  const analysis = await analyzeChanges(input, { settings, ...(await engineDeps(settings)), ...extra });
  lastScanAt = analysis.summary.analyzedAt;
  if (analysis.summary.scannerUnavailable) {
    logger.warn({ siteId: input.siteId, origin: input.origin }, 'scanner: engines unavailable for this analysis, heuristics only');
  }
  return analysis;
}

function engineOff(enabled: boolean, error: string | null = null): ScannerEngineStatus {
  return { enabled, available: false, version: null, signatureVersion: null, signaturesUpdatedAt: null, ruleCount: null, error };
}

/** Short, client-safe description of a scand failure (A6). */
function scandErrorText(err: unknown): string {
  if (err instanceof ScandError) {
    switch (err.kind) {
      case 'unreachable': return 'scanner unreachable';
      case 'timeout': return 'scanner timed out';
      case 'unauthorized': return 'scanner refused the shared key (redeploy the scanner)';
      case 'tooLarge': return 'file too large for the scanner';
      case 'aborted': return 'aborted';
      default: return 'scanner error';
    }
  }
  return 'scanner error';
}

async function probe(): Promise<void> {
  try {
    const settings = await deps.settings();
    if (!settings.enabled) {
      lastAvailable = null;
      return;
    }
    const client = await deps.client();
    let ok = false;
    if (client) {
      try {
        const st = await client.status({ timeoutMs: 5_000 });
        ok = (!settings.clamav || st.clamav.available) && (!settings.yara || st.yara.available);
      } catch { ok = false; }
    }
    if (lastAvailable !== ok) {
      if (ok) logger.info('scanner: scand is available');
      else logger.warn('scanner: scand (or one of its engines) is unavailable — publications are analysed by the heuristics only');
    }
    lastAvailable = ok;
  } catch (err) {
    logger.debug({ err: errText(err) }, 'scanner probe failed');
  }
}

export const scanService = {
  /** Analyses a change set (never throws for an unreachable scanner: heuristics only + summary.scannerUnavailable). */
  async analyze(input: AnalyzeInput): Promise<ChangeAnalysis> {
    // Windows / adapters change an existing release: its directories that already
    // held code are the expected ones for generic applications (§9.2).
    let baseCodeDir: AnalyzeDeps['baseCodeDir'];
    try {
      baseCodeDir = await deps.baseCodeDir(input.siteId, input.accountId);
    } catch (err) {
      logger.warn({ err: errText(err), siteId: input.siteId }, 'scanner: live release unavailable for the code-dir evidence');
      baseCodeDir = undefined;
    }
    return analyzeWith(input, { baseCodeDir });
  },

  /** GET /api/system/scanner */
  async status(): Promise<ScannerStatus> {
    const settings = await deps.settings();
    const container = await deps.containerState();
    const out: ScannerStatus = {
      deployed: container.deployed,
      running: container.running,
      clamav: engineOff(settings.enabled && settings.clamav),
      yara: engineOff(settings.enabled && settings.yara),
      heuristics: { enabled: true, ruleCount: HEURISTIC_RULE_COUNT },
      lastScanAt,
      checkedAt: new Date().toISOString(),
    };
    if (container.error) {
      const e = 'container engine unreachable';
      out.clamav.error = e;
      out.yara.error = e;
    }
    if (!container.running) return out;
    try {
      const client = await deps.client();
      if (!client) throw new ScandError('unauthorized', 'no key');
      const st = await client.status({ timeoutMs: 5_000 });
      out.clamav = { ...st.clamav, enabled: out.clamav.enabled, available: out.clamav.enabled && st.clamav.available };
      out.yara = { ...st.yara, enabled: out.yara.enabled, available: out.yara.enabled && st.yara.available };
    } catch (err) {
      const e = scandErrorText(err);
      out.clamav.error = e;
      out.yara.error = e;
    }
    return out;
  },

  /** POST /api/system/scanner/update — freshclam now (+ clamd reload). */
  async updateSignatures(): Promise<ScannerStatus> {
    const settings = await deps.settings();
    const container = await deps.containerState();
    if (!settings.enabled || !container.running) {
      throw new AppError(409, 'The scanner container is not deployed / running', 'scannerNotDeployed');
    }
    if (settings.clamav) {
      const client = await deps.client();
      if (!client) throw new AppError(409, 'The scanner has no shared key yet: deploy it', 'scannerNotDeployed');
      try {
        await client.update();
      } catch (err) {
        throw new AppError(502, `Signature update failed: ${scandErrorText(err)}`, 'backendUnavailable');
      }
    }
    return this.status();
  },

  /** POST /api/system/scanner/test — EICAR + a known webshell pattern through every enabled engine + heuristics. */
  async test(): Promise<ScanTestResult> {
    const settings = await deps.settings();
    const detections: ScanTestResult['detections'] = [];
    const problems: string[] = [];
    const shell = webshellSample();

    const heur = runHeuristics({ path: 'oblimint-selftest.php', change: 'added', data: shell, mode: null }, { appProfile: null, dataPaths: [], codeDirs: null });
    for (const f of heur) if (f.severity !== 'info') detections.push({ engine: 'heuristic', rule: f.rule });
    if (!heur.some((f) => f.severity === 'critical')) problems.push('heuristics did not flag the webshell sample');

    const engines = settings.enabled && (settings.clamav || settings.yara);
    if (engines) {
      const container = await deps.containerState();
      if (!container.running) throw new AppError(409, 'The scanner container is not deployed / running', 'scannerNotDeployed');
      const client = await deps.client();
      if (!client) throw new AppError(409, 'The scanner has no shared key yet: deploy it', 'scannerNotDeployed');
      const push = (engine: FindingEngine, rule: string) => {
        if (!detections.some((d) => d.engine === engine && d.rule === rule)) detections.push({ engine, rule });
      };
      try {
        const eicar = await client.scan('oblimint-selftest-eicar.txt', eicarSample(), { timeoutMs: 30_000 });
        const web = await client.scan('oblimint-selftest.php', shell, { timeoutMs: 60_000 });
        if (settings.clamav) {
          for (const r of [eicar, web]) if (r.clamav.status === 'found' && r.clamav.signature) push('clamav', `clamav:${r.clamav.signature}`);
          if (eicar.clamav.status === 'error') problems.push('ClamAV failed on the EICAR test file');
          else if (eicar.clamav.status === 'disabled') problems.push('ClamAV is disabled in the container (redeploy the scanner)');
          else if (eicar.clamav.status !== 'found') problems.push('ClamAV did not detect the EICAR test file');
        }
        if (settings.yara) {
          for (const m of web.yara.matches) push('yara', `yara:${m.rule}`);
          if (web.yara.error) problems.push('YARA failed on the webshell sample');
          else if (web.yara.disabled) problems.push('YARA is disabled in the container (redeploy the scanner)');
          else if (web.yara.matches.length === 0) problems.push('YARA did not match the webshell sample');
        }
      } catch (err) {
        problems.push(scandErrorText(err));
      }
    }
    return { ok: problems.length === 0, detections, error: problems.length ? problems.join('; ') : null };
  },

  /** HOOK: settings 'scanner' changed (PUT /system/hosting-settings) → (re)deploy / remove. Never throws. */
  settingsChanged(): void {
    settingsQueue = settingsQueue.then(async () => {
      try {
        const settings = await deps.settings();
        const log = (line: string) => logger.info({ component: 'scanner' }, line);
        if (settings.enabled) await scannerInfraComponent.ensure(log);
        else await removeScannerContainer(log);
      } catch (err) {
        logger.warn({ err: errText(err) }, 'scanner: applying the new settings failed (see the Nodes page / redeploy)');
      }
      void probe();
    }).catch(() => {});
  },

  /** Registers the pre-publish scanner + status probe. Returns at once, never throws. */
  start(): void {
    try {
      setScanner(createPrePublishScanner({
        loadSite: loadPublishSite,
        analyze: (input, opts) => analyzeWith(input, opts),
      }));
      if (!probeTimer) {
        probeTimer = setInterval(() => { void probe(); }, PROBE_INTERVAL_MS);
        probeTimer.unref?.();
        firstProbe = setTimeout(() => { void probe(); }, 30_000);
        firstProbe.unref?.();
      }
    } catch (err) {
      logger.warn({ err: errText(err) }, 'scanner: start failed');
    }
  },

  /** Stops the probe; the pre-publish scanner stays registered (publications in flight keep being analysed). */
  stop(): void {
    if (probeTimer) clearInterval(probeTimer);
    if (firstProbe) clearTimeout(firstProbe);
    probeTimer = null;
    firstProbe = null;
  },
};
