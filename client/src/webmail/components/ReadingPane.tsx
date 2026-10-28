import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive, ChevronDown, ChevronLeft, ChevronRight, Download, FolderInput, Forward, Mail, Paperclip, Reply, ReplyAll, ShieldAlert, Trash2,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { archive, canArchive, canSpam, deleteThreads, markSeen, markSpam, moveTo } from '../actions';
import { wmApi } from '../api';
import { loadBodies, loadThread, setKeyword, type EmailFull } from '../jmap';
import { displayName, draftFrom, formatAddress, formatAddressList, plainTextOf, type ComposeMode } from '../lib/compose';
import { formatFullDate, formatListDate, formatSize } from '../lib/format';
import { htmlToText, sanitizeForDisplay } from '../lib/sanitize';
import { mailboxByRole, useWebmail } from '../store';
import { MessageBody, partValue } from './MessageBody';
import { MoveMenu, ToolbarButton } from './MessageList';

function Attachments({ email }: { email: EmailFull }) {
  const { t } = useTranslation();
  const files = (email.attachments ?? []).filter((a) => a.blobId && !(a.disposition === 'inline' && a.cid));
  if (files.length === 0) return null;
  return (
    <div className="mx-4 mb-3 flex flex-wrap gap-2">
      {files.map((a, i) => (
        <a key={`${a.blobId}-${i}`} href={wmApi.blobUrl(a.blobId!, a.name ?? 'attachment')} download={a.name ?? 'attachment'}
          className="flex max-w-full items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary"
          title={t('wm.read.download') || 'Download'}>
          <Paperclip size={13} className="shrink-0" />
          <span className="truncate">{a.name ?? (t('wm.read.attachment') || 'attachment')}</span>
          <span className="shrink-0 text-text-muted">{formatSize(a.size)}</span>
          <Download size={13} className="shrink-0 text-text-muted" />
        </a>
      ))}
    </div>
  );
}

