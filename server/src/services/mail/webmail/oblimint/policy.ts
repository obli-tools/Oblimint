// ─────────────────────────────────────────────────────────────────────────────
// JMAP proxy policy of the Oblimint webmail — PURE (policy.test.ts).
//
// The browser sends { methodCalls }; this module decides what may reach the
// engine. The engine is called impersonating the session's mailbox, so it
// only exposes that principal's data; on top of that:
//  - "own account only": every accountId is absent or EQUAL to the session's
//    primary JMAP account, and is forced to it (shared / other accounts the
//    principal might see through ACLs are never reachable);
//  - a method allowlist (no copy / import / parse / blob / identity, mailbox,
//    sieve, vacation, principal or push-subscription changes);
//  - bounded requests (calls, ids, limits, body value sizes);
//  - sending: EmailSubmission/set only CREATES, for an Email created by an
//    Email/set of the SAME request (a received message can never be re-sent
//    with its forged From), with one of the mailbox's identities and no
//    explicit envelope; Email/set create: From = exactly one identity
//    address, no Sender, no raw header:* property; Email/set update: only
//    keywords and mailboxIds.
// Any violation throws JmapPolicyError (400 invalidRequest / 403 forbidden).
// ─────────────────────────────────────────────────────────────────────────────

export const JMAP_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
  'urn:ietf:params:jmap:quota',
] as const;

export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'Mailbox/get', 'Mailbox/changes', 'Mailbox/query',
  'Email/get', 'Email/query', 'Email/queryChanges', 'Email/changes', 'Email/set',
  'Thread/get', 'Thread/changes',
  'SearchSnippet/get',
  'Identity/get',
  'EmailSubmission/get', 'EmailSubmission/set',
  'Quota/get',
]);

export const MAX_METHOD_CALLS = 24;
export const MAX_IDS = 1000;
export const MAX_QUERY_LIMIT = 200;
export const MAX_BODY_VALUE_BYTES = 2_000_000;
export const MAX_SET_ENTRIES = 500;

const CALL_ID_RE = /^[A-Za-z0-9_.#-]{1,64}$/;
const CREATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const JMAP_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const ADDRESS_RE = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export type JmapCall = [string, Record<string, unknown>, string];

export class JmapPolicyError extends Error {
  constructor(message: string, public readonly status: 400 | 403 = 400) {
    super(message);
    this.name = 'JmapPolicyError';
  }
}

export interface JmapPolicyContext {
  /** Primary JMAP mail account of the session (the only one accepted). */
  accountId: string;
  /** Identity ids of the mailbox (Identity/get as the mailbox). */
  identityIds: ReadonlySet<string>;
  /** Lower-case e-mail addresses of those identities (allowed From). */
  identityEmails: ReadonlySet<string>;
}

const bad = (m: string): never => { throw new JmapPolicyError(m, 400); };
const forbid = (m: string): never => { throw new JmapPolicyError(m, 403); };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Keys that could reach another account or a prototype. */
const FORBIDDEN_ARG_KEYS = new Set(['fromAccountId', 'toAccountId', '__proto__', 'constructor', 'prototype']);

function checkIdList(v: unknown, what: string): void {
  if (v === null || v === undefined) return;
  if (!Array.isArray(v)) bad(`${what}: expected a list of ids`);
  const list = v as unknown[];
  if (list.length > MAX_IDS) bad(`${what}: at most ${MAX_IDS} ids`);
  for (const id of list) {
    if (typeof id !== 'string' || !(JMAP_ID_RE.test(id) || (id.startsWith('#') && CREATION_ID_RE.test(id.slice(1))))) bad(`${what}: invalid id`);
  }
}

/** A result reference ({ resultOf, name, path }) to an EARLIER call of the request. */
function checkResultRef(v: unknown, earlier: ReadonlySet<string>, key: string): void {
  if (!isPlainObject(v)) bad(`${key}: invalid result reference`);
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['resultOf', 'name', 'path'].includes(k)) bad(`${key}: invalid result reference`);
  if (typeof r.resultOf !== 'string' || !earlier.has(r.resultOf)) bad(`${key}: result reference to an unknown call`);
  if (typeof r.name !== 'string' || !ALLOWED_METHODS.has(r.name)) bad(`${key}: result reference to a method that is not allowed`);
  if (typeof r.path !== 'string' || r.path.length > 200 || !r.path.startsWith('/')) bad(`${key}: invalid result reference path`);
}

