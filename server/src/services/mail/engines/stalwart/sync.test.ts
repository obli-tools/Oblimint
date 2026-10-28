import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import type { DesiredMailbox, MailDesiredState, MailDriver } from '../../driver';
import { MailDriverError } from '../../driver';
import { hashMailPassword, md5Crypt, sha256Crypt } from '../../passwords';
import { StalwartApi } from './api';
import { createStalwartDriver } from './driver';
import { toStalwartSecret, STALWART_PASSWORD_SCHEMES } from './principals';
import { FakeStalwart, QUEUE_FIXTURE_V011, QUEUE_FIXTURE_V012 } from './testing';
import { STALWART_GID, STALWART_UID } from './constants';

const SECRET = 'admin-secret-admin-secret-admin-secret-x';
const creds = { secret: SECRET, hash: '$6$rounds=5000$abcdefghijklmnop$' + 'a'.repeat(86) };
const adminAuth = `Basic ${Buffer.from(`oblimint-admin:${SECRET}`).toString('base64')}`;
const NOW = new Date('2026-10-09T10:00:00Z');
const DKIM_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ssha512 = (pw: string): string => {
  const salt = crypto.randomBytes(8);
  return `{SSHA512}${Buffer.concat([crypto.createHash('sha512').update(pw).update(salt).digest(), salt]).toString('base64')}`;
};
const blf = `{BLF-CRYPT}${bcrypt.hashSync('pw-blf-0123456', 4).replace(/^\$2[ab]\$/, '$2y$')}`;
const md5 = `{MD5-CRYPT}${md5Crypt('pw-md5-0123456', 'cwpSALT1')}`;
const sha256 = `{SHA256-CRYPT}${sha256Crypt('pw-256-0123456', 'saltsaltsalt')}`;
const sshaHash = ssha512('pw-ssha-0123456');
const contactHash = hashMailPassword('Motdepasse-long-1').hash;
const appHash = hashMailPassword('webmail-session-credential').hash;
const expiredAppHash = hashMailPassword('expired-session-credential').hash;

function mailbox(id: number, address: string, passwordHash: string, patch: Partial<DesiredMailbox> = {}): DesiredMailbox {
  const [localPart, domain] = address.split('@');
  return {
    id, accountId: 7, domainId: domain === 'exemple.fr' ? 1 : 2, address, localPart, domain, displayName: null, passwordHash,
    passwordScheme: /^\{([A-Z0-9-]+)\}/.exec(passwordHash)![1] as DesiredMailbox['passwordScheme'],
    quotaMb: 1024, loginEnabled: true, sendEnabled: true, receiveEnabled: true, sendPerHour: 200, forward: null, autoresponder: null, ...patch,
  };
}

