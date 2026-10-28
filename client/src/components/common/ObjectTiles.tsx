import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import { cn } from '@/utils/cn';

// Building blocks of the « Overview » of an object page (account, site —
// coherence plan 1.2 / 1.3): a launch checklist whose lines open the right
// form in place, and clickable count tiles. Same card look as the rest of
// the shell (rounded-xl bg-bg-secondary, mono uppercase labels).

export interface ChecklistItem {
  key: string;
  label: ReactNode;
  /** Shown under the label (state of the step, what is missing). */
  hint?: ReactNode;
  done: boolean;
  /** Unknown (data not readable): neither done nor to do. */
  unknown?: boolean;
  /** Action of a step left to do (opens the form in place); hidden without the right. */
  action?: { label: ReactNode; onClick: () => void } | null;
}

export function LaunchChecklist({ items }: { items: ChecklistItem[] }) {
  const { t } = useTranslation();
  const known = items.filter((i) => !i.unknown);
  const done = known.filter((i) => i.done).length;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${known.length ? Math.round((done / known.length) * 100) : 0}%` }} />
        </div>
        <span className="font-mono text-[11px] text-text-muted">{t('objectPage.checklistCount', { done, total: known.length, defaultValue: '{{done}} / {{total}}' })}</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-3 py-2">
            {i.done
              ? <CheckCircle2 size={16} className="shrink-0 text-status-up" />
              : <Circle size={16} className={cn('shrink-0', i.unknown ? 'text-text-muted/40' : 'text-text-muted')} />}
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm', i.done ? 'text-text-secondary' : 'text-text-primary')}>{i.label}</div>
              {i.hint && <div className="text-[11px] text-text-muted">{i.hint}</div>}
            </div>
            {!i.done && !i.unknown && i.action && (
              <button type="button" onClick={i.action.onClick} className="shrink-0 text-xs font-medium text-accent hover:underline">
                {i.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A count tile, same look as the Obliance MiniStat (components/usage/HeroCards):
 * a link (other page) or a button (tab of the same page).
 */
export function StatTile({ icon, label, value, sub, to, onClick, tone }: {
  icon: ReactNode;
  label: ReactNode;
  /** null = not readable by the caller (« — »). */
  value: ReactNode | null;
  sub?: ReactNode;
  to?: string;
  onClick?: () => void;
  /** Highlight (e.g. something to do). */
  tone?: 'amber' | 'red';
}) {
  const body = (
    <div className="flex items-center gap-3 rounded-lg bg-bg-secondary px-3.5 py-2.5 text-left shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_16px_-8px_rgba(0,0,0,0.35)]">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-muted">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
        <div className="truncate text-[14px] font-semibold leading-tight text-text-primary">{value ?? '—'}</div>
        {sub && <div className={cn('truncate text-[10px] font-mono', tone === 'amber' ? 'text-amber-400' : tone === 'red' ? 'text-red-400' : 'text-text-muted')}>{sub}</div>}
      </div>
      <ChevronRight size={14} className="shrink-0 text-text-muted opacity-60" />
    </div>
  );
  if (to) return <Link to={to} className="block min-w-0 transition-opacity hover:opacity-90">{body}</Link>;
  return <button type="button" onClick={onClick} className="block w-full min-w-0 transition-opacity hover:opacity-90">{body}</button>;
}
