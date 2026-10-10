import type { NetworkPolicyMode } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import type { HostdSegmentState } from '../hostd/client';
import { emitHosting } from '../hosting/events';
import { ACCOUNT_NETWORK_RE } from '../hosting/naming';
import { PLATFORM_NETWORKS } from './platform';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { ensureDefaultDbLinks, segmentedAccountsOfNode } from './defaultLinks';
import { segmentBackends } from './deps';
import { observeNode } from './model';
import { buildPolicy } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Policy push loop (docs/P4b-PLAN.md §4.5, SG6). requestPolicySync() never
// throws and never blocks: it marks the policy dirty and arms a 1 s debounce;
// pushes are serialized (one at a time, a request during a push re-arms the
// timer). A push observes the node, rebuilds the WHOLE policy and replaces it
// in hostd (PUT /v1/segments, atomic there). A failed observation or push
// keeps the last applied policy (hostd keeps its table) and is visible in
// lastPushError. The worker adds a full push every 5 min and follows the
// Docker events of the oblimint containers / account networks (reconnect with
// backoff). A FAILED push (hostd restarting, Docker / DB not ready at boot…)
// is retried on its own with an exponential backoff (1 s → 30 s), never left
// to the next Docker event or the 5-min periodic push: after a host reboot
// hostd restores an allow-list keyed by the OLD container addresses, which
// must be replaced as soon as the panel can observe the node.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNC_DEBOUNCE_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Retry of a failed push: first delay, doubled up to the max. */
export const PUSH_RETRY_MIN_MS = 1_000;
export const PUSH_RETRY_MAX_MS = 30_000;

/** Background reasons: no socket event unless the push result changed. */
const QUIET_REASONS = /^(periodic|boot|docker:|events-connected|reconcile|retry)/;

interface PushStatus {
  lastPushAt: Date | null;
  lastPushError: string | null;
  lastState: HostdSegmentState | null;
  lastReason: string | null;
}

const status: PushStatus = { lastPushAt: null, lastPushError: null, lastState: null, lastReason: null };

let dirtyReason: string | null = null;
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
/** Pushes awaited by syncNow() callers. */
let waiters: Array<() => void> = [];
/** Retry of the last failed push (null = none scheduled) and its next delay. */
let retryTimer: NodeJS.Timeout | null = null;
let retryDelayMs = PUSH_RETRY_MIN_MS;
/** Tests: retry delays override (null = defaults). */
let retryOverride: { min: number; max: number } | null = null;

export function pushStatus(): Readonly<PushStatus> {
  return status;
}

async function currentMode(): Promise<NetworkPolicyMode> {
  try {
    return (await platformSettings.section('network')).mode;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'segments: network settings unreadable (enforce assumed)');
    return 'enforce';
  }
}

/** Link status messages (French: shown on the Network links page). */
const PENDING_NO_CONTAINER = "En attente : aucun conteneur des deux segments ne partage un tissu réseau du compte (démarrez ou redéployez l'application concernée).";
const PENDING_LEGACY = "En attente : le réseau du compte n'est pas encore segmenté (migration en cours).";
const DISABLED = 'Liaison désactivée.';

/** Persists the link statuses after a successful push; returns the accounts whose links changed. */
async function updateLinkStatuses(nodeId: number, activeLinks: ReadonlySet<number>, mode: NetworkPolicyMode): Promise<Map<number, number>> {
  const changed = new Map<number, number>(); // accountId → tenantId
  const rows = await db('network_links as l').join('hosting_accounts as a', 'a.id', 'l.account_id')
    .where('a.node_id', nodeId)
    .select('l.id', 'l.account_id', 'l.tenant_id', 'l.enabled', 'l.status', 'l.status_message', 'a.network_model') as Array<{
      id: number; account_id: number; tenant_id: number; enabled: boolean; status: string; status_message: string | null; network_model: string;
    }>;
  for (const r of rows) {
    let next: { status: 'active' | 'pending'; message: string | null };
    if (!r.enabled) next = { status: 'pending', message: DISABLED };
    else if (r.network_model !== 'segmented') next = { status: 'pending', message: PENDING_LEGACY };
    else if (mode === 'off' || activeLinks.has(Number(r.id))) next = { status: 'active', message: null };
    else next = { status: 'pending', message: PENDING_NO_CONTAINER };
    if (r.status === next.status && (r.status_message ?? null) === next.message) continue;
    await db('network_links').where({ id: r.id }).update({ status: next.status, status_message: next.message });
    changed.set(Number(r.account_id), Number(r.tenant_id));
  }
  return changed;
}

