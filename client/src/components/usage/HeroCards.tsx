import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkline } from './UsageCharts';

// Dashboard KPI cards — ported from Obliance (HeroFeatured / HeroCard /
// MiniStat), shared by the dashboard and the usage pages.

/** Featured hero card: big value, sparkline and a short axis of the last points. */
export function HeroFeatured({ label, value, color, series, days, sub }: {
  label: string;
  value: ReactNode;
  color: string;
  series: number[];
  days: { short: string; value: ReactNode }[];
  sub?: ReactNode;
}) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl bg-gradient-to-br from-accent/10 via-bg-secondary to-bg-secondary p-5 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.18)_inset,_0_6px_28px_-10px_rgb(var(--c-accent)/0.25)]">
      <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className={`font-display text-[48px] font-semibold leading-none max-sm:text-[40px] ${color}`}>{value}</div>
      {sub && <div className="mt-2 text-[12px] font-mono text-text-muted">{sub}</div>}
      <div className="mt-3"><Sparkline data={series} color="#98E8C8" /></div>
      {days.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {days.map((d, i) => {
            const isLast = i === days.length - 1;
            return (
              <div key={i} className={`flex min-w-0 flex-col items-start ${isLast ? 'text-text-primary' : 'text-text-muted'}`}>
                <span className="text-[10px] font-mono uppercase tracking-wider">{d.short}</span>
                <span className={`truncate text-[12px] font-mono ${isLast ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{d.value}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function HeroCard({ label, value, color, deltaText, barPct, barColor }: {
  label: string;
  value: ReactNode;
  color: string;
  deltaText?: ReactNode;
  barPct?: number | null;
  barColor?: string;
}) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl bg-bg-secondary p-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
      <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className={`font-display text-[36px] font-semibold leading-none max-sm:text-[32px] ${color}`}>{value}</div>
      {deltaText && (
        <div className="mt-3 text-[12px] font-mono text-text-muted">
          <span className="mr-1">—</span>{deltaText}
        </div>
      )}
      {barPct != null && (
        <div className="mt-2 h-1 w-full rounded bg-white/[0.04]">
          <div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, barPct))}%`, background: barColor ?? 'rgb(var(--c-accent))' }} />
        </div>
      )}
    </div>
  );
}

/**
 * Mini-stat compact card — ported from Obliance. Also the count tiles of the
 * object overviews (account, site): `onClick` (tab of the same page) renders
 * a button, `to` (other page) a link; `tone` colours the sub line.
 */
export function MiniStat({ icon, label, value, sub, color = 'text-text-primary', to, onClick, tone }: {
  icon: ReactNode;
  label: ReactNode;
  /** null = not readable by the caller (« — »). */
  value: ReactNode | null;
  sub?: ReactNode;
  color?: string;
  to?: string;
  onClick?: () => void;
  /** Highlight of the sub line (e.g. something to do). */
  tone?: 'amber' | 'red';
}) {
  const body = (
    <div className="flex items-center gap-3 rounded-lg bg-bg-secondary px-3.5 py-2.5 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_16px_-8px_rgba(0,0,0,0.35)]">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-muted">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
        <div className={`truncate text-[14px] font-semibold leading-tight ${color}`}>{value ?? '—'}</div>
        {sub && <div className={`truncate text-[10px] font-mono ${tone === 'amber' ? 'text-amber-400' : tone === 'red' ? 'text-red-400' : 'text-text-muted'}`}>{sub}</div>}
      </div>
    </div>
  );
  if (to) return <Link to={to} className="block min-w-0 transition-opacity hover:opacity-90">{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className="block w-full min-w-0 text-left transition-opacity hover:opacity-90">{body}</button>;
  return body;
}
