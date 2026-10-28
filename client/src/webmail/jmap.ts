import type { WebmailIdentity } from '@oblimint/shared';
import { ApiError, wmApi, type JmapInvocation } from './api';

// ─────────────────────────────────────────────────────────────────────────────
// JMAP operations of the webmail (RFC 8620 / 8621) through the proxy. The
// accountId is never sent: the proxy pins the session's own account.
// Within the proxy's bounds (server policy.ts): explicit, duplicate-free id
// lists; message bodies fetched separately, a few messages per request
// (BODY_CHUNK), each body value cut at MAX_BODY_VALUE_BYTES (a longer part
// is then read from its blob: MessageBody.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailListItem {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
  size: number;
}

export interface BodyPart {
  partId: string | null;
  blobId: string | null;
  type: string;
  charset?: string | null;
  name: string | null;
  size: number;
  disposition: string | null;
  cid: string | null;
}

export interface EmailFull extends EmailListItem {
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  sentAt: string | null;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
  bodyValues: Record<string, { value: string; isTruncated?: boolean }>;
  /** The body values were fetched (loadBodies); false = headers / structure only. */
  bodyLoaded?: boolean;
}

export interface SearchQuery {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  /** Search every folder instead of the current one. */
  everywhere?: boolean;
}

const LIST_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'receivedAt', 'preview', 'hasAttachment', 'size'];
const FULL_PROPS = [...LIST_PROPS, 'cc', 'bcc', 'replyTo', 'sentAt', 'messageId', 'inReplyTo', 'references', 'textBody', 'htmlBody', 'attachments'];
const BODY_PROPS = ['partId', 'blobId', 'type', 'charset', 'name', 'size', 'disposition', 'cid'];
/** Body value cut (server policy MAX_BODY_VALUE_BYTES): longer parts come as isTruncated. */
export const MAX_BODY_VALUE_BYTES = 256 * 1024;
/** Messages whose bodies are fetched per request (server: ≤ 32 per call, ≤ 8 MiB of values per request). */
const BODY_CHUNK = 8;
/** Thread ids per Thread/get (server: ≤ 250 explicit ids). */
const THREAD_CHUNK = 100;

const resp = (r: JmapInvocation[], callId: string): Record<string, unknown> => (r.find((m) => m[2] === callId)?.[1] ?? {}) as Record<string, unknown>;

