import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, Flag, FolderInput, Forward, Mail, MailOpen, MoreHorizontal, Paperclip, Reply, ReplyAll, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { archive, canArchive, canSpam, closeThread, deleteThreads, deletesForGood, markSeen, markSpam, moveTo, toggleFlag } from '../actions';
import { wmApi } from '../api';
import { useHotkeys } from '../hotkeys';
import { loadBodies, loadThread, setKeyword, type EmailFull } from '../jmap';
import { displayName, draftFrom, formatAddress, formatAddressList, plainTextOf, type ComposeMode } from '../lib/compose';
import { formatFullDate, formatListDate, formatSize } from '../lib/format';
import { htmlToText, sanitizeForDisplay } from '../lib/sanitize';
import { useWebmail } from '../store';
import { MessageBody, partValue } from './MessageBody';
import { MoveMenu } from './MessageList';
import { useMailboxName } from './MailboxTree';
import { SenderButton } from './SenderCard';
import { Avatar, EmptyState, IconButton, MenuItem, PillButton, Popover } from './ui';

function Attachments({ email }: { email: EmailFull }) {
  const { t } = useTranslation();
  const files = (email.attachments ?? []).filter((a) => a.blobId && !(a.disposition === 'inline' && a.cid));
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3">
      {files.map((a, i) => (
        <a key={`${a.blobId}-${i}`} href={wmApi.blobUrl(a.blobId!, a.name ?? 'attachment')} download={a.name ?? 'attachment'}
          className="group flex max-w-full items-center gap-2.5 rounded-[10px] bg-bg-tertiary py-2 pl-2.5 pr-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={t('wm.read.download') || 'Download'}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-accent/15 text-accent"><Paperclip size={14} /></span>
          <span className="min-w-0">
            <span className="block max-w-[14rem] truncate font-medium text-text-primary">{a.name ?? (t('wm.read.attachment') || 'attachment')}</span>
            <span className="block font-mono text-[10.5px] text-text-muted">{formatSize(a.size)}</span>
          </span>
          <Download size={14} className="shrink-0 text-text-muted transition-colors group-hover:text-accent" />
        </a>
      ))}
    </div>
  );
}

function MessageCard({ email, expanded, last, onToggle, onCompose }: {
  email: EmailFull; expanded: boolean; last: boolean; onToggle: () => void; onCompose: (mode: Exclude<ComposeMode, 'new'>, e: EmailFull) => void;
}) {
  const { t, i18n } = useTranslation();
  const from = email.from?.[0];
  const name = displayName(from) || (t('wm.list.noSender') || '(no sender)');
  const unread = !email.keywords?.$seen;
  return (
    <article className={cn('wm-card overflow-hidden rounded-[10px] bg-bg-secondary transition-colors', !expanded && 'hover:bg-bg-tertiary')}>
      <header className="flex cursor-pointer items-start gap-3 rounded-[10px] px-4 py-3" onClick={onToggle}
        role="button" tabIndex={0} aria-expanded={expanded}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(); } }}>
        <SenderButton person={from ?? null} label={t('wm.card.open') || 'Contact card'} className="shrink-0 rounded-full">
          <Avatar name={from?.name} email={from?.email} size={36} />
        </SenderButton>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <SenderButton person={from ?? null} label={from ? formatAddress(from) : ''} className={cn('min-w-0 truncate text-[13.5px] text-text-primary', unread ? 'font-semibold' : 'font-medium')}>{name}</SenderButton>
            {expanded && from && from.name && <span className="hidden min-w-0 shrink-[4] truncate text-[12px] text-text-muted sm:inline">&lt;{from.email}&gt;</span>}
            <span className="flex-1" />
            {email.hasAttachment && !expanded && <Paperclip size={12} className="shrink-0 self-center text-text-muted" />}
            <time dateTime={email.receivedAt} className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted" title={formatFullDate(email.receivedAt, i18n.language)}>
              {expanded ? formatFullDate(email.receivedAt, i18n.language) : formatListDate(email.receivedAt, i18n.language)}
            </time>
          </div>
          {expanded ? (
            <div className="mt-0.5 space-y-0.5 text-[12px] text-text-muted">
              {!!email.to?.length && <div className="truncate"><span className="text-text-secondary">{t('wm.compose.to') || 'To'}</span> {formatAddressList(email.to)}</div>}
              {!!email.cc?.length && <div className="truncate"><span className="text-text-secondary">{t('wm.compose.cc') || 'Cc'}</span> {formatAddressList(email.cc)}</div>}
            </div>
          ) : <div className="truncate text-[12px] text-text-muted">{email.preview}</div>}
        </div>
        <ChevronDown size={15} className={cn('mt-1 shrink-0 text-text-muted transition-transform', !expanded && '-rotate-90')} />
      </header>
      {expanded && (
        <>
          {email.bodyLoaded ? <MessageBody email={email} /> : (
            <div className="space-y-2 px-4 pb-4 pt-1" aria-hidden>
              <span className="wm-skel block h-3.5 w-11/12" /><span className="wm-skel block h-3.5 w-4/5" /><span className="wm-skel block h-3.5 w-2/3" />
            </div>
          )}
          <Attachments email={email} />
          <div className={cn('flex flex-wrap gap-2 px-4 pb-4', !last && 'pt-0')}>
            <PillButton size="sm" variant={last ? 'accent' : 'secondary'} icon={<Reply size={14} />} onClick={() => onCompose('reply', email)}>{t('wm.actions.reply') || 'Reply'}</PillButton>
            <PillButton size="sm" icon={<ReplyAll size={14} />} onClick={() => onCompose('replyAll', email)}>{t('wm.actions.replyAll') || 'Reply all'}</PillButton>
            <PillButton size="sm" icon={<Forward size={14} />} onClick={() => onCompose('forward', email)}>{t('wm.actions.forward') || 'Forward'}</PillButton>
          </div>
        </>
      )}
    </article>
  );
}

