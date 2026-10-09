import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEBMAIL_TOKEN_RE, WebmailTokenStore, webmailKey, type WebmailTicket } from './ssoTokens';

function ticket(accountId: number, mailboxId = accountId * 10): WebmailTicket {
  return {
    appPasswordId: mailboxId + 1,
    mailboxId,
    accountId,
    kind: 'roundcube',
    credentials: { username: `u${mailboxId}@example.test`, password: 'secret-credential', expiresAt: new Date(0).toISOString() },
  };
}

test('a token is 32 random bytes in base64url and single use', () => {
  const store = new WebmailTokenStore();
  const { token, expiresAt } = store.issue(ticket(1));
  assert.match(token, WEBMAIL_TOKEN_RE);
  assert.ok(expiresAt.getTime() > Date.now());
  const first = store.redeem(token);
  assert.equal(first?.mailboxId, 10);
  assert.equal(store.redeem(token), null, 'replay refused');
  assert.equal(store.size, 0);
});

test('a token expires after 60 s and an expired redemption still consumes it', () => {
  let now = 1_000_000;
  const store = new WebmailTokenStore(() => now);
  const a = store.issue(ticket(1)).token;
  const b = store.issue(ticket(2)).token;
  now += 59_999;
  assert.ok(store.redeem(a), 'still valid just before 60 s');
  now += 1;
  assert.equal(store.redeem(b), null, 'expired at 60 s');
  assert.equal(store.size, 0, 'the expired token left the store');
});

test('malformed or unknown tokens are refused without touching the store', () => {
  const store = new WebmailTokenStore();
  store.issue(ticket(1));
  for (const bad of [undefined, null, 42, '', 'short', 'x'.repeat(43) + '!', { token: 'a' }, 'A'.repeat(43)]) {
    assert.equal(store.redeem(bad), null);
  }
  assert.equal(store.size, 1);
});

test('capacity is bounded per account (own oldest evicted) and globally', () => {
  const store = new WebmailTokenStore(Date.now, 60_000, 5, 2);
  const a1 = store.issue(ticket(1, 11)).token;
  const a2 = store.issue(ticket(1, 12)).token;
  const b1 = store.issue(ticket(2, 21)).token;
  const a3 = store.issue(ticket(1, 13)).token; // account 1 at its cap: a1 goes, b1 stays
  assert.equal(store.redeem(a1), null);
  assert.ok(store.redeem(b1));
  assert.ok(store.redeem(a2));
  assert.ok(store.redeem(a3));
  for (let i = 0; i < 12; i++) store.issue(ticket(100 + i));
  assert.ok(store.size <= 5, 'global bound');
});

test('sweep drops expired tokens; revokeMailbox drops a mailbox\'s pending tokens', () => {
  let now = 0;
  const store = new WebmailTokenStore(() => now);
  store.issue(ticket(1, 10));
  const keep = store.issue(ticket(2, 20)).token;
  store.issue(ticket(3, 30));
  assert.equal(store.revokeMailbox(10), 1);
  now = 120_000;
  assert.equal(store.sweep(), 2);
  assert.equal(store.redeem(keep), null);
});

test('the shared key is a stable HMAC of the session secret, distinct from the DB admin key', async () => {
  const k = webmailKey('s3cret');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, webmailKey('s3cret'));
  assert.notEqual(k, webmailKey('other'));
  const { dbAdminKey } = await import('../../databases/ssoTokens');
  assert.notEqual(k, dbAdminKey('s3cret'));
});