function baseState(): MailDesiredState {
  return {
    generatedAt: NOW.toISOString(),
    settings: { hostname: 'mail.host.net', maxMessageSizeMb: 50, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: true, clamdAddress: null },
    domains: [
      { id: 1, accountId: 7, name: 'exemple.fr', active: true, catchAll: null, maxMessageSizeMb: 25 },
      { id: 2, accountId: 7, name: 'autre.fr', active: true, catchAll: 'contact@exemple.fr', maxMessageSizeMb: 50 },
    ],
    mailboxes: [
      mailbox(1, 'contact@exemple.fr', contactHash, {
        displayName: 'Contact', forward: { targets: ['copie@gmail.com'], keepCopy: true },
        autoresponder: { subject: 'Absent', body: 'Je suis absent.', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-20T00:00:00Z', intervalDays: 1 },
      }),
      mailbox(2, 'md5@exemple.fr', md5),
      mailbox(3, 'blf@autre.fr', blf, { quotaMb: null }),
      mailbox(4, 'ssha@autre.fr', sshaHash),
      mailbox(5, 'sha256@autre.fr', sha256),
    ],
    aliases: [
      { id: 10, accountId: 7, domainId: 1, address: 'info@exemple.fr', targets: ['contact@exemple.fr'] },
      { id: 11, accountId: 7, domainId: 1, address: 'team@exemple.fr', targets: ['contact@exemple.fr', 'Ext@Gmail.com'] },
    ],
    appPasswords: [
      { id: 1, mailboxId: 1, address: 'contact@exemple.fr', passwordHash: appHash, expiresAt: '2026-10-09T22:00:00Z', purpose: 'webmail', allowNets: ['172.30.0.0/16'] },
      { id: 2, mailboxId: 1, address: 'contact@exemple.fr', passwordHash: expiredAppHash, expiresAt: '2026-10-09T09:00:00Z', purpose: 'webmail', allowNets: ['172.30.0.0/16'] },
    ],
    dkim: [{
      domain: 'exemple.fr', selector: 'om202610', algorithm: 'rsa-2048', signing: true,
      privateKeyPem: DKIM_PEM,
    }],
    tls: [],
    relay: { relayHost: 'oblimint-mail-relay', relayAddresses: ['172.30.0.5'] },
  };
}

function setup(clock: () => Date = () => NOW): { fake: FakeStalwart; driver: MailDriver; dirs: { config: string; data: string } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-stalwart-'));
  const dirs = { config: path.join(root, 'config'), data: path.join(root, 'data') };
  const fake = new FakeStalwart(adminAuth);
  const driver = createStalwartDriver({
    credentials: async () => creds,
    api: (c) => new StalwartApi({ user: 'oblimint-admin', secret: c.secret, fetch: fake.fetch }),
    docker: async () => { throw new Error('no docker in this test'); },
    ensureNetwork: async () => undefined,
    hostname: async () => 'mail.host.net',
    configDir: dirs.config,
    dataDir: dirs.data,
    certsDir: path.join(root, 'certs'),
    certRoots: [path.join(root, 'certs')],
    hostDataDir: '/srv/oblimint',
    bindAddresses: [],
    owner: null,
    now: clock,
    restartEngine: fake.restart,
    pollMs: 0,
  });
  return { fake, driver, dirs };
}

test('stalwart password schemes: every advertised scheme converts to the stored form', () => {
  assert.deepEqual([...STALWART_PASSWORD_SCHEMES].sort(), ['BLF-CRYPT', 'MD5-CRYPT', 'SHA256-CRYPT', 'SHA512-CRYPT', 'SSHA', 'SSHA256', 'SSHA512']);
  assert.match(toStalwartSecret(contactHash), /^\$6\$rounds=5000\$/);
  assert.match(toStalwartSecret(sha256), /^\$5\$saltsaltsalt\$/);
  assert.match(toStalwartSecret(md5), /^\$1\$cwpSALT1\$/);
  assert.match(toStalwartSecret(blf), /^\$2y\$04\$/);
  assert.match(toStalwartSecret(ssha512('x')), /^\{SSHA512\}[A-Za-z0-9+/]+=*$/);
  assert.match(toStalwartSecret('{SSHA}' + Buffer.alloc(24, 1).toString('base64')), /^\{SSHA\}/);
  for (const bad of ['{PLAIN}secret', '$6$nohdr', '{MD5-CRYPT}$1$x$short', '{BLF-CRYPT}$2x$10$' + 'a'.repeat(53), '{SSHA512}not base64!', '{CRAM-MD5}abc']) {
    assert.throws(() => toStalwartSecret(bad), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState' && !e.message.includes(bad.slice(1, 8)));
  }
});

test('stalwart sync: first pass creates domains, accounts, lists, config, sieve; second pass writes nothing', async () => {
  const { fake, driver, dirs } = setup();
  const state = baseState();
  const r1 = await driver.sync(state, { reason: 'test' });
  assert.deepEqual(r1.domainErrors, {});
  assert.equal(r1.ok, true);
  assert.equal(r1.changed, true);
  assert.equal(r1.mailboxes, 5);
  assert.equal(r1.domains, 2);

  const p = (n: string) => fake.principals.get(n)!;
  assert.equal(p('exemple.fr').type, 'domain');
  assert.equal(p('autre.fr').type, 'domain');
  const contact = p('contact@exemple.fr');
  assert.equal(contact.type, 'individual');
  assert.deepEqual(contact.emails, ['contact@exemple.fr', 'info@exemple.fr'], 'address + single-target alias');
  assert.deepEqual(contact.secrets, [toStalwartSecret(contactHash), toStalwartSecret(appHash)], 'main hash + live app password only');
  assert.equal(contact.quota, 1024 * 1048576);
  assert.equal(contact.description, 'Contact');
  assert.deepEqual(contact.roles, ['user']);
  assert.deepEqual(contact.disabledPermissions, []);
  assert.deepEqual(p('md5@exemple.fr').secrets, [md5.replace('{MD5-CRYPT}', '')]);
  assert.deepEqual(p('blf@autre.fr').secrets, [blf.replace('{BLF-CRYPT}', '')]);
  assert.equal(p('blf@autre.fr').quota, 0, 'unlimited');
  assert.match(p('ssha@autre.fr').secrets[0], /^\{SSHA512\}/);
  const team = p('oblimint-alias-11');
  assert.equal(team.type, 'list');
  assert.deepEqual(team.emails, ['team@exemple.fr']);
  assert.deepEqual(team.members, ['contact@exemple.fr']);
  assert.deepEqual(team.externalMembers, ['ext@gmail.com']);
  const catchAll = p('oblimint-catchall-2');
  assert.deepEqual(catchAll.emails, ['@autre.fr']);
  assert.deepEqual(catchAll.members, ['contact@exemple.fr']);
  assert.equal(fake.principals.has('oblimint-alias-10'), false);

  // Config written, DKIM key + signing rule + sizes in the engine's settings store (never a key file), reload asked once.
  const toml = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  assert.ok(!toml.includes('remote_ip'), 'relay addresses live in the settings store, not in config.toml');
  assert.match(fake.settings.get('session.rcpt.relay.0001.if') ?? '', /remote_ip == '172\.30\.0\.5'/);
  assert.ok(!toml.includes('PRIVATE KEY') && !toml.includes('[signature'));
  assert.equal(fs.readdirSync(path.join(dirs.config, 'dkim')).length, 0);
  const sigDomains = [...fake.settings].filter(([k]) => /^signature\.[^.]+\.domain$/.test(k)).map(([, v]) => v);
  assert.deepEqual(sigDomains, ['exemple.fr']);
  assert.match(fake.settings.get('auth.dkim.sign.0000.if') ?? '', /sender_domain == 'exemple\.fr'$/);
  assert.equal(fake.settings.get('session.data.limits.size.0000.if'), "rcpt_domain == 'exemple.fr'");
  assert.equal(fake.settings.get('auth.dkim.verify'), 'relaxed', 'local keys untouched');
  assert.equal(fake.calls.filter((c) => c.path === '/api/settings' && c.method === 'POST').length, 1, 'settings written before the restart');
  assert.equal(fake.calls.filter((c) => c.path === '/api/reload').length, 1);
  // Applied by a restart (Stalwart 0.12.4 reads config.toml at start only), then checked through /api/reload.
  assert.equal(fake.restarts, 1);
  // Sieve installed and active for the mailbox with forwarding + autoresponder only.
  const script = fake.sieve.get('contact@exemple.fr')!.get('oblimint')!;
  assert.equal(script.active, true);
  assert.match(script.content, /redirect :copy "copie@gmail\.com";/);
  assert.match(script.content, /vacation :days 1/);
  assert.equal(fake.sieve.get('md5@exemple.fr')?.size ?? 0, 0);
  // No request body / error carries a hash in logs: bodies only go to the fake server.
  const stateFile = fs.readFileSync(path.join(dirs.config, 'oblimint-sync.json'), 'utf8');
  assert.ok(!stateFile.includes('$6$') && !stateFile.includes('{SSHA'), 'bookkeeping holds fingerprints only');
  assert.equal(fs.existsSync(path.join(dirs.data, 'oblimint-sync.json')), false, 'never in the container-writable store');

  // Second pass: nothing written at all (idempotent).
  const before = fake.calls.length;
  const r2 = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(r2.changed, false);
  assert.equal(fake.restarts, 1, 'unchanged configuration: no restart');
  assert.deepEqual(fake.calls.slice(before).filter((c) => c.method !== 'GET' || c.path.startsWith('/api/reload') || c.path.startsWith('/jmap')), []);

  // Same with an API that does not return secrets: fingerprints keep it idempotent.
  fake.returnSecrets = false;
  const before3 = fake.calls.length;
  const r3 = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(r3.changed, false);
  assert.equal(fake.calls.slice(before3).filter((c) => c.method !== 'GET').length, 0);
});

test('stalwart sync: updates, address moves, disable instead of delete, detach', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  fake.returnSecrets = false;

  const st = baseState();
  // info@ now has two targets → leaves contact's emails, becomes a list (address moved: removal first).
  st.aliases[0] = { ...st.aliases[0], targets: ['contact@exemple.fr', 'md5@exemple.fr'] };
  // md5@: login disabled (account suspended) — receive kept.
  st.mailboxes[1] = { ...st.mailboxes[1], loginEnabled: false, sendEnabled: false };
  // blf@: sending off, quota set.
  st.mailboxes[2] = { ...st.mailboxes[2], sendEnabled: false, quotaMb: 512 };
  // contact: new password, forwarding without copy, no autoresponder.
  const newHash = hashMailPassword('Un-autre-motdepasse').hash;
  st.mailboxes[0] = { ...st.mailboxes[0], passwordHash: newHash, forward: { targets: ['copie@gmail.com'], keepCopy: false }, autoresponder: null };
  // sha256@ removed from the state → detached, never deleted.
  st.mailboxes = st.mailboxes.filter((m) => m.address !== 'sha256@autre.fr');
  // catch-all removed.
  st.domains[1] = { ...st.domains[1], catchAll: null };

  const before = fake.calls.length;
  const r = await driver.sync(st, { reason: 'test' });
  assert.deepEqual(r.domainErrors, {});
  assert.equal(r.changed, true);
  const writes = fake.calls.slice(before).filter((c) => c.method !== 'GET');
  assert.ok(!writes.some((c) => c.method === 'DELETE' && !c.path.includes('oblimint-catchall')), 'no account deleted');

  const p = (n: string) => fake.principals.get(n)!;
  assert.deepEqual(p('contact@exemple.fr').emails, ['contact@exemple.fr']);
  assert.deepEqual(p('contact@exemple.fr').secrets, [toStalwartSecret(newHash), toStalwartSecret(appHash)]);
  assert.deepEqual(p('oblimint-alias-10').emails, ['info@exemple.fr']);
  assert.deepEqual(p('oblimint-alias-10').members, ['contact@exemple.fr', 'md5@exemple.fr']);
  assert.deepEqual(p('md5@exemple.fr').secrets, [], 'no login at all');
  assert.deepEqual([...p('md5@exemple.fr').disabledPermissions].sort(), ['authenticate', 'email-send', 'jmap-email-submission-set']);
  assert.deepEqual(p('md5@exemple.fr').emails, ['md5@exemple.fr'], 'still receives');
  assert.deepEqual([...p('blf@autre.fr').disabledPermissions].sort(), ['email-send', 'jmap-email-submission-set']);
  assert.equal(p('blf@autre.fr').quota, 512 * 1048576);
  const gone = p('sha256@autre.fr');
  assert.ok(gone, 'detached, not deleted (data kept for purge)');
  assert.deepEqual(gone.emails, []);
  assert.deepEqual(gone.secrets, []);
  assert.deepEqual([...gone.disabledPermissions].sort(), ['authenticate', 'email-receive', 'email-send', 'jmap-email-submission-set']);
  assert.equal(fake.principals.has('oblimint-catchall-2'), false, 'catch-all list (no data) removed');
  const script = fake.sieve.get('contact@exemple.fr')!.get('oblimint')!;
  assert.match(script.content, /redirect "copie@gmail\.com";/);
  assert.ok(!script.content.includes('vacation'));

  // Removing forwarding entirely removes the script.
  st.mailboxes[0] = { ...st.mailboxes[0], forward: null };
  await driver.sync(st, { reason: 'test' });
  assert.equal(fake.sieve.get('contact@exemple.fr')!.size, 0);

  // Re-enabling md5@ restores its secret and permissions.
  st.mailboxes[1] = { ...st.mailboxes[1], loginEnabled: true, sendEnabled: true };
  await driver.sync(st, { reason: 'test' });
  assert.deepEqual(p('md5@exemple.fr').secrets, [md5.replace('{MD5-CRYPT}', '')]);
  assert.deepEqual(p('md5@exemple.fr').disabledPermissions, []);
  // And it settles.
  const n = fake.calls.length;
  assert.equal((await driver.sync(st, { reason: 'test' })).changed, false);
  assert.equal(fake.calls.slice(n).filter((c) => c.method !== 'GET').length, 0);
});

test('stalwart sync: mass-removal guard refuses before writing anything; force applies', async () => {
  const { fake, driver, dirs } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  const tomlBefore = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  const empty = { ...baseState(), mailboxes: [], aliases: [], appPasswords: [] };
  const n = fake.calls.length;
  await assert.rejects(driver.sync(empty, { reason: 'test' }), (e: unknown) => e instanceof MailDriverError && e.code === 'massRemoval');
  assert.equal(fake.calls.slice(n).filter((c) => c.method !== 'GET').length, 0, 'nothing written');
  assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), tomlBefore, 'config untouched');

  // Removing one mailbox out of five is fine without force.
  const one = baseState();
  one.mailboxes = one.mailboxes.filter((m) => m.address !== 'ssha@autre.fr');
  assert.equal((await driver.sync(one, { reason: 'test' })).ok, true);

  const forced = await driver.sync(empty, { reason: 'test', allowMassRemoval: true });
  assert.equal(forced.ok, true);
  assert.equal([...fake.principals.values()].filter((p) => p.type === 'individual').length, 5, 'detached, never deleted');
  assert.ok([...fake.principals.values()].filter((p) => p.type === 'individual').every((p) => p.emails.length === 0 && p.secrets.length === 0));
});