function ReadingSkeleton() {
  return (
    <div className="space-y-3 px-4 pt-2" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="wm-card space-y-3 rounded-[10px] bg-bg-secondary p-4">
          <div className="flex items-center gap-3"><span className="wm-skel block h-9 w-9 rounded-full" /><span className="wm-skel block h-3.5 w-1/3" /><span className="flex-1" /><span className="wm-skel block h-3 w-16" /></div>
          {i === 1 && <div className="space-y-2 pt-1"><span className="wm-skel block h-3.5 w-full" /><span className="wm-skel block h-3.5 w-11/12" /><span className="wm-skel block h-3.5 w-3/4" /><span className="wm-skel block h-3.5 w-5/6" /></div>}
        </div>
      ))}
    </div>
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
  const composerOpen = useWebmail((s) => !!s.composer);
  const overlay = useWebmail((s) => s.overlay);
  const { openThread, openComposer, patchEmails, refreshMailboxes } = useWebmail.getState();
  const nameOf = useMailboxName();
  const [messages, setMessages] = useState<EmailFull[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const forGood = deletesForGood({ mailboxes, currentMailboxId: currentId });
  const current = mailboxes.find((m) => m.id === currentId) ?? null;

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setMessages(null);
    setError(null);
    setMoveOpen(false);
    setMoreOpen(false);
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

  const lastMessage = messages?.[messages.length - 1] ?? null;
  // r / a / f on the newest message of the open conversation.
  useHotkeys({
    r: () => { if (lastMessage) void compose('reply', lastMessage); },
    a: () => { if (lastMessage) void compose('replyAll', lastMessage); },
    f: () => { if (lastMessage) void compose('forward', lastMessage); },
  }, !!threadId && !!lastMessage && !composerOpen && !overlay);

  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-primary p-6">
        <EmptyState icon={<Mail size={22} />} title={t('wm.read.none') || 'Select a message to read it.'}
          description={t('wm.read.noneHint') || 'The conversation opens here. Keyboard: J and K to move, C to write, ? for every shortcut.'} />
      </div>
    );
  }

  const subject = lastMessage?.subject ?? (listId ? emails[listId]?.subject : '') ?? '';
  const ids = listId ? [listId] : [];
  const flagged = !!(listId && emails[listId]?.keywords?.$flagged);
  const go = (delta: number) => {
    const next = listIds[index + delta];
    if (next && emails[next]) openThread(emails[next].threadId);
  };
  const confirmDelete = () => {
    if (forGood && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads(ids);
  };

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg-primary" aria-label={subject || ''}>
      {/* Toolbar: the conversation verbs, then navigation. */}
      {/* Fits the narrowest reading pane (tablet, 1024 px with the folders: ~360 px): below xl, Reply all /
          Forward and Newer / Older move into More (J / K and the message cards' buttons do the same). */}
      <div className="flex min-w-0 shrink-0 items-center gap-1 px-3 py-2">
        <IconButton className="md:hidden" label={t('wm.common.back') || 'Back'} onClick={closeThread}><ArrowLeft size={17} /></IconButton>
        <div className="hidden items-center gap-1 sm:flex">
          <PillButton size="sm" variant="accent" icon={<Reply size={14} />} disabled={!lastMessage} onClick={() => { if (lastMessage) void compose('reply', lastMessage); }}>
            <span className="max-xl:sr-only">{t('wm.actions.reply') || 'Reply'}</span>
          </PillButton>
          <IconButton className="hidden xl:inline-flex" label={t('wm.actions.replyAll') || 'Reply all'} disabled={!lastMessage} onClick={() => { if (lastMessage) void compose('replyAll', lastMessage); }}><ReplyAll size={16} /></IconButton>
          <IconButton className="hidden xl:inline-flex" label={t('wm.actions.forward') || 'Forward'} disabled={!lastMessage} onClick={() => { if (lastMessage) void compose('forward', lastMessage); }}><Forward size={16} /></IconButton>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        </div>
        {canArchive() && <IconButton label={t('wm.actions.archive') || 'Archive'} disabled={!ids.length} onClick={() => { void archive(ids); }}><Archive size={16} /></IconButton>}
        <IconButton tone="danger" label={forGood ? (t('wm.actions.destroy') || 'Delete permanently') : (t('wm.actions.delete') || 'Delete')} disabled={!ids.length} onClick={confirmDelete}><Trash2 size={16} /></IconButton>
        <div className="relative">
          <IconButton label={t('wm.actions.move') || 'Move to…'} disabled={!ids.length} onClick={() => setMoveOpen((v) => !v)}><FolderInput size={16} /></IconButton>
          <MoveMenu open={moveOpen} align="left" onPick={(id) => { void moveTo(ids, id); }} onClose={() => setMoveOpen(false)} />
        </div>
        <IconButton active={flagged} label={flagged ? (t('wm.actions.unflag') || 'Remove the flag') : (t('wm.actions.flag') || 'Flag')} disabled={!ids.length} onClick={() => { void toggleFlag(ids); }}>
          <Flag size={16} fill={flagged ? 'currentColor' : 'none'} />
        </IconButton>
        <div className="relative">
          <IconButton label={t('wm.actions.more') || 'More actions'} disabled={!ids.length} onClick={() => setMoreOpen((v) => !v)}><MoreHorizontal size={16} /></IconButton>
          <Popover open={moreOpen} onClose={() => setMoreOpen(false)} align="right" className="w-56">
            <MenuItem icon={<MailOpen size={14} />} onClick={() => { setMoreOpen(false); void markSeen(ids, false).then(() => openThread(null)); }}>{t('wm.actions.markUnread') || 'Mark as unread'}</MenuItem>
            {canSpam() && <MenuItem icon={<ShieldAlert size={14} />} onClick={() => { setMoreOpen(false); void markSpam(ids); }}>{t('wm.actions.spam') || 'Mark as spam'}</MenuItem>}
            <div className="xl:hidden">
              <MenuItem icon={<ReplyAll size={14} />} onClick={() => { setMoreOpen(false); if (lastMessage) void compose('replyAll', lastMessage); }}>{t('wm.actions.replyAll') || 'Reply all'}</MenuItem>
              <MenuItem icon={<Forward size={14} />} onClick={() => { setMoreOpen(false); if (lastMessage) void compose('forward', lastMessage); }}>{t('wm.actions.forward') || 'Forward'}</MenuItem>
              <MenuItem icon={<ChevronLeft size={14} />} onClick={() => { setMoreOpen(false); go(-1); }} disabled={index <= 0}>{t('wm.read.previous') || 'Newer'}</MenuItem>
              <MenuItem icon={<ChevronRight size={14} />} onClick={() => { setMoreOpen(false); go(1); }} disabled={index < 0 || index >= listIds.length - 1}>{t('wm.read.next') || 'Older'}</MenuItem>
            </div>
          </Popover>
        </div>
        <div className="flex-1" />
        <IconButton className="hidden xl:inline-flex" label={t('wm.read.previous') || 'Newer'} disabled={index <= 0} onClick={() => go(-1)}><ChevronLeft size={16} /></IconButton>
        <IconButton className="hidden xl:inline-flex" label={t('wm.read.next') || 'Older'} disabled={index < 0 || index >= listIds.length - 1} onClick={() => go(1)}><ChevronRight size={16} /></IconButton>
        <IconButton className="max-md:hidden" label={t('wm.common.close') || 'Close'} onClick={() => openThread(null)}><X size={16} /></IconButton>
      </div>

      <div className="wm-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-24 md:pb-6">
        <div className="mx-auto w-full max-w-4xl">
          <div className="px-4 pb-3 pt-2">
            <h1 className="break-words text-[20px] font-semibold leading-snug text-text-primary">{subject || (t('wm.list.noSubject') || '(no subject)')}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {current && <span className="rounded-[7px] bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{nameOf(current)}</span>}
              {messages && messages.length > 1 && (
                <span className="rounded-[7px] bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-muted">
                  {t('wm.read.count', { count: messages.length }) || `${messages.length} messages`}
                </span>
              )}
              {flagged && <span className="wm-warn wm-warn-bg inline-flex items-center gap-1 rounded-[7px] px-2 py-0.5 text-[11px]"><Flag size={10} fill="currentColor" />{t('wm.list.flagged') || 'Flagged'}</span>}
            </div>
          </div>
          {error && <p className="wm-warn wm-warn-bg mx-4 mb-3 rounded-[10px] px-3 py-2 text-[13px]">{error}</p>}
          {!messages && !error && <ReadingSkeleton />}
          <div className="space-y-3 px-4">
            {messages?.map((m, i) => (
              <MessageCard key={m.id} email={m} expanded={expanded.has(m.id)} last={i === messages.length - 1}
                onToggle={() => {
                  if (!expanded.has(m.id)) fetchBodies([m.id]);
                  setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; });
                }}
                onCompose={(mode, e) => { void compose(mode, e); }} />
            ))}
          </div>
          {messages && messages.length === 0 && (
            <EmptyState icon={<Mail size={22} />} title={t('wm.read.gone') || 'This conversation no longer exists.'} />
          )}
        </div>
      </div>
    </section>
  );
}
