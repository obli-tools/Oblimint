import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_METHODS, attachmentDisposition, isValidBlobId, JmapPolicyError, MAX_METHOD_CALLS, MAX_QUERY_LIMIT, safeFileName, uploadContentType,
  validateJmapRequest, type JmapPolicyContext,
} from './policy';

const ctx: JmapPolicyContext = {
  accountId: 'acctA',
  identityIds: new Set(['idA']),
  identityEmails: new Set(['alice@example.test']),
};

function refused(body: unknown, status: 400 | 403, re?: RegExp): void {
  assert.throws(() => validateJmapRequest(body, ctx), (err: unknown) => {
    assert.ok(err instanceof JmapPolicyError, String(err));
    assert.equal((err as JmapPolicyError).status, status, (err as Error).message);
    if (re) assert.match((err as Error).message, re);
    return true;
  });
}

const call = (name: string, args: Record<string, unknown>, id = 'c0') => [name, args, id];

test('accountId: absent is forced to the session account, equal is kept', () => {
  const out = validateJmapRequest({ methodCalls: [call('Mailbox/get', {}), call('Email/query', { accountId: 'acctA' }, 'c1')] }, ctx);
  assert.equal(out[0][1].accountId, 'acctA');
  assert.equal(out[1][1].accountId, 'acctA');
});

test('own account guard: another accountId is refused (403) on every method', () => {
  for (const m of ALLOWED_METHODS) refused({ methodCalls: [call(m, { accountId: 'acctB' })] }, 403, /another account/);
  refused({ methodCalls: [call('Email/get', { accountId: null })] }, 403);
  refused({ methodCalls: [call('Email/get', { '#accountId': { resultOf: 'x', name: 'Mailbox/get', path: '/list' } })] }, 403);
});

test('cross-account and prototype keys are refused', () => {
  refused({ methodCalls: [call('Email/set', { fromAccountId: 'acctB' })] }, 403);
  refused({ methodCalls: [call('Email/get', { toAccountId: 'acctB' })] }, 403);
  refused({ methodCalls: [call('Email/get', JSON.parse('{"__proto__": {"x": 1}}'))] }, 403);
});

test('method allowlist: copy / import / blob / identity, mailbox, sieve, vacation changes are refused', () => {
  for (const m of ['Email/copy', 'Email/import', 'Email/parse', 'Blob/copy', 'Blob/get', 'Identity/set', 'Mailbox/set', 'SieveScript/set',
    'SieveScript/get', 'VacationResponse/set', 'VacationResponse/get', 'Principal/get', 'PushSubscription/set', 'Core/echo', 'x']) {
    refused({ methodCalls: [call(m, {})] }, 403, /not allowed/);
  }
});

test('malformed requests are 400', () => {
  refused(null, 400);
  refused([], 400);
  refused({}, 400);
  refused({ methodCalls: [] }, 400);
  refused({ methodCalls: [call('Mailbox/get', {})], createdIds: {} }, 400);
  refused({ methodCalls: [['Mailbox/get', {}]] }, 400);
  refused({ methodCalls: [['Mailbox/get', [], 'c']] }, 400);
  refused({ methodCalls: [['Mailbox/get', {}, 'bad id!']] }, 400);
  refused({ methodCalls: Array.from({ length: MAX_METHOD_CALLS + 1 }, (_, i) => call('Mailbox/get', {}, `c${i}`)) }, 400);
  refused({ methodCalls: [call('Email/get', { ids: ['ok', '../x'] })] }, 400);
  refused({ methodCalls: [call('Email/get', { ids: 'x' })] }, 400);
});

test('limits are capped, not trusted', () => {
  const out = validateJmapRequest({ methodCalls: [
    call('Email/query', { limit: 100000 }, 'q'),
    call('Email/get', { ids: ['a'], fetchHTMLBodyValues: true }, 'g'),
    call('Email/get', { ids: ['a'], maxBodyValueBytes: 1e12 }, 'h'),
  ] }, ctx);
  assert.equal(out[0][1].limit, MAX_QUERY_LIMIT);
  assert.equal(out[1][1].maxBodyValueBytes, 2_000_000);
  assert.equal(out[2][1].maxBodyValueBytes, 2_000_000);
  refused({ methodCalls: [call('Email/query', { limit: -1 })] }, 400);
});

