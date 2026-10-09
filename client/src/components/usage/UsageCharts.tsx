import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MEDIA, useMediaQuery } from '@/hooks/useMediaQuery';
import { niceMax, quotaColor } from './usageFormat';

// Hand-written SVG charts of the usage pages — ported from Obliance's
// dashboard (Sparkline, ActivityChart, OsDonut, ComplianceGauge): no chart
// library, theme colours through the CSS variables.

const AXIS_TEXT = 'rgb(var(--c-text-muted))';
const GRID = 'rgba(255,255,255,0.05)';

// ── Sparkline (filled area + line) — ported from Obliance ───────────────────

export function Sparkline({ data, color, height = 36 }: { data: number[]; color: string; height?: number }) {
  const uid = useId().replace(/[^a-z0-9]/gi, '');
  if (data.length < 2) return <div style={{ height }} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const id = `sg-${uid}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }} className="block" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.40" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${id})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Width of the chart box below lg: like Obliance's ActivityChart, the desktop
 * keeps a fixed viewBox stretched to the card, phones get a viewBox that
 * follows the measured width so the 10 px axis labels stay readable.
 */
function useChartWidth(deps: unknown): { ref: React.RefObject<HTMLDivElement>; narrow: boolean; width: number } {
  const isDesktop = useMediaQuery(MEDIA.lg);
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    if (isDesktop) return;
    const el = ref.current;
    if (!el) return;
    const update = () => setMeasured(Math.round(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop, deps]);
  const narrow = !isDesktop && measured > 0;
  return { ref, narrow, width: narrow ? Math.max(measured, 240) : 800 };
}

function NotEnoughData({ height, text }: { height: number; text?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div style={{ height }} className="flex items-center justify-center text-center text-sm text-text-muted">
      {text ?? (t('usage.chart.noData') || 'No data for this period yet.')}
    </div>
  );
}

// ── Bar chart (daily traffic) ───────────────────────────────────────────────

export interface BarPoint { label: string; value: number; title?: string }

/** Vertical bars with a 3-line grid and first / middle / last x labels. */
export function BarChart({ data, color = '#ff6868', height = 220, formatValue, emptyText }: {
  data: BarPoint[];
  color?: string;
  height?: number;
  formatValue: (v: number) => string;
  emptyText?: ReactNode;
}) {
  const { ref, narrow, width: w } = useChartWidth(data.length);
  const h = narrow ? Math.min(height, 200) : height;
  if (data.length === 0 || data.every((d) => d.value === 0)) return <div ref={ref}><NotEnoughData height={h} text={emptyText} /></div>;
  const yMax = niceMax(Math.max(...data.map((d) => d.value)));
  const pad = { l: 56, r: 10, t: 12, b: 26 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const slot = cw / data.length;
  const bw = Math.max(1, Math.min(slot * 0.7, 26));
  const yOf = (v: number) => pad.t + (1 - v / yMax) * ch;
  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const labelIdx = data.length <= 2 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1];
  return (
    <div ref={ref} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} className="block w-full" preserveAspectRatio="none" style={narrow ? { height: h } : undefined} role="img">
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={yOf(v)} y2={yOf(v)} stroke={GRID} strokeWidth="1" />
            <text x={pad.l - 6} y={yOf(v) + 3} fontSize="10" fontFamily="JetBrains Mono" fill={AXIS_TEXT} textAnchor="end">{formatValue(v)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          const y = yOf(d.value);
          const bh = Math.max(d.value > 0 ? 1.5 : 0, pad.t + ch - y);
          return (
            <rect key={i} x={x} y={pad.t + ch - bh} width={bw} height={bh} rx={Math.min(2, bw / 3)} fill={color} fillOpacity={0.85}>
              <title>{d.title ?? `${d.label} · ${formatValue(d.value)}`}</title>
            </rect>
          );
        })}
        {labelIdx.map((i) => (
          <text key={i} x={pad.l + i * slot + slot / 2} y={h - 8} fontSize="10" fontFamily="JetBrains Mono" fill={AXIS_TEXT} textAnchor="middle">
            {data[i].label}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ── Line chart (resources) ──────────────────────────────────────────────────

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
  /** Filled area under the line. */
  area?: boolean;
}

/**
 * Lines over shared x labels (ActivityChart style). `yMax` fixes the axis
 * (e.g. 100 for percentages), otherwise it is rounded up from the data.
 */
export function LineChart({ series, labels, height = 220, formatValue, yMax: fixedMax, emptyText }: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  formatValue: (v: number) => string;
  yMax?: number;
  emptyText?: ReactNode;
}) {
  const uid = useId().replace(/[^a-z0-9]/gi, '');
  const { ref, narrow, width: w } = useChartWidth(labels.length);
  const h = narrow ? Math.min(height, 200) : height;
  if (labels.length < 2) return <div ref={ref}><NotEnoughData height={h} text={emptyText} /></div>;
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values));
  const yMax = fixedMax ?? niceMax(dataMax);
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const xOf = (i: number) => pad.l + (i / (labels.length - 1)) * cw;
  const yOf = (v: number) => pad.t + (1 - Math.min(v, yMax) / yMax) * ch;
  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const labelIdx = [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  return (
    <div ref={ref} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} className="block w-full" preserveAspectRatio="none" style={narrow ? { height: h } : undefined} role="img">
        <defs>
          {series.filter((s) => s.area).map((s) => (
            <linearGradient key={s.key} id={`lc-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.30" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={yOf(v)} y2={yOf(v)} stroke={GRID} strokeWidth="1" />
            <text x={pad.l - 6} y={yOf(v) + 3} fontSize="10" fontFamily="JetBrains Mono" fill={AXIS_TEXT} textAnchor="end">{formatValue(v)}</text>
          </g>
        ))}
        {series.map((s) => {
          if (s.values.length < 2) return null;
          const d = path(s.values);
          return (
            <g key={s.key}>
              {s.area && <path d={`${d} L${xOf(s.values.length - 1)},${pad.t + ch} L${xOf(0)},${pad.t + ch} Z`} fill={`url(#lc-${uid}-${s.key})`} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.4 : 1.8} strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" />
            </g>
          );
        })}
        {labelIdx.map((i, k) => (
          <text key={k} x={xOf(i)} y={h - 8} fontSize="10" fontFamily="JetBrains Mono" fill={AXIS_TEXT} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>
            {labels[i]}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** Colour dot + label legend of a chart. */
export function ChartLegend({ items }: { items: Array<{ label: string; color: string; dashed?: boolean }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5 text-[11px] font-mono text-text-muted">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: it.dashed ? `repeating-linear-gradient(90deg, ${it.color} 0 4px, transparent 4px 7px)` : it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ── Donut — ported from Obliance (OsDonut) ──────────────────────────────────

export interface DonutSlice { name: string; value: number; color: string; to?: string; display?: string }

export function Donut({ slices, total, centerText, centerSub }: { slices: DonutSlice[]; total: number; centerText: string; centerSub: string }) {
  let cumulative = 0;
  const arcs = slices.map((s) => {
    const len = total > 0 ? (s.value / total) * 100 : 0;
    const offset = -cumulative + 25;
    cumulative += len;
    return { ...s, len, offset };
  });
  return (
    <div className="flex items-center gap-5 max-sm:flex-col max-sm:items-stretch">
      <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0 max-sm:self-center" aria-hidden="true">
        <circle cx="21" cy="21" r="15.915" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="3.5" />
        {arcs.map((a) => (
          <circle key={a.name} cx="21" cy="21" r="15.915" fill="none" stroke={a.color} strokeWidth="3.5"
            strokeDasharray={`${a.len} ${100 - a.len}`} strokeDashoffset={a.offset} transform="rotate(-90 21 21)" />
        ))}
        <text x="21" y="20" textAnchor="middle" dominantBaseline="middle" fill="rgb(var(--c-text-primary))" fontSize="5.5" fontWeight="600">{centerText}</text>
        <text x="21" y="26" textAnchor="middle" dominantBaseline="middle" fill="rgb(var(--c-text-muted))" fontSize="2.6" fontFamily="JetBrains Mono">{centerSub}</text>
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {slices.map((s) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
          const inner = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{s.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-text-muted">{s.display ?? s.value} · {pct}%</span>
            </>
          );
          return s.to ? (
            <Link key={s.name} to={s.to} className="-mx-1.5 flex items-center gap-3 rounded px-1.5 py-0.5 text-[13px] transition-colors hover:bg-bg-hover">{inner}</Link>
          ) : (
            <div key={s.name} className="flex items-center gap-3 text-[13px]">{inner}</div>
          );
        })}
      </div>
    </div>
  );
}

/** Palette of the donut slices (accent first, then the Obliance status colours). */
export const SLICE_COLORS = ['#ff6868', '#1edd8a', '#f5a623', '#38bdf8', '#a78bfa', '#f472b6', 'rgb(var(--c-text-muted))'];

// ── Semi-circular quota gauge — ported from Obliance (ComplianceGauge) ──────

export function GaugeArc({ pct, label }: { pct: number | null; label: string }) {
  const shown = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 42 28" className="w-28" aria-hidden="true">
      <path d="M3 25 A18 18 0 0 1 39 25" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3.5" strokeLinecap="round" pathLength="100" />
      {pct != null && (
        <path d="M3 25 A18 18 0 0 1 39 25" fill="none" stroke={quotaColor(pct)} strokeWidth="3.5" strokeLinecap="round" pathLength="100" strokeDasharray={`${shown} 100`} />
      )}
      <text x="21" y="22" textAnchor="middle" fill="rgb(var(--c-text-primary))" fontSize="8" fontWeight="700" fontFamily="Rajdhani">{label}</text>
    </svg>
  );
}

/** Thin horizontal usage bar (80 / 100 % colours). */
export function UsageBar({ pct, className }: { pct: number | null; className?: string }) {
  return (
    <div className={`h-1 w-full rounded bg-white/[0.04] ${className ?? ''}`}>
      <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: quotaColor(pct) }} />
    </div>
  );
}
