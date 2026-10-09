import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_CONTAINER, MAIL_RSPAMD_CONTAINER } from '../../../hosting/naming';
import { parseMailLogLine, splitTimestamp } from './logs';
import { postfixDovecotDriver } from './driver';

// Engine log parser on realistic lines (Postfix 3.9 maillog_file, Dovecot 2.3, Rspamd 3.x).

const NOW = new Date('2026-10-09T17:00:00Z');
const p = (line: string) => parseMailLogLine(MAIL_CONTAINER, line, NOW);
const r = (line: string) => parseMailLogLine(MAIL_RSPAMD_CONTAINER, line, NOW);

test('logs: timestamps (docker, ISO, syslog without year)', () => {
  assert.equal(splitTimestamp('2026-10-09T16:54:01.123456789Z Oct  9 16:54:01 mail postfix/qmgr[1]: x', NOW).at, '2026-10-09T16:54:01.123Z');
  assert.equal(splitTimestamp('2026-10-09T16:54:01Z imap-login: Info: x', NOW).at, '2026-10-09T16:54:01.000Z');
  assert.equal(splitTimestamp('Oct  9 16:54:01 mail postfix/smtpd[1]: x', NOW).at, '2026-10-09T16:54:01.000Z');
  assert.equal(splitTimestamp('Dec 31 23:59:59 mail postfix/smtpd[1]: x', NOW).at, '2025-12-31T23:59:59.000Z', 'not in the future');
  assert.equal(splitTimestamp('2026-10-09 16:54:01 #123(rspamd_proxy) <a1b2>; proxy; x', NOW).at, '2026-10-09T16:54:01.000Z');
});

test('logs: Postfix accepted (inbound, authenticated submission, site relay)', () => {
  const inbound = p('Oct  9 16:54:01 oblimint-mail postfix/smtpd[812]: 5A1B2C3D4E: client=mail-wr1-f54.google.com[209.85.221.54]');
  assert.equal(inbound?.type, 'delivery');
  assert.deepEqual(inbound, {
    type: 'delivery', at: '2026-10-09T16:54:01.000Z', direction: 'inbound', event: 'accepted', queueId: '5A1B2C3D4E',
    messageId: null, sender: null, recipient: null, sizeBytes: null, saslUser: null, detail: null, remote: '209.85.221.54',
  });
  const sub = p('Oct  9 16:55:12 oblimint-mail postfix/submission/smtpd[901]: 7F00AA11BB: client=unknown[2001:db8::5], sasl_method=PLAIN, sasl_username=Contact@Exemple.fr');
  assert.ok(sub?.type === 'delivery');
  assert.equal(sub.direction, 'outbound');
  assert.equal(sub.saslUser, 'contact@exemple.fr');
  assert.equal(sub.remote, '2001:db8::5');
  const relay = p('Oct  9 16:56:00 oblimint-mail postfix/relay/smtpd[77]: 1234ABCDEF: client=oblimint-mail-relay.oblimint-mail[172.20.0.7]');
  assert.ok(relay?.type === 'delivery');
  assert.equal(relay.direction, 'relay');
  assert.equal(relay.remote, '172.20.0.7');
});

test('logs: Postfix deliveries sent / deferred / bounced', () => {
  const sent = p('Oct  9 16:54:02 oblimint-mail postfix/lmtp[820]: 5A1B2C3D4E: to=<contact@exemple.fr>, relay=oblimint-mail[private/dovecot-lmtp], delay=0.4, delays=0.2/0.01/0.01/0.2, dsn=2.0.0, status=sent (250 2.0.0 <contact@exemple.fr> kJ3dF1 Saved)');
  assert.ok(sent?.type === 'delivery');
  assert.equal(sent.event, 'delivered');
  assert.equal(sent.direction, 'inbound');
  assert.equal(sent.recipient, 'contact@exemple.fr');
  assert.equal(sent.detail, '250 2.0.0 <contact@exemple.fr> kJ3dF1 Saved');
  const out = p('Oct  9 16:57:10 oblimint-mail postfix/smtp[930]: 7F00AA11BB: to=<Bob@Gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.27.26]:25, delay=1.2, delays=0.1/0/0.4/0.7, dsn=2.0.0, status=sent (250 2.0.0 OK  1696870630 x12si)');
  assert.ok(out?.type === 'delivery');
  assert.equal(out.direction, 'outbound');
  assert.equal(out.recipient, 'bob@gmail.com');
  assert.equal(out.remote, '142.250.27.26');
  const deferred = p('Oct  9 16:58:00 oblimint-mail postfix/smtp[931]: 7F00AA11BB: to=<x@example.org>, relay=none, delay=30, delays=0/0/30/0, dsn=4.4.1, status=deferred (connect to mx.example.org[192.0.2.1]:25: Connection timed out)');
  assert.ok(deferred?.type === 'delivery');
  assert.equal(deferred.event, 'deferred');
  assert.match(deferred.detail!, /Connection timed out/);
  const bounced = p('Oct  9 16:59:00 oblimint-mail postfix/smtp[932]: 7F00AA11BB: to=<nobody@example.org>, relay=mx.example.org[192.0.2.1]:25, delay=1, delays=0/0/0.5/0.5, dsn=5.1.1, status=bounced (host mx.example.org[192.0.2.1] said: 550 5.1.1 User unknown (in reply to RCPT TO command))');
  assert.ok(bounced?.type === 'delivery');
  assert.equal(bounced.event, 'bounced');
});

