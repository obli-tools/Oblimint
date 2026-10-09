import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeDelivery, clientDetail, deliveryRow, parseRelayLine, relayDecisionRow, RelayPostfixTracker, type AttributionIndex,
} from './attribution';
import { abuseDetail, countersFromRows, evaluateAbuse } from './abuse';

const index: AttributionIndex = {
  domains: new Map([
    ['exemple.fr', { accountId: 5, tenantId: 2 }],
    ['autre.fr', { accountId: 6, tenantId: 3 }],
  ]),
  mailboxes: new Map([
    ['contact@exemple.fr', { accountId: 5, tenantId: 2, mailboxId: 40 }],
    ['boss@autre.fr', { accountId: 6, tenantId: 3, mailboxId: 41 }],
  ]),
  relayUsers: new Map([['site-12', { accountId: 5, tenantId: 2, siteId: 12 }]]),
};

test('attribution: SASL user first (mailbox or site), then sender (out) / recipient (in) domain', () => {
  // Authenticated mailbox: its account, whatever the envelope says.
  assert.deepEqual(attributeDelivery({ direction: 'outbound', sender: 'x@autre.fr', recipient: 'a@gmail.com', saslUser: 'Contact@Exemple.fr' }, index),
    { accountId: 5, tenantId: 2, mailboxId: 40, siteId: null });
  // Site relay user.
  assert.deepEqual(attributeDelivery({ direction: 'relay', sender: 'noreply@exemple.fr', recipient: 'a@gmail.com', saslUser: 'site-12' }, index),
    { accountId: 5, tenantId: 2, mailboxId: null, siteId: 12 });
  // Outbound without SASL (relay input 10025): the sender domain.
  assert.equal(attributeDelivery({ direction: 'outbound', sender: '<noreply@exemple.fr>', recipient: 'a@gmail.com', saslUser: null }, index).accountId, 5);
  // Inbound: the RECIPIENT domain, never the (forgeable) sender.
  const inbound = attributeDelivery({ direction: 'inbound', sender: 'boss@autre.fr', recipient: 'contact@exemple.fr', saslUser: null }, index);
  assert.deepEqual(inbound, { accountId: 5, tenantId: 2, mailboxId: 40, siteId: null });
  // Unknown domain / unknown SASL user: unattributed (invisible to clients).
  assert.equal(attributeDelivery({ direction: 'inbound', sender: 'x@exemple.fr', recipient: 'y@nowhere.fr', saslUser: null }, index).accountId, null);
  assert.equal(attributeDelivery({ direction: 'outbound', sender: 'x@nowhere.fr', recipient: 'y@exemple.fr', saslUser: 'ghost@nowhere.fr' }, index).accountId, null);
  // Sub-domain of a mail domain is NOT that domain.
  assert.equal(attributeDelivery({ direction: 'outbound', sender: 'x@sub.exemple.fr', recipient: null, saslUser: null }, index).accountId, null);
});

test('deliveryRow: cleaned / bounded columns', () => {
  const row = deliveryRow({
    type: 'delivery', at: '2026-10-09T12:00:00Z', direction: 'outbound', event: 'bounced', queueId: '4B2C1\n', messageId: '<m@x>',
    sender: 'NoReply@Exemple.fr', recipient: 'a@gmail.com', sizeBytes: 1234.7, saslUser: null, detail: `550 ${'x'.repeat(2000)}`, remote: 'gmail-smtp-in.l.google.com[1.2.3.4]',
  }, index, 'postfix-dovecot');
  assert.equal(row.account_id, 5);
  assert.equal(row.tenant_id, 2);
  assert.equal(row.sender, 'noreply@exemple.fr');
  assert.equal(row.queue_id, '4B2C1');
  assert.equal(row.size_bytes, 1234);
  assert.equal(row.detail!.length, 1000);
  assert.equal(row.at.toISOString(), '2026-10-09T12:00:00.000Z');
  assert.equal(row.engine, 'postfix-dovecot');
});

test('relayd JSON lines → relay rows attributed through OUR relay users', () => {
  const accept = parseRelayLine('{"type":"decision","at":"2026-10-09T12:00:00Z","stage":"end-of-message","decision":"accept","user":"site-12","site":12,"account":5,"sender":"noreply@exemple.fr","recipients":3,"size":999,"queueId":"ABC"}');
  assert.ok(accept);
  const row = relayDecisionRow(accept, index);
  assert.deepEqual([row.direction, row.event, row.account_id, row.site_id, row.size_bytes, row.detail], ['relay', 'accepted', 5, 12, 999, '3 destinataire(s)']);
  const reject = relayDecisionRow(parseRelayLine('{"type":"decision","at":"2026-10-09T12:00:00Z","stage":"rcpt","decision":"reject","reason":"senderNotAllowed","user":"site-12","site":12,"account":5,"sender":"ceo@bank.com","recipient":"x@y.fr"}')!, index);
  assert.equal(reject.event, 'rejected');
  assert.match(reject.detail!, /expéditeur non autorisé/);
  // A line claiming another account than our table says: unattributed.
  const forged = relayDecisionRow(parseRelayLine('{"type":"decision","at":"2026-10-09T12:00:00Z","stage":"rcpt","decision":"defer","reason":"siteLimit","user":"site-12","site":12,"account":6}')!, index);
  assert.equal(forged.account_id, null);
  assert.equal(forged.event, 'deferred');
  // Not decisions.
  for (const l of ['postfix/relay/smtpd[12]: connect from x', '{"type":"fromRewritten","at":"x"}', '{bad json', '{"type":"decision","decision":"maybe","stage":"rcpt","at":"x"}']) {
    assert.equal(parseRelayLine(l), null, l);
  }
});

