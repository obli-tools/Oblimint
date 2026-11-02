import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the Outlook-like mail handling (migration 034): forwarding
// paused / on (panel), inbox rules (panel + the mailbox owner from the
// webmail, same rows), the owner's external-forwarding policy, the redirect
// budget, the restriction gates, the audit, the desired state the sync hands
// to the engine and the notice e-mail to the mailbox. PostgreSQL at
// MAILRULES_TEST_DATABASE_URL (default port 55468); skipped when nothing
// listens. The engine is a fake 'stalwart' driver (never called here).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MAILRULES_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55468/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('mail forwarding + inbox rules on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-mailrules-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'mail-rules-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const mailRoutes = (await import('../../routes/mail.routes')).default;
  const { setMailDriverForTests } = await import('./registry');
  const { setMailCoreDepsForTests } = await import('./deps');
  const { mailService } = await import('./mail.service');
  const { loadDesiredState } = await import('./desiredState');
  const { resetMailSyncForTests } = await import('./sync');
  const { platformSettings } = await import('../platformSettings');
  const { hashMailPassword } = await import('./passwords');
  const { externalDriver } = await import('./engines/external');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  await db('tenants').update({ action_restrictions: '{}' });
  t.after(async () => { await db.destroy(); });

  const caps = { supported: true, mailboxes: true, sieve: true, appPasswordNets: false, quotaUsage: true, queue: true, clamav: false, greylisting: true, passwordSchemes: ['SHA512-CRYPT'] };
  const driver = (engine: string) => ({ ...externalDriver, engine, capabilities: caps, async sync() { return { ok: true, changed: false, domains: 0, mailboxes: 0, aliases: 0, domainErrors: {}, durationMs: 0 }; } }) as never;
  setMailDriverForTests(driver('stalwart'));
  const notices: Array<{ to: string; subject: string; text: string; smtp: boolean }> = [];
  setMailCoreDepsForTests({
    mailboxNotice(to, subject, text, opts) { notices.push({ to, subject, text, smtp: opts.smtpReachesMailbox }); },
    async sendPolicy() { return new Map(); },
    async dkimSigningKeys() { return []; },
    async tlsCertificates() { return []; },
    async appPasswords() { return []; },
    async relayTrust() { return { relayHost: 'oblimint-mail-relay', relayAddresses: [] }; },
    async webmailUrl() { return null; },
    domainChanged() {}, mailDomainsChanged() {}, mailboxChanged() {}, dnsSyncAll() {}, edgeSync() {},
  });
  t.after(() => { setMailDriverForTests(null); setMailCoreDepsForTests(null); resetMailSyncForTests(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [tenant] = await db('tenants').insert({ name: `R ${suffix}`, slug: `r-${suffix}` }).returning('id');
  const tId = Number(tenant.id ?? tenant);
  const [u] = await db('users').insert({ username: `rules-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const manager = Number(u.id ?? u);
  const [u2] = await db('users').insert({ username: `rules-ro-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const reader = Number(u2.id ?? u2);
  const [u3] = await db('users').insert({ username: `rules-staff-${suffix}`, kind: 'staff', role: 'admin', is_active: true }).returning('id');
  const staff = Number(u3.id ?? u3);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const [plan] = await db('plans').insert({ tenant_id: tId, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acctRow] = await db('hosting_accounts').insert({
    tenant_id: tId, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `rl${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acct = Number(acctRow.id ?? acctRow);
  await db('account_users').insert([
    { user_id: manager, account_id: acct, capabilities: JSON.stringify(['mail.manage']) },
    { user_id: reader, account_id: acct, capabilities: JSON.stringify([]) },
  ]);
  const dom = `regles-${suffix}.test`;
  const [d] = await db('domains').insert({ tenant_id: tId, account_id: acct, name: dom, verification_status: 'verified' }).returning('id');
  const [md] = await db('mail_domains').insert({ tenant_id: tId, account_id: acct, domain_id: Number(d.id ?? d), name: dom, enabled: true }).returning('id');
  const mailDomainId = Number(md.id ?? md);
  const mkBox = async (local: string) => {
    const [m] = await db('mailboxes').insert({
      tenant_id: tId, account_id: acct, mail_domain_id: mailDomainId, local_part: local, address: `${local}@${dom}`,
      password_hash: hashMailPassword('Mailbox-Password-1').hash, password_scheme: 'SHA512-CRYPT', enabled: true,
    }).returning('id');
    return Number(m.id ?? m);
  };
  const alice = await mkBox('alice');
  const bob = await mkBox('bob');

  // ── panel app ──
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = tId;
    next();
  });
  app.use('/mail', mailRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, user: number, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', 'x-user': String(user) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { data?: any; code?: string; error?: string } };
  };
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r1', name: 'Factures', enabled: true, match: 'all', conditions: [{ kind: 'subject', values: ['facture'] }],
    actions: [{ kind: 'move', folder: 'Finance' }, { kind: 'markRead' }], stop: false, ...over,
  });

  await t.test('migration 034: columns and defaults (an existing forwarding stays on)', async () => {
    const row = await db('mailboxes').where({ id: alice }).first('forward_enabled', 'forward_changed_at', 'forward_changed_by_panel', 'mail_rules');
    assert.equal(row.forward_enabled, true);
    assert.equal(row.forward_changed_at, null);
    assert.equal(row.forward_changed_by_panel, false);
    assert.deepEqual(typeof row.mail_rules === 'string' ? JSON.parse(row.mail_rules) : row.mail_rules, []);
  });

  await t.test('panel forwarding: paused keeps the targets, the engine forwards nothing; notice e-mail on / changed only', async () => {
    notices.length = 0;
    let r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, reader, { targets: ['me@gmail.com'], keepCopy: true });
    assert.equal(r.status, 403, 'mail.manage needed');
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: ['me@gmail.com'], keepCopy: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.forwarding, { targets: ['me@gmail.com'], keepCopy: true, enabled: true });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].to, `alice@${dom}`);
    assert.match(notices[0].text, /me@gmail\.com/);
    assert.match(notices[0].text, /forwarded to/);
    // Same forwarding again: no new notice.
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: ['me@gmail.com'], keepCopy: true });
    assert.equal(notices.length, 1);
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: ['me@gmail.com'], keepCopy: true, enabled: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.forwarding, { targets: ['me@gmail.com'], keepCopy: true, enabled: false });
    assert.equal(notices.length, 1, 'pausing sends no notice');
    let state = await loadDesiredState();
    assert.equal(state.mailboxes.find((m) => m.id === alice)?.forward, null, 'paused: nothing forwarded');
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: ['me@gmail.com'], keepCopy: false, enabled: true });
    assert.equal(notices.length, 2, 'turned on again (no copy kept)');
    assert.match(notices[1].text, /No copy stays/);
    assert.deepEqual(notices.map((n) => n.smtp), [true, false], 'no copy kept: by SMTP the notice would follow the forwarding');
    state = await loadDesiredState();
    assert.deepEqual(state.mailboxes.find((m) => m.id === alice)?.forward, { targets: ['me@gmail.com'], keepCopy: false });
    const audit = await db('audit_logs').where({ action: 'mail.mailbox.forwarding', resource_path: String(alice) }).orderBy('id', 'desc').first();
    assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).enabled, true);
    const list = await call('GET', `/mail/mailboxes?accountId=${acct}`, manager);
    assert.deepEqual(list.body.data.items.find((m: { id: number }) => m.id === alice).forwarding, { targets: ['me@gmail.com'], keepCopy: false, enabled: true });
    // Off for the next tests.
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: [], keepCopy: true });
    assert.equal(r.body.data.forwarding, null);
  });

  await t.test('panel rules: validated, stored in order, rendered into the desired state (enabled only), audited without the words', async () => {
    let r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [rule({ actions: [] })] });
    assert.deepEqual([r.status, r.body.code], [400, 'invalidRule']);
    r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [rule({ actions: [{ kind: 'forward', to: [`alice@${dom}`] }] })] });
    assert.deepEqual([r.status, r.body.code], [400, 'invalidRule'], 'to itself');
    r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [rule({ actions: [{ kind: 'forward', to: [`nobody@${dom}`] }] })] });
    assert.deepEqual([r.status, r.body.code], [400, 'invalidTarget'], 'internal target must exist');
    r = await call('PUT', `/mail/mailboxes/${alice}/rules`, reader, { rules: [rule()] });
    assert.equal(r.status, 403);
    r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [
      rule({ conditions: [{ kind: 'subject', values: ['secret-word'] }] }),
      rule({ id: 'r2', name: 'Boss', actions: [{ kind: 'forward', to: [`bob@${dom}`, 'boss@ext.org'] }], stop: true }),
      rule({ id: 'r3', name: 'Idle', enabled: false }),
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.rules.map((x: { id: string }) => x.id), ['r1', 'r2', 'r3']);
    assert.equal(r.body.data.activeRuleCount, 2);
    assert.equal(r.body.data.rulesSupported, true);
    const state = await loadDesiredState();
    const sAlice = state.mailboxes.find((m) => m.id === alice)!;
    assert.deepEqual(sAlice.rules?.map((x) => x.id), ['r1', 'r2']);
    const audit = await db('audit_logs').where({ action: 'mail.mailbox.rules', resource_path: String(alice) }).orderBy('id', 'desc').first();
    assert.ok(audit);
    assert.doesNotMatch(JSON.stringify(audit.details), /secret-word/);
    // Loop through a rule: bob forwarding back to alice is refused.
    r = await call('PUT', `/mail/mailboxes/${bob}/forwarding`, manager, { targets: [`alice@${dom}`], keepCopy: true });
    assert.deepEqual([r.status, r.body.code], [400, 'forwardingLoop']);
    // Budget: 19 forwarding targets + 2 rule targets > 20.
    r = await call('PUT', `/mail/mailboxes/${alice}/forwarding`, manager, { targets: Array.from({ length: 19 }, (_, i) => `t${i}@ext.org`), keepCopy: true });
    assert.deepEqual([r.status, r.body.code], [400, 'tooManyRedirects']);
    // Not on postfix-dovecot.
    setMailDriverForTests(driver('postfix-dovecot'));
    r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [] });
    assert.deepEqual([r.status, r.body.code], [409, 'rulesUnsupported']);
    assert.equal((await call('GET', `/mail/mailboxes/${alice}`, manager)).body.data.rulesSupported, false);
    setMailDriverForTests(driver('stalwart'));
  });

  await t.test('restriction gates: mail.mailbox_forwarding / mail.mailbox_rules protect the panel routes', async () => {
    await db('tenants').where({ id: tId }).update({ action_restrictions: JSON.stringify({ 'mail.mailbox_rules': { level: 'restricted', scope: { mode: 'all' }, via: 'all' } }) });
    const r = await call('PUT', `/mail/mailboxes/${alice}/rules`, manager, { rules: [] });
    assert.notEqual(r.status, 200, 'held by the gate (approval / no approver)');
    const kept = await db('mailboxes').where({ id: alice }).first('mail_rules');
    assert.equal((typeof kept.mail_rules === 'string' ? JSON.parse(kept.mail_rules) : kept.mail_rules).length, 3, 'nothing written before the approval');
    await db('tenants').where({ id: tId }).update({ action_restrictions: '{}' });
  });

  await t.test('owner (webmail): own forwarding within the policy, external refused when the platform says so, panel targets kept', async () => {
    notices.length = 0;
    let f = await mailService.ownerForwarding(bob);
    // External forwarding allowed: the account's domains are not listed to the mailbox user.
    assert.deepEqual([f.enabled, f.active, f.targets, f.policy.external, f.policy.internalDomains, f.ruleForwards], [true, false, [], true, [], []]);
    f = await mailService.setForwardingAsMailbox(bob, { enabled: true, targets: ['me@gmail.com'], keepCopy: true }, '203.0.113.4');
    assert.deepEqual([f.active, f.targets, f.changedByPanelAt], [true, ['me@gmail.com'], null]);
    assert.equal(notices.length, 0, 'the owner changed it: no notice');
    const audit = await db('audit_logs').where({ action: 'mail.mailbox.forwarding', resource_path: String(bob) }).orderBy('id', 'desc').first();
    assert.equal(audit.user_id, null);
    assert.match(JSON.stringify(audit.details), /webmail/);

    await platformSettings.update({ mail: { ownerExternalForwarding: false } } as never);
    platformSettings.invalidate();
    f = await mailService.ownerForwarding(bob);
    assert.equal(f.policy.external, false);
    assert.deepEqual(f.policy.internalDomains, [dom], 'refused outside: the owner is told where it may forward');
    await assert.rejects(mailService.setForwardingAsMailbox(bob, { enabled: true, targets: ['me@gmail.com', 'other@ext.org'], keepCopy: true }, null),
      (err: { code?: string; statusCode?: number }) => err.code === 'forwardingNotAllowed' && err.statusCode === 403);
    // Already there (kept), pausing, internal targets: fine.
    f = await mailService.setForwardingAsMailbox(bob, { enabled: false, targets: ['me@gmail.com'], keepCopy: true }, null);
    assert.deepEqual([f.enabled, f.active], [false, false]);
    f = await mailService.setForwardingAsMailbox(bob, { enabled: true, targets: [], keepCopy: true }, null);
    assert.equal(f.active, false);
    // A client user of the account (panel) is bound by the switch like the owner; staff is not.
    let r = await call('PUT', `/mail/mailboxes/${bob}/forwarding`, manager, { targets: ['panel@ext.org'], keepCopy: true });
    assert.deepEqual([r.status, r.body.code], [403, 'forwardingNotAllowed']);
    r = await call('PUT', `/mail/mailboxes/${bob}/rules`, manager, { rules: [rule({ actions: [{ kind: 'redirect', to: ['panel@ext.org'] }] })] });
    assert.deepEqual([r.status, r.body.code], [403, 'forwardingNotAllowed'], 'a rule too');
    r = await call('PUT', `/mail/mailboxes/${bob}/forwarding`, manager, { targets: [`alice@${dom}`], keepCopy: true, enabled: false });
    assert.equal(r.status, 200, 'internal targets: fine');
    // Panel change by staff: the owner is told (banner date) and sees it.
    r = await call('PUT', `/mail/mailboxes/${bob}/forwarding`, staff, { targets: ['panel@ext.org'], keepCopy: true });
    assert.equal(r.status, 200, 'staff is not bound by the owner policy');
    f = await mailService.ownerForwarding(bob);
    assert.ok(f.changedByPanelAt, 'changed by the panel');
    assert.equal(notices.length, 1);
    // …and the owner may keep that external target while editing.
    f = await mailService.setForwardingAsMailbox(bob, { enabled: true, targets: ['panel@ext.org'], keepCopy: false }, null);
    assert.deepEqual([f.keepCopy, f.changedByPanelAt], [false, null]);

    // Rules from the webmail: same policy.
    await assert.rejects(mailService.setRulesAsMailbox(bob, [rule({ actions: [{ kind: 'redirect', to: ['new@ext.org'] }] })], null),
      (err: { code?: string }) => err.code === 'forwardingNotAllowed');
    // A target the panel already set (the forwarding's) stays allowed in a rule.
    const w = await mailService.setRulesAsMailbox(bob, [rule({ actions: [{ kind: 'forward', to: ['panel@ext.org'] }] })], null);
    assert.equal(w.rules.length, 1);
    assert.equal(w.supported, true);
    assert.deepEqual((await mailService.ownerRules(bob)).rules.map((x) => x.id), ['r1']);
    // …and a client user of the account may keep it too (already there).
    r = await call('PUT', `/mail/mailboxes/${bob}/rules`, manager, { rules: [rule({ actions: [{ kind: 'forward', to: ['panel@ext.org'] }] })] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The banner names the rules that send messages on.
    f = await mailService.ownerForwarding(bob);
    assert.deepEqual(f.ruleForwards, [{ rule: 'Factures', to: ['panel@ext.org'], kept: true }]);
    await platformSettings.update({ mail: { ownerExternalForwarding: true } } as never);
    platformSettings.invalidate();
  });

  await t.test('a rule that forwards: notice e-mail (panel), banner data, list badge', async () => {
    const dave = await mkBox('dave');
    notices.length = 0;
    let r = await call('PUT', `/mail/mailboxes/${dave}/rules`, staff, { rules: [rule({ id: 'all', name: 'Tout', conditions: [], actions: [{ kind: 'redirect', to: ['spy@ext.org'] }] })] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.ruleForwardTargets, ['spy@ext.org']);
    assert.equal(notices.length, 1, 'a new rule target: the mailbox is told');
    assert.match(notices[0].text, /A rule now forwards e-mail to: spy@ext\.org/);
    assert.equal(notices[0].smtp, true);
    // Same targets (renamed): no new notice; turned off: none either.
    r = await call('PUT', `/mail/mailboxes/${dave}/rules`, staff, { rules: [rule({ id: 'all', name: 'Tout (2)', conditions: [], actions: [{ kind: 'redirect', to: ['spy@ext.org'] }] })] });
    r = await call('PUT', `/mail/mailboxes/${dave}/rules`, staff, { rules: [rule({ id: 'all', name: 'Tout', enabled: false, conditions: [], actions: [{ kind: 'redirect', to: ['spy@ext.org'] }] })] });
    assert.equal(notices.length, 1);
    assert.deepEqual(r.body.data.ruleForwardTargets, [], 'disabled: nothing sent on');
    // The owner changing its own rules: no notice.
    await mailService.setRulesAsMailbox(dave, [rule({ id: 'all', name: 'Tout', conditions: [], actions: [{ kind: 'forward', to: ['me2@ext.org'] }] })], null);
    assert.equal(notices.length, 1);
    const list = await call('GET', `/mail/mailboxes?accountId=${acct}`, manager);
    assert.deepEqual(list.body.data.items.find((m: { id: number }) => m.id === dave).ruleForwardTargets, ['me2@ext.org']);
    await mailService.setRulesAsMailbox(dave, [], null);
  });

  await t.test('a target that disappeared never blocks turning things off or re-ordering', async () => {
    const carol = await mkBox('carol');
    const erin = await mkBox('erin');
    let r = await call('PUT', `/mail/mailboxes/${erin}/forwarding`, manager, { targets: [`carol@${dom}`], keepCopy: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PUT', `/mail/mailboxes/${erin}/rules`, manager, { rules: [rule({ id: 'a', actions: [{ kind: 'forward', to: [`carol@${dom}`] }] })] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await db('mailboxes').where({ id: carol }).del();
    // Rules saved while the (enabled) forwarding still names the gone address: fine, it is not re-checked.
    const b = rule({ id: 'b', name: 'Autre', actions: [{ kind: 'flag' }] });
    r = await call('PUT', `/mail/mailboxes/${erin}/rules`, manager, { rules: [b, rule({ id: 'a', actions: [{ kind: 'forward', to: [`carol@${dom}`] }] })] });
    assert.equal(r.status, 200, `re-ordered: ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/mail/mailboxes/${erin}/rules`, manager, { rules: [b, rule({ id: 'a', enabled: false, actions: [{ kind: 'forward', to: [`carol@${dom}`] }] })] });
    assert.equal(r.status, 200, 'the broken rule turned off');
    r = await call('PUT', `/mail/mailboxes/${erin}/rules`, manager, { rules: [b, rule({ id: 'a', enabled: true, actions: [{ kind: 'forward', to: [`carol@${dom}`] }] })] });
    assert.deepEqual([r.status, r.body.code], [400, 'invalidTarget'], 'turning it on again checks it');
    // The owner (webmail banner "Turn off") and the panel pause the forwarding.
    const f = await mailService.setForwardingAsMailbox(erin, { enabled: false, targets: [`carol@${dom}`], keepCopy: true }, null);
    assert.equal(f.active, false);
    r = await call('PUT', `/mail/mailboxes/${erin}/forwarding`, manager, { targets: [`carol@${dom}`], keepCopy: true, enabled: false });
    assert.equal(r.status, 200);
    r = await call('PUT', `/mail/mailboxes/${erin}/forwarding`, manager, { targets: [`carol@${dom}`], keepCopy: true, enabled: true });
    assert.deepEqual([r.status, r.body.code], [400, 'invalidTarget'], 're-enabled: its targets are checked again');
    r = await call('PUT', `/mail/mailboxes/${erin}/forwarding`, manager, { targets: [], keepCopy: true });
    assert.equal(r.status, 200, 'off');
  });

  await t.test('folders of a mailbox: mail.manage (the user content), not a mere read', async () => {
    const r = await call('GET', `/mail/mailboxes/${alice}/folders`, reader);
    assert.equal(r.status, 403);
    assert.equal((await call('GET', `/mail/mailboxes/${alice}/folders`, manager)).status, 200);
  });
});