test('stalwart sync: invalid state refused without leaking the hash; per-domain failures reported', async () => {
  const { fake, driver } = setup();
  const bad = baseState();
  bad.mailboxes[1] = { ...bad.mailboxes[1], address: "x'y@exemple.fr" };
  await assert.rejects(driver.sync(bad, { reason: 'test' }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  assert.equal(fake.calls.filter((c) => c.method !== 'GET').length, 0);

  fake.failOn = (c) => (c.method === 'POST' && (c.body as { name?: string })?.name === 'autre.fr' ? 'other' : null);
  const r = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.domainErrors), ['autre.fr']);
  assert.ok(!r.domainErrors['autre.fr'].includes('$6$'));
  assert.ok(fake.principals.has('contact@exemple.fr'), 'the other domain was applied');
  assert.equal(fake.principals.has('blf@autre.fr'), false);
  fake.failOn = null;
  const again = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(again.ok, true);
  assert.ok(fake.principals.has('blf@autre.fr'));

  fake.down = true;
  await assert.rejects(driver.sync(baseState(), { reason: 'test' }), (e: unknown) => e instanceof MailDriverError && e.code === 'unavailable');
});

test('stalwart purge, usage, queue', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  // An attached mailbox is never purged.
  await assert.rejects(driver.purge({ kind: 'mailbox', name: 'md5@exemple.fr' }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  assert.ok(fake.principals.has('md5@exemple.fr'));
  const st = baseState();
  st.mailboxes = st.mailboxes.filter((m) => m.address !== 'md5@exemple.fr');
  await driver.sync(st, { reason: 'test' });
  await driver.purge({ kind: 'mailbox', name: 'md5@exemple.fr' });
  assert.equal(fake.principals.has('md5@exemple.fr'), false);
  await driver.purge({ kind: 'mailbox', name: 'md5@exemple.fr' }); // missing = success
  await assert.rejects(driver.purge({ kind: 'mailbox', name: "x'@exemple.fr" }), MailDriverError);
  // Domain with mailboxes in use → refused.
  await assert.rejects(driver.purge({ kind: 'domain', name: 'autre.fr' }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');

  fake.principals.get('contact@exemple.fr')!.usedQuota = 4096;
  const usage = await driver.usage();
  assert.deepEqual(usage.find((u) => u.address === 'contact@exemple.fr'), { address: 'contact@exemple.fr', usedBytes: 4096, messages: null });

  fake.queue = [QUEUE_FIXTURE_V011, QUEUE_FIXTURE_V012];
  const q = await driver.queue({ limit: 10 });
  assert.deepEqual(q.map((e) => `${e.queueId}:${e.status}`), ['217863412:deferred', '99:active']);
  await driver.queueAction('99', 'retry');
  assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.path === '/api/queue/messages/99'));
  await driver.queueAction('99', 'delete');
  await assert.rejects(driver.queueAction('99', 'delete'), (e: unknown) => e instanceof MailDriverError && e.code === 'notFound');
  await assert.rejects(driver.queueAction('../principal/x', 'delete'), (e: unknown) => e instanceof MailDriverError && e.code === 'notFound');

  assert.deepEqual(driver.imapEndpoint(), { host: 'oblimint-mail', port: 143, tls: 'starttls' });
  assert.deepEqual(driver.relayTarget(), { host: 'oblimint-mail', port: 10025, tls: 'none' });
  assert.deepEqual(driver.logContainers(), ['oblimint-mail']);
  assert.equal(driver.capabilities.clamav, false);
  assert.equal(driver.capabilities.appPasswordNets, false);
});

test('stalwart sync: an inactive domain is never local (MA10) and leaves the directory when deactivated', async () => {
  const { fake, driver } = setup();
  const st = baseState();
  // Unverified domain claimed by a tenant, with a mailbox and an alias (mail-core marks them off).
  st.domains.push({ id: 3, accountId: 8, name: 'gmail.com', active: false, catchAll: 'gm@gmail.com', maxMessageSizeMb: 50 });
  st.mailboxes.push(mailbox(6, 'gm@gmail.com', contactHash, { domainId: 3, loginEnabled: false, sendEnabled: false, receiveEnabled: false }));
  st.aliases.push({ id: 12, accountId: 8, domainId: 3, address: 'all@gmail.com', targets: ['contact@exemple.fr'] });
  // An alias of an active domain pointing at the inactive-domain mailbox only.
  st.aliases.push({ id: 13, accountId: 7, domainId: 1, address: 'vers-gm@exemple.fr', targets: ['gm@gmail.com'] });
  const r = await driver.sync(st, { reason: 'test' });
  assert.deepEqual(r.domainErrors, {});
  assert.equal(r.domains, 2, 'active domains only');
  assert.equal(fake.principals.has('gmail.com'), false, 'no domain principal for an unverified domain');
  const gm = fake.principals.get('gm@gmail.com')!;
  assert.deepEqual(gm.emails, [], 'no address served');
  assert.deepEqual(gm.secrets, []);
  assert.deepEqual([...gm.disabledPermissions].sort(), ['authenticate', 'email-receive', 'email-send', 'jmap-email-submission-set']);
  assert.equal(fake.principals.has('oblimint-alias-12'), false);
  assert.equal(fake.principals.has('oblimint-alias-13'), false, 'no target left');
  assert.equal(fake.principals.has('oblimint-catchall-3'), false);
  assert.ok(![...fake.principals.values()].some((p) => p.emails.some((e) => e.endsWith('@gmail.com'))));

  // Deactivating autre.fr (ownership lost): domain principal removed, mailboxes kept without address.
  const off = baseState();
  off.domains[1] = { ...off.domains[1], active: false };
  off.mailboxes = off.mailboxes.map((m) => (m.domain === 'autre.fr' ? { ...m, loginEnabled: false, sendEnabled: false, receiveEnabled: false } : m));
  const r2 = await driver.sync(off, { reason: 'test' });
  assert.deepEqual(r2.domainErrors, {});
  assert.equal(fake.principals.has('autre.fr'), false, 'no longer local');
  assert.ok(fake.principals.has('exemple.fr'));
  for (const n of ['blf@autre.fr', 'ssha@autre.fr', 'sha256@autre.fr']) {
    const p = fake.principals.get(n)!;
    assert.ok(p, `${n} kept (data)`);
    assert.deepEqual(p.emails, []);
    assert.deepEqual(p.secrets, []);
  }
  assert.equal(fake.principals.has('oblimint-catchall-2'), false);
  const n = fake.calls.length;
  assert.equal((await driver.sync(off, { reason: 'test' })).changed, false, 'settles');
  assert.equal(fake.calls.slice(n).filter((c) => c.method !== 'GET').length, 0);

  // Reactivated: domain recreated, addresses and secrets back.
  const back = await driver.sync(baseState(), { reason: 'test' });
  assert.deepEqual(back.domainErrors, {});
  assert.equal(fake.principals.get('autre.fr')?.type, 'domain');
  assert.deepEqual(fake.principals.get('blf@autre.fr')!.emails, ['blf@autre.fr']);
  assert.deepEqual(fake.principals.get('blf@autre.fr')!.secrets, [blf.replace('{BLF-CRYPT}', '')]);
  assert.deepEqual(fake.principals.get('oblimint-catchall-2')!.emails, ['@autre.fr']);

  // A principal the panel does not manage still using a domain keeps it.
  fake.seed({ name: 'postmaster', type: 'individual', emails: ['pm@autre.fr'] });
  await driver.sync(off, { reason: 'test' });
  assert.ok(fake.principals.has('autre.fr'), 'kept: unmanaged principal uses it');
});

test('stalwart sync: a failed or rejected reload is retried on the next pass', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  const st = baseState();
  st.relay = { ...st.relay, relayAddresses: ['172.30.0.9'] };

  fake.failOn = (c) => (c.path === '/api/reload' ? 'internal' : null);
  await assert.rejects(driver.sync(st, { reason: 'test' }), (e: unknown) => e instanceof MailDriverError && e.code === 'applyFailed');
  fake.failOn = null;
  fake.reloadErrors = { 'session.rcpt.relay': 'invalid expression' };
  await assert.rejects(driver.sync(st, { reason: 'test' }), (e: unknown) =>
    e instanceof MailDriverError && e.code === 'applyFailed' && /configuration rejected/.test(`${e.message} ${e.detail}`));
  fake.reloadErrors = null;
  const reloadsBefore = fake.reloads;
  const r = await driver.sync(st, { reason: 'test' });
  assert.equal(fake.reloads, reloadsBefore + 1, 'files unchanged, reload retried anyway');
  assert.equal(r.changed, true);
  const after = fake.reloads;
  assert.equal((await driver.sync(st, { reason: 'test' })).changed, false);
  assert.equal(fake.reloads, after, 'accepted: no more reload');

  // A failed certificate reload also forces the next sync to reload.
  fake.failOn = (c) => (c.path === '/api/reload' ? 'internal' : null);
  await assert.rejects(driver.reloadTls(), MailDriverError);
  fake.failOn = null;
  const before = fake.reloads;
  await driver.sync(st, { reason: 'test' });
  assert.equal(fake.reloads, before + 1);
});

