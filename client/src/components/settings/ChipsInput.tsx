import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

// Invisible ≥40px hit area around the chip × (touch only) — as Obliance's EmailChips.
const CHIP_X_HIT = "relative coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-['']";

/**
 * List of short values as removable chips (Outlook-style tokens), ported from
 * Obliance's EmailChips: a separator (comma, semicolon, space, Enter) or a
 * paste locks each value into a chip. `validate` rejects a value (shown red,
 * not added) and `normalize` canonicalises it (lower case…).
 */
export function ChipsInput({ id, value, onChange, placeholder, validate, normalize, max, inputMode, disabled, ariaLabel }: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  validate?: (v: string) => boolean;
  normalize?: (v: string) => string;
  max?: number;
  inputMode?: 'text' | 'email' | 'decimal' | 'numeric' | 'url';
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [rejected, setRejected] = useState<string | null>(null);
  const norm = (v: string) => (normalize ? normalize(v.trim()) : v.trim());
  const full = max != null && value.length >= max;

  const add = (items: string[]) => {
    const next = [...value];
    let bad: string | null = null;
    for (const raw of items) {
      const v = norm(raw);
      if (!v) continue;
      if (validate && !validate(v)) { bad = v; continue; }
      if (!next.includes(v) && (max == null || next.length < max)) next.push(v);
    }
    setRejected(bad);
    if (next.length !== value.length) onChange(next);
  };

  const commitDraft = () => {
    if (draft.trim()) add([draft]);
    setDraft('');
  };
  const onDraftChange = (raw: string) => {
    if (/[,;\s]/.test(raw)) {
      const parts = raw.split(/[,;\s]+/);
      const last = parts.pop() ?? '';
      add(parts);
      setDraft(last);
    } else {
      setDraft(raw);
      setRejected(null);
    }
  };

  return (
    <div>
      <div className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-lg bg-bg-primary px-2 py-1.5 focus-within:ring-2 focus-within:ring-accent coarse:gap-2.5',
        disabled && 'opacity-50',
      )}>
        {value.map((c) => (
          <span key={c} className="inline-flex max-w-full items-center gap-1 rounded bg-accent/15 px-2 py-0.5 font-mono text-xs text-accent coarse:gap-2 coarse:py-1.5">
            <span className="min-w-0 break-all">{c}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== c))}
                className={`shrink-0 text-accent/70 hover:text-status-down ${CHIP_X_HIT}`}
                aria-label={t('platformSettings.chips.remove', { value: c, defaultValue: 'Remove {{value}}' })}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {!full && !disabled && (
          <input
            id={id}
            type="text"
            value={draft}
            aria-label={ariaLabel}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitDraft(); }
              else if (e.key === 'Backspace' && !draft && value.length) { e.preventDefault(); onChange(value.slice(0, -1)); }
            }}
            onBlur={commitDraft}
            placeholder={value.length ? '' : placeholder}
            inputMode={inputMode}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className="min-w-[140px] flex-1 bg-transparent font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        )}
      </div>
      {rejected && <p className="mt-1 text-xs text-status-down">{t('platformSettings.chips.invalid', { value: rejected, defaultValue: '« {{value}} » is not valid.' })}</p>}
    </div>
  );
}
