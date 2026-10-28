import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill } from '@/components/common/Pill';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// The common rights editor (coherence plan C5): one presentation for the three
// vocabularies, which stay distinct (access key scopes, client capabilities,
// staff capabilities). Optional preset bar on top (the active one stands out,
// « Custom » when the form matches none), optional groups, and the rights the
// author cannot delegate greyed with a tooltip. The server stays the authority.
// ─────────────────────────────────────────────────────────────────────────────

export interface RightItem<K extends string> {
  id: K;
  label: ReactNode;
  hint?: ReactNode;
  /** Group id (see `groups`); items without one come first. */
  group?: string;
}

export interface RightsPreset<P extends string> {
  id: P;
  label: ReactNode;
  /** Gives nothing the author holds: not offered. */
  disabled?: boolean;
}

export function RightsChecklist<K extends string, P extends string = string>({
  label, items, value, onChange, grantable, notGrantableHint, disabled = false, columns = 2, groups,
  presets, activePreset, onPreset, presetsLabel, customLabel, presetHint, footer,
}: {
  /** Title of the rights block. */
  label?: ReactNode;
  items: readonly RightItem<K>[];
  value: ReadonlySet<K> | readonly K[];
  /** The checked rights, in the order of `items`. */
  onChange: (next: K[]) => void;
  /** What the author may delegate (undefined = everything). A right outside it can still be unchecked. */
  grantable?: readonly K[];
  /** Tooltip of a right the author cannot delegate. */
  notGrantableHint?: string;
  disabled?: boolean;
  columns?: 1 | 2;
  groups?: readonly { id: string; label: ReactNode }[];
  presets?: readonly RightsPreset<P>[];
  /** The preset the form matches (null = custom). */
  activePreset?: P | null;
  onPreset?: (id: P) => void;
  presetsLabel?: ReactNode;
  /** Label of the « Custom » chip (shown when given). */
  customLabel?: ReactNode;
  /** Text under the preset bar (what the active preset gives, warnings). */
  presetHint?: ReactNode;
  /** Text under the rights (what is never granted…). */
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const checked = new Set<K>(value as Iterable<K>);
  const toggle = (id: K) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(items.filter((i) => next.has(i.id)).map((i) => i.id));
  };

  const renderItem = (item: RightItem<K>) => {
    const held = !grantable || grantable.includes(item.id);
    const on = checked.has(item.id);
    // Not delegable: never checked here (a right already given can still be removed).
    const locked = disabled || (!held && !on);
    return (
      <label
        key={item.id}
        title={held ? undefined : (notGrantableHint ?? (t('hostingCommon.rights.notHeldHint') || 'You do not hold this right: you cannot grant it.'))}
        className={cn('flex gap-2 rounded-lg p-2 ring-1 coarse:py-2.5', locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          on ? 'bg-accent/10 ring-accent/40' : 'bg-bg-tertiary/50 ring-transparent')}
      >
        <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(item.id)} className="mt-0.5 accent-accent" />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5 text-sm text-text-primary">
            {item.label}
            {!held && <Pill>{t('hostingCommon.rights.notHeld') || 'not held'}</Pill>}
          </span>
          {item.hint && <span className="block text-[11px] text-text-muted">{item.hint}</span>}
        </span>
      </label>
    );
  };
  const grid = (list: readonly RightItem<K>[]) => (
    <div className={cn('grid gap-1.5', columns === 2 && 'sm:grid-cols-2')}>{list.map(renderItem)}</div>
  );

  const ungrouped = items.filter((i) => !i.group || !groups?.some((g) => g.id === i.group));
  return (
    <div className="space-y-4">
      {presets && presets.length > 0 && (
        <div>
          {presetsLabel && <div className="mb-1 block text-xs text-text-muted">{presetsLabel}</div>}
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => {
              const active = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled || p.disabled}
                  onClick={() => onPreset?.(p.id)}
                  className={cn('rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors coarse:min-h-10 disabled:cursor-not-allowed disabled:opacity-50',
                    active ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30')}
                >
                  {p.label}
                </button>
              );
            })}
            {customLabel && (
              <span
                aria-current={activePreset == null ? 'true' : undefined}
                className={cn('rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium',
                  activePreset == null ? 'border-accent bg-accent/10 text-accent' : 'border-bg-tertiary text-text-muted/60')}
              >
                {customLabel}
              </span>
            )}
          </div>
          {presetHint && <p className="mt-1.5 text-[11px] text-text-muted">{presetHint}</p>}
        </div>
      )}
      <div>
        {label && <div className="mb-1 block text-xs text-text-muted">{label}</div>}
        <div className="space-y-3">
          {ungrouped.length > 0 && grid(ungrouped)}
          {groups?.map((g) => {
            const list = items.filter((i) => i.group === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id}>
                <div className="mb-1 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{g.label}</div>
                {grid(list)}
              </div>
            );
          })}
        </div>
        {footer && <p className="mt-1.5 text-[11px] text-text-muted">{footer}</p>}
      </div>
    </div>
  );
}
