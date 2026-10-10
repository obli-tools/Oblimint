import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { NumberInput } from '../proxyUi';
import { intIn } from '../proxyFormat';

// Small form fields of the proxy host editor. OWNED BY MODULE `ui-proxy`.

/**
 * Integer field bound to a number (or null when `allowEmpty`): keeps the
 * typed text, reports a value only when it is valid, red ring otherwise.
 */
export function NumField({ id, label, hint, value, onChange, min, max, allowEmpty = false, placeholder, suffix, disabled }: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  allowEmpty?: boolean;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => {
    // Follow outside changes (load, reset) without fighting the typing.
    setText((cur) => {
      const parsed = cur.trim() === '' ? null : intIn(cur, min, max);
      return parsed === value ? cur : value == null ? '' : String(value);
    });
  }, [value, min, max]);
  const parsed = text.trim() === '' ? null : intIn(text, min, max);
  const invalid = text.trim() === '' ? !allowEmpty : parsed === null;
  return (
    <div className="min-w-0">
      <label className={labelCls} htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <NumberInput
          id={id}
          value={text}
          min={min}
          max={max}
          placeholder={placeholder}
          disabled={disabled}
          invalid={invalid}
          onChange={(v) => {
            setText(v);
            const p = v.trim() === '' ? null : intIn(v, min, max);
            if (v.trim() === '' ? allowEmpty : p !== null) onChange(p);
          }}
        />
        {suffix && <span className="shrink-0 text-xs text-text-muted">{suffix}</span>}
      </div>
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

/** "inherit / on / off" select of a nullable boolean (route overrides). */
export function TriStateSelect({ id, label, value, onChange }: { id: string; label: ReactNode; value: boolean | null; onChange: (v: boolean | null) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value == null ? '' : value ? 'on' : 'off'}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'on')}
        className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10"
      >
        <option value="">{t('proxy.editor.inherit') || 'inherit'}</option>
        <option value="on">{t('proxy.editor.on') || 'on'}</option>
        <option value="off">{t('proxy.editor.off') || 'off'}</option>
      </select>
    </div>
  );
}

/** Checkbox list (multi-select) of small objects. */
export function CheckList<T extends { id: number }>({ items, value, onChange, render, empty, disabled }: {
  items: T[];
  value: number[];
  onChange: (ids: number[]) => void;
  render: (item: T) => ReactNode;
  empty: ReactNode;
  disabled?: boolean;
}) {
  if (items.length === 0) return <p className="text-xs text-text-muted">{empty}</p>;
  return (
    <ul className="space-y-1 rounded-lg bg-bg-primary p-1.5">
      {items.map((it) => {
        const checked = value.includes(it.id);
        return (
          <li key={it.id}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={checked}
              onClick={() => onChange(checked ? value.filter((x) => x !== it.id) : [...value, it.id])}
              className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors coarse:min-h-10', checked ? 'bg-accent/10' : 'hover:bg-bg-hover', disabled && 'cursor-not-allowed opacity-60')}
            >
              <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-accent bg-accent text-white' : 'border-text-muted/40')}>
                {checked && <Check size={11} />}
              </span>
              <span className="min-w-0 flex-1">{render(it)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
