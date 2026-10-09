import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFields, parseLogLine, parseStalwartLine } from './logs';

test('stalwart logs: key = value fields (quoted, lists, bare values with commas)', () => {
  assert.deepEqual(parseFields('listenerId = "imap", localPort = 143, remoteIp = 203.0.113.9, to = ["a@x.fr", "b@y.fr"], details = "a, \\"b\\"", size = 12'), {
    listenerId: 'imap', localPort: '143', remoteIp: '203.0.113.9', to: ['a@x.fr', 'b@y.fr'], details: 'a, "b"', size: '12',
  });
  assert.deepEqual(parseFields('reason = Relay not allowed, contact admin, code = 550'), { reason: 'Relay not allowed, contact admin', code: '550' });
  assert.deepEqual(parseFields(''), {});
});

test('stalwart logs: auth.failed → authFailure with the remote IP and the service', () => {
  const ev = parseStalwartLine('2026-10-09T10:00:00Z INFO Authentication failed (auth.failed) listenerId = "imaptls", localPort = 993, remoteIp = 203.0.113.9, remotePort = 50412, accountName = "bob@exemple.fr"');
  assert.deepEqual(ev, { type: 'authFailure', at: '2026-10-09T10:00:00.000Z', service: 'imap', ip: '203.0.113.9', username: 'bob@exemple.fr' });
  const smtp = parseStalwartLine('2026-10-09T10:00:01Z INFO Authentication failed (auth.failed) listenerId = "submission", localPort = 587, remoteIp = ::ffff:198.51.100.7, accountName = "x"');
  assert.equal(smtp?.type === 'authFailure' && smtp.service, 'submission');
  assert.equal(smtp?.type === 'authFailure' && smtp.ip, '198.51.100.7');
  const v6 = parseStalwartLine('2026-10-09T10:00:01Z INFO Authentication failed (auth.failed) listenerId = "sieve", localPort = 4190, remoteIp = 2001:db8::7');
  assert.equal(v6?.type === 'authFailure' && v6.ip, '2001:db8::7');
  assert.equal(v6?.type === 'authFailure' && v6.username, null);
  // Docker --timestamps prefix tolerated.
  assert.equal(parseStalwartLine('2026-10-09T10:00:02.123456789Z 2026-10-09T10:00:02Z INFO Authentication failed (auth.failed) localPort = 110, remoteIp = 192.0.2.1')?.type, 'authFailure');
  // Not a mail port (HTTP API) / no IP → ignored (no ban input).
  assert.equal(parseStalwartLine('2026-10-09T10:00:03Z INFO Authentication failed (auth.failed) listenerId = "http", localPort = 8080, remoteIp = 172.30.0.2'), null);
  assert.equal(parseStalwartLine('2026-10-09T10:00:03Z INFO Authentication failed (auth.failed) localPort = 993, remoteIp = not-an-ip'), null);
});