test('relay Postfix lines (direct delivery): queue id → sender, status → outbound rows', () => {
  const t = new RelayPostfixTracker();
  const at = new Date('2026-10-09T12:00:00Z');
  assert.equal(t.line('postfix/qmgr[90]: 4B2C1D: from=<noreply@exemple.fr>, size=2048, nrcpt=1 (queue active)', at, index), null);
  // The hand-off to our own content filter is not a delivery.
  assert.equal(t.line('postfix/filter/smtp[91]: 4B2C1D: to=<a@gmail.com>, relay=127.0.0.1[127.0.0.1]:10027, delay=0.1, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued)', at, index), null);
  const sent = t.line('postfix/smtp[92]: 4B2C1D: to=<a@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.1.1]:25, delay=1, dsn=2.0.0, status=sent (250 2.0.0 OK)', at, index);
  assert.ok(sent);
  assert.deepEqual([sent.direction, sent.event, sent.account_id, sent.sender, sent.recipient, sent.size_bytes, sent.engine], ['outbound', 'delivered', 5, 'noreply@exemple.fr', 'a@gmail.com', 2048, 'relay']);
  const bounced = t.line('postfix/smtp[92]: 4B2C1D: to=<b@nowhere.example>, relay=none, delay=1, dsn=5.4.4, status=bounced (Host or domain name not found)', at, index);
  assert.equal(bounced?.event, 'bounced');
  assert.equal(t.line('postfix/qmgr[90]: 4B2C1D: removed', at, index), null);
  // Unknown queue id: unattributed row.
  assert.equal(t.line('postfix/smtp[92]: 4B2C1D: to=<c@gmail.com>, relay=x[1.1.1.1]:25, delay=1, dsn=4.0.0, status=deferred (timeout)', at, index)?.account_id, null);
});

test('client view of details (A6)', () => {
  assert.equal(clientDetail('delivered'), null);
  assert.match(clientDetail('bounced')!, /refusé/);
});

test('abuse: counters and verdict', () => {
  const c = countersFromRows([
    { direction: 'outbound', event: 'delivered', n: '40' },
    { direction: 'outbound', event: 'bounced', n: 8 },
    { direction: 'outbound', event: 'deferred', n: 30 },
    { direction: 'outbound', event: 'spam', n: 1 },
    { direction: 'outbound', event: 'virus', n: 1 },
    { direction: 'relay', event: 'rejected', n: 2 },
    { direction: 'relay', event: 'accepted', n: 50 },
    { direction: 'inbound', event: 'bounced', n: 99 },
  ]);
  assert.deepEqual(c, { sent: 40, bounced: 8, rejected: 2, spam: 2 });
  // 12 bad of 52 = 23.1 % ≥ 20 % over 50 messages → abuse (bounces dominate).
  const v = evaluateAbuse(c, { minMessages: 50, ratePct: 20 });
  assert.deepEqual(v, { abusive: true, reason: 'bounceRate', ratePct: 23.1, total: 52 });
  assert.match(abuseDetail(c, v), /52 messages sortants/);
  // Under the volume threshold: never.
  assert.equal(evaluateAbuse(c, { minMessages: 100, ratePct: 20 }).abusive, false);
  // Under the rate: no.
  assert.equal(evaluateAbuse(c, { minMessages: 10, ratePct: 30 }).abusive, false);
  // Spam dominating → spamRate.
  assert.equal(evaluateAbuse({ sent: 10, bounced: 1, rejected: 0, spam: 30 }, { minMessages: 10, ratePct: 20 }).reason, 'spamRate');
  // Nothing bad: never abusive, even with a 0 % threshold misconfiguration.
  assert.equal(evaluateAbuse({ sent: 500, bounced: 0, rejected: 0, spam: 0 }, { minMessages: 1, ratePct: 0 }).abusive, false);
  assert.equal(evaluateAbuse({ sent: 0, bounced: 0, rejected: 0, spam: 0 }, { minMessages: 0, ratePct: 1 }).abusive, false);
});