test('stalwart sync: a configuration change restarts the engine; a failed restart is retried on the next pass', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  assert.equal(fake.restarts, 1);
  const st = baseState();
  st.settings = { ...st.settings, spamTagScore: 5 };
  fake.restartError = 'container is restarting';
  await assert.rejects(driver.sync(st, { reason: 'test' }), (e: unknown) =>
    e instanceof MailDriverError && e.code === 'applyFailed' && /could not be restarted/.test(e.message) && /container is restarting/.test(e.detail ?? ''));
  fake.restartError = null;
  assert.equal((await driver.sync(st, { reason: 'test' })).changed, true);
  assert.equal(fake.restarts, 2, 'files already written, restart retried');
  assert.equal((await driver.sync(st, { reason: 'test' })).changed, false);
  assert.equal(fake.restarts, 2);
  // A principal-only change (new mailbox) needs no restart.
  const st2 = baseState();
  st2.settings = st.settings;
  st2.mailboxes = st2.mailboxes.map((m) => ({ ...m, quotaMb: (m.quotaMb ?? 100) + 1 }));
  await driver.sync(st2, { reason: 'test' });
  assert.equal(fake.restarts, 2);
});

test('stalwart sync: the site relay appearing or changing address is live — no restart (fresh install order)', async () => {
  const { fake, driver, dirs } = setup();
  // Fresh install: the engine's first syncs run before oblimint-mail-relay exists.
  const first = baseState();
  first.relay = { ...first.relay, relayAddresses: [] };
  await driver.sync(first, { reason: 'setup' });
  assert.equal(fake.restarts, 1);
  const toml = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  assert.equal(fake.settings.get('session.rcpt.relay.0001.else'), 'false', 'nobody relays through 10025 yet');
  const reloads = fake.reloads;
  // The relay joins the mail network, then is recreated with another address.
  for (const [i, ip] of ['172.30.0.5', '172.30.0.9'].entries()) {
    const st = baseState();
    st.relay = { ...st.relay, relayAddresses: [ip] };
    const r = await driver.sync(st, { reason: 'relay' });
    assert.equal(r.changed, true);
    assert.equal(fake.restarts, 1, `${ip}: no restart`);
    assert.equal(fake.reloads, reloads + i + 1, `${ip}: one live reload`);
    assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), toml, `${ip}: config.toml untouched`);
    assert.equal(fake.settings.get('session.rcpt.relay.0001.if'), `local_port == 10025 && (remote_ip == '${ip}')`);
    assert.ok((fake.settings.get('auth.spf.verify.mail-from.0000.if') ?? '').includes(`!(remote_ip == '${ip}')`), `${ip}: SPF skipped for the relay only`);
    assert.ok((fake.settings.get('auth.dmarc.verify.0000.if') ?? '').includes(`'${ip}'`), `${ip}: DMARC`);
  }
});