test('logs: Postfix rejects, milter rejects (spam / virus)', () => {
  const relayDenied = p('Oct  9 17:00:01 oblimint-mail postfix/smtpd[940]: NOQUEUE: reject: RCPT from unknown[198.51.100.9]: 554 5.7.1 <victim@example.net>: Relay access denied; from=<spam@spam.test> to=<victim@example.net> proto=ESMTP helo=<x>');
  assert.ok(relayDenied?.type === 'delivery');
  assert.equal(relayDenied.event, 'rejected');
  assert.equal(relayDenied.direction, 'inbound');
  assert.equal(relayDenied.queueId, null);
  assert.equal(relayDenied.sender, 'spam@spam.test');
  assert.equal(relayDenied.recipient, 'victim@example.net');
  assert.equal(relayDenied.remote, '198.51.100.9');
  assert.match(relayDenied.detail!, /Relay access denied/);
  const spam = p('Oct  9 17:00:05 oblimint-mail postfix/cleanup[950]: 9C8B7A6F5E: milter-reject: END-OF-MESSAGE from unknown[198.51.100.9]: 5.7.1 Spam message rejected; from=<a@spam.test> to=<contact@exemple.fr> proto=ESMTP helo=<x>');
  assert.ok(spam?.type === 'delivery');
  assert.equal(spam.event, 'spam');
  assert.equal(spam.queueId, '9C8B7A6F5E');
  const virus = p('Oct  9 17:00:06 oblimint-mail postfix/cleanup[950]: 9C8B7A6F5F: milter-reject: END-OF-MESSAGE from unknown[198.51.100.9]: 5.7.1 ClamAV: virus found: "Eicar-Signature"; from=<a@spam.test> to=<contact@exemple.fr> proto=ESMTP helo=<x>');
  assert.ok(virus?.type === 'delivery');
  assert.equal(virus.event, 'virus');
  const sub = p('Oct  9 17:00:07 oblimint-mail postfix/submission/smtpd[960]: NOQUEUE: reject: RCPT from unknown[203.0.113.4]: 553 5.7.1 <boss@exemple.fr>: Sender address rejected: not owned by user contact@exemple.fr; from=<boss@exemple.fr> to=<x@y.org> proto=ESMTP helo=<pc>');
  assert.ok(sub?.type === 'delivery');
  assert.equal(sub.direction, 'outbound');
  assert.equal(sub.event, 'rejected');
  // 4xx = temporary ⇒ deferred, never 'rejected' (abuse auto-suspension)
  const limit = p('Oct  9 17:00:08 oblimint-mail postfix/cleanup[951]: 7F00AA11BB: milter-reject: END-OF-MESSAGE from unknown[203.0.113.4]: 4.7.1 Hourly sending limit reached, try again later; from=<contact@exemple.fr> to=<x@y.org> proto=ESMTP helo=<pc>');
  assert.ok(limit?.type === 'delivery');
  assert.equal(limit.event, 'deferred');
  const full = p('Oct  9 17:00:09 oblimint-mail postfix/smtpd[941]: NOQUEUE: reject: RCPT from unknown[198.51.100.9]: 452 4.2.2 <contact@exemple.fr>: Recipient address rejected: Mailbox is full; from=<a@b.test> to=<contact@exemple.fr> proto=ESMTP helo=<x>');
  assert.ok(full?.type === 'delivery');
  assert.equal(full.event, 'deferred');
  const unavailable = p('Oct  9 17:00:10 oblimint-mail postfix/submission/smtpd[961]: NOQUEUE: reject: RCPT from unknown[203.0.113.4]: 550 5.2.1 <off@exemple.fr>: Recipient address rejected: Mailbox unavailable; from=<contact@exemple.fr> to=<off@exemple.fr> proto=ESMTP helo=<pc>');
  assert.ok(unavailable?.type === 'delivery');
  assert.equal(unavailable.event, 'rejected');
  assert.equal(unavailable.direction, 'outbound');
});