test('result references must point to an earlier call of an allowed method', () => {
  const ok = validateJmapRequest({ methodCalls: [
    call('Email/query', { filter: { inMailbox: 'm1' } }, 'q'),
    call('Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 'g'),
  ] }, ctx);
  assert.equal(ok.length, 2);
  refused({ methodCalls: [call('Email/get', { '#ids': { resultOf: 'later', name: 'Email/query', path: '/ids' } }, 'g'), call('Email/query', {}, 'later')] }, 400, /unknown call/);
  refused({ methodCalls: [call('Email/query', {}, 'q'), call('Email/get', { '#ids': { resultOf: 'q', name: 'Email/copy', path: '/ids' } }, 'g')] }, 400);
  refused({ methodCalls: [call('Email/query', {}, 'q'), call('Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: 'ids', extra: 1 } }, 'g')] }, 400);
});

test('the caller object is never mutated', () => {
  const args = { ids: ['a'] };
  validateJmapRequest({ methodCalls: [call('Email/get', args)] }, ctx);
  assert.deepEqual(args, { ids: ['a'] });
});

// ── Email/set ──

const draft = (extra: Record<string, unknown> = {}) => ({
  mailboxIds: { drafts: true }, keywords: { $draft: true }, from: [{ name: 'Alice', email: 'alice@example.test' }],
  to: [{ email: 'bob@example.test' }], subject: 'Hi', textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'x' } }, ...extra,
});

test('Email/set create: From must be exactly one identity address', () => {
  validateJmapRequest({ methodCalls: [call('Email/set', { create: { d: draft() } })] }, ctx);
  validateJmapRequest({ methodCalls: [call('Email/set', { create: { d: draft({ from: [{ email: 'ALICE@example.test' }] }) } })] }, ctx);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ from: [{ email: 'bob@example.test' }] }) } })] }, 403, /identities/);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ from: [{ email: 'alice@example.test' }, { email: 'eve@example.test' }] }) } })] }, 403);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ sender: [{ email: 'ceo@example.test' }] }) } })] }, 403, /Sender/);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ 'header:From:asAddresses': [{ email: 'ceo@example.test' }] }) } })] }, 403, /raw header/);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ headers: [{ name: 'From', value: 'x' }] }) } })] }, 403);
  refused({ methodCalls: [call('Email/set', { create: { d: draft({ to: [{ email: 'not an address' }] }) } })] }, 400);
});

test('Email/set update: only keywords and mailboxIds', () => {
  validateJmapRequest({ methodCalls: [call('Email/set', { update: { e1: { 'keywords/$seen': true, 'mailboxIds/trash': true, 'mailboxIds/inbox': null } } })] }, ctx);
  validateJmapRequest({ methodCalls: [call('Email/set', { update: { e1: { keywords: { $seen: true } } } })] }, ctx);
  refused({ methodCalls: [call('Email/set', { update: { e1: { subject: 'x' } } })] }, 400);
  refused({ methodCalls: [call('Email/set', { update: { e1: { 'keywords/$seen': 'yes' } } })] }, 400);
  refused({ methodCalls: [call('Email/set', { update: { e1: {} } })] }, 400);
  refused({ methodCalls: [call('Email/set', { update: { e1: { 'mailboxIds/../x': true } } })] }, 400);
  refused({ methodCalls: [call('Email/set', { onSuccessX: 1 })] }, 400);
});

// ── sending ──

test('EmailSubmission/set: sends a message created by the same request, with an identity', () => {
  const out = validateJmapRequest({ methodCalls: [
    call('Email/set', { create: { m: draft() } }, 'e'),
    call('EmailSubmission/set', {
      create: { s: { identityId: 'idA', emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { 'mailboxIds/drafts': null, 'mailboxIds/sent': true, 'keywords/$draft': null } },
    }, 's'),
  ] }, ctx);
  assert.equal(out[1][1].accountId, 'acctA');
});

test('EmailSubmission/set: an existing (received) message can never be re-sent', () => {
  refused({ methodCalls: [call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: 'M-existing' } } })] }, 403, /created by this request/);
  refused({ methodCalls: [
    call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m' } } }, 's'),
    call('Email/set', { create: { m: draft() } }, 'e'),
  ] }, 403, /created by this request/);
});

test('EmailSubmission/set: identity, envelope, update / destroy and foreign patches are refused', () => {
  const pre = call('Email/set', { create: { m: draft() } }, 'e');
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idB', emailId: '#m' } } }, 's')] }, 403, /identity/);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m', envelope: { mailFrom: { email: 'x@y.z' }, rcptTo: [] } } } }, 's')] }, 403, /envelope/);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { update: { x: { undoStatus: 'canceled' } } }, 's')] }, 403);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { destroy: ['x'] }, 's')] }, 403);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m' } }, onSuccessUpdateEmail: { 'M-other': { 'keywords/$seen': true } } }, 's')] }, 403);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m' } }, onSuccessUpdateEmail: { '#s': { subject: 'x' } } }, 's')] }, 400);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m' } }, onSuccessDestroyEmail: ['M-other'] }, 's')] }, 403);
  refused({ methodCalls: [pre, call('EmailSubmission/set', { create: { s: { identityId: 'idA', emailId: '#m', sendAt: 'x' } } }, 's')] }, 403);
});

test('a session without an account is refused', () => {
  assert.throws(() => validateJmapRequest({ methodCalls: [call('Mailbox/get', {})] }, { ...ctx, accountId: '' }), JmapPolicyError);
});

// ── blobs / uploads / downloads ──

test('blob ids, upload types and download names are sanitized', () => {
  assert.equal(isValidBlobId('Gabc_123-x'), true);
  assert.equal(isValidBlobId('../etc/passwd'), false);
  assert.equal(isValidBlobId('a/b'), false);
  assert.equal(isValidBlobId(''), false);
  assert.equal(uploadContentType('image/png'), 'image/png');
  assert.equal(uploadContentType('text/html; charset=utf-8'), 'text/html');
  assert.equal(uploadContentType('text/html\r\nX-Evil: 1'), 'application/octet-stream');
  assert.equal(uploadContentType(undefined), 'application/octet-stream');
  assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd'.replace(/^\./, '') || 'attachment');
  assert.equal(safeFileName(''), 'attachment');
  assert.doesNotMatch(safeFileName('a\r\nb"c'), /[\r\n"]/);
  const d = attachmentDisposition('rapport été "final".pdf');
  assert.match(d, /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''/);
  assert.doesNotMatch(d, /[\r\n]/);
});
