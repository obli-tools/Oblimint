import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_LIMITS, type PlanLimits } from '@oblimint/shared';
import { buildDesiredState, clamdAddressFor, requiredPart, type DesiredDomainSource, type DesiredStateInput } from './desiredState';
import { summarizeMailComponents } from './infra';
import {
  assertAliasCount, assertDomainMessageSize, assertMailboxCount, assertMailboxQuota, assertTenantMailboxRoom, defaultMailboxQuotaMb,
  effectiveMessageSizeMb, mailAccountLimits,
} from './limits';
import { accountServesMail, autoresponderActive, mailClientSettings, mailDomainStatus, toMailbox, toMailDomain } from './mappers';
import { mailAccountFingerprint } from './reconcileHook';
import type { MailAliasRow, MailboxRow } from './rows';
import { quotaWarningAction } from './usage';
import {
  assertAutoresponderSchedule, assertLocalPartAllowed, assertTargetsExist, findForwardingLoop, isReservedLocalPart,
} from './validation';

// Pure rules of mail-core (docs/P4-PLAN.md §9.1): validation, plan limits,
// mappers / status, desired state, infra summary, usage warnings.

const code = (c: string) => (err: unknown) => (err as { code?: string }).code === c;
const dim = (d: string) => (err: unknown) => (err as { code?: string; details?: { dimension?: string } }).code === 'planLimit'
  && (err as { details?: { dimension?: string } }).details?.dimension === d;

const plan = (over: Partial<PlanLimits> = {}): PlanLimits => ({ ...DEFAULT_PLAN_LIMITS, ...over });

// ── validation ───────────────────────────────────────────────────────────────

test('reserved local parts: mailer-daemon, root, oblimint* — postmaster / abuse allowed', () => {
  for (const lp of ['mailer-daemon', 'root', 'oblimint', 'oblimint-relay', 'OBLIMINTx']) {
    assert.ok(isReservedLocalPart(lp), lp);
    assert.throws(() => assertLocalPartAllowed(lp), code('invalidAddress'));
  }
  for (const lp of ['postmaster', 'abuse', 'contact', 'roots', 'my-oblimint']) assert.doesNotThrow(() => assertLocalPartAllowed(lp), lp);
});

test('forwarding loops: direct, through an alias, through another mailbox; none for chains', () => {
  const graph = new Map<string, string[]>([
    ['info@a.fr', ['contact@a.fr']],
    ['sales@a.fr', ['info@a.fr', 'boss@gmail.com']],
    ['other@a.fr', ['x@ext.org']],
  ]);
  assert.deepEqual(findForwardingLoop('contact@a.fr', ['contact@a.fr'], graph), ['contact@a.fr', 'contact@a.fr']);
  assert.deepEqual(findForwardingLoop('contact@a.fr', ['info@a.fr'], graph), ['contact@a.fr', 'info@a.fr', 'contact@a.fr']);
  assert.deepEqual(findForwardingLoop('contact@a.fr', ['sales@a.fr'], graph), ['contact@a.fr', 'sales@a.fr', 'info@a.fr', 'contact@a.fr']);
  assert.equal(findForwardingLoop('contact@a.fr', ['other@a.fr', 'me@gmail.com'], graph), null);
  // The edited node's OLD targets are ignored (replaced by the new ones).
  const g2 = new Map<string, string[]>([['a@x.fr', ['b@x.fr']], ['b@x.fr', ['a@x.fr']]]);
  assert.equal(findForwardingLoop('a@x.fr', ['c@ext.org'], g2), null);
  // Cycles not involving the start terminate.
  const g3 = new Map<string, string[]>([['b@x.fr', ['c@x.fr']], ['c@x.fr', ['b@x.fr']]]);
  assert.equal(findForwardingLoop('a@x.fr', ['b@x.fr'], g3), null);
});

test('internal targets must exist in the account own domains; other domains are not checked', () => {
  const ctx = { ownDomains: new Set(['a.fr']), existing: new Set(['contact@a.fr']) };
  assert.doesNotThrow(() => assertTargetsExist(['contact@a.fr', 'x@gmail.com', 'y@other-customer.fr'], ctx));
  assert.throws(() => assertTargetsExist(['nobody@a.fr'], ctx), code('invalidTarget'));
});