/** Email/set update patch: keywords and mailbox membership only. */
export function checkEmailPatch(patch: unknown, what: string): void {
  if (!isPlainObject(patch)) bad(`${what}: invalid patch`);
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > 200) bad(`${what}: invalid patch`);
  for (const k of keys) {
    if (k === 'keywords' || k === 'mailboxIds') {
      if (!isPlainObject(p[k])) bad(`${what}: ${k} must be an object`);
      for (const [kk, vv] of Object.entries(p[k] as Record<string, unknown>)) {
        if (kk.length > 255 || vv !== true) bad(`${what}: invalid ${k}`);
      }
      continue;
    }
    const m = /^(keywords|mailboxIds)\/([^/]{1,255})$/.exec(k);
    if (!m) bad(`${what}: only keywords and mailboxIds can be changed`);
    if (m![1] === 'mailboxIds' && !(JMAP_ID_RE.test(m![2]) || (m![2].startsWith('#') && CREATION_ID_RE.test(m![2].slice(1))))) bad(`${what}: invalid mailbox id`);
    if (p[k] !== true && p[k] !== null) bad(`${what}: invalid ${m![1]} value`);
  }
}

function addressList(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) bad(`${what}: expected a list of addresses`);
  return (v as unknown[]).map((a) => {
    if (!isPlainObject(a)) bad(`${what}: invalid address`);
    const o = a as Record<string, unknown>;
    if (typeof o.email !== 'string' || !ADDRESS_RE.test(o.email)) bad(`${what}: invalid address`);
    if (o.name !== undefined && o.name !== null && (typeof o.name !== 'string' || o.name.length > 200)) bad(`${what}: invalid name`);
    return (o.email as string).toLowerCase();
  });
}

/** Email/set create entry: From = one identity address, no Sender / raw headers. */
export function checkEmailCreate(entry: unknown, ctx: JmapPolicyContext, what: string): void {
  if (!isPlainObject(entry)) bad(`${what}: invalid email`);
  const e = entry as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (k.startsWith('header:') || k === 'headers') forbid(`${what}: raw header properties are not allowed`);
    if (k === 'sender') forbid(`${what}: the Sender header is not allowed`);
    if (FORBIDDEN_ARG_KEYS.has(k)) bad(`${what}: invalid property`);
  }
  if (e.from !== undefined && e.from !== null) {
    const from = addressList(e.from, `${what}.from`);
    if (from.length !== 1 || !ctx.identityEmails.has(from[0])) forbid(`${what}: From must be one of the mailbox's identities`);
  }
  for (const k of ['to', 'cc', 'bcc', 'replyTo'] as const) {
    if (e[k] !== undefined && e[k] !== null) {
      const list = addressList(e[k], `${what}.${k}`);
      if (list.length > 500) bad(`${what}.${k}: too many recipients`);
    }
  }
  if (e.mailboxIds !== undefined) {
    if (!isPlainObject(e.mailboxIds) || Object.keys(e.mailboxIds as object).length === 0) bad(`${what}: invalid mailboxIds`);
    for (const [id, v] of Object.entries(e.mailboxIds as Record<string, unknown>)) {
      if (!(JMAP_ID_RE.test(id) || (id.startsWith('#') && CREATION_ID_RE.test(id.slice(1)))) || v !== true) bad(`${what}: invalid mailboxIds`);
    }
  }
}

interface RequestState {
  /** callIds seen so far (result references must point backwards). */
  callIds: Set<string>;
  /** '#<creation id>' of the Email/set creations of the request (validated From). */
  createdEmails: Set<string>;
}