/** Observes, builds and pushes the whole policy of the local node. Never throws; false when the push failed. */
async function pushOnce(reason: string): Promise<boolean> {
  const backends = segmentBackends();
  const before = status.lastPushError;
  let changedAccounts = new Map<number, number>();
  try {
    const nodeId = await backends.localNode();
    const mode = await currentMode();
    let built: ReturnType<typeof buildPolicy>;
    if (mode === 'off') {
      built = buildPolicy({ mode, accounts: [], sites: new Map(), dbInstances: new Map(), stacks: new Map(), adapterRuns: new Map(), panelRefs: [], links: [], proxyTargets: [], internalPort: 0 });
    } else {
      // A new DB instance does not always run an account pass: its container start (Docker event) lands here.
      try {
        const added = await ensureDefaultDbLinks(await segmentedAccountsOfNode(nodeId));
        if (added) logger.info({ added }, 'segments: default site → DB links created');
      } catch (err) {
        logger.warn({ err: errText(err) }, 'segments: default site → DB links not created (next push)');
      }
      const observed = await observeNode(nodeId, { mode });
      if (observed.proxyTargetsError) logger.debug({ err: observed.proxyTargetsError }, 'segments: proxy targets unavailable (no edge → app flow)');
      if (observed.missingFabrics.length) logger.debug({ missing: observed.missingFabrics }, 'segments: fabrics not created yet');
      built = buildPolicy(observed.model);
    }
    await backends.hostd(nodeId).setSegments(built.state);
    status.lastPushAt = backends.now();
    status.lastPushError = null;
    status.lastState = built.state;
    status.lastReason = reason;
    changedAccounts = await updateLinkStatuses(nodeId, built.activeLinks, mode);
    logger.debug({ reason, bridges: built.state.bridges.length, rules: built.state.allow.length, mode }, 'segments: policy pushed');
  } catch (err) {
    status.lastPushError = errText(err).slice(0, 500);
    status.lastReason = reason;
    logger.warn({ reason, err: status.lastPushError }, 'segments: policy not pushed (the last applied policy stays in force)');
  }
  const ok = status.lastPushError === null;
  for (const [accountId, tenantId] of changedAccounts) {
    emitHosting(HostingSocketEvents.NETWORK_UPDATED, { accountId, linkId: null }, { tenantId, accountId });
  }
  if (!QUIET_REASONS.test(reason) || before !== status.lastPushError) {
    emitHosting(HostingSocketEvents.NETWORK_UPDATED, { accountId: null, linkId: null }, { tenantId: 1 });
  }
  return ok;
}

/** After a push: success resets the backoff, a failure schedules its own retry (exponential, capped). */
function afterPush(ok: boolean): void {
  const min = retryOverride?.min ?? PUSH_RETRY_MIN_MS;
  const max = retryOverride?.max ?? PUSH_RETRY_MAX_MS;
  if (ok) {
    retryDelayMs = min;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return;
  }
  if (retryTimer) return;
  const delay = Math.min(Math.max(retryDelayMs, min), max);
  retryDelayMs = Math.min(delay * 2, max);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (dirtyReason === null) dirtyReason = 'retry';
    arm(0); // the backoff already waited: no extra debounce
  }, delay);
  retryTimer.unref?.();
}

function arm(delayMs: number): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, delayMs);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (running) { arm(SYNC_DEBOUNCE_MS); return; }
  const reason = dirtyReason;
  if (reason === null) return;
  dirtyReason = null;
  const done = waiters;
  waiters = [];
  let ok = false;
  running = pushOnce(reason).then((r) => { ok = r; });
  try {
    await running;
    afterPush(ok);
  } finally {
    running = null;
    for (const w of done) w();
    if (dirtyReason !== null) arm(SYNC_DEBOUNCE_MS);
  }
}

/** Recompute + push soon (debounced, coalesced). Never throws. */
export function requestPolicySync(reason: string): void {
  try {
    // A change wins over a background reason (it is announced to the admins).
    dirtyReason = dirtyReason === null || QUIET_REASONS.test(dirtyReason) ? String(reason || 'request') : dirtyReason;
    arm(SYNC_DEBOUNCE_MS);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'requestPolicySync failed');
  }
}

/** Push now (still serialized with the loop) and wait for it. */
export async function syncPolicyNow(reason: string): Promise<void> {
  dirtyReason = reason;
  if (timer) { clearTimeout(timer); timer = null; }
  const wait = new Promise<void>((resolve) => { waiters.push(resolve); });
  if (running) {
    // The running push did not include this request: wait for it, then for ours.
    await running.catch(() => undefined);
  }
  void flush();
  await wait;
}