test('logs: authentication failures ⇒ authFailure (bans)', () => {
  assert.deepEqual(p('2026-10-09T17:01:00Z imap-login: Info: Disconnected (auth failed, 1 attempts in 2 secs): user=<contact@exemple.fr>, method=PLAIN, rip=198.51.100.23, lip=172.20.0.2, TLS, session=<abc>'), {
    type: 'authFailure', at: '2026-10-09T17:01:00.000Z', service: 'imap', ip: '198.51.100.23', username: 'contact@exemple.fr',
  });
  const aborted = p('2026-10-09T17:01:02Z pop3-login: Info: Login aborted: Connection closed (auth failed, 3 attempts in 12 secs) (auth_failed): user=<x@y.fr>, method=PLAIN, rip=2001:db8::66, lip=172.20.0.2, TLS, session=<abc>');
  assert.deepEqual(aborted && { ...aborted, at: '' }, { type: 'authFailure', at: '', service: 'pop3', ip: '2001:db8::66', username: 'x@y.fr' });
  const sieve = p('2026-10-09T17:01:03Z managesieve-login: Info: Disconnected (auth failed, 1 attempts in 2 secs): user=<>, method=PLAIN, rip=203.0.113.8, lip=172.20.0.2');
  assert.ok(sieve?.type === 'authFailure');
  assert.equal(sieve.service, 'sieve');
  const sasl = p('Oct  9 17:01:04 oblimint-mail postfix/submissions/smtpd[970]: warning: unknown[203.0.113.9]: SASL LOGIN authentication failed: UGFzc3dvcmQ6, sasl_username=contact@exemple.fr');
  assert.deepEqual(sasl && { ...sasl, at: '' }, { type: 'authFailure', at: '', service: 'submission', ip: '203.0.113.9', username: 'contact@exemple.fr' });
  // not failures
  assert.equal(p('2026-10-09T17:01:05Z imap-login: Info: Login: user=<contact@exemple.fr>, method=PLAIN, rip=198.51.100.23, lip=172.20.0.2, mpid=10, TLS'), null);
  assert.equal(p('2026-10-09T17:01:06Z imap-login: Info: Disconnected (no auth attempts in 0 secs): user=<>, rip=198.51.100.23, lip=172.20.0.2'), null);
});

