import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailFull } from '../jmap';
import { draftFrom, formatAddressList, forwardSubject, parseAddressList, quoteText, replySubject } from './compose';
import { linkify } from './format';

const labels = {
  wrote: (d: string, w: string) => `On ${d}, ${w} wrote:`, forwarded: 'Forwarded message', from: 'From', date: 'Date', subject: 'Subject', to: 'To',
};

const mail = (over: Partial<EmailFull> = {}): EmailFull => ({
  id: 'M1', threadId: 'T1', mailboxIds: { inbox: true }, keywords: {}, receivedAt: '2026-01-02T10:00:00Z', preview: 'p', hasAttachment: true, size: 10,
  from: [{ name: 'Bob', email: 'bob@example.org' }], to: [{ name: null, email: 'alice@example.org' }, { name: 'Carol', email: 'carol@example.org' }],
  cc: [{ name: null, email: 'dan@example.org' }, { name: null, email: 'alice@example.org' }], bcc: null, replyTo: null, sentAt: null,
  subject: 'Hello', messageId: ['m1@example.org'], inReplyTo: null, references: ['m0@example.org'],
  textBody: [], htmlBody: [], bodyValues: {},
  attachments: [
    { partId: '2', blobId: 'B2', type: 'application/pdf', name: 'a.pdf', size: 5, disposition: 'attachment', cid: null },
    { partId: '3', blobId: 'B3', type: 'image/png', name: 'logo.png', size: 5, disposition: 'inline', cid: 'logo' },
  ],
  ...over,
});

test('address lists: names, quotes, separators, invalid entries', () => {
  const r = parseAddressList('Bob <Bob@Example.org>, "Doe, Jane" <jane@example.org>; x@example.org\nnot-an-address, <a@b>');
  assert.deepEqual(r.list, [
    { name: 'Bob', email: 'bob@example.org' },
    { name: 'Doe, Jane', email: 'jane@example.org' },
    { name: null, email: 'x@example.org' },
  ]);
  assert.deepEqual(r.invalid, ['not-an-address', '<a@b>']);
  assert.equal(formatAddressList([{ name: 'Doe, Jane', email: 'j@example.org' }, { name: null, email: 'x@example.org' }]), '"Doe, Jane" <j@example.org>, x@example.org');
});

test('subjects and quoting', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(forwardSubject('Hello'), 'Fwd: Hello');
  assert.equal(forwardSubject('TR: Hello'), 'TR: Hello');
  assert.equal(quoteText('a\n> b'), '> a\n>> b');
});

test('reply: to the sender, threading headers, quoted text', () => {
  const d = draftFrom(mail(), 'reply', ['alice@example.org'], 'Hi Alice', null, labels, () => 'DATE');
  assert.equal(d.to, 'Bob <bob@example.org>');
  assert.equal(d.cc, '');
  assert.equal(d.subject, 'Re: Hello');
  assert.deepEqual(d.inReplyTo, ['m1@example.org']);
  assert.deepEqual(d.references, ['m0@example.org', 'm1@example.org']);
  assert.equal(d.answering, 'M1');
  assert.match(d.text, /On DATE, Bob <bob@example\.org> wrote:\n> Hi Alice$/);
  assert.equal(d.html, null);
});

test('reply all: everyone but the mailbox itself, no duplicates', () => {
  const d = draftFrom(mail(), 'replyAll', ['alice@example.org'], 'x', '<p>x</p>', labels, () => 'DATE');
  assert.equal(d.to, 'Bob <bob@example.org>, Carol <carol@example.org>');
  assert.equal(d.cc, 'dan@example.org');
  assert.match(d.html ?? '', /<blockquote><p>x<\/p><\/blockquote>$/);
});

test('forward: no recipient, original attachments kept (not the inline images), header block', () => {
  const d = draftFrom(mail(), 'forward', ['alice@example.org'], 'body', null, labels, () => 'DATE');
  assert.equal(d.to, '');
  assert.equal(d.subject, 'Fwd: Hello');
  assert.deepEqual(d.attachments.map((a) => a.blobId), ['B2']);
  assert.match(d.text, /Forwarded message[\s\S]*From: Bob <bob@example\.org>[\s\S]*body$/);
  assert.equal(d.inReplyTo, null);
});

test('plain text links become link runs, never markup', () => {
  assert.deepEqual(linkify('see https://ok.example/a?b=1. and <b>x</b>'), [
    { text: 'see ' }, { text: 'https://ok.example/a?b=1', href: 'https://ok.example/a?b=1' }, { text: '. and <b>x</b>' },
  ]);
  assert.deepEqual(linkify('javascript:alert(1)'), [{ text: 'javascript:alert(1)' }]);
});
