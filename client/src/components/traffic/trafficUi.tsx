import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyTrafficRange } from '@oblimint/shared';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';

// Shared pieces of the traffic pages. OWNED BY MODULE `ui-proxy`.

/** Traffic aggregates are flushed every minute and no socket event carries them: poll while the page is visible. */
export const TRAFFIC_POLL_MS = 60_000;

/** Calls `load` every `ms` while the tab is visible, and once when it becomes visible again. */
export function useVisiblePoll(load: () => void, ms: number = TRAFFIC_POLL_MS): void {
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const timer = setInterval(() => { if (visible()) ref.current(); }, ms);
    const onVisibility = () => { if (visible()) ref.current(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [ms]);
}

export const TRAFFIC_RANGES: readonly ProxyTrafficRange[] = ['1h', '6h', '24h', '7d', '30d', '90d'];

export function isTrafficRange(v: string | null): v is ProxyTrafficRange {
  return v !== null && (TRAFFIC_RANGES as readonly string[]).includes(v);
}

/** Status colours (2xx green, 3xx blue, 4xx amber, 5xx red — Obliance status palette). */
export const STATUS_COLORS = { s2xx: '#1edd8a', s3xx: '#38bdf8', s4xx: '#f5a623', s5xx: '#ff6868' } as const;
export const LATENCY_COLORS = { p50: '#1edd8a', p95: '#f5a623', p99: '#ff6868' } as const;

export function RangeTabs({ value, onChange }: { value: ProxyTrafficRange; onChange: (r: ProxyTrafficRange) => void }) {
  const { t } = useTranslation();
  return (
    <SegmentedTabs<ProxyTrafficRange>
      size="sm"
      fill={false}
      tabs={TRAFFIC_RANGES.map((r) => ({ id: r, label: r }))}
      value={value}
      onChange={onChange}
      ariaLabel={t('traffic.range') || 'Period'}
    />
  );
}

/** Milliseconds → "38 ms" / "1.2 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms)} ms`;
}

/** 0…1 → "3.4 %". */
export function formatPct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  const p = rate * 100;
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10} %`;
}

/** X label of a bucket: time of day within 24 h, else day / month. */
export function bucketLabel(iso: string, range: ProxyTrafficRange, lang: string): string {
  const d = new Date(iso);
  if (range === '1h' || range === '6h' || range === '24h') return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  if (range === '7d') return d.toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit' });
  return d.toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
}

/** Stat tile of the traffic pages (Obliance hero card look). */
export function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-bg-secondary px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="mt-1 truncate font-display text-2xl font-semibold text-text-primary" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}