function MessageCard({ email, expanded, onToggle, onCompose }: {
  email: EmailFull; expanded: boolean; onToggle: () => void; onCompose: (mode: Exclude<ComposeMode, 'new'>, e: EmailFull) => void;
}) {
  const { t, i18n } = useTranslation();
  const from = email.from?.[0];
  return (
    <article className="border-b border-border">
      <header className="flex cursor-pointer items-start gap-3 px-4 py-3" onClick={onToggle}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold uppercase text-accent">
          {(displayName(from) || '?').slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary" title={from ? formatAddress(from) : ''}>{displayName(from) || (t('wm.list.noSender') || '(no sender)')}</span>
            <span className="shrink-0 font-mono text-[11px] text-text-muted" title={formatFullDate(email.receivedAt, i18n.language)}>{formatListDate(email.receivedAt, i18n.language)}</span>
          </div>
          {expanded ? (
            <div className="mt-0.5 space-y-0.5 text-xs text-text-muted">
              {from && <div className="truncate">{from.email}</div>}
              {!!email.to?.length && <div className="truncate"><span className="text-text-secondary">{t('wm.compose.to') || 'To'}:</span> {formatAddressList(email.to)}</div>}
              {!!email.cc?.length && <div className="truncate"><span className="text-text-secondary">{t('wm.compose.cc') || 'Cc'}:</span> {formatAddressList(email.cc)}</div>}
            </div>
          ) : <div className="truncate text-xs text-text-muted">{email.preview}</div>}
        </div>
        <ChevronDown size={16} className={cn('mt-1 shrink-0 text-text-muted transition-transform', !expanded && '-rotate-90')} />
      </header>
      {expanded && (
        <>
          {email.bodyLoaded
            ? <MessageBody email={email} />
            : <p className="px-4 py-3 text-sm text-text-muted">{t('wm.common.loading') || 'Loading…'}</p>}
          <Attachments email={email} />
          <div className="flex flex-wrap gap-2 px-4 pb-4">
            <button type="button" onClick={() => onCompose('reply', email)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary coarse:min-h-10">
              <Reply size={15} />{t('wm.actions.reply') || 'Reply'}
            </button>
            <button type="button" onClick={() => onCompose('replyAll', email)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary coarse:min-h-10">
              <ReplyAll size={15} />{t('wm.actions.replyAll') || 'Reply all'}
            </button>
            <button type="button" onClick={() => onCompose('forward', email)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary coarse:min-h-10">
              <Forward size={15} />{t('wm.actions.forward') || 'Forward'}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

export function ReadingPane() {
  const { t, i18n } = useTranslation();
  const threadId = useWebmail((s) => s.openThreadId);
  const listIds = useWebmail((s) => s.list.ids);
  const emails = useWebmail((s) => s.list.emails);
  const mailboxes = useWebmail((s) => s.mailboxes);
  const currentId = useWebmail((s) => s.currentMailboxId);
  const session = useWebmail((s) => s.session);
  const { openThread, openComposer, patchEmails, refreshMailboxes } = useWebmail.getState();
  const [messages, setMessages] = useState<EmailFull[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  /** Bodies requested for the open thread (fetched once per message, when it is expanded). */
  const requested = useRef<Set<string>>(new Set());
  const threadRef = useRef<string | null>(null);
  threadRef.current = threadId;

  /** Fetches the bodies of `ids` not requested yet, merged into the messages. */
  const fetchBodies = useCallback((ids: string[]) => {
    const missing = ids.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    const forThread = threadRef.current;
    loadBodies(missing).then((bodies) => {
      if (threadRef.current !== forThread) return;
      // A message gone meanwhile (or too large for the proxy) shows without a body rather than loading forever.
      setMessages((list) => list && list.map((m) => (missing.includes(m.id) ? { ...m, bodyValues: bodies[m.id] ?? {}, bodyLoaded: true } : m)));
    }).catch((err) => {
      for (const id of missing) requested.current.delete(id);
      if (threadRef.current === forThread) setError((err as Error).message);
    });
  }, []);
  const listId = listIds.find((id) => emails[id]?.threadId === threadId) ?? null;
  const index = listId ? listIds.indexOf(listId) : -1;
  const inTrash = !!currentId && currentId === mailboxByRole(mailboxes, 'trash')?.id;

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setMessages(null);
    setError(null);
    requested.current = new Set();
    loadThread(threadId).then(async (list) => {
      if (cancelled) return;
      setMessages(list);
      // The last unread messages (at most 10) + the last one expanded; their bodies fetched now, the others on demand.
      const open = [...list.filter((m) => !m.keywords?.$seen).slice(-10).map((m) => m.id), list[list.length - 1]?.id].filter(Boolean) as string[];
      setExpanded(new Set(open));
      fetchBodies(open);
      const unread = list.filter((m) => !m.keywords?.$seen).map((m) => m.id);
      if (unread.length) {
        await setKeyword(unread, '$seen', true).catch(() => undefined);
        const ids = Object.values(useWebmail.getState().list.emails).filter((e) => e.threadId === threadId).map((e) => e.id);
        patchEmails(ids, (e) => ({ ...e, keywords: { ...e.keywords, $seen: true } }));
        void refreshMailboxes(true).catch(() => undefined);
      }
    }).catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [threadId, patchEmails, refreshMailboxes, fetchBodies]);

  if (!threadId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
        <Mail size={40} className="opacity-40" />
        <p className="text-sm">{t('wm.read.none') || 'Select a message to read it.'}</p>
      </div>
    );
  }

  const compose = async (mode: Exclude<ComposeMode, 'new'>, original: EmailFull) => {
    // The quote needs the body: fetched now when the message was never expanded.
    let e = original;
    if (!e.bodyLoaded) {
      const bodies = await loadBodies([e.id]).catch(() => ({} as Record<string, EmailFull['bodyValues']>));
      e = { ...e, bodyValues: bodies[e.id] ?? {}, bodyLoaded: true };
    }
    const html = partValue(e, e.htmlBody);
    const isHtml = !!html && /html/i.test(e.htmlBody?.[0]?.type ?? '');
    const safe = isHtml ? sanitizeForDisplay(html!, { allowRemote: false }).html : null;
    const own = (session?.identities ?? []).map((i) => i.email).concat(session?.address ? [session.address] : []);
    const d = draftFrom(e, mode, own, plainTextOf(e, htmlToText), safe, {
      wrote: (date, who) => t('wm.compose.wrote', { date, who }) || `On ${date}, ${who} wrote:`,
      forwarded: t('wm.compose.forwarded') || 'Forwarded message',
      from: t('wm.compose.from') || 'From',
      date: t('wm.compose.date') || 'Date',
      subject: t('wm.compose.subject') || 'Subject',
      to: t('wm.compose.to') || 'To',
    }, (iso) => formatFullDate(iso, i18n.language));
    openComposer(d);
  };

  const subject = messages?.[messages.length - 1]?.subject ?? (listId ? emails[listId]?.subject : '') ?? '';
  const ids = listId ? [listId] : [];
  const go = (delta: number) => {
    const next = listIds[index + delta];
    if (next && emails[next]) openThread(emails[next].threadId);
  };
  const confirmDelete = () => {
    if (inTrash && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads(ids);
  };

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label={subject || ''}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <ToolbarButton title={t('wm.common.back') || 'Back'} onClick={() => openThread(null)}><ChevronLeft size={18} /></ToolbarButton>
        <div className="flex-1" />
        <ToolbarButton title={t('wm.actions.markUnread') || 'Mark as unread'} disabled={!ids.length} onClick={() => { void markSeen(ids, false).then(() => openThread(null)); }}><Mail size={17} /></ToolbarButton>
        <div className="relative">
          <ToolbarButton title={t('wm.actions.move') || 'Move to…'} disabled={!ids.length} onClick={() => setMoveOpen((v) => !v)}><FolderInput size={17} /></ToolbarButton>
          {moveOpen && <MoveMenu onPick={(id) => { void moveTo(ids, id); }} onClose={() => setMoveOpen(false)} />}
        </div>
        {canArchive() && <ToolbarButton title={t('wm.actions.archive') || 'Archive'} disabled={!ids.length} onClick={() => { void archive(ids); }}><Archive size={17} /></ToolbarButton>}
        {canSpam() && <ToolbarButton title={t('wm.actions.spam') || 'Mark as spam'} disabled={!ids.length} onClick={() => { void markSpam(ids); }}><ShieldAlert size={17} /></ToolbarButton>}
        <ToolbarButton title={inTrash ? (t('wm.actions.destroy') || 'Delete permanently') : (t('wm.actions.delete') || 'Delete')} disabled={!ids.length} onClick={confirmDelete}><Trash2 size={17} /></ToolbarButton>
        <ToolbarButton title={t('wm.read.previous') || 'Newer'} disabled={index <= 0} onClick={() => go(-1)}><ChevronLeft size={17} /></ToolbarButton>
        <ToolbarButton title={t('wm.read.next') || 'Older'} disabled={index < 0 || index >= listIds.length - 1} onClick={() => go(1)}><ChevronRight size={17} /></ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <h1 className="break-words px-4 pb-1 pt-4 font-display text-xl font-semibold text-text-primary">{subject || (t('wm.list.noSubject') || '(no subject)')}</h1>
        {error && <p className="px-4 py-3 text-sm text-amber-400">{error}</p>}
        {!messages && !error && <p className="px-4 py-6 text-sm text-text-muted">{t('wm.common.loading') || 'Loading…'}</p>}
        {messages?.map((m) => (
          <MessageCard key={m.id} email={m} expanded={expanded.has(m.id)}
            onToggle={() => {
              if (!expanded.has(m.id)) fetchBodies([m.id]);
              setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; });
            }}
            onCompose={(mode, e) => { void compose(mode, e); }} />
        ))}
        {messages && messages.length === 0 && <p className="px-4 py-6 text-sm text-text-muted">{t('wm.read.gone') || 'This conversation no longer exists.'}</p>}
      </div>
    </section>
  );
}
