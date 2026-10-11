import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MEDIA, useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/utils/cn';
import { uptimeColor } from './appsFormat';

// Hand-made SVG charts (docs/P4b-PLAN.md §13: no chart library), ported from
// the Obliance dashboard (Sparkline, ActivityChart). OWNED BY MODULE `ui-apps`.

/** Filled area + line, no axis (lists, cards). Null values are skipped. */
export function Sparkline({ values, color = '#1edd8a', height = 28, className }: {
  values: Array<number | null>;
  color?: string;
  height?: number;
  className?: string;
}) {
  const gid = useId().replace(/:/g, '');
  const data = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (data.length < 2) return <div style={{ height }} className={className} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 4) - 2]);
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }} className={cn('block', className)} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.40" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export interface ChartSeries {
  label: string;
  color: string;
  /** Same length as the x labels; null = gap. */
  values: Array<number | null>;
  /** Filled area under the line (first series by default). */
  area?: boolean;
  dashed?: boolean;
}

/**
 * Time series chart with a y grid (0 / ½ / max), first / middle / last x
 * labels and a legend — Obliance ActivityChart geometry (800×240 stretched on
 * desktop, measured width below lg so the labels keep a real 10 px).
 */
export function TimeChart({ series, labels, formatY, height = 220, emptyText }: {
  series: ChartSeries[];
  labels: string[];
  formatY?: (v: number) => string;
  height?: number;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const gid = useId().replace(/:/g, '');
  const isDesktop = useMediaQuery(MEDIA.lg);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    if (isDesktop) return;
    const el = wrapRef.current;
    if (!el) return;
    const upd = () => setMeasured(Math.round(el.getBoundingClientRect().width));
    upd();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop, labels.length]);

  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
  if (labels.length < 2 || all.length < 2) {
    return (
      <div ref={wrapRef} className="flex items-center justify-center text-sm text-text-muted" style={{ height }}>
        {emptyText ?? (t('apps.charts.noData') || 'Not enough data yet.')}
      </div>
    );
  }
  const yMax = Math.max(...all, 0) || 1;
  const narrow = !isDesktop && measured > 0;
  const w = narrow ? Math.max(measured, 240) : 800;
  const h = height;
  const pad = { l: 52, r: 12, t: 12, b: 26 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const n = labels.length;
  const xOf = (i: number) => pad.l + (i / (n - 1)) * cw;
  const yOf = (v: number) => pad.t + (1 - v / yMax) * ch;
  const fmt = formatY ?? ((v: number) => String(Math.round(v)));

  const pathOf = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const areaOf = (values: Array<number | null>) => {
    const idx = values.map((v, i) => (v == null || !Number.isFinite(v) ? -1 : i)).filter((i) => i >= 0);
    if (idx.length < 2) return '';
    const line = idx.map((i, k) => `${k === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(values[i] as number).toFixed(1)}`).join(' ');
    return `${line} L${xOf(idx[idx.length - 1]).toFixed(1)},${pad.t + ch} L${xOf(idx[0]).toFixed(1)},${pad.t + ch} Z`;
  };
  const ticks = [0, 0.5, 1].map((k) => yMax * k);
  const xIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];

  return (
    <div ref={wrapRef} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} className="block w-full" preserveAspectRatio="none" style={narrow ? { height: h } : undefined} role="img">
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={yOf(v)} y2={yOf(v)} stroke="rgb(var(--c-text-muted) / 0.12)" strokeWidth="1" />
            {/* The ½ label is dropped when it rounds to a neighbour (yMax 1 → 0 / 1 / 1). */}
            {(i !== 1 || (fmt(v) !== fmt(ticks[0]) && fmt(v) !== fmt(ticks[2]))) && (
              <text x={pad.l - 6} y={yOf(v) + 3} fontSize="10" fontFamily="'JetBrains Mono', Consolas, monospace" fill="rgb(var(--c-text-muted))" textAnchor="end">{fmt(v)}</text>
            )}
          </g>
        ))}
        {series.map((s, si) => ((s.area ?? si === 0) ? <path key={`a${si}`} d={areaOf(s.values)} fill={`url(#${gid}-${si})`} /> : null))}
        {series.map((s, si) => (
          <path key={`l${si}`} d={pathOf(s.values)} fill="none" stroke={s.color} strokeWidth="1.7" strokeLinejoin="round" strokeDasharray={s.dashed ? '4 3' : undefined} />
        ))}
        {xIdx.map((i) => (
          <text key={i} x={xOf(i)} y={h - 8} fontSize="10" fontFamily="'JetBrains Mono', Consolas, monospace" fill="rgb(var(--c-text-muted))" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
            {labels[i]}
          </text>
        ))}
      </svg>
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />{s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One bar per day (oldest first), coloured by uptime — status pages / monitor detail. */
export function UptimeBars({ days, lang, height = 30 }: {
  days: Array<{ day: string; uptime: number | null }>;
  lang: string;
  height?: number;
}) {
  const { t } = useTranslation();
  if (days.length === 0) return null;
  return (
    <div className="flex w-full items-end gap-[2px]" style={{ height }} role="img" aria-label={t('apps.charts.uptimeBars') || 'Daily uptime'}>
      {days.map((d) => {
        const label = `${new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang)} — ${d.uptime == null ? (t('apps.charts.noDataShort') || 'no data') : `${(d.uptime * 100).toFixed(2)} %`}`;
        return (
          <span
            key={d.day}
            title={label}
            className="min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70"
            style={{ height: '100%', background: uptimeColor(d.uptime) }}
          />
        );
      })}
    </div>
  );
}

/** Horizontal used / limit bar with label ("1.2 / 2 cores"). */
export function UsageMeter({ label, used, limit, format }: {
  label: string;
  used: number;
  limit: number | null;
  format: (v: number) => string;
}) {
  const { t } = useTranslation();
  const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : null;
  const color = pct == null ? 'rgb(var(--c-text-muted))' : pct >= 100 ? '#ef4444' : pct >= 80 ? '#f5b544' : '#1edd8a';
  return (
    <div className="min-w-0 rounded-lg bg-bg-primary p-2.5">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="truncate font-mono uppercase tracking-[0.12em] text-text-muted">{label}</span>
        <span className="ml-auto shrink-0 font-mono text-text-secondary">
          {format(used)}<span className="text-text-muted"> / {limit == null ? (t('hostingCommon.unlimited') || 'unlimited') : format(limit)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full rounded bg-white/[0.04]">
        <div className="h-full rounded" style={{ width: `${pct ?? 0}%`, background: color }} />
      </div>
    </div>
  );
}
