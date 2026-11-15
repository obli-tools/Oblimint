import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailClientDiscovery, buildMailClientServers, publicMailEndpoints, type DiscoveryInput } from './mailClientDiscovery';

// « Se connecter à Mint », O2 / O6 / P6 — pure builders of the discovery document.

const input = (over: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  host: 'mx1.hebergeur.net',
  domain: 'acme.fr',
  panelHost: 'panel.hebergeur.net',
  clientHost: 'client.hebergeur.net',
  desktopClients: true,
  maxMessageSizeMb: 25,
  authBan: { threshold: 10, windowMinutes: 10, durationMinutes: 60, revokedAllowance: true },
  webmailUrl: 'https://webmail.acme.fr/',
  ...over,
});

test('discovery: submission 465 (implicit TLS) first, 587 STARTTLS second; IMAPS first (O6)', () => {
  const e = publicMailEndpoints('mx1.hebergeur.net');
  assert.deepEqual(e.smtp.map((x) => [x.port, x.security]), [[465, 'tls'], [587, 'starttls']]);
  assert.deepEqual(e.imap.map((x) => [x.port, x.security]), [[993, 'tls'], [143, 'starttls']]);
  assert.deepEqual(e.pop3.map((x) => [x.port, x.security]), [[995, 'tls']]);
});

test('discovery: both issuers, domain part, no OAuth before lot 2, limits and ban policy', () => {
  const doc = buildMailClientDiscovery(input());
  assert.equal(doc.version, 1);
  assert.equal(doc.product, 'oblimint');
  assert.equal(doc.domain, 'acme.fr');
  assert.deepEqual(doc.issuers, ['https://panel.hebergeur.net', 'https://client.hebergeur.net']);
  assert.equal(doc.panelUrl, 'https://panel.hebergeur.net');
  assert.equal(doc.clientSpaceUrl, 'https://client.hebergeur.net');
  assert.equal(doc.oauth.clientId, 'mailforge');
  assert.equal(doc.oauth.scope, 'mail.client');
  assert.equal(doc.oauth.enabled, false);
  assert.deepEqual(doc.oauth.endpoints, {});
  assert.equal(doc.mail.username, 'address');
  assert.deepEqual(doc.mail.authMechanisms, ['PLAIN']);
  assert.deepEqual(doc.mail.tlsNames, ['mx1.hebergeur.net']);
  assert.equal(doc.mail.limits.maxMessageBytes, 25 * 1048576);
  assert.deepEqual(doc.mail.authBan, { threshold: 10, windowMinutes: 10, durationMinutes: 60, revokedAllowance: true });
  assert.equal(doc.webmailUrl, 'https://webmail.acme.fr/');
  // Panel host: no domain part.
  const panel = buildMailClientDiscovery(input({ domain: null }));
  assert.equal(panel.domain, undefined);
  assert.ok(!('webmailUrl' in panel));
  // No client space: one issuer.
  assert.deepEqual(buildMailClientDiscovery(input({ clientHost: null })).issuers, ['https://panel.hebergeur.net']);
});

test('discovery: endpoints per issuer, same origin, once the sign-in exists and is allowed', () => {
  const on = buildMailClientDiscovery(input({ oauthReady: true }));
  assert.equal(on.oauth.enabled, true);
  for (const iss of on.issuers) {
    assert.equal(new URL(on.oauth.endpoints[iss].authorization).origin, iss);
    assert.equal(new URL(on.oauth.endpoints[iss].token).origin, iss);
    assert.equal(new URL(on.oauth.endpoints[iss].token).pathname, '/oauth/mail-client/token');
  }
  const off = buildMailClientDiscovery(input({ oauthReady: true, desktopClients: false }));
  assert.equal(off.oauth.enabled, false);
  assert.deepEqual(off.oauth.endpoints, {});
});

test('discovery never betrays the engine (P6); the authenticated `servers` does', () => {
  const doc = JSON.stringify(buildMailClientDiscovery(input()));
  for (const k of ['engine', 'dovecot', 'stalwart', 'managesieve', 'serverFullTextSearch', 'imapConnectionsPerUserIp', '4190', 'LOGIN']) {
    assert.ok(!doc.toLowerCase().includes(k.toLowerCase()), k);
  }
  const dovecot = buildMailClientServers('postfix-dovecot', 'mx1.hebergeur.net')!;
  assert.equal(dovecot.engine, 'postfix-dovecot');
  assert.deepEqual(dovecot.managesieve, { host: 'mx1.hebergeur.net', port: 4190, security: 'starttls' });
  assert.equal(dovecot.serverFullTextSearch, false);
  assert.equal(dovecot.imapConnectionsPerUserIp, 20);
  assert.deepEqual(dovecot.authMechanisms, ['PLAIN', 'LOGIN']);
  const stalwart = buildMailClientServers('stalwart', 'mx1.hebergeur.net')!;
  assert.equal(stalwart.managesieve, null);
  assert.equal(stalwart.serverFullTextSearch, true);
  assert.equal(stalwart.imapConnectionsPerUserIp, null);
  assert.deepEqual(stalwart.authMechanisms, ['PLAIN']);
  assert.equal(stalwart.smtp[0].port, 465);
  assert.equal(buildMailClientServers('external', 'mx1.hebergeur.net'), null);
});
