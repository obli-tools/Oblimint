import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Paperclip, Send, Trash2, Type, X } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';
import { wmApi } from '../api';
import { destroyEmails, saveDraft, sendMessage, setKeyword, type OutgoingMessage } from '../jmap';
import { parseAddressList, textToHtml } from '../lib/compose';
import { formatSize } from '../lib/format';
import { mailboxByRole, useWebmail, type ComposerState } from '../store';
import { RichEditor, type RichEditorHandle } from './RichEditor';

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
    const html = rich ? editor.current?.html() ?? '' : null;
    const text = rich ? editor.current?.text() ?? '' : cur.text;
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
      toast('error', (err as Error).message || (t('wm.compose.sendFailed') || 'The message could not be sent.'));
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

  const field = 'min-w-0 flex-1 bg-transparent px-1 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none';
  const title = c.mode === 'reply' || c.mode === 'replyAll' ? (t('wm.compose.titleReply') || 'Reply')
    : c.mode === 'forward' ? (t('wm.compose.titleForward') || 'Forward') : (t('wm.compose.new') || 'New message');

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-secondary sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(44rem,calc(100vh-2rem))] sm:w-[min(44rem,calc(100vw-2rem))] sm:rounded-xl sm:border sm:border-border sm:shadow-2xl"
      role="dialog" aria-label={title}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 truncate text-sm font-semibold text-text-primary">{title}</h2>
        <span className="text-[11px] text-text-muted">
          {saveState === 'saving' ? (t('wm.compose.saving') || 'Saving…') : saveState === 'saved' ? (t('wm.compose.saved') || 'Draft saved') : saveState === 'error' ? (t('wm.compose.saveFailed') || 'Draft not saved') : ''}
        </span>
        <button type="button" onClick={() => { void close(); }} className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10" aria-label={t('wm.common.close') || 'Close'}>
          <X size={16} />
        </button>
      </div>

      <div className="shrink-0 divide-y divide-border/60 border-b border-border px-3">
        {identities.length > 1 && (
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-text-muted">{t('wm.compose.from') || 'From'}</span>
            <select value={identityId} onChange={(e) => { setIdentityId(e.target.value); changed(); }} className={cn(field, 'bg-bg-secondary')}>
              {identities.map((i) => <option key={i.id} value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-text-muted">{t('wm.compose.to') || 'To'}</span>
          <input value={c.to} onChange={(e) => set({ to: e.target.value })} className={field} autoFocus={c.mode === 'new' || c.mode === 'forward'} autoCapitalize="off" spellCheck={false} />
          {!showCcBcc && <button type="button" onClick={() => setShowCcBcc(true)} className="shrink-0 text-xs text-text-muted hover:text-accent">{t('wm.compose.ccBcc') || 'Cc / Bcc'}</button>}
        </label>
        {showCcBcc && (
          <>
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-text-muted">{t('wm.compose.cc') || 'Cc'}</span>
              <input value={c.cc} onChange={(e) => set({ cc: e.target.value })} className={field} autoCapitalize="off" spellCheck={false} />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-text-muted">{t('wm.compose.bcc') || 'Bcc'}</span>
              <input value={c.bcc} onChange={(e) => set({ bcc: e.target.value })} className={field} autoCapitalize="off" spellCheck={false} />
            </label>
          </>
        )}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-text-muted">{t('wm.compose.subject') || 'Subject'}</span>
          <input value={c.subject} onChange={(e) => set({ subject: e.target.value })} className={field} maxLength={998} />
        </label>
      </div>

      {rich ? (
        <RichEditor key={c.key} ref={editor} initialHtml={c.html ?? ''} onChange={changed} placeholder={t('wm.compose.bodyPlaceholder') || 'Write your message…'} />
      ) : (
        <textarea
          value={c.text}
          onChange={(e) => set({ text: e.target.value })}
          placeholder={t('wm.compose.bodyPlaceholder') || 'Write your message…'}
          autoFocus={c.mode === 'reply' || c.mode === 'replyAll'}
          className="min-h-[12rem] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          onFocus={(e) => { if (c.mode !== 'new' && e.currentTarget.selectionStart === e.currentTarget.value.length) e.currentTarget.setSelectionRange(0, 0); }}
        />
      )}

      {(c.attachments.length > 0 || uploads.length > 0) && (
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-border px-3 py-2">
          {c.attachments.map((a) => (
            <span key={a.blobId} className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">
              <Paperclip size={12} className="shrink-0" />
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 text-text-muted">{formatSize(a.size)}</span>
              <button type="button" onClick={() => { updateComposer({ attachments: c.attachments.filter((x) => x.blobId !== a.blobId) }); changed(); }}
                className="text-text-muted hover:text-text-primary" aria-label={t('wm.common.remove') || 'Remove'}><X size={12} /></button>
            </span>
          ))}
          {uploads.map((u) => (
            <span key={u.key} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', u.error ? 'border-status-down/40 text-amber-400' : 'border-border text-text-muted')}>
              {u.error ? <X size={12} /> : <Loader2 size={12} className="animate-spin" />}
              <span className="truncate">{u.name}</span>
              <span>{u.error ? u.error.slice(0, 60) : `${Math.round(u.progress * 100)} %`}</span>
              {u.error && <button type="button" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label={t('wm.common.remove') || 'Remove'}><X size={12} /></button>}
            </span>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 pb-[max(0.5rem,var(--safe-bottom,0px))]">
        <Button onClick={() => { void send(); }} loading={sending} disabled={!drafts || identities.length === 0}>
          <Send size={15} className="mr-1.5" />{t('wm.compose.send') || 'Send'}
        </Button>
        <label className="cursor-pointer rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10" title={t('wm.compose.attach') || 'Attach files'}>
          <Paperclip size={17} />
          <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <button type="button" onClick={toggleRich} title={rich ? (t('wm.compose.plain') || 'Plain text') : (t('wm.compose.rich') || 'Rich text')}
          className={cn('rounded-md p-2 hover:bg-bg-hover coarse:min-h-10 coarse:min-w-10', rich ? 'text-accent' : 'text-text-muted hover:text-text-primary')}>
          {rich ? <Type size={17} /> : <FileText size={17} />}
        </button>
        {maxBytes > 0 && usedBytes > 0 && <span className="text-[11px] text-text-muted">{formatSize(usedBytes)} / {formatSize(Math.floor(maxBytes / MIME_OVERHEAD))}</span>}
        <div className="flex-1" />
        <button type="button" onClick={() => { void discard(); }} title={t('wm.compose.discard') || 'Discard'}
          className="rounded-md p-2 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10">
          <Trash2 size={17} />
        </button>
      </div>
      {!drafts && <p className="px-3 pb-2 text-xs text-amber-400">{t('wm.compose.noDrafts') || 'This mailbox has no Drafts folder: messages cannot be sent from the webmail.'}</p>}
    </div>
  );
}