function checkEmailSet(args: Record<string, unknown>, ctx: JmapPolicyContext, st: RequestState): void {
  for (const k of Object.keys(args)) {
    if (!['accountId', 'ifInState', 'create', 'update', 'destroy', '#destroy'].includes(k)) bad(`Email/set: argument ${k} is not allowed`);
  }
  let n = 0;
  if (args.create !== undefined && args.create !== null) {
    if (!isPlainObject(args.create)) bad('Email/set: invalid create');
    for (const [cid, entry] of Object.entries(args.create as Record<string, unknown>)) {
      if (!CREATION_ID_RE.test(cid)) bad('Email/set: invalid creation id');
      checkEmailCreate(entry, ctx, `Email/set create ${cid}`);
      st.createdEmails.add(`#${cid}`);
      n++;
    }
  }
  if (args.update !== undefined && args.update !== null) {
    if (!isPlainObject(args.update)) bad('Email/set: invalid update');
    for (const [id, patch] of Object.entries(args.update as Record<string, unknown>)) {
      if (!(JMAP_ID_RE.test(id) || (id.startsWith('#') && CREATION_ID_RE.test(id.slice(1))))) bad('Email/set: invalid id');
      checkEmailPatch(patch, `Email/set update ${id}`);
      n++;
    }
  }
  if (args.destroy !== undefined) {
    checkIdList(args.destroy, 'Email/set destroy');
    n += Array.isArray(args.destroy) ? args.destroy.length : 0;
  }
  if (n > MAX_SET_ENTRIES) bad(`Email/set: at most ${MAX_SET_ENTRIES} changes`);
}

function checkSubmissionSet(args: Record<string, unknown>, ctx: JmapPolicyContext, st: RequestState): void {
  for (const k of Object.keys(args)) {
    if (!['accountId', 'ifInState', 'create', 'onSuccessUpdateEmail', 'onSuccessDestroyEmail'].includes(k)) {
      forbid(`EmailSubmission/set: ${k} is not allowed`);
    }
  }
  if (!isPlainObject(args.create) || Object.keys(args.create as object).length === 0) bad('EmailSubmission/set: create expected');
  const subs = new Set<string>();
  const entries = Object.entries(args.create as Record<string, unknown>);
  if (entries.length > 10) bad('EmailSubmission/set: at most 10 submissions');
  for (const [cid, raw] of entries) {
    if (!CREATION_ID_RE.test(cid)) bad('EmailSubmission/set: invalid creation id');
    if (!isPlainObject(raw)) bad('EmailSubmission/set: invalid submission');
    const s = raw as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!['identityId', 'emailId', 'envelope'].includes(k)) forbid(`EmailSubmission/set: ${k} is not allowed`);
    if (s.envelope !== undefined && s.envelope !== null) forbid('EmailSubmission/set: an explicit envelope is not allowed');
    if (typeof s.identityId !== 'string' || !ctx.identityIds.has(s.identityId)) forbid('EmailSubmission/set: unknown identity');
    if (typeof s.emailId !== 'string' || !st.createdEmails.has(s.emailId)) {
      forbid('EmailSubmission/set: only a message created by this request can be sent');
    }
    subs.add(`#${cid}`);
  }
  if (args.onSuccessUpdateEmail !== undefined && args.onSuccessUpdateEmail !== null) {
    if (!isPlainObject(args.onSuccessUpdateEmail)) bad('EmailSubmission/set: invalid onSuccessUpdateEmail');
    for (const [ref, patch] of Object.entries(args.onSuccessUpdateEmail as Record<string, unknown>)) {
      if (!subs.has(ref)) forbid('EmailSubmission/set: onSuccessUpdateEmail must reference a submission of this call');
      checkEmailPatch(patch, 'onSuccessUpdateEmail');
    }
  }
  if (args.onSuccessDestroyEmail !== undefined && args.onSuccessDestroyEmail !== null) {
    if (!Array.isArray(args.onSuccessDestroyEmail)) bad('EmailSubmission/set: invalid onSuccessDestroyEmail');
    for (const ref of args.onSuccessDestroyEmail as unknown[]) {
      if (typeof ref !== 'string' || !subs.has(ref)) forbid('EmailSubmission/set: onSuccessDestroyEmail must reference a submission of this call');
    }
  }
}

function capNumber(args: Record<string, unknown>, key: string, max: number): void {
  if (args[key] === undefined || args[key] === null) return;
  const n = args[key];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) bad(`${key}: expected a non-negative integer`);
  if ((n as number) > max) args[key] = max;
}

/**
 * Validates and normalizes a proxy request. Returns the method calls to send
 * (accountId forced to the session's). Throws JmapPolicyError.
 */