test('stalwart sync: a relay expression missing from the engine store is written back (no restart)', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  // An engine whose store lacks the relay expression (e.g. an upgrade from a version where it was a local key).
  for (const k of [...fake.settings.keys()]) if (k.startsWith('session.rcpt.relay')) fake.settings.delete(k);
  const r = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(r.changed, true);
  assert.equal(fake.settings.get('session.rcpt.relay.0000.if'), '!is_empty(authenticated_as)');
  assert.equal(fake.restarts, 1);
});

test('stalwart sync: an unverifiable hash only blocks its own mailbox', async () => {
  const { fake, driver } = setup();
  const st = baseState();
  const x2 = `{BLF-CRYPT}$2x$10$${'a'.repeat(53)}`;
  st.mailboxes[2] = { ...st.mailboxes[2], passwordHash: x2 };
  st.mailboxes[0] = { ...st.mailboxes[0], passwordHash: '{PLAIN}cleartext-secret' };
  const r = await driver.sync(st, { reason: 'test' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.domainErrors).sort(), ['autre.fr', 'exemple.fr']);
  for (const msg of Object.values(r.domainErrors)) assert.ok(!msg.includes('cleartext-secret') && !msg.includes('$2x$'), 'no hash in the error');
  assert.deepEqual(fake.principals.get('blf@autre.fr')!.secrets, [], 'no login for that mailbox');
  assert.deepEqual(fake.principals.get('blf@autre.fr')!.emails, ['blf@autre.fr'], 'still receives');
  assert.deepEqual(fake.principals.get('contact@exemple.fr')!.secrets, [], 'not even the app password');
  assert.equal(fake.principals.get('ssha@autre.fr')!.secrets.length, 1, 'others applied');
  assert.ok(fake.sieve.get('contact@exemple.fr')?.get('oblimint'), 'sieve still applied');
  // Fixed hash: login restored.
  const ok = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(ok.ok, true);
  assert.deepEqual(fake.principals.get('blf@autre.fr')!.secrets, [blf.replace('{BLF-CRYPT}', '')]);
});

