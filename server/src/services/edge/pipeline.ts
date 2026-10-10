import crypto from 'crypto';
import type { EdgeApplyRecord, EdgeApplyResult, EdgeUnitStatusKind, EdgeUnitUpstreamState } from '@oblimint/shared';
import { compareCanary, measureCanary, pickCanaryHosts, type CanaryResult } from './canary';
import { EDGE_NOT_RUNNING, type EdgeExecResult } from './confSync';
import {
  auxEqual, CONF_DIRS, emptyTree, parseUnitHeader, readLiveTree, readSnapshot, treesEqual, unitFileContent, writeLiveTree, writeSnapshot,
  type ConfDirName, type EdgeDirs, type EdgeTree, type UnitFileKind,
} from './edgeTree';
import { probeUpstreamWith, type EdgeExec } from './probe';
import { cleanNginxError, failingUnitOf, removeSandbox, sandboxTestCommand, sweepSandbox, writeSandbox, type SandboxUnit } from './sandbox';
import { isValidServerNameEntry } from './nginxConfig';
import { renderStub } from './stub';
import { checkUnit, checkUnitConfigText } from './unitCheck';
import type { EdgeConfigUnit, EdgeUpstreamRef } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// Apply pipeline of the edge units (docs/P4b-PLAN.md §8.3–§8.6, ED1–ED5) —
// every side effect injected (tests: temp dirs + scripted docker exec).
//
//  1. every unit is re-checked (unitCheck.ts: ids, names, ports, paths,
//     variable proxy_pass, advancedConfig lint) and hashed;
//  2. a unit whose content differs from its LAST GOOD version (edge/good/,
//     else the live files on the first P4b pass) is a candidate, unless the
//     same version was already refused (kept refused until it changes, a
//     retry, a forced sync or REFUSED_RETEST_MS), held by a rollback (a
//     canary hold is retried after CANARY_HOLD_RETRY_MS) or its upstream
//     probe failed < 1 min ago; a unit whose name / port is taken by another
//     unit never serves its good version (stub with its free names only);
//  3. changed upstreams are probed from inside the edge (TCP; a sleeping app
//     target never blocks); unreachable ⇒ previous version kept;
//  4. candidates are tested in the SANDBOX (image config + good global units
//     + candidates): all together first, then the failing ones isolated
//     (≤ MAX_SANDBOX_TESTS per pass, the rest stays pending for the next).
//     Only a configuration error reported by nginx (exit 1 + [emerg]) that
//     names a candidate, or that an empty sandbox does not reproduce,
//     refuses a unit; an exec failure / timeout / unusable sandbox keeps the
//     candidates pending (infraError: the caller retries after a delay);
//  5. refused unit ⇒ its last good version (quarantined) or, without one, a
//     503 stub keeping its names + certificate (http server units), the
//     fallbackConfig of a global unit, nothing for a stream unit;
//  6. the live tree is written (atomic files, exact sets), `nginx -t` on the
//     whole configuration (safety net: a unit named by the error, or every
//     changed unit re-added one by one, goes back to its baseline);
//  7. reload (exit code checked; the image script also checks that the
//     master really started new workers) → canary → on failure the previous good
//     tree is restored and reloaded (result rolledBack);
//  8. success ⇒ the live tree recorded as the new good copy (marker
//     written last); good.prev/ (admin rollback point) is the good copy the
//     pass started from, recorded at step 6 before any live write.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_SANDBOX_TESTS = 50;
export const MAX_GLOBAL_TESTS = 20;
export const MAX_PROBES_PER_PASS = 60;
/** Upstream probes run in parallel (each may take its full 3 s timeout when a DROP answers nothing). */
export const PROBE_CONCURRENCY = 8;
/** Wall-clock budget of the probes of one pass: units not probed in time stay pending (probed next pass). */
export const PROBE_PASS_BUDGET_MS = 30_000;
export const UPSTREAM_RETRY_MS = 60_000;
export const CANARY_SETTLE_MS = 1_000;
/** Reload through the image script (switches the edge back to the live config after a fallback start, ED4). */
export const RELOAD_COMMAND = ['oblimint-edge-reload'];
export const GLOBAL_TEST_COMMAND = ['nginx', '-t'];
/** Error prefix of a unit held back after a rollback (not retried until it changes, a retry or a forced sync). */
export const HOLD_PREFIX = 'rolled back: ';
/** Reason of a hold set by a failed canary: retried automatically after CANARY_HOLD_RETRY_MS (an admin rollback hold is not). */
export const CANARY_HOLD_REASON = 'the canary failed after the reload';
export const CANARY_HOLD_RETRY_MS = 30 * 60_000;
/** A version refused by nginx is re-tested at most this often without change / retry / forced sync (stale refusals heal). */
export const REFUSED_RETEST_MS = 6 * 3600_000;

/**
 * Result of one `nginx -t` run. `config`: nginx ran and reported a
 * configuration error (exit 1 + an [emerg] line) — only such a failure may
 * refuse a unit. Anything else (exec exception / timeout, other exit code,
 * no [emerg]) is an infrastructure failure: the pass keeps its units pending.
 */
type TestResult = { ok: true } | { ok: false; config: boolean; error: string };

function testResultOf(r: EdgeExecResult): TestResult {
  if (r.exitCode === 0) return { ok: true };
  const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
  const error = out || `nginx -t exited with ${r.exitCode}`;
  return { ok: false, config: r.exitCode === 1 && /\[emerg\]/.test(out), error };
}

/** A unit as the pipeline receives it (`invalidReason`: P1 vhost refused by validateVhost, H5, or a provider unit it could not render). */
export type PipelineUnit = EdgeConfigUnit;