test('autoresponder schedule: endsAt > startsAt', () => {
  assert.doesNotThrow(() => assertAutoresponderSchedule(null, '2026-01-01T00:00:00Z'));
  assert.doesNotThrow(() => assertAutoresponderSchedule('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'));
  assert.throws(() => assertAutoresponderSchedule('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'), code('invalidSchedule'));
  assert.throws(() => assertAutoresponderSchedule('2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z'), code('invalidSchedule'));
});

// ── limits ───────────────────────────────────────────────────────────────────

test('mailbox count, alias count, tenant envelope', () => {
  assert.doesNotThrow(() => assertMailboxCount(plan({ maxMailboxes: 2 }), 1));
  assert.throws(() => assertMailboxCount(plan({ maxMailboxes: 2 }), 2), dim('mailboxes'));
  assert.doesNotThrow(() => assertMailboxCount(plan({ maxMailboxes: null }), 10_000));
  assert.throws(() => assertMailboxCount(plan({ maxMailboxes: 0 }), 0), dim('mailboxes'));
  assert.throws(() => assertAliasCount(plan({ maxMailAliases: 1 }), 1), dim('aliases'));
  assert.doesNotThrow(() => assertAliasCount(plan({ maxMailAliases: null }), 99));
  assert.throws(() => assertTenantMailboxRoom({ maxMailboxes: 3, allowOversell: false }, 3), code('envelopeExceeded'));
  assert.doesNotThrow(() => assertTenantMailboxRoom({ maxMailboxes: 3, allowOversell: true }, 3));
  assert.doesNotThrow(() => assertTenantMailboxRoom({ maxMailboxes: null, allowOversell: false }, 3));
});

test('mailbox quotas: per mailbox, account total, unlimited refused when bounded', () => {
  const p = plan({ mailQuotaMb: 3000, mailboxQuotaMaxMb: 2048 });
  assert.doesNotThrow(() => assertMailboxQuota(p, 1024, 1024));
  assert.throws(() => assertMailboxQuota(p, 4096, 0), dim('mailboxQuota'));
  assert.throws(() => assertMailboxQuota(p, 2048, 1024), dim('mailQuota'));
  assert.throws(() => assertMailboxQuota(p, null, 0), dim('mailboxQuota'));
  assert.throws(() => assertMailboxQuota(plan({ mailQuotaMb: 3000, mailboxQuotaMaxMb: null }), null, 0), dim('mailQuota'));
  assert.doesNotThrow(() => assertMailboxQuota(plan({ mailQuotaMb: null, mailboxQuotaMaxMb: null }), null, 99_999));
});

test('default quota: setting capped by the plan and by what is left', () => {
  assert.equal(defaultMailboxQuotaMb(1024, plan({ mailboxQuotaMaxMb: 512 }), 0), 512);
  assert.equal(defaultMailboxQuotaMb(1024, plan({ mailQuotaMb: 1500, mailboxQuotaMaxMb: 2048 }), 1000), 500);
  // Nothing left: the default stays (assertMailboxQuota reports mailQuota).
  assert.equal(defaultMailboxQuotaMb(1024, plan({ mailQuotaMb: 1000, mailboxQuotaMaxMb: 2048 }), 1000), 1024);
  assert.equal(defaultMailboxQuotaMb(1024, plan({ mailQuotaMb: null, mailboxQuotaMaxMb: null }), 0), 1024);
});

test('message size: min(domain, plan, platform); domain above plan refused', () => {
  assert.equal(effectiveMessageSizeMb(null, { mailMaxMessageSizeMb: 25 }, 50), 25);
  assert.equal(effectiveMessageSizeMb(10, { mailMaxMessageSizeMb: 25 }, 50), 10);
  assert.equal(effectiveMessageSizeMb(null, { mailMaxMessageSizeMb: 80 }, 50), 50);
  assert.throws(() => assertDomainMessageSize(30, { mailMaxMessageSizeMb: 25 }), dim('messageSize'));
  assert.doesNotThrow(() => assertDomainMessageSize(null, { mailMaxMessageSizeMb: 25 }));
  assert.equal(mailAccountLimits(plan({ mailMaxMessageSizeMb: 80 }), 50).maxMessageSizeMb, 50);
});

// ── mappers / status ─────────────────────────────────────────────────────────