test('stalwart sync: forwarding / autoresponder changes apply to a login-disabled mailbox', async () => {
  const { fake, driver } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  assert.ok(fake.sieve.get('contact@exemple.fr')!.get('oblimint'));
  // Account suspended for abuse, staff removes the forward and the autoresponder.
  const st = baseState();
  st.mailboxes[0] = { ...st.mailboxes[0], loginEnabled: false, sendEnabled: false, forward: null, autoresponder: null };
  st.appPasswords = [];
  const r = await driver.sync(st, { reason: 'test' });
  assert.deepEqual(r.domainErrors, {});
  assert.equal(fake.sieve.get('contact@exemple.fr')!.size, 0, 'stale script removed');
  const contact = fake.principals.get('contact@exemple.fr')!;
  assert.deepEqual(contact.secrets, []);
  assert.ok(contact.disabledPermissions.includes('authenticate'), 'login disabled again');
  // And a new forward set while suspended is installed too.
  st.mailboxes[0] = { ...st.mailboxes[0], forward: { targets: ['abuse@exemple.fr'], keepCopy: true } };
  await driver.sync(st, { reason: 'test' });
  assert.match(fake.sieve.get('contact@exemple.fr')!.get('oblimint')!.content, /abuse@exemple\.fr/);
  assert.ok(fake.principals.get('contact@exemple.fr')!.disabledPermissions.includes('authenticate'));
  const n = fake.calls.length;
  assert.equal((await driver.sync(st, { reason: 'test' })).changed, false);
  assert.equal(fake.calls.slice(n).filter((c) => c.method !== 'GET').length, 0);
});

test('stalwart driver: deployment and removal failures are MailDriverError', async () => {
  const { driver } = setup();
  await assert.rejects(driver.ensure(() => undefined), (e: unknown) => e instanceof MailDriverError && e.code === 'applyFailed' && /no docker/.test(e.detail ?? ''));
  await assert.rejects(driver.remove(() => undefined), (e: unknown) => e instanceof MailDriverError && e.code === 'applyFailed');
});

test('stalwart sync (report P4): mailbox create / delete, send toggle, password, quota, alias, forward are live — no restart; /api/reload only after a revocation', async () => {
  const { fake, driver, dirs } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  assert.equal(fake.restarts, 1);
  const tomlBefore = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  const limiters = () => [...fake.settings].filter(([k]) => k.startsWith('queue.limiter.inbound.oblimint-')).map(([k, v]) => `${k}=${v}`).join('\n');
  assert.match(limiters(), /ends_with\(authenticated_as, '@exemple\.fr'\)/, 'limits per domain, not per mailbox');
  assert.ok(!/authenticated_as == /.test(limiters()));
  assert.ok(!tomlBefore.includes('queue.limiter'), 'no limiter in config.toml');
  const limitersBefore = limiters();
  const reloads = () => fake.calls.filter((c) => c.path.startsWith('/api/reload')).length;
  let reloadsBefore = reloads();

  // A revocation (permission disabled, address / mailbox removed) is followed by ONE
  // /api/reload: Stalwart caches positive directory lookups (stale RCPT 250 otherwise).
  const live = async (what: string, st: MailDesiredState, check: () => void, revokes = false) => {
    const calls = fake.calls.length;
    const r = await driver.sync(st, { reason: what });
    assert.equal(r.ok, true, `${what}: ${JSON.stringify(r.domainErrors)}`);
    assert.equal(r.changed, true, `${what}: applied`);
    assert.equal(fake.restarts, 1, `${what}: no restart`);
    assert.equal(reloads(), reloadsBefore + (revokes ? 1 : 0), `${what}: ${revokes ? 'one /api/reload (lookup cache)' : 'no /api/reload'}`);
    reloadsBefore = reloads();
    assert.ok(fake.calls.slice(calls).some((c) => c.method !== 'GET'), `${what}: through the admin API`);
    assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), tomlBefore, `${what}: config.toml untouched`);
    assert.equal(limiters(), limitersBefore, `${what}: same account, same limiters`);
    check();
  };

  // Create a mailbox (same account: its limit is already loaded).
  let st = baseState();
  st.mailboxes.push(mailbox(9, 'nouveau@autre.fr', contactHash));
  await live('create', st, () => assert.equal(fake.principals.get('nouveau@autre.fr')?.type, 'individual'));
  // Send toggle = the email-send permission of the principal.
  st = baseState();
  st.mailboxes.push(mailbox(9, 'nouveau@autre.fr', contactHash, { sendEnabled: false }));
  await live('send off', st, () => assert.deepEqual([...fake.principals.get('nouveau@autre.fr')!.disabledPermissions].sort(), ['email-send', 'jmap-email-submission-set']), true);
  st.mailboxes[st.mailboxes.length - 1] = mailbox(9, 'nouveau@autre.fr', contactHash);
  await live('send on', st, () => assert.deepEqual(fake.principals.get('nouveau@autre.fr')!.disabledPermissions, []));
  // Password + quota.
  st.mailboxes[st.mailboxes.length - 1] = mailbox(9, 'nouveau@autre.fr', md5, { quotaMb: 2048 });
  await live('password + quota', st, () => {
    assert.deepEqual(fake.principals.get('nouveau@autre.fr')!.secrets, [md5.replace('{MD5-CRYPT}', '')]);
    assert.equal(fake.principals.get('nouveau@autre.fr')!.quota, 2048 * 1048576);
  });
  // Alias (list) + forwarding (sieve through JMAP).
  st.aliases.push({ id: 12, accountId: 7, domainId: 2, address: 'equipe@autre.fr', targets: ['nouveau@autre.fr', 'contact@exemple.fr'] });
  st.mailboxes[st.mailboxes.length - 1] = mailbox(9, 'nouveau@autre.fr', md5, { quotaMb: 2048, forward: { targets: ['x@gmail.com'], keepCopy: true } });
  await live('alias + forward', st, () => {
    assert.deepEqual(fake.principals.get('oblimint-alias-12')!.members, ['contact@exemple.fr', 'nouveau@autre.fr']);
    assert.match(fake.sieve.get('nouveau@autre.fr')!.get('oblimint')!.content, /redirect :copy "x@gmail\.com";/);
  });
  // Delete (detach: login / delivery removed, data kept until purge).
  await live('delete', baseState(), () => {
    const p = fake.principals.get('nouveau@autre.fr')!;
    assert.deepEqual(p.emails, []);
    assert.ok(p.disabledPermissions.includes('authenticate'));
  }, true);
  // Nothing left to do: no write, no reload.
  const r = await driver.sync(baseState(), { reason: 'idempotent' });
  assert.equal(r.changed, false);
  assert.equal(reloads(), reloadsBefore, 'idempotent: no /api/reload');
});

