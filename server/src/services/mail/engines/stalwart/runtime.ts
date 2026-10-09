import type { MailboxUsage, MailQueueEntry } from '../../driver';
import type { StalwartPrincipal } from './api';
import { isMailAddress } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE mapping of the admin API answers to the driver's runtime types
// (runtime.test.ts with recorded fixtures). Tolerant of the 0.11 queue shape
// (domains[].recipients[]) and the flatter 0.12 one (recipients[] with their
// own status / retry fields) — api.ts H9.
// ─────────────────────────────────────────────────────────────────────────────

/** Queue ids of Stalwart are unsigned 64-bit integers (decimal); hex tolerated. */
export const QUEUE_ID_RE = /^[0-9A-Fa-f]{1,20}$/;

export function usageFromPrincipals(items: StalwartPrincipal[]): MailboxUsage[] {
  return items
    .filter((p) => isMailAddress(p.name) && p.usedQuota !== null)
    .map((p) => ({ address: p.name.toLowerCase(), usedBytes: Math.max(0, Math.round(p.usedQuota ?? 0)), messages: null }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A recipient / domain status: 'scheduled' | 'completed' | {temp_fail|perm_fail: {...}} | "TempFail" … */
function statusOf(v: unknown): { kind: 'scheduled' | 'done' | 'temp' | 'perm'; reason: string | null } {
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s.includes('temp')) return { kind: 'temp', reason: null };
    if (s.includes('perm')) return { kind: 'perm', reason: null };
    if (s === 'completed' || s === 'delivered' || s === 'done') return { kind: 'done', reason: null };
    return { kind: 'scheduled', reason: null };
  }
  if (v && typeof v === 'object') {
    const [k, detail] = Object.entries(v as Record<string, unknown>)[0] ?? [];
    const key = String(k ?? '').toLowerCase();
    const reason = detail && typeof detail === 'object'
      ? str((detail as Record<string, unknown>).response) ?? str((detail as Record<string, unknown>).details)
        ?? str((detail as Record<string, unknown>).reason) ?? JSON.stringify(detail).slice(0, 300)
      : str(detail);
    if (key.includes('temp')) return { kind: 'temp', reason: reason ? reason.slice(0, 500) : null };
    if (key.includes('perm')) return { kind: 'perm', reason: reason ? reason.slice(0, 500) : null };
    if (key.includes('complet') || key.includes('deliver')) return { kind: 'done', reason: null };
  }
  return { kind: 'scheduled', reason: null };
}

export function queueEntryFromApi(m: Record<string, unknown>): MailQueueEntry | null {
  const queueId = str(m.id);
  if (!queueId || !QUEUE_ID_RE.test(queueId)) return null;
  const recipients: string[] = [];
  let temp = false;
  let reason: string | null = null;
  let attempts: number | null = null;
  let next: string | null = null;
  const take = (r: Record<string, unknown>) => {
    const st = statusOf(r.status);
    const addr = str(r.address) ?? str(r.address_lcase) ?? str(r.rcpt);
    if (addr && st.kind !== 'done') recipients.push(addr.toLowerCase());
    if (st.kind === 'temp') temp = true;
    if (!reason && st.reason) reason = st.reason;
    const n = Number(r.retry_num ?? r.retryNum);
    if (Number.isFinite(n)) attempts = Math.max(attempts ?? 0, n);
    const nr = isoOrNull(r.next_retry ?? r.nextRetry);
    if (nr && (!next || nr < next)) next = nr;
  };
  if (Array.isArray(m.domains)) {
    for (const d of m.domains as Array<Record<string, unknown>>) {
      if (!d || typeof d !== 'object') continue;
      const dst = statusOf(d.status);
      if (dst.kind === 'temp') temp = true;
      if (!reason && dst.reason) reason = dst.reason;
      const n = Number(d.retry_num);
      if (Number.isFinite(n)) attempts = Math.max(attempts ?? 0, n);
      const nr = isoOrNull(d.next_retry);
      if (nr && (!next || nr < next)) next = nr;
      for (const r of Array.isArray(d.recipients) ? d.recipients as Array<Record<string, unknown>> : []) if (r && typeof r === 'object') take(r);
    }
  }
  if (Array.isArray(m.recipients)) {
    for (const r of m.recipients as Array<Record<string, unknown>>) if (r && typeof r === 'object') take(r);
  }
  return {
    queueId,
    sender: (str(m.return_path) ?? str(m.returnPath) ?? str(m.from) ?? '').toLowerCase(),
    recipients: [...new Set(recipients)],
    sizeBytes: Math.max(0, Number(m.size) || 0),
    arrivedAt: isoOrNull(m.created) ?? new Date(0).toISOString(),
    status: temp ? 'deferred' : 'active',
    reason,
    attempts,
    nextAttemptAt: next,
  };
}

export function queueFromApi(items: Array<Record<string, unknown>>, limit: number): MailQueueEntry[] {
  const out: MailQueueEntry[] = [];
  for (const m of items) {
    const e = queueEntryFromApi(m);
    if (e) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