// ── Docker events ────────────────────────────────────────────────────────────

interface DockerEvent {
  Type?: string;
  Action?: string;
  status?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
}

const CONTAINER_ACTIONS = new Set(['start', 'die', 'destroy', 'create', 'kill', 'stop', 'restart']);
const NETWORK_ACTIONS = new Set(['connect', 'disconnect', 'create', 'destroy']);

/** Is a Docker event relevant to the policy? (oblimint containers, account fabrics.) */
export function relevantEvent(ev: DockerEvent): boolean {
  const action = String(ev.Action ?? ev.status ?? '').split(':')[0];
  const attrs = ev.Actor?.Attributes ?? {};
  if (ev.Type === 'container') {
    if (!CONTAINER_ACTIONS.has(action)) return false;
    return Object.keys(attrs).some((k) => k.startsWith('oblimint.')) || String(attrs.name ?? '').startsWith('oblimint');
  }
  if (ev.Type === 'network') {
    const name = String(attrs.name ?? '');
    // Platform networks too: a container (re)attached there gets a new address to restrict / allow.
    return NETWORK_ACTIONS.has(action) && (ACCOUNT_NETWORK_RE.test(name) || PLATFORM_NETWORKS.includes(name));
  }
  return false;
}

let eventsActive = false;
let eventStream: NodeJS.ReadableStream | null = null;
let backoffTimer: NodeJS.Timeout | null = null;
let backoffWake: (() => void) | null = null;

function consume(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    let buf = '';
    const finish = () => { stream.removeAllListeners('data'); resolve(); };
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      if (buf.length > 1_000_000) buf = buf.slice(-100_000); // never grow without bound on garbage
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as DockerEvent;
          if (relevantEvent(ev)) requestPolicySync(`docker:${ev.Type}:${String(ev.Action ?? ev.status ?? '').split(':')[0]}`);
        } catch { /* partial / foreign line */ }
      }
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    backoffWake = resolve;
    backoffTimer = setTimeout(() => { backoffTimer = null; backoffWake = null; resolve(); }, ms);
    backoffTimer.unref?.();
  });
}

async function eventLoop(): Promise<void> {
  let backoff = 1000;
  while (eventsActive) {
    try {
      const backends = segmentBackends();
      const docker = await backends.docker(await backends.localNode());
      const stream = await docker.getEvents({ filters: { type: ['container', 'network'] } }) as NodeJS.ReadableStream;
      if (!eventsActive) { (stream as unknown as { destroy?: () => void }).destroy?.(); break; }
      eventStream = stream;
      backoff = 1000;
      // Events may have been missed while disconnected.
      requestPolicySync('events-connected');
      await consume(stream);
    } catch (err) {
      logger.debug({ err: errText(err) }, 'segments: Docker events unavailable');
    } finally {
      eventStream = null;
    }
    if (!eventsActive) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

export function startEvents(): void {
  if (eventsActive) return;
  eventsActive = true;
  void eventLoop().catch((err) => logger.warn({ err: errText(err) }, 'segments: event loop stopped'));
}

export function stopEvents(): void {
  eventsActive = false;
  try { (eventStream as unknown as { destroy?: () => void } | null)?.destroy?.(); } catch { /* closing */ }
  eventStream = null;
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
  backoffWake?.();
  backoffWake = null;
}

/** Tests: forget the loop state. */
export function resetSegmentSyncForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  dirtyReason = null;
  running = null;
  waiters = [];
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelayMs = PUSH_RETRY_MIN_MS;
  status.lastPushAt = null;
  status.lastPushError = null;
  status.lastState = null;
  status.lastReason = null;
}

/** Tests: retry delays of a failed push (null = defaults). */
export function setPushRetryForTests(delays: { min: number; max: number } | null): void {
  retryOverride = delays;
  retryDelayMs = delays?.min ?? PUSH_RETRY_MIN_MS;
}

/** Is a retry of a failed push scheduled? (status / tests) */
export function pushRetryPending(): boolean {
  return retryTimer !== null;
}

/** Tests: resolves once no push is pending nor running (a scheduled retry is not waited for). */
export async function whenSegmentSyncIdle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!timer && !running && dirtyReason === null) return;
    if (running) await running.catch(() => undefined);
    else await new Promise((r) => setTimeout(r, 20));
  }
}
