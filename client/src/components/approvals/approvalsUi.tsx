import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import type { PendingAction, PendingActionStatus, RestrictionLevel } from '@oblimint/shared';
import { Pill, type Tone } from '@/components/common/Pill';
import { remaining } from '@/api/pendingReplay';

// Shared pieces of the Approvals page and the waiting modal (ported from
// Obliance ApprovalsPage: statusPill, formatCountdown).

const STATUS_TONE: Record<PendingActionStatus, Tone> = {
  pending: 'amber',
  approved: 'green',
  consumed: 'green',
  denied: 'red',
  expired: 'muted',
  cancelled: 'muted',
};

const STATUS_FALLBACK: Record<PendingActionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  consumed: 'Executed',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** Status shown: a pending request past its expiry reads « expired » until the sweep (≤ 1 min). */
export function shownStatus(a: Pick<PendingAction, 'status' | 'expiresAt' | 'consumeBy'>, now = Date.now()): PendingActionStatus {
  if (a.status === 'pending' && new Date(a.expiresAt).getTime() <= now) return 'expired';
  if (a.status === 'approved' && a.consumeBy && new Date(a.consumeBy).getTime() <= now) return 'expired';
  return a.status;
}

export function StatusPill({ status, t }: { status: PendingActionStatus; t: TFunction }) {
  return <Pill tone={STATUS_TONE[status]} className="text-[10px]">{t(`approvals.status.${status}`) || STATUS_FALLBACK[status]}</Pill>;
}

export function LevelPill({ level, t }: { level: Exclude<RestrictionLevel, 'none'>; t: TFunction }) {
  return level === 'restricted'
    ? <Pill tone="red" className="text-[10px]">{t('restrictions.level.restricted') || 'Approval'}</Pill>
    : <Pill tone="orange" className="text-[10px]">{t('restrictions.level.sensitive') || '2FA'}</Pill>;
}

/** Readable label of a catalogue action (falls back to its key). */
export function actionLabel(t: TFunction, key: string): string {
  const k = `restrictions.actions.${key.replace(/\./g, '_')}`;
  return t(k, { defaultValue: key });
}

/** « 12m 04s » until `iso`, « expired » once past. */
export function formatCountdown(iso: string | null, t: TFunction, now = Date.now()): string {
  const r = remaining(iso, now);
  if (!r) return t('approvals.status.expired') || 'Expired';
  return t('approvals.countdown', { m: r.minutes, s: String(r.seconds).padStart(2, '0'), defaultValue: '{{m}}m {{s}}s' });
}

/** Re-renders every second (live countdowns). */
export function useTick(enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const h = window.setInterval(() => setN((x) => x + 1), 1000);
    return () => window.clearInterval(h);
  }, [enabled]);
  return n;
}

/** Who asked, and through what (« via the key "CI" », « via a Claude connector »). */
export function requesterLine(a: PendingAction, t: TFunction): string {
  const who = a.requestedBy?.displayName || a.requestedBy?.username || (a.requestedBy ? `#${a.requestedBy.id}` : '—');
  if (a.via === 'key' && a.apiKey) return t('approvals.viaKey', { who, key: a.apiKey.name, defaultValue: '{{who}}, via the access key « {{key}} »' });
  if (a.via === 'connector') return t('approvals.viaConnector', { who, key: a.apiKey?.name ?? 'Claude', defaultValue: '{{who}}, via the connector « {{key}} »' });
  return t('approvals.viaPanel', { who, defaultValue: '{{who}}, in the panel' });
}