test('mail domain status: pending (D1) → disabled → suspended → error → active', () => {
  const ok = { enabled: true, sync_error: null };
  assert.equal(mailDomainStatus(ok, { verified: false, accountStatus: 'active' }).status, 'pending');
  assert.equal(mailDomainStatus({ ...ok, enabled: false }, { verified: true, accountStatus: 'active' }).status, 'disabled');
  assert.equal(mailDomainStatus(ok, { verified: true, accountStatus: 'suspended' }).status, 'suspended');
  assert.equal(mailDomainStatus(ok, { verified: true, accountStatus: 'deleting' }).status, 'suspended');
  const err = mailDomainStatus({ ...ok, sync_error: 'postmap: /srv/oblimint/mail/x failed' }, { verified: true, accountStatus: 'active' });
  assert.equal(err.status, 'error');
  assert.equal(mailDomainStatus(ok, { verified: true, accountStatus: 'error' }).status, 'active', 'a site container problem keeps mail');
  assert.ok(accountServesMail('provisioning') && !accountServesMail('suspended') && !accountServesMail('deleting'));
});

test('toMailDomain hides the raw engine error from client users (A6)', () => {
  const row = {
    id: 1, tenant_id: 2, account_id: 3, domain_id: 4, name: 'a.fr', enabled: true, catch_all: null, max_message_size_mb: null,
    dns_settings: {}, external_dns: null, dns_check: null, dns_healthy: null, dns_checked_at: null, sync_error: 'doveadm: /srv/x boom',
    used_bytes: '123', created_at: new Date(0), updated_at: new Date(0), account_username: 'acme', account_status: 'active',
    domain_verification_status: 'verified', mailbox_count: '2', alias_count: 1,
  };
  const staff = toMailDomain(row, { dnsManaged: true }, { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' });
  assert.match(staff.statusMessage ?? '', /doveadm/);
  const client = toMailDomain(row, { dnsManaged: true }, { kind: 'client', userId: 1, tenantId: 2, accounts: new Map() });
  assert.equal(client.status, 'error');
  assert.doesNotMatch(client.statusMessage ?? '', /doveadm|srv/);
  const tricky = toMailDomain({ ...row, sync_error: 'apply · stalwart: /opt/stalwart/etc/config.toml : 500 internal' }, { dnsManaged: true },
    { kind: 'client', userId: 1, tenantId: 2, accounts: new Map() });
  assert.equal(tricky.statusMessage, 'Synchronisation du moteur mail en échec', 'fixed label, nothing of the raw cause');
  assert.equal(client.mailboxCount, 2);
  assert.equal(client.usedBytes, 123);
});

const mailboxRow = (over: Partial<MailboxRow> = {}): MailboxRow => ({
  id: 10, tenant_id: 2, account_id: 3, mail_domain_id: 1, local_part: 'contact', address: 'contact@a.fr', display_name: null,
  password_hash: '{SHA512-CRYPT}$6$secret', password_scheme: 'SHA512-CRYPT', password_set_at: null, imported: false, quota_mb: 1024,
  enabled: true, send_enabled: true, receive_enabled: true, forward_targets: [], forward_keep_copy: true, autoresponder: null,
  used_bytes: null, usage_checked_at: null, quota_warned_at: null, created_at: new Date(0), updated_at: new Date(0), ...over,
});

test('toMailbox never carries the password hash (MA4); client settings 993 / 995 / 587', () => {
  const mb = toMailbox({ ...mailboxRow({ forward_targets: ['x@gmail.com'], forward_keep_copy: false }), domain_name: 'a.fr' });
  assert.ok(!JSON.stringify(mb).includes('secret'));
  assert.deepEqual(mb.forwarding, { targets: ['x@gmail.com'], keepCopy: false });
  const cs = mailClientSettings('contact@a.fr', 'mail.host.net', null);
  assert.deepEqual([cs.imap.port, cs.pop3.port, cs.smtp.port, cs.smtp.security], [993, 995, 587, 'starttls']);
  assert.equal(cs.username, 'contact@a.fr');
  const now = new Date('2026-06-01T00:00:00Z');
  assert.ok(autoresponderActive({ enabled: true, startsAt: null, endsAt: null }, now));
  assert.ok(!autoresponderActive({ enabled: true, startsAt: '2026-07-01T00:00:00Z', endsAt: null }, now));
  assert.ok(!autoresponderActive({ enabled: true, startsAt: null, endsAt: '2026-05-01T00:00:00Z' }, now));
});

// ── desired state ────────────────────────────────────────────────────────────

const domain = (over: Partial<DesiredDomainSource> = {}): DesiredDomainSource => ({
  id: 1, account_id: 3, name: 'a.fr', enabled: true, catch_all: null, max_message_size_mb: null, account_status: 'active', verified: true,
  plan: plan({ mailMaxMessageSizeMb: 25, mailOutboundPerHour: 200 }), ...over,
});
const alias = (over: Partial<MailAliasRow> = {}): MailAliasRow => ({
  id: 5, tenant_id: 2, account_id: 3, mail_domain_id: 1, local_part: 'info', address: 'info@a.fr', targets: ['contact@a.fr'],
  enabled: true, comment: null, created_at: new Date(0), updated_at: new Date(0), ...over,
});
const input = (over: Partial<DesiredStateInput> = {}): DesiredStateInput => ({
  now: new Date('2026-06-01T00:00:00Z'),
  hostname: 'mail.host.net',
  settings: { maxMessageSizeMb: 50, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: true },
  domains: [domain()],
  mailboxes: [mailboxRow()],
  aliases: [alias()],
  sendPolicy: new Map(),
  appPasswords: [],
  dkim: [],
  tls: [],
  relay: { relayHost: 'oblimint-mail-relay', relayAddresses: [] },
  ...over,
});

test('desired state: active account serves everything, plan limits applied', () => {
  const s = buildDesiredState(input());
  assert.equal(s.settings.clamdAddress, 'oblimint-scanner:3310');
  assert.equal(s.settings.hostname, 'mail.host.net');
  assert.deepEqual(s.domains.map((d) => [d.name, d.active, d.maxMessageSizeMb]), [['a.fr', true, 25]]);
  const m = s.mailboxes[0];
  assert.deepEqual([m.loginEnabled, m.sendEnabled, m.receiveEnabled, m.sendPerHour, m.quotaMb], [true, true, true, 200, 1024]);
  assert.equal(m.passwordHash, '{SHA512-CRYPT}$6$secret');
  assert.deepEqual(s.aliases.map((a) => a.address), ['info@a.fr']);
  assert.equal(clamdAddressFor(false), null);
});

test('desired state: suspended account keeps inbound only; outbound suspension cuts sending', () => {
  const s = buildDesiredState(input({ domains: [domain({ account_status: 'suspended' })] }));
  assert.equal(s.domains[0].active, true, 'the domain is still served (inbound)');
  const m = s.mailboxes[0];
  assert.deepEqual([m.loginEnabled, m.sendEnabled, m.receiveEnabled], [false, false, true]);
  assert.equal(s.aliases.length, 1, 'aliases still deliver');

  const o = buildDesiredState(input({ sendPolicy: new Map([[3, { accountId: 3, suspended: true, perHour: 50 }]]) }));
  assert.deepEqual([o.mailboxes[0].loginEnabled, o.mailboxes[0].sendEnabled, o.mailboxes[0].sendPerHour], [true, false, 50]);
});

// Pinned choice (§9.1 says "compte active"; architect to confirm): 'provisioning' / 'error' are statuses of the
// account's SITE containers (reconcile pass, failed teardown) — they must not cut every mailbox login. Only
// 'suspended' (inbound kept) and 'deleting' (nothing) stop logins / sending.
test('desired state: account provisioning / error keeps logins and sending (pinned)', () => {
  for (const account_status of ['provisioning', 'error'] as const) {
    const s = buildDesiredState(input({ domains: [domain({ account_status })] }));
    const m = s.mailboxes[0];
    assert.deepEqual([s.domains[0].active, m.loginEnabled, m.sendEnabled, m.receiveEnabled], [true, true, true, true], account_status);
  }
});

test('desired state: D1 unverified / disabled / deleting domain is not served', () => {
  for (const d of [domain({ verified: false }), domain({ enabled: false }), domain({ account_status: 'deleting' })]) {
    const s = buildDesiredState(input({ domains: [d] }));
    assert.equal(s.domains[0].active, false);
    assert.deepEqual([s.mailboxes[0].loginEnabled, s.mailboxes[0].receiveEnabled, s.mailboxes[0].sendEnabled], [false, false, false]);
    assert.equal(s.aliases.length, 0);
  }
});

test('desired state: mailbox flags, forwarding, autoresponder dates, app passwords and DKIM filtering', () => {
  const s = buildDesiredState(input({
    mailboxes: [
      mailboxRow({ id: 10, send_enabled: false, forward_targets: ['x@gmail.com'], forward_keep_copy: false,
        autoresponder: { enabled: true, subject: 'Absent', body: 'b', startsAt: null, endsAt: '2026-05-01T00:00:00Z', intervalDays: 3 } }),
      mailboxRow({ id: 11, address: 'off@a.fr', local_part: 'off', enabled: false, receive_enabled: false,
        autoresponder: { enabled: true, subject: 'S', body: 'B', startsAt: '2026-07-01T00:00:00Z', endsAt: null, intervalDays: 3 } }),
    ],
    domains: [domain(), domain({ id: 2, name: 'b.fr', verified: false })],
    aliases: [alias(), alias({ id: 6, address: 'x@a.fr', enabled: false }), alias({ id: 7, address: 'y@b.fr', mail_domain_id: 2 })],
    appPasswords: [
      { id: 1, mailboxId: 10, address: 'contact@a.fr', passwordHash: 'h', expiresAt: '2026-06-01T01:00:00Z', purpose: 'webmail', allowNets: [] },
      { id: 2, mailboxId: 11, address: 'off@a.fr', passwordHash: 'h', expiresAt: '2026-06-01T01:00:00Z', purpose: 'webmail', allowNets: [] },
      { id: 3, mailboxId: 10, address: 'contact@a.fr', passwordHash: 'h', expiresAt: '2026-05-31T23:00:00Z', purpose: 'webmail', allowNets: [] },
    ],
    dkim: [
      { domain: 'a.fr', selector: 'om202606', algorithm: 'rsa-2048', privateKeyPem: 'k', signing: true },
      { domain: 'b.fr', selector: 'om202606', algorithm: 'rsa-2048', privateKeyPem: 'k', signing: true },
    ],
  }));
  const [a, off] = s.mailboxes;
  assert.deepEqual([a.loginEnabled, a.sendEnabled], [true, false]);
  assert.equal(a.forward, null, 'sending disabled ⇒ no external forwarding (MA9)');
  assert.equal(a.autoresponder, null, 'ended autoresponder dropped');
  assert.deepEqual([off.loginEnabled, off.receiveEnabled], [false, false]);
  assert.equal(off.autoresponder?.subject, 'S', 'future autoresponder kept (engine checks the dates)');
  assert.deepEqual(s.aliases.map((x) => x.id), [5]);
  assert.deepEqual(s.appPasswords.map((p) => p.id), [1], 'only valid sessions of mailboxes that may log in');
  assert.deepEqual(s.dkim.map((k) => k.domain), ['a.fr'], 'keys of served domains only');
  assert.equal(s.domains.find((d) => d.name === 'b.fr')?.active, false);
});

test('desired state: an account that may not send forwards / expands / catches-all to local targets only (MA9)', () => {
  const rows = {
    domains: [domain({ catch_all: 'ext@gmail.com' }), domain({ id: 2, account_id: 4, name: 'b.fr', catch_all: 'bob@b.fr' })],
    mailboxes: [
      mailboxRow({ forward_targets: ['x@gmail.com', 'bob@b.fr'], forward_keep_copy: false,
        autoresponder: { enabled: true, subject: 'S', body: 'B', startsAt: null, endsAt: null, intervalDays: 3 } }),
      mailboxRow({ id: 12, address: 'only@a.fr', local_part: 'only', forward_targets: ['y@gmail.com'], forward_keep_copy: false }),
      mailboxRow({ id: 20, account_id: 4, mail_domain_id: 2, address: 'bob@b.fr', local_part: 'bob', forward_targets: ['z@gmail.com'] }),
    ],
    aliases: [alias({ targets: ['contact@a.fr', 'ext@gmail.com'] }), alias({ id: 6, address: 'out@a.fr', local_part: 'out', targets: ['ext@gmail.com'] })],
  };
  const free = buildDesiredState(input(rows));
  assert.deepEqual(free.mailboxes[0].forward?.targets, ['x@gmail.com', 'bob@b.fr']);
  assert.equal(free.domains[0].catchAll, 'ext@gmail.com');
  assert.deepEqual(free.aliases.map((a) => a.targets.length), [2, 1]);

  for (const over of [
    { sendPolicy: new Map([[3, { accountId: 3, suspended: true, perHour: 50 }]]) },
    { domains: [domain({ catch_all: 'ext@gmail.com', account_status: 'suspended' }), rows.domains[1]] },
  ]) {
    const s = buildDesiredState(input({ ...rows, ...over }));
    const [a, only, bob] = s.mailboxes;
    assert.deepEqual(a.forward, { targets: ['bob@b.fr'], keepCopy: false }, 'local target of another account kept');
    assert.equal(a.autoresponder, null, 'no autoresponder while sending is cut');
    assert.equal(only.forward, null, 'only external targets ⇒ local delivery');
    assert.equal(s.domains[0].catchAll, null, 'external catch-all dropped');
    assert.deepEqual(s.aliases.map((x) => [x.address, x.targets]), [['info@a.fr', ['contact@a.fr']]], 'external alias targets dropped');
    assert.deepEqual(bob.forward?.targets, ['z@gmail.com'], 'other accounts untouched');
    assert.equal(s.domains[1].catchAll, 'bob@b.fr');
  }
  // mailbox-level send switch also stops its external forwarding
  const m = buildDesiredState(input({ ...rows, mailboxes: [mailboxRow({ send_enabled: false, forward_targets: ['x@gmail.com'] })] }));
  assert.equal(m.mailboxes[0].forward, null);
});

// ── infra / hook / usage ─────────────────────────────────────────────────────

test('infra summary: deployed / running only when every container is', () => {
  const c = (deployed: boolean, running: boolean, detail: string | null = null) =>
    ({ id: 'mail' as const, deployed, running, image: 'img', version: running ? '1.0' : null, detail });
  assert.deepEqual(summarizeMailComponents([], 'nothing'), { id: 'mail', deployed: false, running: false, image: null, version: null, detail: 'nothing' });
  const all = summarizeMailComponents([c(true, true), c(true, true)], null);
  assert.deepEqual([all.deployed, all.running, all.version, all.detail], [true, true, '1.0', null]);
  const one = summarizeMailComponents([c(true, true), c(true, false, 'rspamd: exited')], null);
  assert.deepEqual([one.deployed, one.running, one.detail], [true, false, 'rspamd: exited']);
});

test('reconcile fingerprint: status and mail plan limits only', () => {
  const base = mailAccountFingerprint('active', plan());
  assert.equal(base, mailAccountFingerprint('active', plan({ diskMb: 1 })), 'non-mail limits ignored');
  assert.notEqual(base, mailAccountFingerprint('suspended', plan()));
  assert.notEqual(base, mailAccountFingerprint('active', plan({ mailOutboundPerHour: 10 })));
});

test('quota warning: once at 90 %, re-armed under 80 %', () => {
  const mib = 1024 * 1024;
  assert.equal(quotaWarningAction(95 * mib, 100, false), 'warn');
  assert.equal(quotaWarningAction(95 * mib, 100, true), null);
  assert.equal(quotaWarningAction(85 * mib, 100, true), null);
  assert.equal(quotaWarningAction(70 * mib, 100, true), 'rearm');
  assert.equal(quotaWarningAction(70 * mib, 100, false), null);
  assert.equal(quotaWarningAction(10 * mib, null, true), 'rearm');
});

test('desired state: a mandatory provider never falls back to empty (last good value, else the sync is aborted)', async () => {
  const cache = new Map<string, unknown>();
  const boom = async (): Promise<string[]> => { throw new Error('pool acquire timeout'); };
  await assert.rejects(requiredPart('dkim', boom, cache), /mail desired state: dkim unavailable \(pool acquire timeout\)/);
  assert.deepEqual(await requiredPart('dkim', async () => ['k1'], cache), ['k1']);
  assert.deepEqual(await requiredPart('dkim', boom, cache), ['k1'], 'last value loaded successfully reused');
  await assert.rejects(requiredPart('tls', boom, cache), /tls unavailable/, 'one part cached never covers another');
});
