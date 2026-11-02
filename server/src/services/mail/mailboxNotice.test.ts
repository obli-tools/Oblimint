import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebmailEngine } from './webmail/oblimint/engine';
import { buildNoticeMessage, deliverMailboxNotice, type MailboxNoticeDeps } from './mailboxNotice';

// The forwarding notice must reach the owner: imported into the Inbox on
// Stalwart (no sieve on the way), by SMTP only when that reaches the mailbox.

function fakeEngine(over: { importType?: string; failEndpoints?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const uploads: string[] = [];
  const engine = {
    async endpoints() {
      if (over.failEndpoints) throw new Error('403 login disabled');
      return { accountId: 'a1', apiPath: '/jmap/', uploadPath: '', downloadPath: '', eventSourcePath: '', capabilities: [] };
    },
    async call(_address: string, methodCalls: Array<[string, Record<string, unknown>, string]>) {
      const [name, args, tag] = methodCalls[0];
      calls.push([name, args]);
      if (name === 'Mailbox/get') return { methodResponses: [[name, { list: [{ id: 'm-sent', role: 'sent' }, { id: 'm-inbox', role: 'inbox' }] }, tag]] };
      if (name === 'Email/import') {
        return { methodResponses: [[name, over.importType ? { notCreated: { n: { type: over.importType } } } : { created: { n: { id: 'e1' } } }, tag]] };
      }
      return { methodResponses: [['error', { type: 'unknownMethod' }, tag]] };
    },
    async upload(_a: string, _id: string, type: string, body: Uint8Array) {
      uploads.push(`${type}\n${Buffer.from(body).toString('utf8')}`);
      return { blobId: 'b1', type, size: body.length };
    },
  } as unknown as WebmailEngine;
  return { engine, calls, uploads };
}

function deps(engineName: string, engine: WebmailEngine, sent: unknown[]): MailboxNoticeDeps {
  return { activeEngine: async () => engineName, webmailEngine: async () => engine, sendTransactional: async (m) => { sent.push(m); }, now: () => new Date('2026-11-02T10:00:00Z') };
}

test('mailbox notice: Stalwart = imported into the Inbox (unread), never by SMTP', async () => {
  const f = fakeEngine();
  const sent: unknown[] = [];
  const how = await deliverMailboxNotice('bob@acme.fr', '[Oblimint] Transfert', 'Vos e-mails sont transférés.', { smtpReachesMailbox: false }, deps('stalwart', f.engine, sent));
  assert.equal(how, 'inbox');
  assert.equal(sent.length, 0);
  const imp = f.calls.find(([n]) => n === 'Email/import')![1] as { emails: { n: { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> } } };
  assert.deepEqual(imp.emails.n.mailboxIds, { 'm-inbox': true });
  assert.deepEqual(imp.emails.n.keywords, {});
  assert.match(f.uploads[0], /^message\/rfc822\n/);
  assert.match(f.uploads[0], /Auto-Submitted: auto-generated/i);
  assert.match(f.uploads[0], /From: Oblimint <postmaster@acme\.fr>/);
});

test('mailbox notice: import refused → SMTP only when it reaches the mailbox', async () => {
  const sent: unknown[] = [];
  const refused = fakeEngine({ importType: 'overQuota' });
  assert.equal(await deliverMailboxNotice('bob@acme.fr', 's', 't', { smtpReachesMailbox: true }, deps('stalwart', refused.engine, sent)), 'smtp');
  assert.deepEqual(sent, [{ to: 'bob@acme.fr', subject: 's', text: 't', kind: 'mailbox' }]);
  const disabled = fakeEngine({ failEndpoints: true });
  assert.equal(await deliverMailboxNotice('bob@acme.fr', 's', 't', { smtpReachesMailbox: false }, deps('stalwart', disabled.engine, sent)), 'skipped');
  assert.equal(sent.length, 1, 'forwarding without a copy: by SMTP it would go to the target — nothing sent');
});

test('mailbox notice: other engines use the transactional sender (when it reaches the mailbox)', async () => {
  const f = fakeEngine();
  const sent: unknown[] = [];
  assert.equal(await deliverMailboxNotice('a@b.fr', 's', 't', { smtpReachesMailbox: true }, deps('postfix-dovecot', f.engine, sent)), 'smtp');
  assert.equal(await deliverMailboxNotice('a@b.fr', 's', 't', { smtpReachesMailbox: false }, deps('postfix-dovecot', f.engine, sent)), 'skipped');
  assert.equal(sent.length, 1);
  assert.equal(f.calls.length, 0, 'the JMAP engine is not used');
});

test('mailbox notice: the message is a single-line subject, bilingual text kept', async () => {
  const raw = (await buildNoticeMessage('x@acme.fr', 'a\r\nBcc: evil@x.org', 'Bonjour é', new Date('2026-11-02T10:00:00Z'))).toString('utf8');
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.match(raw, /^To: x@acme\.fr/m);
});
