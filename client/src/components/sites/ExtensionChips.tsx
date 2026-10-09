import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { DEFAULT_TYPED_EXTENSIONS } from '@oblimint/shared';
import { isPhpLikeExtension, parseExtensionList, phpLikeExtensions } from './siteForm';
import { fieldCls } from './styles';

const MAX_EXTENSIONS = 100;

/** Chips editor of the allowed extensions of a `typed` data path. */
export function ExtensionChips({ value, onChange, disabled = false }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);

  const addFrom = (input: string) => {
    // PHP-like extensions are refused by the image config loader (whole site
    // down): never accepted, and the user is told why.
    setRejected(phpLikeExtensions(input));
    const next = [...value];
    for (const ext of parseExtensionList(input)) {
      if (!next.includes(ext) && next.length < MAX_EXTENSIONS) next.push(ext);
    }
    onChange(next);
    setDraft('');
  };

  const suggestions = DEFAULT_TYPED_EXTENSIONS.filter((e) => !value.includes(e) && !isPhpLikeExtension(e));

  return (
    <div className="space-y-2">
      <div className="flex min-h-10 flex-wrap items-center gap-1 rounded-md bg-bg-tertiary p-1.5">
        {value.length === 0 && <span className="px-1.5 text-xs text-text-muted">{t('dataPaths.extensions.none') || 'No extension: nothing will be served.'}</span>}
        {value.map((ext) => (
          <span key={ext} className="inline-flex items-center gap-1 rounded bg-bg-primary/70 py-0.5 pl-2 pr-1 font-mono text-xs text-text-primary">
            .{ext}
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(value.filter((e) => e !== ext))}
                className="rounded p-0.5 text-text-muted hover:bg-red-400/10 hover:text-red-400"
                aria-label={t('dataPaths.extensions.remove', { ext, defaultValue: 'Remove .{{ext}}' })}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setRejected([]); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFrom(draft); }
              }}
              placeholder={t('dataPaths.extensions.placeholder') || 'jpg, png, pdf…'}
              className={`${fieldCls} font-mono`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => addFrom(draft)}
              disabled={!draft.trim()}
              className="inline-flex shrink-0 items-center rounded-md bg-bg-tertiary px-3 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 coarse:min-h-10"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {rejected.length > 0 && (
            <p className="text-xs text-red-400">
              {t('dataPaths.extensions.phpRefused', {
                exts: rejected.map((e) => `.${e}`).join(', '),
                defaultValue: 'Refused: {{exts}}. PHP-like extensions can never be allowed in a data path.',
              })}
            </p>
          )}
          {suggestions.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-text-muted">
                {t('dataPaths.extensions.suggestions') || 'Suggestions'}
                <button type="button" onClick={() => onChange([...value, ...suggestions].slice(0, MAX_EXTENSIONS))} className="text-accent hover:underline">
                  {t('dataPaths.extensions.addAll') || 'add all'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {suggestions.map((ext) => (
                  <button
                    key={ext}
                    type="button"
                    onClick={() => onChange([...value, ext])}
                    disabled={value.length >= MAX_EXTENSIONS}
                    className="rounded border border-dashed border-border-light px-1.5 py-0.5 font-mono text-[11px] text-text-muted hover:border-accent hover:text-accent"
                  >
                    +{ext}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
