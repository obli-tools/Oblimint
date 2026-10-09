import type { MailAccountLimits, PlanLimits } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Plan limits of the mail objects (docs/P4-PLAN.md §9.1.1) — pure rules,
// unit-tested; mail.service.ts loads the counts under the tenant lock and
// calls them. Every refusal is 409 planLimit with details.dimension ∈
// mailboxes | mailQuota | mailboxQuota | aliases | messageSize.
// ─────────────────────────────────────────────────────────────────────────────

export type MailLimitDimension = 'mailboxes' | 'mailQuota' | 'mailboxQuota' | 'aliases' | 'messageSize';

export function planLimitError(dimension: MailLimitDimension, limit: number | null, message: string): AppError {
  return new AppError(409, message, 'planLimit', { dimension, limit });
}

/** Limits of one account as the API shows them (message size capped by the platform). */
export function mailAccountLimits(plan: PlanLimits, platformMaxMessageSizeMb: number): MailAccountLimits {
  return {
    maxMailboxes: plan.maxMailboxes,
    mailQuotaMb: plan.mailQuotaMb,
    mailboxQuotaMaxMb: plan.mailboxQuotaMaxMb,
    maxMailAliases: plan.maxMailAliases,
    maxMessageSizeMb: Math.max(1, Math.min(plan.mailMaxMessageSizeMb, platformMaxMessageSizeMb)),
    outboundPerHour: plan.mailOutboundPerHour,
    siteOutboundPerHour: plan.mailSiteOutboundPerHour,
  };
}

/** Effective max message size of a domain = min(domain, plan, platform), ≥ 1. */
export function effectiveMessageSizeMb(domainMb: number | null, plan: Pick<PlanLimits, 'mailMaxMessageSizeMb'>, platformMb: number): number {
  const planMb = plan.mailMaxMessageSizeMb;
  return Math.max(1, Math.min(domainMb ?? planMb, planMb, platformMb));
}

/** 409 messageSize when a domain asks more than the plan allows. */
export function assertDomainMessageSize(domainMb: number | null, plan: Pick<PlanLimits, 'mailMaxMessageSizeMb'>): void {
  if (domainMb !== null && domainMb > plan.mailMaxMessageSizeMb) {
    throw planLimitError('messageSize', plan.mailMaxMessageSizeMb, `The plan allows messages of at most ${plan.mailMaxMessageSizeMb} MiB`);
  }
}

/**
 * Quota of a new mailbox when none is given: settings default, capped by the
 * plan's per-mailbox maximum and by what is left of the account total (when
 * something is left: an exhausted total is reported by assertMailboxQuota).
 */
export function defaultMailboxQuotaMb(settingDefaultMb: number, plan: PlanLimits, allocatedMb: number): number {
  let q = Math.max(1, settingDefaultMb);
  if (plan.mailboxQuotaMaxMb !== null) q = Math.min(q, plan.mailboxQuotaMaxMb);
  if (plan.mailQuotaMb !== null) {
    const left = plan.mailQuotaMb - allocatedMb;
    if (left >= 1) q = Math.min(q, left);
  }
  return Math.max(1, q);
}

/**
 * One mailbox quota against the plan. `othersAllocatedMb` = sum of the quotas
 * of the account's OTHER mailboxes (unlimited ones count 0).
 *  - unlimited (null) is refused when the plan bounds one mailbox or the total;
 *  - quota ≤ mailboxQuotaMaxMb;
 *  - othersAllocatedMb + quota ≤ mailQuotaMb.
 */
export function assertMailboxQuota(plan: PlanLimits, quotaMb: number | null, othersAllocatedMb: number): void {
  if (quotaMb === null) {
    if (plan.mailboxQuotaMaxMb !== null) {
      throw planLimitError('mailboxQuota', plan.mailboxQuotaMaxMb, `The plan allows mailboxes of at most ${plan.mailboxQuotaMaxMb} MiB (no unlimited mailbox)`);
    }
    if (plan.mailQuotaMb !== null) {
      throw planLimitError('mailQuota', plan.mailQuotaMb, `The plan bounds the mail storage to ${plan.mailQuotaMb} MiB (no unlimited mailbox)`);
    }
    return;
  }
  if (plan.mailboxQuotaMaxMb !== null && quotaMb > plan.mailboxQuotaMaxMb) {
    throw planLimitError('mailboxQuota', plan.mailboxQuotaMaxMb, `The plan allows mailboxes of at most ${plan.mailboxQuotaMaxMb} MiB`);
  }
  if (plan.mailQuotaMb !== null && othersAllocatedMb + quotaMb > plan.mailQuotaMb) {
    throw planLimitError('mailQuota', plan.mailQuotaMb,
      `The plan allows ${plan.mailQuotaMb} MiB of mailboxes in total (${othersAllocatedMb} MiB already allocated)`);
  }
}

/** One more mailbox in an account holding `count`. */
export function assertMailboxCount(plan: PlanLimits, count: number): void {
  if (plan.maxMailboxes !== null && count >= plan.maxMailboxes) {
    throw planLimitError('mailboxes', plan.maxMailboxes, `The plan allows at most ${plan.maxMailboxes} mailbox(es) for this account`);
  }
}

/** One more alias in an account holding `count`. */
export function assertAliasCount(plan: PlanLimits, count: number): void {
  if (plan.maxMailAliases !== null && count >= plan.maxMailAliases) {
    throw planLimitError('aliases', plan.maxMailAliases, `The plan allows at most ${plan.maxMailAliases} alias(es) for this account`);
  }
}

/** Tenant envelope maxMailboxes (skipped when the tenant may oversell): 409 envelopeExceeded. */
export function assertTenantMailboxRoom(tenant: { maxMailboxes: number | null; allowOversell: boolean }, tenantCount: number): void {
  if (tenant.allowOversell || tenant.maxMailboxes === null) return;
  if (tenantCount >= tenant.maxMailboxes) {
    throw new AppError(409, `The tenant envelope allows at most ${tenant.maxMailboxes} mailboxes`, 'envelopeExceeded',
      [{ dimension: 'maxMailboxes', limit: tenant.maxMailboxes, requested: tenantCount + 1 }]);
  }
}
