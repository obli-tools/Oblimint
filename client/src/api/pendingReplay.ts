import { PENDING_ACTION_HEADER } from '@oblimint/shared';

// Pure helpers of the panel's "pending approval" flow (spec §6.2): a
// 'restricted' action answered 202 pendingApproval; once a second person
// approves it, the very same request is sent again with the approval's id
// (header X-Oblimint-Approval) and the server consumes the approval.
// No secret outlives the waiting modal: a request whose body names a secret
// field (password, token…) or carries a file is never kept for a later replay.

export interface PendingApprovalInfo {
  pendingActionId: number;
  description: string | null;
  expiresAt: string | null;
}

/** The 202 body of a panel action filed for approval, or null. */
export function parsePendingApproval(status: number | undefined, body: unknown): PendingApprovalInfo | null {
  if (status !== 202 || !body || typeof body !== 'object') return null;
  const d = (body as { data?: unknown }).data as { status?: unknown; pendingActionId?: unknown; description?: unknown; expiresAt?: unknown } | undefined;
  if (!d || typeof d !== 'object' || d.status !== 'pendingApproval') return null;
  const id = Number(d.pendingActionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    pendingActionId: id,
    description: typeof d.description === 'string' ? d.description : null,
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : null,
  };
}

// Same rule as the server (restrictions/canonical.ts isSecretKey) and the
// Approvals page: a credential-named field. Identifiers (…Id) are not secrets.
const SECRET_FIELD = /(password|passwd|passphrase|^pwd$|^pass$|secret|token|apikey|privatekey|credential|twofactorcode|^totp|^otp$|assertion|sshkey|publickey)/;

export function isSecretField(key: string): boolean {
  if (key.includes('.')) return false;
  const n = key.toLowerCase().replace(/[_\-\s]/g, '');
  if (/(id|ids)$/.test(n)) return false;
  return SECRET_FIELD.test(n);
}

function hasSecret(v: unknown, depth = 0): boolean {
  if (depth > 8 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasSecret(x, depth + 1));
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (isSecretField(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean') return true;
    if (hasSecret(x, depth + 1)) return true;
  }
  return false;
}

/**
 * True when the request body must not be kept after the waiting modal
 * closes: a secret-named field (`{ secret: true, value }` env rows included),
 * a file / binary body, or an unreadable one.
 */
export function bodyCarriesSecret(data: unknown): boolean {
  if (data === undefined || data === null || data === '') return false;
  if (typeof data === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return true; }
    return bodyCarriesSecret(parsed);
  }
  if (typeof FormData !== 'undefined' && data instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return true;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return true;
  if (typeof data !== 'object') return false;
  if (hasSecret(data)) return true;
  // Environment rows marked secret: { key, value, secret: true }.
  const rows = JSON.stringify(data);
  return /"secret"\s*:\s*true/.test(rows);
}

export interface ReplayableConfig {
  headers?: Record<string, unknown> | unknown;
  [k: string]: unknown;
}

/** The original request again, naming its approval (never re-filed as a new one by the interceptor). */
export function replayConfig<T extends ReplayableConfig>(config: T, pendingActionId: number): T {
  const headers = { ...((config.headers ?? {}) as Record<string, unknown>), [PENDING_ACTION_HEADER]: String(pendingActionId) };
  return { ...config, headers, _pendingReplay: pendingActionId };
}

/** Countdown text pieces until `iso` (null once past). */
export function remaining(iso: string | null, now = Date.now()): { minutes: number; seconds: number } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { minutes: Math.floor(ms / 60_000), seconds: Math.floor((ms % 60_000) / 1000) };
}
