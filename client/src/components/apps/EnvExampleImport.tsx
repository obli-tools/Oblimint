import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, FileDown } from 'lucide-react';
import { mergeEnvExample, type AppEnvTemplate } from '@oblimint/shared';
import { Button } from '@/components/common/Button';

/**
 * .env example of an application source (.env.example …): import of the
 * missing variables (never overwrites a value already set) and notice of the
 * variables it expects that the .env does not set. OWNED BY MODULE `ui-apps`.
 */

/** `current` + the variables of the example it does not set (toasts the outcome); null when nothing to add. */
export function importEnvExample(t: TFunction, current: string, tpl: AppEnvTemplate): string | null {
  if (!tpl.file || tpl.content === null) {
    toast(t('apps.env.exampleNone') || 'No .env.example (.env.sample, .env.dist, example.env) in the repository.');
    return null;
  }
  const header = t('apps.env.exampleHeader', { file: tpl.file, defaultValue: 'From {{file}}: example values, replace them before deploying' });
  const r = mergeEnvExample(current, tpl.content, header);
  if (!r.added.length) {
    toast(t('apps.env.exampleNothing', { file: tpl.file, defaultValue: 'Every variable of {{file}} is already set.' }));
    return null;
  }
  toast.success(t('apps.env.exampleImported', { count: r.added.length, file: tpl.file, defaultValue: '{{count}} variable(s) added from {{file}}: check their values.' }));
  return r.text;
}

/** Variables the example declares that the .env does not set (warning + import button). */
export function MissingEnvKeys({ file, keys, onImport, importing = false }: {
  file: string;
  keys: string[];
  onImport?: () => void;
  importing?: boolean;
}) {
  const { t } = useTranslation();
  if (!keys.length) return null;
  return (
    <div className="mb-3 rounded-lg bg-amber-400/10 p-3">
      <p className="mb-2 flex items-start gap-1.5 text-xs text-amber-400">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>{t('apps.env.missingExpected', { count: keys.length, file, defaultValue: 'Expected variables missing: {{count}} variable(s) of {{file}} are not set in the .env.' })}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((k) => <span key={k} className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-xs text-text-secondary">{k}</span>)}
      </div>
      {onImport && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" loading={importing} onClick={onImport}>
            <FileDown size={14} className="mr-1.5" />{t('apps.env.exampleImport', { file, defaultValue: 'Import from {{file}}' })}
          </Button>
        </div>
      )}
    </div>
  );
}