test('stalwart sync: a failed reload after a revocation is retried on the next pass (stale lookup cache)', async () => {
  const { fake, driver } = setup();
  const st = baseState();
  st.mailboxes.push(mailbox(9, 'carol@autre.fr', contactHash));
  await driver.sync(st, { reason: 'test' });
  const reloads = () => fake.calls.filter((c) => c.path.startsWith('/api/reload')).length;
  const r0 = reloads();
  // The mailbox is deleted, but the reload that drops the cached RCPT lookup fails.
  fake.failOn = (c) => (c.path === '/api/reload' ? 'internal' : null);
  await assert.rejects(driver.sync(baseState(), { reason: 'carol deleted' }), (e: unknown) =>
    e instanceof MailDriverError && /after a revocation/.test(e.message));
  assert.deepEqual(fake.principals.get('carol@autre.fr')!.emails, [], 'address released before the reload');
  fake.failOn = null;
  // Nothing left to write, yet the reload is still due.
  await driver.sync(baseState(), { reason: 'retry' });
  assert.equal(reloads(), r0 + 2, 'reload retried');
  await driver.sync(baseState(), { reason: 'again' });
  assert.equal(reloads(), r0 + 2, 'accepted: no more reload');
});

test('stalwart sync (report P4): the FIRST mailbox of a fresh install never restarts the engine — its limiter is live', async () => {
  // Regression (the Linux test host P4b): the limiters lived in config.toml, so the first limited
  // mailbox (nothing loaded yet) rewrote the file and restarted Stalwart.
  const { fake, driver, dirs } = setup();
  // Stalwart's own default limiters (written at its first boot) are never touched by the panel.
  fake.settings.set('queue.limiter.inbound.ip.rate', '5/1s');
  fake.settings.set('queue.limiter.inbound.sender.rate', '25/1h');
  const st = baseState();
  st.mailboxes = [];
  st.aliases = [];
  st.appPasswords = [];
  st.dkim = [];
  st.domains = [{ id: 1, accountId: 7, name: 'exemple.fr', active: true, catchAll: null, maxMessageSizeMb: 50 }];
  await driver.sync(st, { reason: 'fresh install, first domain' });
  assert.equal(fake.restarts, 1, 'the first sync loads the panel\'s config.toml');
  const limiters = () => Object.fromEntries([...fake.settings].filter(([k]) => k.startsWith('queue.limiter.inbound.oblimint-')));
  assert.deepEqual(limiters(), {}, 'no mailbox: no limit yet');
  const toml = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  const reloads = () => fake.calls.filter((c) => c.path.startsWith('/api/reload')).length;
  const r0 = reloads();

  st.mailboxes.push({ ...mailbox(1, 'carol@exemple.fr', contactHash), sendPerHour: 100 });
  const r = await driver.sync(st, { reason: 'first mailbox' });
  assert.equal(r.ok, true);
  assert.equal(fake.restarts, 1, 'first mailbox: NO restart');
  assert.equal(reloads(), r0 + 1, 'its limiter applied by one /api/reload');
  assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), toml, 'config.toml untouched');
  assert.deepEqual(limiters(), {
    'queue.limiter.inbound.oblimint-rate-100-0.enable': 'true',
    'queue.limiter.inbound.oblimint-rate-100-0.key.0000': 'authenticated_as',
    'queue.limiter.inbound.oblimint-rate-100-0.match': "ends_with(authenticated_as, '@exemple.fr')",
    'queue.limiter.inbound.oblimint-rate-100-0.rate': '100/1h',
    'queue.limiter.inbound.oblimint-rate-default.enable': 'true',
    'queue.limiter.inbound.oblimint-rate-default.key.0000': 'authenticated_as',
    'queue.limiter.inbound.oblimint-rate-default.match': "!is_empty(authenticated_as) && !(ends_with(authenticated_as, '@exemple.fr'))",
    'queue.limiter.inbound.oblimint-rate-default.rate': '100/1h',
  }, 'MA9 enforced at once (exact rate, not a bounded catch-up)');
  assert.ok(fake.principals.get('carol@exemple.fr'), 'mailbox created');
  // Settings written BEFORE the principal: the mailbox never exists without its limit.
  const settingsWrite = fake.calls.findIndex((c) => c.method === 'POST' && c.path === '/api/settings' && JSON.stringify(c.body ?? '').includes('oblimint-rate-100'));
  const principalWrite = fake.calls.findIndex((c) => c.method === 'POST' && c.path === '/api/principal' && JSON.stringify(c.body ?? '').includes('carol@exemple.fr'));
  assert.ok(settingsWrite >= 0 && principalWrite > settingsWrite, 'limiter stored before the mailbox is created');
  assert.equal(fake.settings.get('queue.limiter.inbound.ip.rate'), '5/1s', "Stalwart's own limiters kept");
  assert.equal(fake.settings.get('queue.limiter.inbound.sender.rate'), '25/1h');

  // A second mailbox of the same account: no limiter change, no reload.
  st.mailboxes.push({ ...mailbox(2, 'dave@exemple.fr', contactHash), sendPerHour: 100 });
  await driver.sync(st, { reason: 'second mailbox' });
  assert.equal(fake.restarts, 1);
  assert.equal(reloads(), r0 + 1);
  // A new account (second domain + first mailbox, looser plan) and a plan downgrade: exact, live, never a restart.
  st.domains.push({ id: 3, accountId: 8, name: 'client2.fr', active: true, catchAll: null, maxMessageSizeMb: 50 });
  st.mailboxes.push({ ...mailbox(20, 'a@client2.fr', contactHash), accountId: 8, domainId: 3, sendPerHour: 500 });
  await driver.sync(st, { reason: 'new account' });
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-500-0.match'), "ends_with(authenticated_as, '@client2.fr')");
  for (const m of st.mailboxes) if (m.accountId === 7) m.sendPerHour = 50;
  await driver.sync(st, { reason: 'downgrade' });
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-50-0.rate'), '50/1h');
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-100-0.rate'), undefined, 'old rate removed');
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-default.rate'), '50/1h');
  // Last mailbox of every account deleted: limiters removed, still live.
  st.mailboxes = [];
  await driver.sync(st, { reason: 'all deleted', allowMassRemoval: true });
  assert.deepEqual(limiters(), {});
  assert.equal(fake.restarts, 1, 'no restart at any step');
  assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), toml);
  // Idempotent.
  const r1 = reloads();
  assert.equal((await driver.sync(st, { reason: 'again' })).changed, false);
  assert.equal(reloads(), r1);
});

