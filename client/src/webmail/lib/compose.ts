import type { EmailAddress, EmailFull, OutgoingAttachment } from '../jmap';

// Pure helpers of the composer (compose.test.ts): address lists, reply /
// forward drafts, quoting. No DOM.

const ADDRESS_RE = /^[^\s@<>",;]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isValidAddress(email: string): boolean {
  return email.length <= 254 && ADDRESS_RE.test(email);
}

/** "Name <a@b>, c@d; "Last, First" <e@f>" → addresses; invalid entries are returned in `invalid`. */
export function parseAddressList(input: string): { list: EmailAddress[]; invalid: string[] } {
  const list: EmailAddress[] = [];
  const invalid: string[] = [];
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<' && !quoted) angle = true;
    if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !quoted && !angle) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(raw);
    const email = (m ? m[2] : raw).trim();
    const name = m && m[1] ? m[1].trim() : null;
    if (isValidAddress(email)) list.push({ name: name || null, email: email.toLowerCase() });
    else invalid.push(raw);
  }
  return { list, invalid };
}

export function formatAddress(a: EmailAddress): string {
  if (!a.name) return a.email;
  const name = /[",;<>@]/.test(a.name) ? `"${a.name.replace(/"/g, "'")}"` : a.name;
  return `${name} <${a.email}>`;
}

export function formatAddressList(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(', ');
}

export function displayName(a: EmailAddress | null | undefined): string {
  if (!a) return '';
  return a.name?.trim() || a.email;
}

export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return /^(re|aw|sv|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return /^(fwd?|tr|wg)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

export function quoteText(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n');
}

/** Plain text of a message: its text part, else its HTML stripped by the caller-provided function. */
export function plainTextOf(e: EmailFull, htmlToText: (html: string) => string): string {
  const t = e.textBody?.[0]?.partId ? e.bodyValues?.[e.textBody[0].partId]?.value : undefined;
  if (t !== undefined && !(e.textBody[0].type ?? '').includes('html')) return t;
  const h = e.htmlBody?.[0]?.partId ? e.bodyValues?.[e.htmlBody[0].partId]?.value : undefined;
  return h ? htmlToText(h) : (e.preview ?? '');
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface DraftFields {
  mode: ComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** Plain text body (also the rich editor's initial content when rich). */
  text: string;
  /** Initial HTML of the rich editor (null = start in plain text). */
  html: string | null;
  attachments: OutgoingAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
  /** The message answered (keyword $answered after sending). */
  answering: string | null;
}

export function emptyDraft(): DraftFields {
  return { mode: 'new', to: '', cc: '', bcc: '', subject: '', text: '', html: null, attachments: [], inReplyTo: null, references: null, answering: null };
}

export interface QuoteLabels {
  wrote: (date: string, who: string) => string;
  forwarded: string;
  from: string;
  date: string;
  subject: string;
  to: string;
}

/**
 * Draft of a reply / reply-all / forward of `e`. `own` = the mailbox's own
 * addresses (never answered to themselves). `safeHtml` = the original HTML
 * already sanitized (rich quote), null = quote as text.
 */
export function draftFrom(
  e: EmailFull,
  mode: Exclude<ComposeMode, 'new'>,
  own: string[],
  text: string,
  safeHtml: string | null,
  labels: QuoteLabels,
  formatDate: (iso: string) => string,
): DraftFields {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const notMine = (l: EmailAddress[] | null | undefined) => (l ?? []).filter((a) => !mine.has(a.email.toLowerCase()));
  const from = e.from?.[0] ?? null;
  const date = formatDate(e.sentAt ?? e.receivedAt);
  const d = emptyDraft();
  d.mode = mode;
  if (mode === 'forward') {
    d.subject = forwardSubject(e.subject);
    d.attachments = (e.attachments ?? []).filter((a) => a.blobId && a.disposition !== 'inline').map((a) => ({
      blobId: a.blobId!, name: a.name ?? 'attachment', type: a.type, size: a.size,
    }));
    const head = [
      `---------- ${labels.forwarded} ----------`,
      `${labels.from}: ${formatAddressList(e.from)}`,
      `${labels.date}: ${date}`,
      `${labels.subject}: ${e.subject ?? ''}`,
      `${labels.to}: ${formatAddressList(e.to)}`,
    ];
    d.text = `\n\n${head.join('\n')}\n\n${text}`;
    d.html = safeHtml !== null ? `<p><br></p><p>${head.map(escapeHtml).join('<br>')}</p>${safeHtml}` : null;
    return d;
  }
  const replyTo = e.replyTo?.length ? e.replyTo : e.from ?? [];
  d.subject = replySubject(e.subject);
  const to = mode === 'replyAll' ? [...replyTo, ...notMine(e.to)] : replyTo;
  const seen = new Set<string>();
  const uniq = (l: EmailAddress[]) => l.filter((a) => { const k = a.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  d.to = formatAddressList(uniq(to));
  if (mode === 'replyAll') d.cc = formatAddressList(uniq(notMine(e.cc)));
  const msgId = e.messageId?.[0] ?? null;
  d.inReplyTo = msgId ? [msgId] : null;
  d.references = msgId ? [...(e.references ?? []), msgId].slice(-20) : e.references ?? null;
  d.answering = e.id;
  const intro = labels.wrote(date, from ? formatAddress(from) : '');
  d.text = `\n\n${intro}\n${quoteText(text)}`;
  d.html = safeHtml !== null ? `<p><br></p><p>${escapeHtml(intro)}</p><blockquote>${safeHtml}</blockquote>` : null;
  return d;
}
