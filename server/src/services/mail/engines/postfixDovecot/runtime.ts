import type { MailQueueItemStatus } from '@oblimint/shared';
import type { MailboxUsage, MailQueueEntry } from '../../driver';

// ─────────────────────────────────────────────────────────────────────────────
// PURE parsers of the engine's runtime outputs (runtime.test.ts):
//  - `postqueue -j`: one JSON object per line (Postfix ≥ 3.1);
//  - `doveadm -f json quota get -A`: JSON array, one object per user and
//    quota type (STORAGE in KiB, MESSAGE in messages).
// Both tolerate a truncated last line / malformed entries (skipped).
// ─────────────────────────────────────────────────────────────────────────────

interface PostqueueRecipient { address?: unknown; delay_reason?: unknown }
interface PostqueueJson {
  queue_name?: unknown;
  queue_id?: unknown;
  arrival_time?: unknown;
  message_size?: unknown;
  sender?: unknown;
  recipients?: unknown;
}

const REASON_MAX = 500;

function queueStatus(name: string): MailQueueItemStatus | null {
  switch (name) {
    case 'active':
    case 'incoming':
    case 'maildrop':
      return 'active';
    case 'deferred': return 'deferred';
    case 'hold': return 'hold';
    default: return null;
  }
}

export function parsePostqueueJson(output: string, limit: number): MailQueueEntry[] {
  const out: MailQueueEntry[] = [];
  for (const raw of String(output ?? '').split('\n')) {
    if (out.length >= limit) break;
    const l = raw.trim();
    if (!l.startsWith('{')) continue;
    let j: PostqueueJson;
    try {
      j = JSON.parse(l) as PostqueueJson;
    } catch {
      continue; // truncated / garbage line
    }
    const id = typeof j.queue_id === 'string' ? j.queue_id : '';
    const status = queueStatus(String(j.queue_name ?? ''));
    if (!/^[A-F0-9]{6,20}$/.test(id) || !status) continue;
    const rcpts = Array.isArray(j.recipients) ? (j.recipients as PostqueueRecipient[]) : [];
    const reason = rcpts.map((r) => (typeof r?.delay_reason === 'string' ? r.delay_reason : '')).find(Boolean) ?? null;
    const arrival = Number(j.arrival_time);
    out.push({
      queueId: id,
      sender: typeof j.sender === 'string' ? j.sender.toLowerCase() : '',
      recipients: rcpts.map((r) => (typeof r?.address === 'string' ? r.address.toLowerCase() : '')).filter(Boolean),
      sizeBytes: Number.isFinite(Number(j.message_size)) ? Math.max(0, Math.round(Number(j.message_size))) : 0,
      arrivedAt: new Date(Number.isFinite(arrival) && arrival > 0 ? arrival * 1000 : 0).toISOString(),
      status,
      reason: reason ? (reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason) : null,
      attempts: null,
      nextAttemptAt: null,
    });
  }
  return out;
}

interface QuotaJson { user?: unknown; username?: unknown; type?: unknown; value?: unknown }

export function parseDoveadmQuotaJson(output: string): MailboxUsage[] {
  let rows: unknown;
  try {
    rows = JSON.parse(String(output ?? '').trim() || '[]');
  } catch {
    throw new Error('unreadable doveadm quota output');
  }
  if (!Array.isArray(rows)) throw new Error('unexpected doveadm quota output');
  const byUser = new Map<string, MailboxUsage>();
  for (const r of rows as QuotaJson[]) {
    const user = String(r?.user ?? r?.username ?? '').toLowerCase();
    if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(user)) continue;
    const value = Number(r?.value);
    if (!Number.isFinite(value) || value < 0) continue;
    const u = byUser.get(user) ?? { address: user, usedBytes: 0, messages: null };
    const type = String(r?.type ?? '').toUpperCase();
    if (type === 'STORAGE') u.usedBytes = Math.round(value * 1024);
    else if (type === 'MESSAGE') u.messages = Math.round(value);
    else continue;
    byUser.set(user, u);
  }
  return [...byUser.values()].sort((a, b) => (a.address < b.address ? -1 : 1));
}