export interface PriorUnitState {
  status: EdgeUnitStatusKind;
  error: string | null;
  desiredHash: string | null;
  activeHash: string | null;
  upstreams: EdgeUnitUpstreamState[];
  checkedAt: Date | null;
}

export interface PipelineSettings {
  probeUpstreams: boolean;
  canary: boolean;
  canarySampleSize: number;
  streamPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

export interface PipelineDeps {
  dirs: EdgeDirs;
  isRunning: () => Promise<boolean>;
  exec: EdgeExec;
  /** apps-core: is that stack sleeping (an unreachable upstream then never blocks)? Never throws (false). */
  isAppSleeping: (stackId: number) => Promise<boolean>;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  runId?: () => string;
}

export interface PipelineInput {
  units: PipelineUnit[];
  prior: ReadonlyMap<string, PriorUnitState>;
  settings: PipelineSettings;
  /** Re-test refused units (manual sync, retry of everything); implies reload. */
  force: boolean;
  /** Test + reload even without file change (first sync after boot, after a failed pass). */
  reload?: boolean;
  /** Units re-validated now whatever their previous result (retry). */
  forceUnits?: ReadonlySet<string>;
  /** A provider failed this pass: live units it may own (unknown ids) are kept as they are. */
  keepUnknown?: boolean;
}

export interface UnitResult {
  unitId: string;
  unit: PipelineUnit;
  status: EdgeUnitStatusKind;
  error: string | null;
  upstreams: EdgeUnitUpstreamState[];
  desiredHash: string;
  /** Hash of the version of the unit itself being served (null: stub, fallback or nothing). */
  activeHash: string | null;
  /** Evaluated (lint / probe / sandbox) this pass. */
  checked: boolean;
  /** The desired version went live this pass. */
  applied: boolean;
  /** Something is served for the unit (its version, the good one, a stub or a fallback). */
  served: boolean;
}

export interface PipelineOutcome {
  result: EdgeApplyResult;
  error: string | null;
  running: boolean;
  reloaded: boolean;
  units: UnitResult[];
  /** Units left untested (budget): the caller schedules another pass. */
  pending: number;
  /** Candidates of this pass (changed units evaluated). */
  changed: number;
  quarantined: number;
  canary: CanaryResult | null;
  /** Live files written / removed. */
  filesChanged: number;
  tests: number;
  /**
   * The pass could not test (docker exec failure / timeout, sandbox not
   * usable, reload not applied…): its candidates stay pending, never refused.
   * The caller retries after a delay, not immediately.
   */
  infraError: string | null;
}

type Stage = 'unchanged' | 'candidate' | 'accepted' | 'refused' | 'unreachable' | 'held' | 'pending';

interface Work {
  u: PipelineUnit;
  id: string;
  dir: ConfDirName;
  hash: string;
  /** Desired file content (null: invalid unit, or nothing to serve — disabled stream / global unit). */
  desired: Buffer | null;
  desiredAux: Map<string, Buffer>;
  good: Buffer | undefined;
  goodAux: Map<string, Buffer> | undefined;
  goodKind: UnitFileKind | null;
  goodHash: string | null;
  stage: Stage;
  error: string | null;
  upstreams: EdgeUnitUpstreamState[];
  checked: boolean;
  /** Stub content when the unit falls back to one (tested in a batch). */
  stub: Buffer | null;
  /** Refused by the global test: only its baseline version may be served. */
  baselineOnly: boolean;
  /**
   * Refused because a name / port is already served by another unit: its
   * good version (which may carry that name) is never served; an http unit
   * gets a stub with its FREE names only (stubNames), a stream unit nothing.
   */
  collision: boolean;
  /** Names its stub may carry (null: all its valid names). */
  stubNames: string[] | null;
}

/** Stable hash of a unit's desired content. */
export function unitHash(u: EdgeConfigUnit): string {
  const files = Object.entries(u.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return crypto.createHash('sha256').update(JSON.stringify({
    s: u.scope, l: u.level, c: u.config, f: files, d: !!u.disabled, fb: u.fallbackConfig ?? null,
    n: u.disabled ? u.serverNames : null, t: u.disabled ? u.tls : null,
  })).digest('hex');
}

function dirOf(u: EdgeConfigUnit): ConfDirName {
  if (u.scope === 'stream') return 'stream.d';
  return u.level === 'global' ? 'global.d' : 'conf.d';
}

const upstreamTarget = (r: EdgeUpstreamRef) => `${r.host}:${r.port}`;

function upstreamKey(list: Array<{ where: string; target: string }>): string {
  return list.map((x) => `${x.where}|${x.target}`).sort().join('\n');
}

/** Has a TCP target of `refs` never been measured (reachable null) in the prior states? (UDP is never probed.) */
function neverMeasured(prior: readonly EdgeUnitUpstreamState[], refs: readonly EdgeUpstreamRef[]): boolean {
  const tcp = new Set(refs.filter((r) => r.protocol !== 'udp').map((r) => upstreamTarget(r)));
  return prior.some((u) => u.reachable === null && tcp.has(u.target));
}

function initialUpstreams(u: EdgeConfigUnit, prior: PriorUnitState | undefined): EdgeUnitUpstreamState[] {
  const refs = Array.isArray(u.upstreams) ? u.upstreams : [];
  const fresh = refs.map((r) => ({ where: String(r.where ?? '').slice(0, 200), target: upstreamTarget(r), reachable: null, error: null }));
  if (prior && upstreamKey(prior.upstreams) === upstreamKey(fresh)) return prior.upstreams;
  return fresh;
}

const bufEqual = (a: Buffer | null | undefined, b: Buffer | null | undefined) => (!a && !b) || (!!a && !!b && a.equals(b));

/** Runs one apply pass. Never throws for a unit problem; throws only on file-system failures before anything was written. */
export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runPrefix = deps.runId?.() ?? `r${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const forceUnits = input.forceUnits ?? new Set<string>();
  const { dirs } = deps;

  const live = readLiveTree(dirs);
  const good = readSnapshot(dirs.good, { goodPaths: true });
  /** "Last good" versions: the good copy, else (first P4b pass, legacy P1 files) what is live. */
  const baseline: EdgeTree = good ?? live;

  // ── 1. check + hash + classify ──
  const works: Work[] = [];
  const names = new Map<string, string>();
  const ports = new Map<string, string>();
  for (const u of input.units) {
    const id = String(u?.id ?? '');
    if (works.some((w) => w.id === id)) {
      // The first unit of an id keeps it (P1 vhosts come first, then the providers in order).
      deps.log.warn({ unit: id.slice(0, 64) }, 'edge: duplicate unit id dropped');
      continue;
    }
    let error = u?.invalidReason ?? checkUnit(u, { streamPorts: input.settings.streamPorts });
    if (!error && u.scope === 'http' && u.level === 'server') {
      const taken = u.serverNames.find((n) => names.has(n));
      if (taken) error = `server name ${taken} already served by unit ${names.get(taken)}`;
    }
    if (!error && u.scope === 'stream' && u.level === 'server') {
      const taken = u.listen.find((l) => ports.has(`${l.port}/${l.protocol}`));
      if (taken) error = `stream port ${taken.port}/${taken.protocol} already used by unit ${ports.get(`${taken.port}/${taken.protocol}`)}`;
    }
    if (error && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      deps.log.warn({ unit: id.slice(0, 64), error }, 'edge: unit dropped (invalid id)');
      continue;
    }
    const dir = dirOf(u);
    const hash = unitHash(u);
    // A refused unit still claims its (valid) names / ports: its last good version or its stub keeps serving them.
    // A colliding unit claims only its FREE names (served by its stub), never the taken ones nor its ports.
    const collides = !!error && /already (served|used) by unit/.test(error);
    let stubNames: string[] | null = null;
    if (u?.scope === 'http' && u.level === 'server' && Array.isArray(u.serverNames)) {
      const free = u.serverNames.filter((n) => isValidServerNameEntry(n) && !names.has(n));
      free.forEach((n) => names.set(n, id));
      if (collides) stubNames = free;
    }
    if (!collides && u?.scope === 'stream' && u.level === 'server' && Array.isArray(u.listen)) {
      u.listen.filter((l) => l && !ports.has(`${l.port}/${l.protocol}`)).forEach((l) => ports.set(`${l.port}/${l.protocol}`, id));
    }
    let desired: Buffer | null = null;
    if (!error) {
      if (u.disabled) {
        const stub = renderStub(u, { reason: 'disabled' });
        desired = stub ? unitFileContent(id, hash, 'disabled', stub) : null;
      } else {
        desired = unitFileContent(id, hash, 'unit', u.config);
      }
    }
    const desiredAux = new Map<string, Buffer>(u.disabled ? [] : Object.entries(u.files ?? {}).map(([k, v]) => [k, Buffer.from(String(v), 'utf8')]));
    const goodBuf = baseline.conf[dir].get(id);
    const header = parseUnitHeader(goodBuf);
    const w: Work = {
      u, id, dir, hash, desired, desiredAux,
      good: goodBuf, goodAux: baseline.aux.get(id), goodKind: goodBuf ? (header?.kind ?? 'unit') : null, goodHash: header?.hash ?? null,
      stage: 'candidate', error: null, upstreams: initialUpstreams(u, input.prior.get(id)), checked: false, stub: null, baselineOnly: false,
      collision: collides, stubNames,
    };
    if (error) {
      w.stage = 'refused';
      w.error = error;
      w.checked = true;
    } else if (goodBuf && bufEqual(goodBuf, desired) && auxEqual(w.goodAux, desiredAux)
      // Without a good/ copy the baseline is the live tree, which may hold files written UNTESTED while the
      // edge was down: identical content is "unchanged" only when this version was really activated.
      && (good !== null || (input.prior.get(id)?.status === 'active' && input.prior.get(id)?.activeHash === hash))) {
      w.stage = 'unchanged';
    } else if (desired === null) {
      w.stage = 'unchanged'; // disabled stream / global unit: nothing to serve, nothing to test
    } else {
      const p = input.prior.get(id);
      const forced = input.force || forceUnits.has(id);
      if (p && p.desiredHash === hash && !forced) {
        const age = p.checkedAt ? now().getTime() - p.checkedAt.getTime() : Infinity;
        const held = !!p.error?.startsWith(HOLD_PREFIX);
        // A canary hold is retried after a while (the culprit may have been another unit, or a transient state).
        const holdKept = held && !(p.error?.startsWith(`${HOLD_PREFIX}${CANARY_HOLD_REASON}`) && age >= CANARY_HOLD_RETRY_MS);
        if (p.status === 'upstreamUnreachable' && age < UPSTREAM_RETRY_MS) {
          w.stage = 'unreachable';
          w.error = p.error;
          w.upstreams = p.upstreams;
        } else if ((p.status === 'quarantined' || p.status === 'stub') && p.error) {
          if (held ? holdKept : age < REFUSED_RETEST_MS) {
            w.stage = held ? 'held' : 'refused';
            w.error = p.error;
          }
        } else if (p.status === 'pending' && held && holdKept) {
          w.stage = 'held';
          w.error = p.error;
        }
      }
    }
    works.push(w);
  }
  const knownIds = new Set(works.map((w) => w.id));

  /** First infrastructure failure of the pass (see PipelineOutcome.infraError). */
  let infraError: string | null = null;
  let running = false;
  try { running = await deps.isRunning(); } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'edge: cannot inspect the edge container');
  }

  // ── composition of a tree from the works ──
  const finalOf = (w: Work): { content: Buffer | null; aux: Map<string, Buffer> | undefined; status: EdgeUnitStatusKind; activeHash: string | null } => {
    const fromGood = (status: EdgeUnitStatusKind) => ({
      content: w.good ?? null, aux: w.goodAux,
      status: w.goodKind === 'stub' || w.goodKind === 'disabled' ? (status === 'quarantined' ? 'stub' : status) : status,
      activeHash: w.goodKind === 'unit' ? w.goodHash : null,
    });
    // A colliding unit never serves its good version (it may carry the taken name): its stub with its free names, or nothing.
    if (w.collision) {
      return w.stub
        ? { content: w.stub, aux: undefined, status: w.u.disabled ? 'disabled' : 'stub', activeHash: null }
        : { content: null, aux: undefined, status: 'quarantined', activeHash: null };
    }
    // A disabled owner never gets its old content back: its stub (HTTP only when the TLS one was refused) or nothing.
    if (w.u.disabled && !w.baselineOnly && (w.stage === 'refused' || w.stage === 'held' || w.stage === 'pending')) {
      return { content: w.stub, aux: undefined, status: 'disabled', activeHash: null };
    }
    if (w.baselineOnly) return w.good ? fromGood(w.stage === 'pending' ? 'pending' : 'quarantined') : { content: null, aux: undefined, status: w.stage === 'pending' ? 'pending' : 'quarantined', activeHash: null };
    switch (w.stage) {
      case 'unchanged':
      case 'accepted':
        return { content: w.desired, aux: w.desired ? w.desiredAux : undefined, status: w.u.disabled ? 'disabled' : 'active', activeHash: w.u.disabled ? null : w.hash };
      case 'pending':
        if (!running) return { content: w.desired, aux: w.desiredAux, status: 'pending', activeHash: null };
        return w.good ? fromGood('pending') : { content: null, aux: undefined, status: 'pending', activeHash: null };
      case 'held':
        if (w.good) return fromGood('quarantined');
        // Never served yet: its names keep a 503 stub rather than falling through to the default server.
        if (w.stub) return { content: w.stub, aux: undefined, status: 'stub', activeHash: null };
        return { content: null, aux: undefined, status: 'pending', activeHash: null };
      case 'refused':
      case 'unreachable': {
        const status: EdgeUnitStatusKind = w.stage === 'unreachable' ? 'upstreamUnreachable' : 'quarantined';
        if (w.good) return fromGood(status);
        if (w.stub) return { content: w.stub, aux: undefined, status: w.stage === 'unreachable' ? status : 'stub', activeHash: null };
        const fallback = fallbackOf(w);
        if (fallback) return { content: fallback, aux: undefined, status, activeHash: null };
        return { content: null, aux: undefined, status, activeHash: null };
      }
      default:
        return w.good ? fromGood('pending') : { content: null, aux: undefined, status: 'pending', activeHash: null };
    }
  };

  const compose = (): EdgeTree => {
    const t = emptyTree();
    if (input.keepUnknown) {
      for (const d of CONF_DIRS) for (const [id, buf] of live.conf[d]) if (!knownIds.has(id)) t.conf[d].set(id, buf);
      for (const [id, files] of live.aux) if (!knownIds.has(id)) t.aux.set(id, files);
    }
    for (const w of works) {
      const f = finalOf(w);
      if (!f.content) continue;
      t.conf[w.dir].set(w.id, f.content);
      if (f.aux && f.aux.size) t.aux.set(w.id, f.aux);
    }
    return t;
  };

  const results = (): UnitResult[] => works.map((w) => {
    const f = finalOf(w);
    return {
      unitId: w.id, unit: w.u, status: f.status, error: f.status === 'active' || f.status === 'disabled' ? null : w.error, upstreams: w.upstreams,
      desiredHash: w.hash, activeHash: f.activeHash, checked: w.checked,
      applied: (w.stage === 'accepted' || (w.stage === 'unchanged' && !bufEqual(live.conf[w.dir].get(w.id), w.desired))) && !w.baselineOnly,
      served: !!f.content,
    };
  });

  const outcome = (o: Partial<PipelineOutcome> & Pick<PipelineOutcome, 'result' | 'error'>): PipelineOutcome => {
    const units = results();
    return {
      running, reloaded: false, canary: null, filesChanged: 0, tests: 0, infraError,
      ...o,
      units,
      pending: works.filter((w) => w.stage === 'pending').length,
      changed: works.filter((w) => w.checked || w.stage === 'accepted').length,
      quarantined: units.filter((u) => u.status === 'quarantined' || u.status === 'stub' || u.status === 'upstreamUnreachable').length,
    };
  };

  // ── edge not running: write what is wanted (untested), nothing else ──
  if (!running) {
    for (const w of works) if (w.stage === 'candidate') w.stage = 'pending';
    for (const w of works) prepareStub(w);
    const filesChanged = writeLiveTree(dirs, compose());
    return outcome({ result: 'skipped', error: EDGE_NOT_RUNNING, filesChanged });
  }

  sweepSandbox(dirs.sandbox);

  // ── 3. upstream probes ──
  // Selected first (≤ MAX_PROBES_PER_PASS refs), then run PROBE_CONCURRENCY at a time within
  // PROBE_PASS_BUDGET_MS: a burst of dead targets never holds the serialized edge chain for minutes.
  // A unit is probed when it is new, was unreachable (its retry timer is over: see the prior handling
  // above), changed targets, or NEVER had its TCP targets measured — a unit left pending (probe budget
  // exceeded, edge down, sandbox unusable) keeps unmeasured states and must not go live unprobed.
  const toProbe: Array<{ w: Work; refs: EdgeUpstreamRef[] }> = [];
  let probes = 0;
  for (const w of works) {
    if (w.stage !== 'candidate' || !input.settings.probeUpstreams) continue;
    const refs = (w.u.upstreams ?? []).slice(0, 16);
    if (refs.length === 0) continue; // nothing declared (e.g. skipUpstreamCheck): never probed
    const p = input.prior.get(w.id);
    const fresh = refs.map((r) => ({ where: String(r.where ?? '').slice(0, 200), target: upstreamTarget(r) }));
    const changed = !p || p.status === 'upstreamUnreachable' || p.status === 'pending'
      || upstreamKey(p.upstreams) !== upstreamKey(fresh) || neverMeasured(p.upstreams, refs);
    if (!changed) continue;
    if (probes + refs.length > MAX_PROBES_PER_PASS) { w.stage = 'pending'; continue; }
    probes += refs.length;
    toProbe.push({ w, refs });
  }
  if (toProbe.length) {
    const startedAt = Date.now();
    const tasks: Array<{ unit: number; index: number; ref: EdgeUpstreamRef }> = [];
    toProbe.forEach((x, unit) => x.refs.forEach((ref, index) => tasks.push({ unit, index, ref })));
    const outcomes: Array<Array<{ reachable: boolean | null; error: string | null; blocks: boolean } | undefined>> = toProbe.map((x) => new Array(x.refs.length));
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        if (Date.now() - startedAt > PROBE_PASS_BUDGET_MS) return; // left unprobed: unit pending
        const { unit, index, ref } = tasks[i];
        const res = await probeUpstreamWith(deps.exec, ref);
        let error = res.error;
        let blocks = false;
        if (res.reachable === false) {
          let sleeping = false;
          if (Number.isInteger(ref.appStackId) && (ref.appStackId ?? 0) > 0) {
            try { sleeping = await deps.isAppSleeping(ref.appStackId as number); } catch { sleeping = false; }
          }
          if (sleeping) error = 'app sleeping: woken by the first request';
          else blocks = true;
        }
        outcomes[unit][index] = { reachable: res.reachable, error, blocks };
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, tasks.length) }, () => worker()));
    toProbe.forEach(({ w, refs }, unit) => {
      const res = outcomes[unit];
      if (res.some((r) => r === undefined)) {
        w.stage = 'pending'; // budget exhausted before all its targets were probed
        return;
      }
      const states: EdgeUnitUpstreamState[] = [];
      let blocking: string | null = null;
      refs.forEach((r, i) => {
        const o = res[i]!;
        if (o.blocks && !blocking) blocking = `upstream ${r.where} (${upstreamTarget(r)}) unreachable from the edge`;
        states.push({ where: String(r.where ?? '').slice(0, 200), target: upstreamTarget(r), reachable: o.reachable, error: o.error });
      });
      w.upstreams = states;
      w.checked = true;
      if (blocking) {
        w.stage = 'unreachable';
        w.error = blocking;
      }
    });
  }

  // ── 4. sandbox tests ──
  let tests = 0;
  let testSeq = 0;
  const baseGlobals = (exclude: ReadonlySet<string>): SandboxUnit[] => {
    const out: SandboxUnit[] = [];
    for (const w of works) {
      if (w.u.level !== 'global' || exclude.has(w.id)) continue;
      const current = w.stage === 'accepted' || w.stage === 'unchanged';
      const content = current ? w.desired : w.good ?? fallbackOf(w);
      const aux = current ? w.desiredAux : w.good ? w.goodAux : undefined;
      if (content) out.push({ id: w.id, dir: w.dir, content, aux });
    }
    if (input.keepUnknown) {
      for (const [id, buf] of live.conf['global.d']) if (!knownIds.has(id)) out.push({ id, dir: 'global.d', content: buf, aux: live.aux.get(id) });
    }
    return out;
  };
  const sandboxTest = async (cands: Array<{ w: Work; content: Buffer; aux: Map<string, Buffer> | undefined }>): Promise<TestResult> => {
    tests++;
    const run = `${runPrefix}-${++testSeq}`;
    const candIds = new Set(cands.map((c) => c.w.id));
    const units: SandboxUnit[] = [...baseGlobals(candIds), ...cands.map((c) => ({ id: c.w.id, dir: c.w.dir, content: c.content, aux: c.aux }))];
    try {
      writeSandbox(dirs.sandbox, run, units);
      return testResultOf(await deps.exec(sandboxTestCommand(run)));
    } catch (err) {
      return { ok: false, config: false, error: `sandbox test failed: ${(err as Error).message}` };
    } finally {
      try { removeSandbox(dirs.sandbox, run); } catch { /* swept next pass */ }
    }
  };
  /**
   * Does the sandbox itself work (image base + good globals, no candidate)?
   * Asked once, only when a configuration error names none of the units under
   * test: a failing empty sandbox (mount missing on an old edge container,
   * broken base…) is an infrastructure failure, never the candidates' fault.
   */
  let baseVerdict: TestResult | null = null;
  const baseBroken = async (): Promise<string | null> => {
    if (!baseVerdict) baseVerdict = await sandboxTest([]);
    return baseVerdict.ok ? null : baseVerdict.error;
  };
  /** Infrastructure failure: the units still to test stay pending (retried later, never refused). */
  const giveUp = (ws: Work[], error: string) => {
    infraError ??= cleanNginxError(error);
    for (const w of ws) if (w.stage === 'candidate') w.stage = 'pending';
    deps.log.warn({ error: infraError, units: ws.length }, 'edge: sandbox unusable this pass, units kept pending');
  };
  /** The failure of a test of `group` is attributable to it (refusal allowed)? null = yes, else the infrastructure error. */
  const infraOf = async (r: Extract<TestResult, { ok: false }>, group: Work[]): Promise<string | null> => {
    if (!r.config) return r.error;
    const named = failingUnitOf(r.error);
    if (named && group.some((w) => w.id === named.id && w.dir === named.dir)) return null;
    return baseBroken();
  };
  const asCand = (w: Work) => ({ w, content: w.desired as Buffer, aux: w.desiredAux });
  const refuse = (w: Work, raw: string) => {
    w.stage = 'refused';
    w.error = cleanNginxError(raw);
    w.checked = true;
    deps.log.warn({ unit: w.id, error: w.error }, 'edge: unit refused by nginx -t (sandbox), isolated');
  };

  const candidates = works.filter((w) => w.stage === 'candidate')
    .sort((a, b) => Number(b.u.level === 'global') - Number(a.u.level === 'global'));
  let group = [...candidates];
  while (group.length && tests < MAX_SANDBOX_TESTS && infraError === null) {
    const r = await sandboxTest(group.map(asCand));
    if (r.ok) {
      for (const w of group) { w.stage = 'accepted'; w.checked = true; }
      group = [];
      break;
    }
    const infra = await infraOf(r, group);
    if (infra !== null) { giveUp(group, infra); group = []; break; }
    const named = failingUnitOf(r.error);
    const culprit = named ? group.find((w) => w.id === named.id && w.dir === named.dir) : undefined;
    if (!culprit) break;
    refuse(culprit, r.error);
    group = group.filter((w) => w !== culprit);
  }
  // Isolation, globals first (an accepted global joins the base of the next tests).
  for (const w of group) {
    if (w.stage !== 'candidate') continue;
    if (infraError !== null || tests >= MAX_SANDBOX_TESTS) { w.stage = 'pending'; continue; }
    const r = await sandboxTest([asCand(w)]);
    if (r.ok) { w.stage = 'accepted'; w.checked = true; continue; }
    const infra = await infraOf(r, [w]);
    if (infra !== null) giveUp(group, infra);
    else refuse(w, r.error);
  }

  // ── 5. stubs of refused http server units without a good version ──
  for (const w of works) prepareStub(w);
  const stubbed = works.filter((w) => w.stub && (!w.good || w.collision) && !w.u.disabled
    && (w.stage === 'refused' || w.stage === 'unreachable' || w.stage === 'held') && w.u.tls);
  const plainStub = (w: Work) => {
    // Certificate problem most likely: HTTP-only stub (cannot fail on a file).
    const plain = renderStub(stubUnitOf(w), { withTls: false });
    w.stub = plain ? unitFileContent(w.id, null, 'stub', plain) : null;
  };
  // Batch first; on a configuration error the failing stub(s) are isolated, so one bad certificate only downgrades its own unit.
  let stubGroup = stubbed;
  let stubFailed = false;
  while (stubGroup.length && tests < MAX_SANDBOX_TESTS && infraError === null) {
    const r = await sandboxTest(stubGroup.map((w) => ({ w, content: w.stub as Buffer, aux: undefined })));
    if (r.ok) { stubGroup = []; break; }
    // Infrastructure failure: TLS stubs kept as rendered (the global nginx -t stays the safety net).
    if (!r.config) { stubGroup = []; break; }
    stubFailed = true;
    const named = failingUnitOf(r.error);
    const culprit = named ? stubGroup.find((w) => w.id === named.id && w.dir === named.dir) : undefined;
    if (!culprit) {
      for (const w of stubGroup) {
        if (tests >= MAX_SANDBOX_TESTS) { plainStub(w); continue; }
        const one = await sandboxTest([{ w, content: w.stub as Buffer, aux: undefined }]);
        if (!one.ok && one.config) plainStub(w);
      }
      stubGroup = [];
      break;
    }
    plainStub(culprit);
    stubGroup = stubGroup.filter((w) => w !== culprit);
  }
  // Budget exhausted after a failure: the untested rest goes HTTP-only (never risk the global test on them).
  if (stubFailed) for (const w of stubGroup) plainStub(w);

  // ── 6. write + global test (safety net) ──
  let target = compose();
  if (treesEqual(target, live) && !input.force && !input.reload && !works.some((w) => w.stage === 'accepted')) {
    return outcome({ result: resultOf(), error: summary(), tests });
  }
  // The good copy this pass starts from becomes the admin rollback point (good.prev/) BEFORE the live tree changes,
  // whatever the outcome (accepted, partial, failed, rolled back): an admin rollback undoes the latest pass, never
  // an older one (a rollback to a copy taken several passes ago would take down hosts that were healthy since).
  if (good && !treesEqual(good, target)) {
    try {
      const prev = readSnapshot(dirs.goodPrev, { goodPaths: false });
      if (!prev || !treesEqual(prev, good)) writeSnapshot(dirs.goodPrev, good, { goodPaths: false });
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'edge: cannot record the rollback point (good.prev)');
    }
  }
  let filesChanged = writeLiveTree(dirs, target);

  let globalTests = 0;
  const globalTest = async (): Promise<TestResult> => {
    globalTests++;
    try {
      return testResultOf(await deps.exec(GLOBAL_TEST_COMMAND));
    } catch (err) {
      return { ok: false, config: false, error: `nginx -t: ${(err as Error).message}` };
    }
  };
  /** A configuration error of the global test (a unit may be sent back to its baseline); null otherwise. */
  const configErrorOf = (r: TestResult): string | null => (!r.ok && r.config ? r.error : null);
  const differsFromBaseline = (w: Work) => {
    const f = finalOf(w);
    return !bufEqual(f.content, w.good) || !auxEqual(f.content ? f.aux : undefined, w.goodAux);
  };
  const toBaseline = (w: Work, raw: string) => {
    w.baselineOnly = true;
    if (w.stage === 'accepted' || w.stage === 'unchanged') w.stage = 'refused';
    w.error = cleanNginxError(raw);
    w.checked = true;
    deps.log.warn({ unit: w.id, error: w.error }, 'edge: unit refused by the global nginx -t, back to its last good version');
  };

  // Only a configuration error reported by nginx sends a unit back to its baseline (refused); an exec failure /
  // timeout fails the pass as a whole (units pending, retried later).
  let g = await globalTest();
  let gErr = configErrorOf(g);
  while (gErr !== null && globalTests < MAX_GLOBAL_TESTS) {
    const named = failingUnitOf(gErr);
    const w = named ? works.find((x) => x.id === named.id && x.dir === named.dir && !x.baselineOnly && differsFromBaseline(x)) : undefined;
    if (!w) break;
    toBaseline(w, gErr);
    filesChanged += writeLiveTree(dirs, (target = compose()));
    g = await globalTest();
    gErr = configErrorOf(g);
  }
  if (gErr !== null && globalTests < MAX_GLOBAL_TESTS) {
    // Error naming no unit (interaction, server_names hash…): every changed unit back to its baseline, then re-added one by one.
    const changedWorks = works.filter((w) => !w.baselineOnly && differsFromBaseline(w));
    const saved = changedWorks.map((w) => ({ w, stage: w.stage, error: w.error }));
    for (const w of changedWorks) w.baselineOnly = true;
    filesChanged += writeLiveTree(dirs, (target = compose()));
    const base = await globalTest();
    if (base.ok) {
      g = base;
      for (const s of saved) {
        if (globalTests >= MAX_GLOBAL_TESTS) {
          if (s.w.stage === 'accepted') s.w.stage = 'pending';
          continue;
        }
        s.w.baselineOnly = false;
        filesChanged += writeLiveTree(dirs, (target = compose()));
        const e = await globalTest();
        if (e.ok) continue;
        if (!e.config) {
          // Infrastructure failure midway: the pass fails (the units not re-added yet stay accepted ⇒ pending below).
          s.w.baselineOnly = true;
          g = e;
          break;
        }
        toBaseline(s.w, e.error);
        filesChanged += writeLiveTree(dirs, (target = compose()));
      }
    } else {
      g = base;
    }
  }
  if (!g.ok) {
    writeLiveTree(dirs, baseline);
    const error = `nginx -t failed on the whole configuration, last good configuration restored: ${cleanNginxError(g.error)}`;
    deps.log.warn({ error }, 'edge: global nginx -t failed');
    for (const w of works) if (w.stage === 'accepted') { w.stage = 'pending'; w.baselineOnly = true; }
    // Not attributable to a unit this pass: retried after a delay, not in a tight loop.
    infraError ??= cleanNginxError(g.error);
    return outcome({ result: 'failed', error, tests, filesChanged });
  }

  // ── 7. reload + canary ──
  const changedHosts: string[][] = [];
  const otherHosts: string[][] = [];
  for (const w of [...works].sort((a, b) => a.id.localeCompare(b.id))) {
    if (w.u.scope !== 'http' || w.u.level !== 'server' || !finalOf(w).content) continue;
    (w.stage === 'accepted' ? changedHosts : otherHosts).push(w.u.serverNames);
  }
  const canaryHosts = input.settings.canary ? pickCanaryHosts(changedHosts, otherHosts, input.settings.canarySampleSize) : [];
  const before = input.settings.canary ? await measureCanary(deps.exec, canaryHosts) : null;

  const reload = async (): Promise<string | null> => {
    try {
      const r = await deps.exec(RELOAD_COMMAND);
      return r.exitCode === 0 ? null : (r.stderr || r.stdout || `reload exited with ${r.exitCode}`).trim().slice(0, 1000);
    } catch (err) {
      return (err as Error).message;
    }
  };
  const reloadErr = await reload();
  if (reloadErr !== null) {
    writeLiveTree(dirs, baseline);
    for (const w of works) if (w.stage === 'accepted') { w.stage = 'pending'; w.baselineOnly = true; w.error = `edge reload failed: ${reloadErr}`; }
    deps.log.warn({ error: reloadErr }, 'edge: reload failed, last good configuration restored');
    infraError ??= `nginx reload failed: ${reloadErr}`.slice(0, 1000);
    return outcome({ result: 'failed', error: `nginx reload failed: ${reloadErr}`, tests, filesChanged });
  }

  let canary: CanaryResult | null = null;
  if (before) {
    await sleep(CANARY_SETTLE_MS);
    canary = compareCanary(before, await measureCanary(deps.exec, canaryHosts));
    if (!canary.ok) {
      const why = canary.failures.map((f) => `${f.host}: ${f.error}`).join('; ').slice(0, 500);
      writeLiveTree(dirs, baseline);
      const back = await reload();
      for (const w of works) {
        if (w.stage === 'accepted') {
          w.stage = 'held';
          w.baselineOnly = true;
          w.error = `${HOLD_PREFIX}${CANARY_HOLD_REASON} (${why})`;
        }
      }
      deps.log.warn({ failures: canary.failures, reloadError: back }, 'edge: canary failed, previous good configuration restored');
      return outcome({
        result: 'rolledBack', reloaded: back === null, canary, tests, filesChanged,
        error: `canary failed after the reload, previous configuration restored${back ? ` (reload of the restored configuration failed: ${back})` : ''}: ${why}`,
      });
    }
  }

  // ── 8. good copy ──
  try {
    // good.prev/ was recorded before the live tree was written (step 6).
    writeSnapshot(dirs.good, target, { goodPaths: true });
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'edge: cannot record the last good configuration');
  }
  deps.log.info({ units: works.length, changed: works.filter((w) => w.stage === 'accepted').length, tests }, 'edge: configuration applied');
  return outcome({ result: resultOf(), error: summary(), reloaded: true, canary, tests, filesChanged });

  // ── helpers (hoisted) ──
  function prepareStub(w: Work): void {
    if (w.stub || w.u.scope !== 'http' || w.u.level !== 'server') return;
    if (w.u.disabled) {
      // The TLS stub of a disabled owner is its desired content: refused ⇒ HTTP-only stub.
      if (w.stage !== 'refused' && w.stage !== 'held' && w.stage !== 'pending') return;
      const plain = renderStub(stubUnitOf(w), { reason: 'disabled', withTls: false });
      w.stub = plain ? unitFileContent(w.id, w.hash, 'disabled', plain) : null;
      return;
    }
    if ((w.good && !w.collision) || (w.stage !== 'refused' && w.stage !== 'unreachable' && w.stage !== 'held')) return;
    const stub = renderStub(stubUnitOf(w), { reason: 'refused' });
    w.stub = stub ? unitFileContent(w.id, null, 'stub', stub) : null;
  }
  /** The unit as its stub sees it: a colliding unit keeps only its free names. */
  function stubUnitOf(w: Work): PipelineUnit {
    return w.stubNames ? { ...w.u, serverNames: w.stubNames } : w.u;
  }
  function fallbackOf(w: Work): Buffer | null {
    if (w.u.level !== 'global' || typeof w.u.fallbackConfig !== 'string') return null;
    if (checkUnitConfigText(w.u.fallbackConfig, w.id, 'global', w.u.scope) !== null) return null;
    return unitFileContent(w.id, w.hash, 'fallback', w.u.fallbackConfig);
  }
  function resultOf(): EdgeApplyResult {
    return works.every((w) => { const s = finalOf(w).status; return s === 'active' || s === 'disabled'; }) ? 'ok' : 'partial';
  }
  function summary(): string | null {
    const bad = works.filter((w) => { const s = finalOf(w).status; return s !== 'active' && s !== 'disabled' && s !== 'pending'; });
    if (bad.length === 0) return null;
    return `${bad.length} unit(s) not applied (${bad.slice(0, 5).map((w) => w.id).join(', ')}${bad.length > 5 ? '…' : ''}): ${bad[0].error ?? ''}`.slice(0, 1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin rollback: the previous good copy (good.prev/) becomes the live and
// the good configuration again.
// ─────────────────────────────────────────────────────────────────────────────

export interface RollbackOutcome {
  ok: boolean;
  error: string | null;
  /** Units whose served content changed (they are held back by the caller). */
  changedUnits: Array<{ id: string; restoredHash: string | null; restoredKind: UnitFileKind | null }>;
}

export async function rollbackToPrevious(deps: Pick<PipelineDeps, 'dirs' | 'isRunning' | 'exec' | 'log'>): Promise<RollbackOutcome> {
  const prev = readSnapshot(deps.dirs.goodPrev, { goodPaths: false });
  if (!prev) return { ok: false, error: 'noPreviousConfiguration', changedUnits: [] };
  let running = false;
  try { running = await deps.isRunning(); } catch { running = false; }
  if (!running) return { ok: false, error: EDGE_NOT_RUNNING, changedUnits: [] };
  const live = readLiveTree(deps.dirs);
  writeLiveTree(deps.dirs, prev);
  const test = await deps.exec(GLOBAL_TEST_COMMAND).catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message }));
  if (test.exitCode !== 0) {
    writeLiveTree(deps.dirs, live);
    return { ok: false, error: `the previous configuration no longer passes nginx -t: ${cleanNginxError(test.stderr || test.stdout)}`, changedUnits: [] };
  }
  const reload = await deps.exec(RELOAD_COMMAND).catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message }));
  if (reload.exitCode !== 0) {
    writeLiveTree(deps.dirs, live);
    return { ok: false, error: `nginx reload failed: ${(reload.stderr || reload.stdout).trim().slice(0, 500)}`, changedUnits: [] };
  }
  try { writeSnapshot(deps.dirs.good, prev, { goodPaths: true }); } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'edge: cannot record the restored configuration as good');
  }
  const changedUnits: RollbackOutcome['changedUnits'] = [];
  for (const d of CONF_DIRS) {
    const ids = new Set([...live.conf[d].keys(), ...prev.conf[d].keys()]);
    for (const id of ids) {
      if (bufEqual(live.conf[d].get(id), prev.conf[d].get(id)) && auxEqual(live.aux.get(id), prev.aux.get(id))) continue;
      const h = parseUnitHeader(prev.conf[d].get(id));
      changedUnits.push({ id, restoredHash: h?.hash ?? null, restoredKind: prev.conf[d].has(id) ? (h?.kind ?? 'unit') : null });
    }
  }
  deps.log.info({ changed: changedUnits.length }, 'edge: previous good configuration restored (admin rollback)');
  return { ok: true, error: null, changedUnits };
}

export type { EdgeApplyRecord };
