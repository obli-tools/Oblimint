import type { PendingApprovalInfo } from '@/api/pendingReplay';

// Module-level bridge between the axios interceptor (outside React) and the
// <PendingApprovalGate> singleton (the waiting modal), like twoFactorGate.ts.
// The interceptor files a 202 pendingApproval here and waits:
//   'run'      the request was approved and the user chose to run it now:
//              the interceptor replays it and the call site continues;
//   'dismiss'  the modal was closed (still pending, denied, expired,
//              cancelled): the call site gets a PendingApprovalError.

export type PendingApprovalDecision = 'run' | 'dismiss';

export interface PendingApprovalPrompt extends PendingApprovalInfo {
  /** The original request can be replayed later (no secret, no file): a toast offers it once approved. */
  replayableLater: boolean;
  resolve: (d: PendingApprovalDecision) => void;
}

type Listener = (p: PendingApprovalPrompt) => void;

let listener: Listener | null = null;

export function setPendingApprovalListener(fn: Listener | null): void {
  listener = fn;
}

export function hasPendingApprovalListener(): boolean {
  return listener !== null;
}

/** Shows the waiting modal; resolves with the user's decision ('dismiss' when no modal is mounted). */
export function awaitPendingApproval(info: PendingApprovalInfo, replayableLater: boolean): Promise<PendingApprovalDecision> {
  return new Promise((resolve) => {
    if (!listener) { resolve('dismiss'); return; }
    listener({ ...info, replayableLater, resolve });
  });
}

// ── replays kept after the modal (no secret): offered once approved ─────────

type Replay = () => Promise<unknown>;
const laterReplays = new Map<number, Replay>();

export function keepReplay(pendingActionId: number, replay: Replay): void {
  laterReplays.set(pendingActionId, replay);
  // Bounded: an approval is consumable 15 min after the decision, the request lives 30 min.
  if (laterReplays.size > 20) laterReplays.delete(laterReplays.keys().next().value as number);
}

export function takeReplay(pendingActionId: number): Replay | null {
  const r = laterReplays.get(pendingActionId) ?? null;
  laterReplays.delete(pendingActionId);
  return r;
}

export function hasReplay(pendingActionId: number): boolean {
  return laterReplays.has(pendingActionId);
}

export function dropReplay(pendingActionId: number): void {
  laterReplays.delete(pendingActionId);
}
