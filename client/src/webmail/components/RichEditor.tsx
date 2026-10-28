import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Bold, Eraser, Italic, Link, List, ListOrdered, Underline } from 'lucide-react';
import { sanitizeOutgoing } from '../lib/sanitize';

// Simple rich text editor (contentEditable + execCommand): bold, italic,
// underline, lists, links. Its content is sanitized when set (quoted
// replies) and again when read (pasted content). The host CSP forbids inline
// script / handlers on top of that.

export interface RichEditorHandle {
  html(): string;
  text(): string;
  focus(): void;
}

export const RichEditor = forwardRef<RichEditorHandle, { initialHtml: string; onChange: () => void; placeholder: string }>(
  ({ initialHtml, onChange, placeholder }, ref) => {
    const { t } = useTranslation();
    const el = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (el.current) el.current.innerHTML = sanitizeOutgoing(initialHtml);
      // Set once: the editor owns its DOM afterwards.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      html: () => sanitizeOutgoing(el.current?.innerHTML ?? ''),
      text: () => (el.current?.innerText ?? '').replace(/ /g, ' '),
      focus: () => el.current?.focus(),
    }));

    const exec = (cmd: string, value?: string) => {
      el.current?.focus();
      document.execCommand(cmd, false, value);
      onChange();
    };
    const link = () => {
      const url = window.prompt(t('wm.editor.linkPrompt') || 'Link address (https://…)', 'https://');
      if (!url) return;
      if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) return;
      exec('createLink', url.trim());
    };
    const btn = 'rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-9 coarse:min-w-9';

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1" role="toolbar">
          <button type="button" className={btn} title={t('wm.editor.bold') || 'Bold'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}><Bold size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.italic') || 'Italic'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}><Italic size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.underline') || 'Underline'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}><Underline size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.bullets') || 'Bulleted list'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')}><List size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.numbers') || 'Numbered list'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')}><ListOrdered size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.link') || 'Link'} onMouseDown={(e) => e.preventDefault()} onClick={link}><Link size={15} /></button>
          <button type="button" className={btn} title={t('wm.editor.clear') || 'Clear formatting'} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')}><Eraser size={15} /></button>
        </div>
        <div
          ref={el}
          className="wm-editor min-h-[12rem] flex-1 overflow-y-auto px-3 py-2 text-sm text-text-primary"
          contentEditable
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          onInput={onChange}
          onPaste={(e) => {
            // Pasted HTML goes through the sanitizer before it enters the document.
            const html = e.clipboardData.getData('text/html');
            if (!html) return;
            e.preventDefault();
            document.execCommand('insertHTML', false, sanitizeOutgoing(html));
            onChange();
          }}
          suppressContentEditableWarning
        />
      </div>
    );
  },
);
RichEditor.displayName = 'RichEditor';
