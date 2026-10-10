import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import type { EdgeLogEntry } from '../usage/edgeLog';
import { appsDeps } from './deps';
import { isStackBusy, loadStackRow, startAction } from './deployments';
import { sleepPolicyOf, type StackRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Sleep / wake of idle stacks (docs/P4b-PLAN.md §5.7, after Oblihub
// sleep.service.ts). Activity = proxied requests of the edge log carrying the
// stack id ($oblimint_app), robots / probes / monitors ignored; flushed to
// app_stacks.last_activity_at every minute. A stack with sleepPolicy.enabled
// idle for idleMinutes is stopped (or paused) — status 'sleeping'. A request
// that reaches a sleeping stack (502 / 503 / 504 from the edge) wakes it,
// debounced; proxy-hosts serves the waking page meanwhile.
// ─────────────────────────────────────────────────────────────────────────────

const BOT_RE = /bot|crawl|spider|slurp|monitor|uptime|pingdom|statuscake|healthcheck|probe|curl\/|wget\/|python-requests|go-http-client|nagios|zabbix|prometheus|blackbox/i;
export const WAKE_DEBOUNCE_MS = 15_000;

/** Does this edge log entry count as activity of a stack? Returns the stack id or null. */
export function activityOf(entry: EdgeLogEntry): number | null {
  const id = entry.appStackId;
  if (!id || !Number.isInteger(id) || id <= 0) return null;
  if (entry.kind === 'probe' || entry.kind === 'stub') return null;
  if (BOT_RE.test(entry.userAgent ?? '')) return null;
  return id;
}

/** Default wake: a 'wake' action when the stack is (still) sleeping. */
async function wakeStack(stackId: number): Promise<void> {
  const stack = await loadStackRow(stackId);
  if (!stack || stack.status !== 'sleeping' || isStackBusy(stackId)) return;
  // A suspended / deleted account is never woken (startAction refuses it too).
  const account = await db('hosting_accounts').where({ id: stack.account_id }).first('status') as { status: string } | undefined;
  if (!account || account.status === 'suspended' || account.status === 'deleting') return;
  await startAction(stack, 'wake', 'wake', { userId: null });
}

export class SleepManager {
  constructor(private readonly wake: (stackId: number) => Promise<void> = wakeStack) {}

  private activity = new Map<number, number>();
  private lastWake = new Map<number, number>();
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = appsDeps().subscribeEdgeLog((e) => this.onEntry(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onEntry(entry: EdgeLogEntry): void {
    const id = activityOf(entry);
    if (id === null) return;
    this.activity.set(id, appsDeps().now());
    if (entry.status >= 502 && entry.status <= 504) this.wakeForRequest(id);
  }

  /** A request reached a (maybe) sleeping stack: wake it, at most once per debounce window. Never throws. */
  wakeForRequest(stackId: number): void {
    const now = appsDeps().now();
    this.activity.set(stackId, now);
    const last = this.lastWake.get(stackId) ?? 0;
    if (now - last < WAKE_DEBOUNCE_MS) return;
    this.lastWake.set(stackId, now);
    void this.wake(stackId).catch((err) => logger.warn({ err: errText(err), stackId }, 'apps: wake failed'));
  }

  /** Persists the activity seen since the last flush. */
  async flush(): Promise<void> {
    const entries = [...this.activity.entries()];
    this.activity.clear();
    for (const [id, at] of entries) {
      await db('app_stacks').where({ id }).where((w) => { w.whereNull('last_activity_at').orWhere('last_activity_at', '<', new Date(at)); })
        .update({ last_activity_at: new Date(at) }).catch(() => undefined);
    }
  }

  /** Puts idle stacks to sleep. Never throws. */
  async sleepIdle(): Promise<number> {
    let slept = 0;
    try {
      const now = appsDeps().now();
      const rows = await db('app_stacks as s').join('hosting_accounts as a', 'a.id', 's.account_id')
        .where('a.status', 'active').where('s.status', 'running').where('s.desired_state', 'running').select('s.*') as StackRow[];
      for (const stack of rows) {
        const policy = sleepPolicyOf(stack);
        if (!policy.enabled || isStackBusy(stack.id)) continue;
        const seen = this.activity.get(stack.id);
        const lastActive = Math.max(
          seen ?? 0,
          stack.last_activity_at ? new Date(stack.last_activity_at).getTime() : 0,
          stack.last_deployed_at ? new Date(stack.last_deployed_at).getTime() : 0,
        );
        if (now - lastActive < policy.idleMinutes * 60_000) continue;
        await startAction(stack, 'sleep', 'sleep', { userId: null });
        slept++;
      }
    } catch (err) {
      logger.warn({ err: errText(err) }, 'apps: idle sleep pass failed');
    }
    return slept;
  }
}

export const sleepManager = new SleepManager();
