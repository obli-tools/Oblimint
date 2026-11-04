import type { HealthCenterSettings, HealthTrackStatus } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Health center: pure transition logic (unit tested, no I/O).
//
// A followed item (a deep health component, the data disk) keeps a CONFIRMED
// status and a streak of observations that disagree with it. A change is
// confirmed after `confirm` observations in a row (hysteresis): one red check
// never notifies, and a flapping component (red, green, red…) never confirms
// anything. One transition = one notification:
//   unknown/skipped + ok         → ok (silent: first sight of a healthy item)
//   unknown/skipped/ok + fail×N  → fail, transition 'down'
//   fail + ok×N                  → ok, transition 'up'
//   any + skipped                → skipped (component not deployed: silent)
// A backup target has no hysteresis: each finished run is a definitive
// outcome. Its first failure (after a success or never seen) goes 'down', the
// next success after failures goes 'up'; failures in a row stay silent.
// ─────────────────────────────────────────────────────────────────────────────

export type Observation = 'ok' | 'fail' | 'skipped';
export type Transition = 'down' | 'up' | null;

export interface Track {
  status: HealthTrackStatus;
  /** Observations in a row that disagree with `status`. */
  streak: number;
  /** Last confirmed transition (ISO). */
  since: string | null;
  detail: string | null;
}

export const EMPTY_TRACK: Track = { status: 'unknown', streak: 0, since: null, detail: null };

export interface Step {
  next: Track;
  transition: Transition;
}

const clampConfirm = (n: number) => (Number.isInteger(n) && n >= 1 ? Math.min(n, 100) : 1);

/** One observation of an item with hysteresis. */
export function stepTrack(prev: Track, obs: Observation, detail: string | null, confirm: number, nowIso: string): Step {
  const need = clampConfirm(confirm);
  if (obs === 'skipped') {
    return { next: { status: 'skipped', streak: 0, since: prev.status === 'skipped' ? prev.since : nowIso, detail }, transition: null };
  }
  if (obs === prev.status) return { next: { ...prev, streak: 0, detail }, transition: null };
  if (obs === 'ok' && (prev.status === 'unknown' || prev.status === 'skipped')) {
    return { next: { status: 'ok', streak: 0, since: nowIso, detail }, transition: null };
  }
  // A disagreeing observation: fail on unknown / skipped / ok, ok on fail.
  const streak = prev.streak + 1;
  if (streak < need) return { next: { ...prev, streak, detail }, transition: null };
  return {
    next: { status: obs, streak: 0, since: nowIso, detail },
    transition: obs === 'fail' ? 'down' : 'up',
  };
}

export type BackupOutcome = 'ok' | 'partial' | 'failed';

export interface BackupTrack extends Track {
  /** Failed runs in a row. */
  failures: number;
  lastRunId: number | null;
}

export const EMPTY_BACKUP_TRACK: BackupTrack = { ...EMPTY_TRACK, failures: 0, lastRunId: null };

/** One finished backup run of a target (no hysteresis). */
export function stepBackup(prev: BackupTrack, outcome: BackupOutcome, runId: number, detail: string | null, nowIso: string): { next: BackupTrack; transition: Transition } {
  if (outcome === 'ok') {
    const recovered = prev.status === 'fail';
    return {
      next: { status: 'ok', streak: 0, since: recovered || prev.status !== 'ok' ? nowIso : prev.since, detail: null, failures: 0, lastRunId: runId },
      transition: recovered ? 'up' : null,
    };
  }
  const first = prev.status !== 'fail';
  return {
    next: { status: 'fail', streak: 0, since: first ? nowIso : prev.since, detail, failures: (first ? 0 : prev.failures) + 1, lastRunId: runId },
    transition: first ? 'down' : null,
  };
}

export interface DiskFigures { totalBytes: number; availableBytes: number }

const GIB = 1024 ** 3;

/** Disk observation against the thresholds (null / zero size: unreadable, never a false alarm). */
export function diskObservation(d: DiskFigures | null, s: Pick<HealthCenterSettings, 'diskMinFreePercent' | 'diskMinFreeGiB'>): { obs: Observation; detail: string } {
  if (!d || !(d.totalBytes > 0) || !(d.availableBytes >= 0)) return { obs: 'skipped', detail: 'data directory unreadable' };
  const pct = (d.availableBytes / d.totalBytes) * 100;
  const shown = `${Math.round(pct * 10) / 10}% free (${(d.availableBytes / GIB).toFixed(1)} GiB of ${(d.totalBytes / GIB).toFixed(1)} GiB)`;
  const low = pct < s.diskMinFreePercent || (s.diskMinFreeGiB > 0 && d.availableBytes < s.diskMinFreeGiB * GIB);
  return { obs: low ? 'fail' : 'ok', detail: shown };
}

/** "2 h 05 min" style duration (French), for the recovery messages. */
export function durationFr(fromIso: string | null, toMs: number): string | null {
  if (!fromIso) return null;
  const ms = toMs - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'moins d’une minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}
