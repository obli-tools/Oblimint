import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/utils/cn';

// Building blocks of the « Overview » of an object page (account, site —
// coherence plan 1.2 / 1.3): a launch checklist whose lines open the right
// form in place. The count tiles are the Obliance MiniStat (usage/HeroCards).

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
