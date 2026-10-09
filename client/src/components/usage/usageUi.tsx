import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, Ban, BellRing, ChevronLeft, ChevronRight, Lock, PauseCircle } from 'lucide-react';
import type { OverQuotaState, QuotaDimension, QuotaGauge, ResourcePoint, UsageAlert } from '@oblimint/shared';
import { IconButton } from '@/components/common/IconButton';
import { Pill } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { GaugeArc, UsageBar } from './UsageCharts';
import { formatBytes, formatCount, isoMonth, shiftMonth, type ByteUnits } from './usageFormat';

/** Translated byte units + formatter. */
export function useByteFormat(): (bytes: number | null | undefined) => string {
  const { t } = useTranslation();
  const units: ByteUnits = {
    b: t('usage.units.b') || 'B',
    kb: t('usage.units.kb') || 'KB',
    mb: t('usage.units.mb') || 'MB',
    gb: t('usage.units.gb') || 'GB',
    tb: t('usage.units.tb') || 'TB',
  };
  const key = `${units.b}|${units.kb}|${units.mb}|${units.gb}|${units.tb}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((bytes) => formatBytes(bytes, units), [key]);
}

export function quotaDimensionLabel(t: TFunction, d: QuotaDimension): string {
  const fallback: Record<QuotaDimension, string> = { disk: 'Disk', traffic: 'Traffic', databases: 'Databases', dbSize: 'Database size' };
  return t(`usage.dimension.${d}`) || fallback[d];
}

/** Value of a gauge dimension: bytes for disk / traffic / dbSize, a count for databases. */
export function gaugeValue(d: QuotaDimension, v: number | null, bytes: (n: number | null) => string): string {
  if (v == null) return '—';
  return d === 'databases' ? formatCount(v) : bytes(v);
}

/** "YYYY-MM" → "October 2026" in the UI language. */
export function monthLabel(month: string, lang: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "YYYY-MM-DD" → "12" (day of month) for the chart axis. */
export function dayLabel(day: string): string {
  return String(Number(day.slice(8, 10)) || day);
}

/** Previous / next month picker (no future month). */
export function MonthPicker({ value, onChange, className }: { value: string; onChange: (m: string) => void; className?: string }) {
  const { t, i18n } = useTranslation();
  const current = isoMonth();
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-1', className)}>
      <IconButton size="sm" label={t('usage.month.previous') || 'Previous month'} icon={<ChevronLeft size={14} />} onClick={() => onChange(shiftMonth(value, -1))} />
      <span className="min-w-[8.5rem] text-center font-mono text-xs capitalize text-text-primary">{monthLabel(value, i18n.language)}</span>
      <IconButton size="sm" label={t('usage.month.next') || 'Next month'} icon={<ChevronRight size={14} />} disabled={value >= current} onClick={() => onChange(shiftMonth(value, 1))} />
    </div>
  );
}

/** One quota gauge card (semi-circle + used / limit). */
export function QuotaGaugeCard({ gauge }: { gauge: QuotaGauge }) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  const pct = gauge.pct;
  const label = pct == null ? '∞' : `${Math.round(pct)}%`;
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 rounded-xl bg-bg-secondary p-4 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
      <div className="self-stretch truncate text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">{quotaDimensionLabel(t, gauge.dimension)}</div>
      <GaugeArc pct={pct} label={label} />
      <div className="max-w-full truncate font-mono text-[12px] text-text-secondary">
        {gaugeValue(gauge.dimension, gauge.used, bytes)}
        <span className="text-text-muted"> / {gauge.limit == null ? (t('hostingCommon.unlimited') || 'unlimited') : gaugeValue(gauge.dimension, gauge.limit, bytes)}</span>
      </div>
      {gauge.level != null && (
        <Pill tone={gauge.level >= 100 ? 'red' : 'amber'}>{t('usage.gauge.level', { level: gauge.level, defaultValue: '{{level}} % reached' })}</Pill>
      )}
    </div>
  );
}

/** Compact gauge line (label, bar, value) for tables and cards. */
export function QuotaLine({ dimension, used, limit }: { dimension: QuotaDimension; used: number | null; limit: number | null }) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  const pct = used != null && limit != null && limit > 0 ? (used / limit) * 100 : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-[11px] font-mono text-text-secondary">
        <span className="text-text-muted">{quotaDimensionLabel(t, dimension)}</span>
        <span className="ml-auto truncate">
          {gaugeValue(dimension, used, bytes)}
          <span className="text-text-muted"> / {limit == null ? (t('hostingCommon.unlimited') || 'unlimited') : gaugeValue(dimension, limit, bytes)}</span>
        </span>
      </div>
      <UsageBar pct={pct} className="mt-1" />
    </div>
  );
}

export function overQuotaLabel(t: TFunction, s: OverQuotaState): string {
  const fallback: Record<OverQuotaState, string> = { ok: 'Within quota', warn: 'Quota warning', blocked: 'Uploads blocked', suspended: 'Suspended (quota)' };
  return t(`usage.overQuota.${s}`) || fallback[s];
}

export function OverQuotaPill({ state }: { state: OverQuotaState }) {
  const { t } = useTranslation();
  if (state === 'ok') return null;
  const tone = state === 'warn' ? 'amber' : 'red';
  return <Pill tone={tone}>{overQuotaLabel(t, state)}</Pill>;
}

/** Banner of an account above its quota (warn / blocked / suspended). */
export function OverQuotaBanner({ state }: { state: OverQuotaState }) {
  const { t } = useTranslation();
  if (state === 'ok') return null;
  const text = state === 'warn'
    ? (t('usage.overQuota.warnBanner') || 'This account has reached a quota threshold. Free some space or ask for a larger plan.')
    : state === 'blocked'
      ? (t('usage.overQuota.blockedBanner') || 'This account is over its quota: uploads are blocked (SFTP is read + delete only). Published sites keep running.')
      : (t('usage.overQuota.suspendedBanner') || 'This account was suspended because it went over its quota.');
  const Icon = state === 'warn' ? AlertTriangle : state === 'blocked' ? Lock : PauseCircle;
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-lg border p-3 text-xs',
      state === 'warn' ? 'border-amber-400/30 bg-amber-400/5 text-amber-400' : 'border-status-down/30 bg-status-down/5 text-status-down',
    )}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** List of quota alerts (open or cleared). `accountLink` links each alert to its account. */
export function UsageAlertsList({ alerts, accountNames, accountLink = false }: {
  alerts: UsageAlert[];
  accountNames?: Map<number, string>;
  accountLink?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  if (alerts.length === 0) {
    return <p className="py-3 text-center text-xs text-text-muted">{t('usage.alerts.none') || 'No open alert.'}</p>;
  }
  return (
    <ul className="space-y-2">
      {alerts.map((a) => {
        const name = a.accountId != null ? (accountNames?.get(a.accountId) ?? `#${a.accountId}`) : null;
        const who = a.scope === 'tenant' ? (t('usage.alerts.workspace') || 'Workspace') : name;
        return (
          <li key={a.id} className="flex items-start gap-3 rounded-lg bg-bg-primary px-3 py-2">
            {a.level >= 100 ? <Ban size={14} className="mt-0.5 shrink-0 text-status-down" /> : <BellRing size={14} className="mt-0.5 shrink-0 text-amber-400" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                <span className="font-medium">{quotaDimensionLabel(t, a.dimension)}</span>
                <Pill tone={a.level >= 100 ? 'red' : 'amber'}>{a.level} %</Pill>
                {who && (accountLink && a.accountId != null
                  ? <Link to={`/accounts/${a.accountId}?tab=usage`} className="font-mono text-xs text-text-muted hover:text-accent">{who}</Link>
                  : <span className="font-mono text-xs text-text-muted">{who}</span>)}
                {a.clearedAt && <Pill tone="green">{t('usage.alerts.cleared') || 'cleared'}</Pill>}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-text-muted">
                {gaugeValue(a.dimension, a.used, bytes)} / {gaugeValue(a.dimension, a.limit, bytes)}
                {' · '}{a.period === 'current' ? (t('usage.alerts.current') || 'current') : a.period}
                {' · '}{new Date(a.createdAt).toLocaleString(i18n.language)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Hour label of a resource point ("14:00"). */
export function hourLabel(iso: string, lang: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

/** CPU % and memory series of resource points (max variant when present). */
export function resourceSeries(points: ResourcePoint[]): { cpu: number[]; mem: number[] } {
  return {
    cpu: points.map((p) => p.cpuPct ?? 0),
    mem: points.map((p) => p.memBytes ?? 0),
  };
}