test('logs: Rspamd task log ⇒ tagged spam; refusals with a queue id are left to Postfix (one event per message)', () => {
  // reject / soft reject of a message Postfix is receiving: Postfix's milter-reject line counts it
  assert.equal(r('2026-10-09 17:02:00 #57(rspamd_proxy) <6a1b2c>; proxy; rspamd_task_write_log: id: <gtube@spam.test>, qid: <9C8B7A6F5E>, ip: 198.51.100.9, from: <a@spam.test>, (default: T (reject): [1000.00/15.00] [GTUBE(0.00){}]), len: 830, rcpts: <contact@exemple.fr>'), null);
  assert.equal(r('2026-10-09 17:02:01 #57(rspamd_proxy) <6a1b2d>; proxy; rspamd_task_write_log: id: <eicar@x>, qid: <9C8B7A6F5F>, ip: 198.51.100.9, from: <a@spam.test>, (default: T (reject): [0.00/15.00] [CLAM_VIRUS(0.00){Eicar-Signature;}]), len: 300, rcpts: <contact@exemple.fr>'), null);
  assert.equal(r('2026-10-09 17:02:02 #57(rspamd_proxy) <6a1b2e>; proxy; rspamd_task_write_log: id: <m@exemple.fr>, qid: <7F00AA11BB>, ip: 203.0.113.4, user: contact@exemple.fr, from: <contact@exemple.fr>, (default: T (soft reject): [0.00/15.00] [OBLIMINT_LIMITS(0.00){}]), len: 300, rcpts: <x@y.org>'), null);
  // tagged (delivered) spam: only Rspamd knows it
  const tagged = r('2026-10-09 17:02:05 #57(rspamd_proxy) <6a1b30>; proxy; rspamd_task_write_log: id: <t@spam.test>, qid: <9C8B7A6F60>, ip: 198.51.100.9, from: <a@spam.test>, (default: T (add header): [7.10/15.00] [R_SPF_FAIL(1.00){-all;}]), len: 830, rcpts: <contact@exemple.fr>');
  assert.ok(tagged?.type === 'delivery');
  assert.equal(tagged.event, 'spam');
  assert.equal(tagged.queueId, '9C8B7A6F60');
  // no queue id (direct scan): Rspamd's own line is the only trace
  const spam = r('2026-10-09 17:02:00 #57(rspamd_proxy) <6a1b2c>; proxy; rspamd_task_write_log: id: <gtube@spam.test>, qid: <undef>, ip: 198.51.100.9, from: <a@spam.test>, (default: T (reject): [1000.00/15.00] [GTUBE(0.00){},R_SPF_FAIL(1.00){-all;}]), len: 830, time: 12.3ms, dns req: 4, digest: <f00>, rcpts: <contact@exemple.fr>, mime_rcpts: <contact@exemple.fr>, forced: reject "Gtube pattern"');
  assert.ok(spam?.type === 'delivery');
  assert.equal(spam.event, 'spam');
  assert.equal(spam.queueId, null);
  assert.equal(spam.messageId, 'gtube@spam.test');
  assert.equal(spam.recipient, 'contact@exemple.fr');
  assert.equal(spam.direction, 'inbound');
  const virus = r('2026-10-09 17:02:01 #57(rspamd_proxy) <6a1b2d>; proxy; rspamd_task_write_log: id: <eicar@x>, ip: 198.51.100.9, from: <a@spam.test>, (default: T (reject): [0.00/15.00] [CLAM_VIRUS(0.00){Eicar-Signature;}]), len: 300, time: 50ms, rcpts: <contact@exemple.fr>');
  assert.ok(virus?.type === 'delivery');
  assert.equal(virus.event, 'virus');
  const out = r('2026-10-09 17:02:02 #57(rspamd_proxy) <6a1b2e>; proxy; rspamd_task_write_log: id: <m@exemple.fr>, ip: 203.0.113.4, user: contact@exemple.fr, from: <contact@exemple.fr>, (default: T (soft reject): [0.00/15.00] [OBLIMINT_LIMITS(0.00){}]), len: 300, rcpts: <x@y.org>');
  assert.ok(out?.type === 'delivery');
  assert.equal(out.event, 'deferred');
  assert.equal(out.direction, 'outbound');
  assert.equal(out.saslUser, 'contact@exemple.fr');
  assert.equal(r('2026-10-09 17:02:03 #57(rspamd_proxy) <6a1b2f>; proxy; rspamd_task_write_log: id: <ok@x>, qid: <7F00AA11BC>, ip: 1.2.3.4, from: <a@b.c>, (default: F (no action): [1.20/15.00] [DKIM_TRACE(0.00){}]), len: 300, rcpts: <x@y.org>'), null);
  assert.equal(r('2026-10-09 17:02:04 #57(rspamd_proxy) <6a1b2f>; proxy; rspamd_task_write_log: id: <ok@x>, qid: <7F00AA11BC>, (default: F (no action): [0.00/15.00] [CLAM_VIRUS_FAIL(0.00){}])'), null);
});

test('logs: unrelated containers / lines / garbage ⇒ null; the driver never throws', () => {
  assert.equal(p('Oct  9 17:00:00 oblimint-mail postfix/qmgr[1]: 5A1B2C3D4E: removed'), null);
  assert.equal(p('Oct  9 17:00:00 oblimint-mail postfix/cleanup[1]: 5A1B2C3D4E: message-id=<a@b>'), null);
  assert.equal(parseMailLogLine('oblimint-edge', 'Oct  9 17:00:00 x postfix/smtpd[1]: 5A1B2C3D4E: client=x[1.2.3.4]', NOW), null);
  assert.equal(p(''), null);
  assert.equal(p('x'.repeat(20_000)), null);
  assert.equal(postfixDovecotDriver.parseLogLine(MAIL_CONTAINER, '\u0000￿'), null);
  assert.deepEqual(postfixDovecotDriver.logContainers(), [MAIL_CONTAINER, MAIL_RSPAMD_CONTAINER]);
});