test('stalwart logs: queue / delivery / ingest / rejections', () => {
  const out = parseStalwartLine('2026-10-09T10:01:00Z INFO Message queued for delivery (queue.queue-message-authenticated) listenerId = "submissions", localPort = 465, queueId = 217863412, from = "Contact@Exemple.fr", to = ["a@gmail.com", "b@gmail.com"], size = 5120, accountName = "contact@exemple.fr"');
  assert.deepEqual(out, {
    type: 'delivery', at: '2026-10-09T10:01:00.000Z', direction: 'outbound', event: 'accepted', queueId: '217863412', messageId: null,
    sender: 'contact@exemple.fr', recipient: 'a@gmail.com', sizeBytes: 5120, saslUser: 'contact@exemple.fr', detail: '+1 recipient(s)', remote: null,
  });
  const relay = parseStalwartLine('2026-10-09T10:01:01Z INFO Message queued (queue.queue-message) listenerId = "relay", localPort = 10025, queueId = 5, from = "site@exemple.fr", to = "x@outlook.com", size = 900');
  assert.equal(relay?.type === 'delivery' && relay.direction, 'relay');
  const inbound = parseStalwartLine('2026-10-09T10:01:02Z INFO Message queued (queue.queue-message) listenerId = "smtp", localPort = 25, queueId = 6, from = "z@gmail.com", to = "contact@exemple.fr", size = 1000');
  assert.equal(inbound?.type === 'delivery' && inbound.direction, 'inbound');
  const delivered = parseStalwartLine('2026-10-09T10:01:03Z INFO Delivered (delivery.delivered) queueId = 217863412, to = "a@gmail.com", hostname = "gmail-smtp-in.l.google.com", code = 250');
  assert.equal(delivered?.type === 'delivery' && `${delivered.event}/${delivered.remote}`, 'delivered/gmail-smtp-in.l.google.com');
  assert.equal(parseStalwartLine('2026-10-09T10:01:04Z WARN Temp fail (delivery.dsn-temp-fail) queueId = 7, to = "a@b.fr"')?.type === 'delivery' ? 'ok' : 'no', 'ok');
  const bounced = parseStalwartLine('2026-10-09T10:01:05Z INFO Perm fail (delivery.dsn-perm-fail) queueId = 8, from = "a@exemple.fr", to = "nobody@b.fr", details = "550 5.1.1 unknown"');
  assert.equal(bounced?.type === 'delivery' && `${bounced.event}:${bounced.detail}`, 'bounced:550 5.1.1 unknown');
  const spam = parseStalwartLine('2026-10-09T10:01:06Z INFO Message ingested (message-ingest.spam) accountName = "contact@exemple.fr", messageId = "<x@y>", size = 10');
  assert.equal(spam?.type === 'delivery' && `${spam.event}/${spam.recipient}/${spam.messageId}`, 'spam/contact@exemple.fr/<x@y>');
  const rej = parseStalwartLine('2026-10-09T10:01:07Z INFO Relay not allowed (smtp.relay-not-allowed) listenerId = "smtp", localPort = 25, remoteIp = 198.51.100.2, to = "x@gmail.com"');
  assert.equal(rej?.type === 'delivery' && `${rej.event}/${rej.direction}/${rej.remote}/${rej.detail}`, 'rejected/inbound/198.51.100.2/smtp.relay-not-allowed');
  // JSON flavour.
  const j = parseStalwartLine(JSON.stringify({ timestamp: '2026-10-09T10:02:00Z', level: 'INFO', event: 'auth.failed', data: { localPort: 143, remoteIp: '203.0.113.10', accountName: 'a@b.fr' } }));
  assert.equal(j?.type === 'authFailure' && j.ip, '203.0.113.10');
});

test('stalwart logs: noise, garbage and other containers → null', () => {
  assert.equal(parseStalwartLine('2026-10-09T10:00:00Z INFO SMTP connection started (smtp.connection-start) listenerId = "smtp", localPort = 25, remoteIp = 192.0.2.1'), null);
  assert.equal(parseStalwartLine('random text'), null);
  assert.equal(parseStalwartLine('{not json'), null);
  assert.equal(parseStalwartLine(''), null);
  assert.equal(parseLogLine('oblimint-mail-relay', '2026-10-09T10:00:00Z INFO Authentication failed (auth.failed) localPort = 143, remoteIp = 203.0.113.9'), null);
  assert.equal(parseLogLine('oblimint-mail', '2026-10-09T10:00:00Z INFO Authentication failed (auth.failed) localPort = 143, remoteIp = 203.0.113.9')?.type, 'authFailure');
});

test('stalwart logs: real 0.12.4 auth.failed lines (the Linux test host, tracing.level auth.failed = info)', () => {
  // remoteIp appears twice in 0.12.4 lines.
  const imaps = parseStalwartLine('2026-10-09T18:59:56Z INFO Authentication failed (auth.failed) listenerId = "imaptls", localPort = 993, remoteIp = 203.0.113.77, remotePort = 47904, remoteIp = 203.0.113.77, accountName = "bob@p4mail.test", id = "A002"');
  assert.deepEqual(imaps, { type: 'authFailure', at: '2026-10-09T18:59:56.000Z', service: 'imap', ip: '203.0.113.77', username: 'bob@p4mail.test' });
  const sub = parseStalwartLine('2026-10-09T18:59:56Z INFO Authentication failed (auth.failed) listenerId = "submission", localPort = 587, remoteIp = 203.0.113.77, remotePort = 40508, remoteIp = 203.0.113.77, accountName = "bob@p4mail.test"');
  assert.equal(sub?.type === 'authFailure' && sub.service, 'submission');
  // The admin API / JMAP listener is not a mail service: no ban input.
  assert.equal(parseStalwartLine('2026-10-09T19:00:01Z INFO Authentication failed (auth.failed) listenerId = "http", localPort = 8080, remoteIp = 172.20.0.77, remotePort = 55506, remoteIp = 172.20.0.77, accountName = "bob@p4mail.test"'), null);
});