export async function loadMailboxes(background = false): Promise<Mailbox[]> {
  const r = await wmApi.jmap([['Mailbox/get', { ids: null, properties: ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'] }, 'm']], background);
  return ((resp(r, 'm').list ?? []) as Mailbox[]).map((m) => ({ ...m, role: m.role ?? null, parentId: m.parentId ?? null }));
}

export function buildFilter(mailboxId: string | null, q: SearchQuery | null): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (mailboxId && !q?.everywhere) conditions.push({ inMailbox: mailboxId });
  if (q?.text?.trim()) conditions.push({ text: q.text.trim() });
  if (q?.from?.trim()) conditions.push({ from: q.from.trim() });
  if (q?.to?.trim()) conditions.push({ to: q.to.trim() });
  if (q?.subject?.trim()) conditions.push({ subject: q.subject.trim() });
  if (q?.hasAttachment) conditions.push({ hasAttachment: true });
  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

export interface ThreadPage {
  ids: string[];
  emails: Record<string, EmailListItem>;
  threadSizes: Record<string, number>;
  total: number;
  position: number;
}

/** One page of the thread list (one email per thread, newest first). */
export async function queryThreads(filter: Record<string, unknown>, position: number, limit = 50, background = false): Promise<ThreadPage> {
  const r = await wmApi.jmap([
    ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit, calculateTotal: true }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: LIST_PROPS }, 'g'],
    ['Thread/get', { '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
  ], background);
  const q = resp(r, 'q');
  const emails: Record<string, EmailListItem> = {};
  for (const e of (resp(r, 'g').list ?? []) as EmailListItem[]) emails[e.id] = e;
  const threadSizes: Record<string, number> = {};
  for (const t of (resp(r, 't').list ?? []) as Array<{ id: string; emailIds: string[] }>) threadSizes[t.id] = t.emailIds.length;
  return { ids: ((q.ids ?? []) as string[]).filter((id) => emails[id]), emails, threadSizes, total: Number(q.total ?? 0), position: Number(q.position ?? position) };
}

/** Every message of a thread, oldest first: headers and structure only (bodies: loadBodies). */
export async function loadThread(threadId: string): Promise<EmailFull[]> {
  const r = await wmApi.jmap([
    ['Thread/get', { ids: [threadId] }, 't'],
    ['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: FULL_PROPS, bodyProperties: BODY_PROPS }, 'g'],
  ]);
  const list = ((resp(r, 'g').list ?? []) as EmailFull[]).map((e) => ({ ...e, bodyValues: {}, bodyLoaded: false }));
  return list.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * Body values (text + HTML parts, each cut at MAX_BODY_VALUE_BYTES) of
 * `emailIds`, BODY_CHUNK messages per request. A chunk the server finds too
 * large is retried one message at a time; a message still too large comes
 * back without values (the reader offers its parts as downloads).
 */
export async function loadBodies(emailIds: string[]): Promise<Record<string, EmailFull['bodyValues']>> {
  const out: Record<string, EmailFull['bodyValues']> = {};
  const fetchChunk = async (ids: string[]) => {
    const r = await wmApi.jmap([['Email/get', {
      ids, properties: ['id', 'bodyValues'], fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
    }, 'b']]);
    for (const e of (resp(r, 'b').list ?? []) as Array<{ id: string; bodyValues?: EmailFull['bodyValues'] }>) out[e.id] = e.bodyValues ?? {};
  };
  const unique = [...new Set(emailIds)];
  for (let i = 0; i < unique.length; i += BODY_CHUNK) {
    const chunk = unique.slice(i, i + BODY_CHUNK);
    try {
      await fetchChunk(chunk);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'tooLarge') throw err;
      for (const id of chunk) {
        try { await fetchChunk([id]); } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'tooLarge') throw e;
          out[id] = {};
        }
      }
    }
  }
  return out;
}

/** Ids of the messages of `threadIds` (optionally only those in `mailboxId`). */
export async function threadEmailIds(threadIds: string[], mailboxId: string | null): Promise<EmailListItem[]> {
  const unique = [...new Set(threadIds)];
  const list: EmailListItem[] = [];
  for (let i = 0; i < unique.length; i += THREAD_CHUNK) {
    const r = await wmApi.jmap([
      ['Thread/get', { ids: unique.slice(i, i + THREAD_CHUNK) }, 't'],
      ['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'threadId', 'mailboxIds', 'keywords'] }, 'g'],
    ]);
    list.push(...((resp(r, 'g').list ?? []) as EmailListItem[]));
  }
  return mailboxId ? list.filter((e) => e.mailboxIds?.[mailboxId]) : list;
}

async function update(patches: Record<string, Record<string, unknown>>): Promise<void> {
  const ids = Object.keys(patches);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = Object.fromEntries(ids.slice(i, i + 200).map((id) => [id, patches[id]]));
    const r = await wmApi.jmap([['Email/set', { update: chunk }, 'u']]);
    const failed = resp(r, 'u').notUpdated as Record<string, unknown> | undefined;
    if (failed && Object.keys(failed).length) throw new Error('Some messages could not be updated');
  }
}

export async function setKeyword(emailIds: string[], keyword: '$seen' | '$flagged' | '$answered', value: boolean): Promise<void> {
  await update(Object.fromEntries(emailIds.map((id) => [id, { [`keywords/${keyword}`]: value ? true : null }])));
}

export async function moveEmails(emails: Array<Pick<EmailListItem, 'id' | 'mailboxIds'>>, from: string | null, to: string): Promise<void> {
  await update(Object.fromEntries(emails.map((e) => {
    const patch: Record<string, unknown> = { [`mailboxIds/${to}`]: true };
    if (from && from !== to) patch[`mailboxIds/${from}`] = null;
    else for (const m of Object.keys(e.mailboxIds ?? {})) if (m !== to) patch[`mailboxIds/${m}`] = null;
    return [e.id, patch];
  })));
}

export async function destroyEmails(emailIds: string[]): Promise<void> {
  const ids = [...new Set(emailIds)];
  for (let i = 0; i < ids.length; i += 200) {
    await wmApi.jmap([['Email/set', { destroy: ids.slice(i, i + 200) }, 'd']]);
  }
}

// ── composing ────────────────────────────────────────────────────────────────

export interface OutgoingAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface OutgoingMessage {
  identity: WebmailIdentity;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  text: string;
  /** Sanitized HTML (rich mode), null = plain text only. */
  html: string | null;
  attachments: OutgoingAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
}

function emailObject(m: OutgoingMessage, mailboxId: string, draft: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = {
    mailboxIds: { [mailboxId]: true },
    keywords: draft ? { $draft: true, $seen: true } : { $seen: true, $draft: true },
    from: [{ name: m.identity.name || null, email: m.identity.email }],
    subject: m.subject,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: m.text } } as Record<string, { value: string }>,
  };
  if (m.to.length) o.to = m.to;
  if (m.cc.length) o.cc = m.cc;
  if (m.bcc.length) o.bcc = m.bcc;
  if (m.html !== null) {
    o.htmlBody = [{ partId: 'h', type: 'text/html' }];
    (o.bodyValues as Record<string, { value: string }>).h = { value: m.html };
  }
  if (m.attachments.length) o.attachments = m.attachments.map((a) => ({ blobId: a.blobId, type: a.type || 'application/octet-stream', name: a.name, disposition: 'attachment' }));
  if (m.inReplyTo?.length) o.inReplyTo = m.inReplyTo;
  if (m.references?.length) o.references = m.references;
  return o;
}