export function validateJmapRequest(body: unknown, ctx: JmapPolicyContext): JmapCall[] {
  if (!ctx.accountId || !JMAP_ID_RE.test(ctx.accountId)) forbid('no JMAP account for this session');
  if (!isPlainObject(body)) bad('invalid request');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'methodCalls' && k !== 'using') bad(`invalid request property ${k}`);
  if (!Array.isArray(b.methodCalls) || b.methodCalls.length === 0) bad('methodCalls expected');
  const calls = b.methodCalls as unknown[];
  if (calls.length > MAX_METHOD_CALLS) bad(`at most ${MAX_METHOD_CALLS} method calls`);
  const st: RequestState = { callIds: new Set(), createdEmails: new Set() };
  const out: JmapCall[] = [];
  for (const raw of calls) {
    if (!Array.isArray(raw) || raw.length !== 3) bad('invalid method call');
    const [name, argsRaw, callId] = raw as [unknown, unknown, unknown];
    if (typeof name !== 'string' || !ALLOWED_METHODS.has(name)) forbid(`method ${String(name).slice(0, 64)} is not allowed`);
    if (typeof callId !== 'string' || !CALL_ID_RE.test(callId)) bad('invalid call id');
    if (!isPlainObject(argsRaw)) bad(`${name}: arguments must be an object`);
    // Copy: the caller's object is never mutated.
    const args: Record<string, unknown> = { ...(argsRaw as Record<string, unknown>) };
    for (const k of Object.keys(args)) {
      if (FORBIDDEN_ARG_KEYS.has(k)) forbid(`${name}: argument ${k} is not allowed`);
      if (k.startsWith('#')) {
        if (k === '#accountId') forbid(`${name}: accountId cannot be a reference`);
        checkResultRef(args[k], st.callIds, `${name} ${k}`);
      }
    }
    if (args.accountId !== undefined && args.accountId !== ctx.accountId) forbid(`${name}: another account cannot be accessed`);
    args.accountId = ctx.accountId;
    if (args.ids !== undefined) checkIdList(args.ids, `${name} ids`);

    switch (name) {
      case 'Email/get':
        capNumber(args, 'maxBodyValueBytes', MAX_BODY_VALUE_BYTES);
        if (args.fetchAllBodyValues === true || args.fetchTextBodyValues === true || args.fetchHTMLBodyValues === true) {
          if (args.maxBodyValueBytes === undefined || args.maxBodyValueBytes === null || args.maxBodyValueBytes === 0) args.maxBodyValueBytes = MAX_BODY_VALUE_BYTES;
        }
        break;
      case 'Email/query':
      case 'Mailbox/query':
      case 'Email/queryChanges':
        capNumber(args, 'limit', MAX_QUERY_LIMIT);
        capNumber(args, 'maxChanges', MAX_IDS);
        if (args.limit === undefined && name === 'Email/query') args.limit = 50;
        break;
      case 'Email/changes':
      case 'Mailbox/changes':
      case 'Thread/changes':
        capNumber(args, 'maxChanges', MAX_IDS);
        break;
      case 'Email/set':
        checkEmailSet(args, ctx, st);
        break;
      case 'EmailSubmission/set':
        checkSubmissionSet(args, ctx, st);
        break;
      default:
        break;
    }
    st.callIds.add(callId as string);
    out.push([name as string, args, callId as string]);
  }
  return out;
}

/** JMAP blob id accepted in /wm-api/blob/:blobId. */
export function isValidBlobId(v: unknown): v is string {
  return typeof v === 'string' && JMAP_ID_RE.test(v) && v.length <= 255;
}

/** Media type accepted for an upload (token/token, no parameters): anything else = application/octet-stream. */
export function uploadContentType(v: unknown): string {
  const t = typeof v === 'string' ? v.split(';')[0].trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : 'application/octet-stream';
}

/** Download file name: printable, no path, bounded; never empty. */
export function safeFileName(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  const n = (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return n || 'attachment';
}

/** RFC 6266 Content-Disposition: attachment with an ASCII fallback and the UTF-8 name. */
export function attachmentDisposition(name: string): string {
  const safe = safeFileName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
