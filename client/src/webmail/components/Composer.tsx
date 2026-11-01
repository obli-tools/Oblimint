import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Maximize2, Minimize2, Minus, Paperclip, Send, Trash2, Type, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { ApiError, wmApi } from '../api';
import { destroyEmails, saveDraft, sendMessage, setKeyword, type OutgoingMessage } from '../jmap';
import { COMPOSER_CLOSE_EVENT } from '../actions';
import { COMPOSER_ATTR } from '../hotkeys';
import { composerBody, parseAddressList, textToHtml } from '../lib/compose';
import { formatSize } from '../lib/format';
import { htmlToText } from '../lib/sanitize';
import { mailboxByRole, useWebmail, type ComposerState } from '../store';
import { RichEditor, type RichEditorHandle } from './RichEditor';
import { IconButton, PillButton } from './ui';

// Composer: plain text or simple rich text, reply / reply all / forward,
// drafts saved automatically (Drafts folder, replaced at each save),
// attachments uploaded through the proxy (size limit = the mail settings'),
// sent with EmailSubmission under the mailbox's identity, copy in Sent.

const AUTOSAVE_MS = 4000;
/** Base64 + MIME overhead of attachments in the final message. */
const MIME_OVERHEAD = 1.37;

interface Upload { key: number; name: string; size: number; progress: number; error?: string }

