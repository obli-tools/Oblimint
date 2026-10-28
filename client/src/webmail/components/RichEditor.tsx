import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Bold, Eraser, Italic, Link, List, ListOrdered, Underline } from 'lucide-react';
import { buildComposerDoc, COMPOSER_SANDBOX } from '../lib/htmlPolicy';
import { sanitizeOutgoing } from '../lib/sanitize';

// Simple rich text editor (contentEditable + execCommand): bold, italic,
// underline, lists, links. The editable document is a SANDBOXED IFRAME
// (allow-same-origin only: the composer drives it, nothing in it can run a
// script) with its own CSP that loads nothing remote (htmlPolicy.ts
// composerCsp). Quoted / pasted HTML therefore never reaches the webmail's
// own document: it cannot restyle or overlay the app, nor read the To / Cc /
// Subject fields through CSS selectors, nor load a tracker on reply. Content
// is sanitized in compose mode when it enters (quote, paste, drop) and again
// when it is read (the message sent).

export interface RichEditorHandle {
  html(): string;
  text(): string;
  focus(): void;
}

/** Theme variables copied into the editor document (the iframe does not inherit the app's CSS). */
const THEME_VARS = ['--c-text-primary', '--c-text-secondary', '--c-text-muted', '--c-accent', '--c-border-light', '--c-bg-secondary'];

export const RichEditor = forwardRef<RichEditorHandle, { initialHtml: string; onChange: () => void; placeholder: string }>(
  ({ initialHtml, onChange, placeholder }, ref) => {
    const { t } = useTranslation();
    const frame = useRef<HTMLIFrameElement>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    /** Content until the editor document is ready (then the document owns it). */
    const pending = useRef(sanitizeOutgoing(initialHtml));
    const ready = useRef<Document | null>(null);
    // Built once: the editor keeps its DOM afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const srcDoc = useMemo(() => buildComposerDoc(placeholder), []);

    const doc = (): Document | null => ready.current;

    const init = useCallback(() => {
      const d = frame.current?.contentDocument;
      if (!d || !d.body || ready.current === d || d.readyState !== 'complete' || !d.body.isContentEditable) return;
      ready.current = d;
      const root = getComputedStyle(document.documentElement);
      for (const v of THEME_VARS) {
        const value = root.getPropertyValue(v).trim();
        if (/^[0-9 .,%]{1,40}$/.test(value)) d.documentElement.style.setProperty(v, value);
      }
      d.body.innerHTML = pending.current;
      const changed = () => onChangeRef.current();
      d.addEventListener('input', changed);
      d.addEventListener('paste', (e) => {
        // Pasted HTML goes through the sanitizer before it enters the document.
        const html = e.clipboardData?.getData('text/html');
        if (!html) return;
        e.preventDefault();
        d.execCommand('insertHTML', false, sanitizeOutgoing(html));
        changed();
      });
      d.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        e.preventDefault();
        // Dropped markup: sanitized like a paste; dropped files: attachments are added with the paperclip.
        const html = dt.getData('text/html');
        const text = dt.getData('text/plain');
        if (html) d.execCommand('insertHTML', false, sanitizeOutgoing(html));
        else if (text) d.execCommand('insertText', false, text);
        else return;
        changed();
      });
      d.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    }, []);

    useEffect(() => {
      // The load event may already have fired (cached srcdoc).
      init();
    }, [init]);

    useImperativeHandle(ref, () => ({
      html: () => {
        const d = doc();
        return sanitizeOutgoing(d ? d.body.innerHTML : pending.current);
      },
      text: () => {
        const d = doc();
        if (d) return (d.body.innerText ?? '').replace(/ /g, ' ');
        const tmp = new DOMParser().parseFromString(pending.current, 'text/html');
        return (tmp.body.textContent ?? '').replace(/ /g, ' ');
      },
      focus: () => {
        frame.current?.contentWindow?.focus();
        doc()?.body.focus();
      },
    }));

    const exec = (cmd: string, value?: string) => {
      const d = doc();
      if (!d) return;
      frame.current?.contentWindow?.focus();
      d.execCommand(cmd, false, value);
      onChangeRef.current();
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
        <iframe
          ref={frame}
          title={t('wm.compose.bodyTitle') || 'Message body'}
          sandbox={COMPOSER_SANDBOX}
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          onLoad={init}
          className="wm-editor-frame min-h-[12rem] w-full flex-1 border-0 bg-bg-secondary"
        />
      </div>
    );
  },
);
RichEditor.displayName = 'RichEditor';