test('stalwart sync: upgrade from limiters in config.toml (old bookkeeping) — one structural restart, limiters moved to the store', async () => {
  const { fake, driver, dirs } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  assert.equal(fake.restarts, 1);
  // Older panel: limiters were local keys of the file, the store holds none, the bookkeeping has appliedLimits.
  const stateFile = 'oblimint-sync.json';
  const old = JSON.parse(fs.readFileSync(path.join(dirs.config, stateFile), 'utf8'));
  fs.writeFileSync(path.join(dirs.config, stateFile), JSON.stringify({ ...old, appliedConfig: 'old-fingerprint', appliedLimits: { byDomain: { 'exemple.fr': 200 }, fallback: 200 }, limitsStaleSince: null }));
  for (const k of [...fake.settings.keys()]) if (k.startsWith('queue.limiter.inbound.oblimint-')) fake.settings.delete(k);
  await driver.sync(baseState(), { reason: 'upgrade' });
  assert.equal(fake.restarts, 2, 'the file changed: one restart');
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-200-0.rate'), '200/1h');
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.config, stateFile), 'utf8'));
  assert.equal('appliedLimits' in saved || 'limitsStaleSince' in saved, false, 'obsolete bookkeeping dropped');
  await driver.sync(baseState(), { reason: 'again' });
  assert.equal(fake.restarts, 2);
});

test('stalwart sync (report P4): a structural change restarts; domains, DKIM keys and sizes are live', async () => {
  const { fake, driver, dirs } = setup();
  await driver.sync(baseState(), { reason: 'test' });
  assert.equal(fake.restarts, 1);
  let st = baseState();
  st.domains.push({ id: 3, accountId: 8, name: 'client2.fr', active: true, catchAll: null, maxMessageSizeMb: 50 });
  await driver.sync(st, { reason: 'domain' });
  assert.equal(fake.restarts, 1, 'a domain without DKIM key nor specific size is a principal only: live');
  assert.equal(fake.principals.get('client2.fr')?.type, 'domain');
  st.mailboxes.push({ ...mailbox(20, 'a@client2.fr', contactHash), accountId: 8, domainId: 3, sendPerHour: 500 });
  await driver.sync(st, { reason: 'first mailbox of a new account' });
  assert.equal(fake.restarts, 1, 'its limiter is live');
  // A structural change (platform setting rendered into config.toml): restart.
  st = JSON.parse(JSON.stringify(st)) as MailDesiredState;
  st.settings.spamRejectScore = 12;
  await driver.sync(st, { reason: 'spam score' });
  assert.equal(fake.restarts, 2);
  assert.match(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), /reject = 12\.0/);
  // Then idempotent.
  await driver.sync(st, { reason: 'again' });
  assert.equal(fake.restarts, 2);
  // The new domain's DKIM key and a smaller message size (report P4, §19): live — settings replaced in the
  // engine's store + one /api/reload, NO restart, config.toml unchanged.
  const reloads = () => fake.calls.filter((c) => c.path.startsWith('/api/reload')).length;
  const r0 = reloads();
  const tomlBefore = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8');
  st.dkim.push({ ...st.dkim[0], domain: 'client2.fr', selector: 'om202612' });
  st.domains[2].maxMessageSizeMb = 10;
  await driver.sync(st, { reason: 'dkim' });
  assert.equal(fake.restarts, 2, 'a DKIM key / domain size never restarts the engine');
  assert.equal(reloads(), r0 + 1, 'applied by one reload');
  assert.equal(fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8'), tomlBefore);
  assert.ok([...fake.settings].some(([k, v]) => /^signature\.[^.]+\.domain$/.test(k) && v === 'client2.fr'));
  assert.ok([...fake.settings.values()].includes("rcpt_domain == 'client2.fr'"));
  assert.ok([...fake.settings.values()].includes("sender_domain == 'client2.fr'"), 'its bounces are signed with its own key');
  // Idempotent: nothing written, no reload.
  const w0 = fake.writes().length;
  await driver.sync(st, { reason: 'again' });
  assert.equal(fake.writes().length, w0);
  // A rejected reload of the settings is retried on the next pass even though the store already holds them.
  st.dkim = st.dkim.filter((k) => k.domain !== 'client2.fr');
  fake.reloadErrors = { 'signature.x.private-key': 'Failed to build RSA key' };
  await assert.rejects(driver.sync(st, { reason: 'dkim removed' }), (e: unknown) => e instanceof MailDriverError && /domain settings/.test(e.message));
  fake.reloadErrors = null;
  const r1 = reloads();
  await driver.sync(st, { reason: 'retry' });
  assert.equal(reloads(), r1 + 1, 'pending settings reloaded');
  await driver.sync(st, { reason: 'again' });
  assert.equal(reloads(), r1 + 1, 'accepted: no more reload');
  assert.ok(![...fake.settings.values()].includes('client2.fr'), 'the removed key is gone from the store');
  assert.equal(fake.restarts, 2);
  // A store that lost the settings (wiped / restored engine data) gets them back.
  for (const k of [...fake.settings.keys()]) if (k.startsWith('signature.') || k.startsWith('queue.limiter.inbound.oblimint-')) fake.settings.delete(k);
  await driver.sync(st, { reason: 'healed' });
  assert.ok([...fake.settings].some(([k, v]) => /^signature\.[^.]+\.domain$/.test(k) && v === 'exemple.fr'));
  assert.equal(fake.settings.get('queue.limiter.inbound.oblimint-rate-500-0.rate'), '500/1h');
  assert.equal(fake.restarts, 2);
});

test('certGid: the engine group reads its certificate copies (mail-dns-tls), root only without owner', () => {
  const base = { credentials: async () => creds, api: (c: typeof creds) => new StalwartApi({ user: 'oblimint-admin', secret: c.secret }), docker: async () => { throw new Error('no docker'); }, ensureNetwork: async () => undefined, hostname: async () => 'mail.host.net', configDir: 'c', dataDir: 'd', certsDir: 'x', certRoots: ['x'], hostDataDir: '/srv/oblimint', bindAddresses: [] };
  assert.equal(createStalwartDriver({ ...base, owner: { uid: STALWART_UID, gid: STALWART_GID } }).certGid, STALWART_GID);
  assert.equal(createStalwartDriver({ ...base, owner: null }).certGid, null);
});