export function Composer({ c }: { c: ComposerState }) {
  const { t } = useTranslation();
  const session = useWebmail((s) => s.session);
  const mailboxes = useWebmail((s) => s.mailboxes);
  const { updateComposer, closeComposer, toast, refreshMailboxes, reloadList } = useWebmail.getState();
  const identities = session?.identities ?? [];
  const [identityId, setIdentityId] = useState(identities[0]?.id ?? '');
  const [showCcBcc, setShowCcBcc] = useState(!!(c.cc || c.bcc));
  const [rich, setRich] = useState(c.html !== null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  /** Docked bottom-right, enlarged in the middle, or minimized to its title bar (desktop; full screen on phones). */
  const [view, setView] = useState<'dock' | 'max' | 'min'>('dock');
  const editor = useRef<RichEditorHandle>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number | null>(null);
  const cRef = useRef(c);
  cRef.current = c;
  const drafts = mailboxByRole(mailboxes, 'drafts');
  const sent = mailboxByRole(mailboxes, 'sent');
  const maxBytes = session?.maxUploadBytes ?? 0;
  const usedBytes = c.attachments.reduce((n, a) => n + a.size, 0);

  /** The message as it would be sent now (editor read live). */
  const outgoing = useCallback((): OutgoingMessage | null => {
    const cur = cRef.current;
    const identity = identities.find((i) => i.id === identityId) ?? identities[0];
    if (!identity) return null;
    const { html, text } = composerBody(rich, editor.current, cur, htmlToText);
    return {
      identity,
      to: parseAddressList(cur.to).list,
      cc: parseAddressList(cur.cc).list,
      bcc: parseAddressList(cur.bcc).list,
      subject: cur.subject,
      text,
      html,
      attachments: cur.attachments,
      inReplyTo: cur.inReplyTo,
      references: cur.references,
    };
  }, [identities, identityId, rich]);

  const save = useCallback(async (): Promise<void> => {
    if (!drafts) return;
    if (saving.current) await saving.current.catch(() => undefined);
    const m = outgoing();
    if (!m) return;
    dirty.current = false;
    setSaveState('saving');
    const p = saveDraft(m, drafts.id, cRef.current.draftId).then((id) => {
      updateComposer({ draftId: id });
      cRef.current = { ...cRef.current, draftId: id };
      setSaveState('saved');
    }).catch(() => { dirty.current = true; setSaveState('error'); });
    saving.current = p;
    await p;
    saving.current = null;
  }, [drafts, outgoing, updateComposer]);

  const changed = useCallback(() => {
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (dirty.current) void save(); }, AUTOSAVE_MS);
  }, [save]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const set = (patch: Partial<ComposerState>) => { updateComposer(patch); changed(); };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const total = (cRef.current.attachments.reduce((n, a) => n + a.size, 0) + f.size) * MIME_OVERHEAD;
      if (maxBytes && total > maxBytes) {
        toast('error', t('wm.compose.tooLarge', { size: formatSize(maxBytes) }) || `Attachments are limited to ${formatSize(maxBytes)} per message.`);
        continue;
      }
      const key = Date.now() + Math.random();
      setUploads((u) => [...u, { key, name: f.name, size: f.size, progress: 0 }]);
      try {
        const up = await wmApi.upload(f, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        const att = { blobId: up.blobId, name: f.name, type: f.type || up.type || 'application/octet-stream', size: f.size };
        updateComposer({ attachments: [...cRef.current.attachments, att] });
        cRef.current = { ...cRef.current, attachments: [...cRef.current.attachments, att] };
        setUploads((u) => u.filter((x) => x.key !== key));
        changed();
      } catch (err) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: (err as Error).message } : x)));
      }
    }
  };

  const send = async () => {
    const m = outgoing();
    if (!m || !drafts) return;
    const bad = [...parseAddressList(c.to).invalid, ...parseAddressList(c.cc).invalid, ...parseAddressList(c.bcc).invalid];
    if (bad.length) { toast('error', t('wm.compose.badAddress', { list: bad.join(', ') }) || `Invalid address: ${bad.join(', ')}`); return; }
    if (m.to.length + m.cc.length + m.bcc.length === 0) { toast('error', t('wm.compose.noRecipient') || 'Add at least one recipient.'); return; }
    if (uploads.some((u) => !u.error)) { toast('error', t('wm.compose.uploading') || 'Wait for the attachments to finish uploading.'); return; }
    if (!m.subject.trim() && !window.confirm(t('wm.compose.noSubjectConfirm') || 'Send without a subject?')) return;
    if (timer.current) window.clearTimeout(timer.current);
    setSending(true);
    try {
      if (saving.current) await saving.current.catch(() => undefined);
      await sendMessage(m, { drafts: drafts.id, sent: sent?.id ?? null }, cRef.current.draftId);
      if (c.answering) await setKeyword([c.answering], '$answered', true).catch(() => undefined);
      closeComposer();
      toast('ok', t('wm.compose.sent') || 'Message sent');
      void refreshMailboxes(true).then(() => reloadList(true));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sendDisabled') {
        // Refused by the proxy before anything was created: the message stays open, saved as a draft.
        toast('error', t('wm.compose.sendDisabled') || 'Sending is disabled for this mailbox. Your message stays here and is saved in Drafts.');
        void save();
      } else {
        toast('error', (err as Error).message || (t('wm.compose.sendFailed') || 'The message could not be sent.'));
      }
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (saving.current) await saving.current.catch(() => undefined);
    const id = cRef.current.draftId;
    closeComposer();
    if (id) {
      await destroyEmails([id]).catch(() => undefined);
      void refreshMailboxes(true);
    }
  };

  const close = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (dirty.current) await save();
    closeComposer();
    void refreshMailboxes(true);
  };
  // The phone's system Back button closes the composer like its X (MailShell, draft saved).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onClose = () => { void closeRef.current(); };
    window.addEventListener(COMPOSER_CLOSE_EVENT, onClose);
    return () => window.removeEventListener(COMPOSER_CLOSE_EVENT, onClose);
  }, []);

  /** Minimizing unmounts the rich editor: its content is kept in the store first (remounted from it on restore). */
  const minimize = () => {
    if (rich && editor.current) {
      const html = editor.current.html();
      updateComposer({ html });
      cRef.current = { ...cRef.current, html };
    }
    setView('min');
  };

  const toggleRich = () => {
    if (rich) {
      const text = editor.current?.text() ?? '';
      updateComposer({ text, html: null });
      setRich(false);
    } else {
      updateComposer({ html: c.text ? textToHtml(c.text) : '' });
      setRich(true);
    }
    changed();
  };

  const field = 'min-w-0 flex-1 bg-transparent px-1 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none';
  const title = c.mode === 'reply' || c.mode === 'replyAll' ? (t('wm.compose.titleReply') || 'Reply')
    : c.mode === 'forward' ? (t('wm.compose.titleForward') || 'Forward') : (t('wm.compose.new') || 'New message');
  const headline = c.subject.trim() || title;
  const saveText = saveState === 'saving' ? (t('wm.compose.saving') || 'Saving…') : saveState === 'saved' ? (t('wm.compose.saved') || 'Draft saved') : saveState === 'error' ? (t('wm.compose.saveFailed') || 'Draft not saved') : '';

  // Ctrl / Cmd + Enter sends from any field of the composer (the rich editor's iframe forwards it, RichEditor.tsx).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!sending) void send(); }
    if (e.key === 'Escape' && view === 'max') { e.stopPropagation(); setView('dock'); }
  };

  if (view === 'min') {
    return (
      <div {...{ [COMPOSER_ATTR]: '' }} className="wm-pop wm-dock-in fixed bottom-0 right-4 z-40 flex w-72 max-w-[calc(100vw-2rem)] items-center gap-1 rounded-t-[10px] bg-bg-secondary py-1.5 pl-3 pr-1" role="dialog" aria-label={title}>
        <button type="button" onClick={() => setView('dock')} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text-primary">{headline}</button>
        <IconButton size="sm" label={t('wm.compose.restore') || 'Restore'} onClick={() => setView('dock')}><Maximize2 size={13} /></IconButton>
        <IconButton size="sm" label={t('wm.common.close') || 'Close'} onClick={() => { void close(); }}><X size={14} /></IconButton>
      </div>
    );
  }

  return (
    <>
      {view === 'max' && <div className="wm-backdrop fixed inset-0 z-40 max-sm:hidden" onMouseDown={() => setView('dock')} />}
      <div
        {...{ [COMPOSER_ATTR]: '' }}
        onKeyDown={onKeyDown}
        className={cn(
          'wm-pop wm-dock-in fixed z-40 flex flex-col overflow-hidden bg-bg-secondary',
          // Phone: full screen. Desktop: docked bottom-right (Outlook), or large and centred.
          'inset-0 pb-[var(--safe-bottom,0px)] pt-[var(--safe-top,0px)] sm:pb-0 sm:pt-0',
          view === 'max'
            ? 'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(52rem,calc(100vh-3rem))] sm:w-[min(64rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[14px]'
            : 'sm:inset-auto sm:bottom-0 sm:right-4 sm:h-[min(40rem,calc(100vh-5rem))] sm:w-[min(40rem,calc(100vw-2rem))] sm:rounded-t-[14px]',
        )}
        role="dialog" aria-label={title}
      >
        <div className="flex shrink-0 items-center gap-1 bg-bg-tertiary py-1.5 pl-4 pr-1.5">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{headline}</h2>
          <span className="mr-1 hidden text-[11px] text-text-muted sm:inline">{saveText}</span>
          <IconButton size="sm" className="max-sm:hidden" label={t('wm.compose.minimize') || 'Minimize'} onClick={minimize}><Minus size={14} /></IconButton>
          <IconButton size="sm" className="max-sm:hidden" label={view === 'max' ? (t('wm.compose.dock') || 'Dock') : (t('wm.compose.maximize') || 'Enlarge')} onClick={() => setView(view === 'max' ? 'dock' : 'max')}>
            {view === 'max' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
          <IconButton size="sm" label={t('wm.common.close') || 'Close'} onClick={() => { void close(); }}><X size={15} /></IconButton>
        </div>

        <div className="shrink-0 divide-y divide-border/60 px-4">
          {identities.length > 1 && (
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[12px] text-text-muted">{t('wm.compose.from') || 'From'}</span>
              <select value={identityId} onChange={(e) => { setIdentityId(e.target.value); changed(); }} className={cn(field, 'wm-select bg-bg-secondary')}>
                {identities.map((i) => <option key={i.id} value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[12px] text-text-muted">{t('wm.compose.to') || 'To'}</span>
            <input value={c.to} onChange={(e) => set({ to: e.target.value })} className={field} autoFocus={c.mode === 'new' || c.mode === 'forward'} autoCapitalize="off" spellCheck={false} />
            {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] text-text-muted transition-colors hover:bg-bg-hover hover:text-accent">{t('wm.compose.ccBcc') || 'Cc / Bcc'}</button>}
          </label>
          {showCcBcc && (
            <>
              <label className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] text-text-muted">{t('wm.compose.cc') || 'Cc'}</span>
                <input value={c.cc} onChange={(e) => set({ cc: e.target.value })} className={field} autoCapitalize="off" spellCheck={false} />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] text-text-muted">{t('wm.compose.bcc') || 'Bcc'}</span>
                <input value={c.bcc} onChange={(e) => set({ bcc: e.target.value })} className={field} autoCapitalize="off" spellCheck={false} />
              </label>
            </>
          )}
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[12px] text-text-muted">{t('wm.compose.subject') || 'Subject'}</span>
            <input value={c.subject} onChange={(e) => set({ subject: e.target.value })} className={cn(field, 'font-medium')} maxLength={998} />
          </label>
        </div>
        <div className="h-px shrink-0 bg-border" />

        {rich ? (
          <RichEditor key={c.key} ref={editor} initialHtml={c.html ?? ''} onChange={changed} onSubmit={() => { if (!sending) void send(); }} placeholder={t('wm.compose.bodyPlaceholder') || 'Write your message…'} />
        ) : (
          <textarea
            value={c.text}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t('wm.compose.bodyPlaceholder') || 'Write your message…'}
            autoFocus={c.mode === 'reply' || c.mode === 'replyAll'}
            className="wm-scroll min-h-[12rem] flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
            onFocus={(e) => { if (c.mode !== 'new' && e.currentTarget.selectionStart === e.currentTarget.value.length) e.currentTarget.setSelectionRange(0, 0); }}
          />
        )}

        {(c.attachments.length > 0 || uploads.length > 0) && (
          <div className="wm-scroll flex max-h-32 shrink-0 flex-wrap gap-2 overflow-y-auto px-4 py-2">
            {c.attachments.map((a) => (
              <span key={a.blobId} className="flex max-w-full items-center gap-1.5 rounded-[7px] bg-bg-tertiary py-1 pl-2 pr-1 text-[12px] text-text-secondary">
                <Paperclip size={12} className="shrink-0 text-accent" />
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-text-muted">{formatSize(a.size)}</span>
                <button type="button" onClick={() => { updateComposer({ attachments: c.attachments.filter((x) => x.blobId !== a.blobId) }); changed(); }}
                  className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary" aria-label={t('wm.common.remove') || 'Remove'}><X size={12} /></button>
              </span>
            ))}
            {uploads.map((u) => (
              <span key={u.key} className={cn('flex max-w-full items-center gap-1.5 rounded-[7px] px-2 py-1 text-[12px]', u.error ? 'wm-warn-bg wm-warn' : 'bg-bg-tertiary text-text-muted')}>
                {u.error ? <X size={12} /> : <Loader2 size={12} className="animate-spin" />}
                <span className="truncate">{u.name}</span>
                <span>{u.error ? u.error.slice(0, 60) : `${Math.round(u.progress * 100)} %`}</span>
                {u.error && <button type="button" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label={t('wm.common.remove') || 'Remove'}><X size={12} /></button>}
              </span>
            ))}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1 px-3 py-2.5 pb-[max(0.625rem,var(--safe-bottom,0px))]">
          <PillButton variant="primary" icon={<Send size={14} />} loading={sending} disabled={!drafts || identities.length === 0} onClick={() => { void send(); }}
            title={`${t('wm.compose.send') || 'Send'} (Ctrl+Enter)`}>
            {t('wm.compose.send') || 'Send'}
          </PillButton>
          <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:h-10 coarse:w-10" title={t('wm.compose.attach') || 'Attach files'}>
            <Paperclip size={16} />
            <span className="sr-only">{t('wm.compose.attach') || 'Attach files'}</span>
            <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <IconButton active={rich} label={rich ? (t('wm.compose.plain') || 'Plain text') : (t('wm.compose.rich') || 'Rich text')} onClick={toggleRich}>
            {rich ? <Type size={16} /> : <FileText size={16} />}
          </IconButton>
          {maxBytes > 0 && usedBytes > 0 && <span className="ml-1 font-mono text-[10.5px] text-text-muted">{formatSize(usedBytes)} / {formatSize(Math.floor(maxBytes / MIME_OVERHEAD))}</span>}
          <span className="ml-auto mr-1 truncate text-[11px] text-text-muted sm:hidden">{saveText}</span>
          <IconButton tone="danger" className="sm:ml-auto" label={t('wm.compose.discard') || 'Discard'} onClick={() => { void discard(); }}><Trash2 size={16} /></IconButton>
        </div>
        {!drafts && <p className="wm-warn px-4 pb-2 text-[12px]">{t('wm.compose.noDrafts') || 'This mailbox has no Drafts folder: messages cannot be sent from the webmail.'}</p>}
      </div>
    </>
  );
}
