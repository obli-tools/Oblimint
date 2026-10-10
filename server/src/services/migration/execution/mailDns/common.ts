import { createHash } from 'crypto';
import type { MigrationFollowUp, MigrationScopeKind, MigrationSeverity, MigrationWarning } from '@oblimint/shared';
import type { MigrationStepContext, MigrationStepOutcome } from '../../contracts/execution';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers shared by the mail-dns steps (pure).
// ─────────────────────────────────────────────────────────────────────────────

export type Params = Record<string, string | number | boolean | null>;

export function warning(
  ctx: Pick<MigrationStepContext, 'run'>,
  code: string,
  severity: MigrationSeverity,
  scope: { kind: MigrationScopeKind; key: string },
  params?: Params,
): MigrationWarning {
  return { code, severity, scope: { ...scope, account: ctx.run.cwpUsername }, ...(params ? { params } : {}) };
}

export function followUp(
  ctx: Pick<MigrationStepContext, 'run'>,
  code: string,
  scope: { kind: MigrationScopeKind; key: string },
  suggestion: MigrationFollowUp['suggestion'] = 'manual',
  params?: Params,
): MigrationFollowUp {
  return { code, suggestion, scope: { ...scope, account: ctx.run.cwpUsername }, ...(params ? { params } : {}) };
}

/** Status of an outcome: 'warning' as soon as one warning is not informational. */
export function outcome(result: Record<string, unknown>, warnings: MigrationWarning[] = [], followUps: MigrationFollowUp[] = []): MigrationStepOutcome {
  const status = warnings.some((w) => w.severity !== 'info') ? 'warning' : 'done';
  return { status, result, ...(warnings.length ? { warnings } : {}), ...(followUps.length ? { followUps } : {}) };
}

export function skipped(result: Record<string, unknown>, warnings: MigrationWarning[] = [], followUps: MigrationFollowUp[] = []): MigrationStepOutcome {
  return { status: 'skipped', result, ...(warnings.length ? { warnings } : {}), ...(followUps.length ? { followUps } : {}) };
}

/** AppError-like (statusCode + code) without importing the class (doubles throw plain objects too). */
export function errorCode(err: unknown): { status: number | null; code: string | null } {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  return {
    status: typeof e?.statusCode === 'number' ? e.statusCode : null,
    code: typeof e?.code === 'string' ? e.code : null,
  };
}

export function isClientError(err: unknown, ...codes: string[]): boolean {
  const { status, code } = errorCode(err);
  if (status === null || status >= 500) return false;
  return codes.length === 0 || (code !== null && codes.includes(code));
}

export const lower = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');

/** 'local@domain' → parts (lower case). '@domain' = catch-all (local ''). */
export function splitMailAddress(address: string): { local: string; domain: string } {
  const a = lower(address);
  const at = a.lastIndexOf('@');
  return at < 0 ? { local: a, domain: '' } : { local: a.slice(0, at), domain: a.slice(at + 1) };
}

/** Owner name of a planned record relative to its zone ('@' apex). Absolute names outside the zone are returned as is (validation refuses them). */
export function ownerRelativeTo(name: string, zone: string): string {
  const n = lower(name);
  const z = lower(zone);
  if (n === '' || n === '@' || n === z) return '@';
  if (n.endsWith(`.${z}`)) return n.slice(0, -(z.length + 1));
  return n;
}

/**
 * Fingerprint of a credential hash the migration wrote (object map meta: "what was applied", never the
 * hash itself). A later refresh only overwrites the target while it still holds what WE wrote: a password
 * changed on Oblimint (leak, reset by the owner / staff) is never put back to the old CWP one.
 */
export function credentialDigest(hash: string): string {
  return createHash('sha256').update(`oblimint-migration:${hash}`).digest('hex').slice(0, 32);
}

/**
 * Owner a mapped object must have before a mail-dns step reuses it: recorded for this CWP user, and a
 * row of the run's target account (objectMap.resolveOwned). A key reassigned on CWP to another user
 * (domain sold…) never makes this run write into the first user's zone / mail domain / mailbox.
 */
export function runOwner(ctx: Pick<MigrationStepContext, 'run' | 'targetAccountId'>): { cwpUsername: string; accountId: number | null } {
  return { cwpUsername: ctx.run.cwpUsername, accountId: ctx.targetAccountId() };
}
