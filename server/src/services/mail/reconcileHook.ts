import type { PlanLimits } from '@oblimint/shared';
import type { AccountPassContext, AccountPassHook } from '../docker/extensions';
import { mailService } from './mail.service';

// ─────────────────────────────────────────────────────────────────────────────
// afterAccountPass hook 'mail' (docs/P4-PLAN.md §7, §9.1) — module mail-core.
// Runs INSIDE the account lock after every reconcile pass: in-memory compare
// only (no DB, no Docker), never withAccountLock / reconcileAccountNow.
// Status (active / suspended / deleting…) or the mail limits of the plan
// changed since the last pass ⇒ mailService.accountChanged() (debounced sync:
// logins / sending of a suspended account cut, inbound kept). The first pass
// of an account after a boot only records it (the boot sync covers it).
// ─────────────────────────────────────────────────────────────────────────────

const MAIL_PLAN_KEYS = [
  'maxMailboxes', 'mailQuotaMb', 'mailboxQuotaMaxMb', 'maxMailAliases', 'mailMaxMessageSizeMb', 'mailOutboundPerHour', 'mailSiteOutboundPerHour',
] as const satisfies ReadonlyArray<keyof PlanLimits>;

/** Fingerprint of what the mail state depends on in an account (pure). */
export function mailAccountFingerprint(status: string, limits: Partial<PlanLimits>): string {
  return JSON.stringify([status, ...MAIL_PLAN_KEYS.map((k) => limits[k] ?? null)]);
}

const lastSeen = new Map<number, { status: string; fingerprint: string }>();

export const mailReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    const account = ctx.state.account;
    const fingerprint = mailAccountFingerprint(account.status, account.limits);
    const prev = lastSeen.get(account.id);
    lastSeen.set(account.id, { status: account.status, fingerprint });
    if (!prev || prev.fingerprint === fingerprint) return;
    const reason = prev.status !== account.status ? `status ${prev.status} → ${account.status}` : 'plan limits changed';
    mailService.accountChanged(account.id, reason);
  },
};

/** Tests: forget what the hook saw. */
export function resetMailReconcileHookForTests(): void {
  lastSeen.clear();
}