/** Saves the draft (JMAP emails are immutable: a new one replaces the previous). Returns the new id. */
export async function saveDraft(m: OutgoingMessage, draftsId: string, previousId: string | null): Promise<string> {
  const args: Record<string, unknown> = { create: { d: emailObject(m, draftsId, true) } };
  if (previousId) args.destroy = [previousId];
  const r = await wmApi.jmap([['Email/set', args, 's']]);
  const created = (resp(r, 's').created as Record<string, { id: string }> | undefined)?.d?.id;
  if (!created) throw new Error(String(Object.values((resp(r, 's').notCreated ?? {}) as Record<string, { description?: string }>)[0]?.description ?? 'Draft not saved'));
  return created;
}

/** Sends: creates the message in Drafts, submits it, then moves it to Sent (and drops the previous draft). */
export async function sendMessage(m: OutgoingMessage, mailboxes: { drafts: string; sent: string | null }, previousDraftId: string | null): Promise<void> {
  const setArgs: Record<string, unknown> = { create: { m: emailObject(m, mailboxes.drafts, true) } };
  if (previousDraftId) setArgs.destroy = [previousDraftId];
  const onSuccess: Record<string, unknown> = { 'keywords/$draft': null };
  if (mailboxes.sent) {
    onSuccess[`mailboxIds/${mailboxes.drafts}`] = null;
    onSuccess[`mailboxIds/${mailboxes.sent}`] = true;
  }
  const r = await wmApi.jmap([
    ['Email/set', setArgs, 'e'],
    ['EmailSubmission/set', { create: { s: { identityId: m.identity.id, emailId: '#m' } }, onSuccessUpdateEmail: { '#s': onSuccess } }, 's'],
  ]);
  const notCreated = resp(r, 'e').notCreated as Record<string, { description?: string; type?: string }> | undefined;
  if (notCreated?.m) throw new Error(notCreated.m.description ?? notCreated.m.type ?? 'Message not created');
  const sub = resp(r, 's');
  const subFail = (sub.notCreated as Record<string, { description?: string; type?: string }> | undefined)?.s;
  if (subFail) throw new Error(subFail.description ?? subFail.type ?? 'Message not sent');
}
