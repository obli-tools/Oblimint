import { useEffect, useMemo, useState } from 'react';
import CodeMirror, { Decoration, EditorView, RangeSetBuilder, type Extension } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { useCurrentTheme } from '@/hooks/useCurrentTheme';
import { cn } from '@/utils/cn';

export interface LineMarker {
  /** 1-based line. */
  line: number;
  severity: 'error' | 'warning';
}

const errorLine = Decoration.line({ class: 'cm-om-error' });
const warningLine = Decoration.line({ class: 'cm-om-warning' });

/** Background of the lines carrying a validation issue (errors win over warnings on the same line). */
function markerExtension(markers: LineMarker[]): Extension {
  const byLine = new Map<number, 'error' | 'warning'>();
  for (const m of markers) {
    if (!Number.isInteger(m.line) || m.line < 1) continue;
    if (byLine.get(m.line) !== 'error') byLine.set(m.line, m.severity);
  }
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  return EditorView.decorations.of((view) => {
    const b = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    for (const n of lines) {
      if (n > doc.lines) break;
      const line = doc.line(n);
      b.add(line.from, line.from, byLine.get(n) === 'error' ? errorLine : warningLine);
    }
    return b.finish();
  });
}

export type CodeLanguage = 'yaml' | 'text' | 'php' | 'javascript' | 'typescript' | 'css' | 'html' | 'json' | 'markdown' | 'xml' | 'sql';

/** Language support loaded on demand (separate chunks: only YAML ships with the main bundle). */
async function loadLanguage(language: CodeLanguage): Promise<Extension | null> {
  switch (language) {
    case 'yaml': return yaml();
    case 'php': return (await import('@codemirror/lang-php')).php();
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'xml': return (await import('@codemirror/lang-xml')).xml();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    default: return null;
  }
}

/** Colours of the obli themes (tokens), on top of the base light / dark CodeMirror theme. */
const obliTheme = EditorView.theme({
  '&': { fontSize: '13px' },
  '.cm-content': { fontFamily: '"JetBrains Mono", ui-monospace, monospace' },
  '.cm-gutters': { fontFamily: '"JetBrains Mono", ui-monospace, monospace', border: 'none' },
  '.cm-om-error': { backgroundColor: 'rgba(239, 68, 68, 0.14)' },
  '.cm-om-warning': { backgroundColor: 'rgba(245, 181, 68, 0.12)' },
  '&.cm-focused': { outline: 'none' },
});

/** Scroll the editor to a 1-based line and put the cursor there. */
export function revealLine(view: EditorView | null, line: number): void {
  if (!view) return;
  const doc = view.state.doc;
  const n = Math.min(Math.max(1, line), doc.lines);
  const pos = doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}

/**
 * CodeMirror 6 editor (YAML or plain text) themed with the obli tokens:
 * compose / .env / template editors (docs/P4b-PLAN.md §13). OWNED BY MODULE `ui-apps`.
 */
export function CodeEditor({
  value, onChange, language = 'yaml', readOnly = false, markers, height, minHeight = '240px', maxHeight, ariaLabel, placeholder, onCreateEditor, className,
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  markers?: LineMarker[];
  height?: string;
  minHeight?: string;
  maxHeight?: string;
  ariaLabel?: string;
  placeholder?: string;
  onCreateEditor?: (view: EditorView) => void;
  className?: string;
}) {
  const theme = useCurrentTheme();
  const markerKey = JSON.stringify(markers ?? []);
  const [lang, setLang] = useState<{ id: CodeLanguage; ext: Extension | null }>(() => ({ id: language, ext: language === 'yaml' ? yaml() : null }));
  useEffect(() => {
    let live = true;
    loadLanguage(language).then((ext) => { if (live) setLang({ id: language, ext }); }).catch(() => { if (live) setLang({ id: language, ext: null }); });
    return () => { live = false; };
  }, [language]);
  const extensions = useMemo<Extension[]>(() => {
    const ext: Extension[] = [obliTheme, EditorView.lineWrapping];
    if (lang.ext && lang.id === language) ext.push(lang.ext);
    if (markers?.length) ext.push(markerExtension(markers));
    if (ariaLabel) ext.push(EditorView.contentAttributes.of({ 'aria-label': ariaLabel }));
    return ext;
  }, [language, lang, markerKey, ariaLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-lg',
        // Token colours win over the base theme (two-class selectors + !important on the shared surfaces).
        '[&_.cm-editor]:!bg-bg-primary [&_.cm-gutters]:!bg-bg-secondary [&_.cm-gutters]:!text-text-muted',
        '[&_.cm-activeLineGutter]:!bg-bg-hover [&_.cm-activeLine]:!bg-bg-hover/40',
        className,
      )}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={theme === 'obli-daylight' ? 'light' : 'dark'}
        extensions={extensions}
        height={height}
        minHeight={minHeight}
        maxHeight={maxHeight}
        placeholder={placeholder}
        onCreateEditor={onCreateEditor}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly, autocompletion: false }}
      />
    </div>
  );
}
