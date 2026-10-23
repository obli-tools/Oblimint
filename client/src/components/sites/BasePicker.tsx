import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { SITE_BASES, type SiteBaseDef, type SiteBaseId } from '@oblimint/shared';
import { cn } from '@/utils/cn';
import { PhpBranchBadges, Pill } from './SiteBadges';

type Group = 'apache' | 'nginx' | 'static';

function groupOf(def: SiteBaseDef): Group {
  if (def.php === null) return 'static';
  return def.engine;
}

export interface BasePickerProps {
  /** Selected base (check mark + accent ring). */
  value?: SiteBaseId | null;
  onSelect?: (base: SiteBaseId) => void;
  /** Extra chips per base (current / preview / recommended markers…). */
  markers?: (base: SiteBaseId) => ReactNode;
  /** Bases that cannot be picked (current base, not allowed…). */
  isDisabled?: (base: SiteBaseId) => boolean;
  /** Smaller cards (create modal). */
  compact?: boolean;
  readOnly?: boolean;
}

/** The base catalog (SITE_BASES) as cards grouped Apache / nginx / static. */
export function BasePicker({ value, onSelect, markers, isDisabled, compact = false, readOnly = false }: BasePickerProps) {
  const { t } = useTranslation();
  const groups: Array<{ id: Group; label: string; hint: string }> = [
    { id: 'apache', label: 'Apache + PHP-FPM', hint: t('runtime.groups.apacheHint') || 'Honours .htaccess files: the usual choice for WordPress, PrestaShop, Joomla.' },
    { id: 'nginx', label: 'nginx + PHP-FPM', hint: t('runtime.groups.nginxHint') || 'Faster, but ignores .htaccess files: rewrites go in the custom nginx rules.' },
    { id: 'static', label: t('runtime.groups.static') || 'Static (nginx)', hint: t('runtime.groups.staticHint') || 'HTML, CSS, JS and media only: PHP is never executed.' },
  ];

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const bases = SITE_BASES.filter((b) => groupOf(b) === g.id);
        return (
          <div key={g.id}>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{g.label}</span>
              <span className="text-xs text-text-muted/80">{g.hint}</span>
            </div>
            <div className={cn('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' : 'grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5')}>
              {bases.map((b) => {
                const selected = value === b.id;
                const disabled = readOnly || (isDisabled?.(b.id) ?? false);
                return (
                  <button
                    key={b.id}
                    type="button"
                    disabled={disabled && !selected}
                    aria-pressed={selected}
                    onClick={() => { if (!disabled) onSelect?.(b.id); }}
                    className={cn(
                      'relative flex min-w-0 flex-col items-start gap-1 rounded-lg border bg-bg-tertiary/60 text-left transition-colors',
                      compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
                      selected ? 'border-accent ring-1 ring-accent' : 'border-transparent',
                      !disabled && !selected && 'hover:border-border-light hover:bg-bg-hover',
                      disabled && !selected && 'cursor-not-allowed opacity-60',
                      readOnly && 'cursor-default',
                    )}
                  >
                    {selected && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent" />}
                    <span className={cn('font-display font-semibold text-text-primary', compact ? 'text-base' : 'text-lg leading-tight')}>
                      {b.php ? `PHP ${b.php}` : (t('runtime.staticShort') || 'Static')}
                    </span>
                    <span className="font-mono text-[10px] text-text-muted">{b.id}</span>
                    <span className="flex flex-wrap gap-1">
                      {b.htaccess && <Pill tone="muted" className="text-[10px]">.htaccess</Pill>}
                      {b.php && <PhpBranchBadges branch={b.php} compact />}
                      {markers?.(b.id)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
