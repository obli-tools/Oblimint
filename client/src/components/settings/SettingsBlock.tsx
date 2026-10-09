import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';

/**
 * One section of the Settings page (icon + title, then the bg-secondary card)
 * — the layout of the P0 sections, itself Obliance's. When `dirty`, a footer
 * offers Save / Cancel; `error` shows under the fields.
 */
export function SettingsBlock({ id, icon, title, description, children, dirty = false, saving = false, canSave = true, onSave, onReset, error, headerExtra }: {
  id?: string;
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  canSave?: boolean;
  onSave?: () => void;
  onReset?: () => void;
  error?: string | null;
  headerExtra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div id={id} className="scroll-mt-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-accent [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        {headerExtra && <div className="ml-auto flex items-center gap-2">{headerExtra}</div>}
      </div>
      <div className="space-y-4 rounded-lg bg-bg-secondary p-5 max-sm:p-4">
        {description && <p className="text-sm text-text-muted">{description}</p>}
        {children}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {onSave && (
          <div className={cn('flex flex-wrap items-center justify-end gap-2 pt-1', !dirty && 'hidden')}>
            {onReset && <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={onReset}>{t('common.cancel') || 'Cancel'}</Button>}
            <Button type="button" size="sm" loading={saving} disabled={!canSave} onClick={onSave}>{t('common.save') || 'Save'}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Label + control + hint, as the P0 settings fields. */
export function Field({ label, htmlFor, hint, error, children, className }: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-text-secondary">{label}</label>
      {children}
      {error ? <p className="mt-1 text-xs text-status-down">{error}</p> : hint ? <p className="mt-1.5 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

export const settingsInputCls =
  'w-full min-w-0 rounded-lg bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50 coarse:min-h-10';
