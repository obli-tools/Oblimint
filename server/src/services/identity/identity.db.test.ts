import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Request } from 'express';
import * as OTPAuth from 'otpauth';

// ─────────────────────────────────────────────────────────────────────────────
// Self-service identity against the real panel app (createApp) on a real
// PostgreSQL: IDENTITY_TEST_DATABASE_URL (default: port 55950; skipped when
// nothing listens). The transactional sender is an external SMTP with a fake
// transport (every e-mail is captured).
//   - forgotten password: same answer for every address; only an active local
//     account with a verified address gets a link (never an Obligate one, an
//     unverified / unknown / disabled one); throttled per account; token
//     stored hashed, 30 min, single use, bound to the address; the reset ends
//     every session (credential_version), audit, personal notice; the second
//     factor is still asked afterwards;
//   - recovery codes: generated on enable and on demand (step-up), 10, shown
//     once, hashed; a sign-in with one consumes it (never twice), notifies the
//     account (bell + e-mail) and opens the lost-authenticator grace;
//   - e-mail change: step-up, confirmation link to the new address, notice to
//     the old one, address taken refused, PUT /profile can no longer change
//     it; without an e-mail sender the change applies unverified.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.IDENTITY_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55950/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

type Json = { success?: boolean; code?: string; error?: string; data?: any; [k: string]: unknown } | null;
type Reply = { status: number; body: string; json: Json; cookies: string[] };

function send(port: number, method: string, urlPath: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json: Json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode ?? 0, body: data, json, cookies: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('self-service identity: password reset, recovery codes, e-mail change', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-identity-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'identity-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  const { createApp } = await import('../../app');
  const { setResetAnswerDelayForTests } = await import('../../routes/auth.routes');
  const { identityService } = await import('./identity.service');
  const { hashPassword } = await import('../../utils/crypto');
  const { SESSION_COOKIE_NAME } = await import('../../config');
  const tm = await import('../mail/transactional');
  const { forgetPanelHosts } = await import('../panelHosts');

  // ── e-mail sender: external SMTP, fake transport ──
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  tm.setTransactionalDepsForTests({
    transport: () => ({
      async sendMail(m: Record<string, unknown>) { mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) }); return {}; },
      close() { /* nothing */ },
    }),
    lookup: async () => [{ address: '100.64.0.25', family: 4 }],
    submissionEndpoint: async () => null,
  });
  const senderOn = async (on: boolean) => {
    await db('app_config').insert({
      key: 'mail.transactional',
      value: JSON.stringify({ mode: on ? 'smtp' : 'off', fromName: null, platform: { mailbox: null }, smtp: { host: 'smtp.example.com', port: 587, secure: false, username: null, from: 'noreply@example.com' }, secrets: null, secretsSet: [] }),
    }).onConflict('key').merge();
    tm.setTransactionalDepsForTests({
      transport: () => ({
        async sendMail(m: Record<string, unknown>) { mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) }); return {}; },
        close() { /* nothing */ },
      }),
      lookup: async () => [{ address: '100.64.0.25', family: 4 }],
      submissionEndpoint: async () => null,
    }); // drops the settings cache
  };
  await senderOn(true);
  await db('app_config').insert([{ key: 'panel_hostname', value: 'panel.example.com' }, { key: 'client_panel_hostname', value: 'client.example.com' }]).onConflict('key').merge();
  forgetPanelHosts();
  setResetAnswerDelayForTests(() => 0);
  t.after(() => setResetAnswerDelayForTests(null));

  // ── fixtures ──
  const [ta] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
  const A = Number(ta.id ?? ta);
  const password = 'Initial-Password-0001';
  const pwHash = await hashPassword(password);
  const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
  const mkUser = async (username: string, o: { email?: string | null; verified?: boolean; kind?: 'staff' | 'client'; sso?: boolean; active?: boolean; totp?: boolean; lang?: string } = {}) => {
    const email = o.email === undefined ? `${username}@example.com` : o.email;
    const [row] = await db('users').insert({
      username, password_hash: o.sso ? null : pwHash, role: 'user', kind: o.kind ?? 'staff', is_active: o.active ?? true, email,
      email_verified_for: email && o.verified !== false ? email.toLowerCase() : null,
      foreign_source: o.sso ? 'obligate' : null, foreign_id: o.sso ? 77 : null,
      totp_enabled: !!o.totp, totp_secret: o.totp ? totpSecret : null, preferred_language: o.lang ?? 'en',
    }).returning('id');
    const id = Number(row.id ?? row);
    await db('user_tenants').insert({ user_id: id, tenant_id: A, role: o.kind === 'client' ? 'client' : 'admin' });
    return id;
  };
  const alice = await mkUser('alice', { totp: true });
  const carol = await mkUser('carol', { kind: 'client', lang: 'fr' });
  const ogBob = await mkUser('og_bob', { sso: true });
  const dave = await mkUser('dave', { verified: false });
  await mkUser('erin', { active: false });
  void ogBob;

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tm.setTransactionalDepsForTests(null);
    await db.destroy();
  });

  const cookieOf = (r: Reply) => r.cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  const totpAt = (ms: number) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: ms });
  /** A current code of alice's authenticator, usable now (the anti-replay step is cleared first: tests run within one 30 s step). */
  const freshTotp = async () => { await db('users').where({ id: alice }).update({ totp_last_step: null }); return totpAt(Date.now()); };
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const tokenIn = (text: string, pathName: string) => {
    const m = new RegExp(`https://[a-z.]+${pathName}\\?token=([A-Za-z0-9_-]{43})`).exec(text);
    assert.ok(m, `a ${pathName} link in: ${text}`);
    return { url: m[0], token: m[1] };
  };
  const waitMail = async (to: string, n: number) => {
    for (let i = 0; i < 100 && mails.filter((m) => m.to === to).length < n; i++) await sleep(20);
    return mails.filter((m) => m.to === to);
  };
  const lastMailTo = (to: string) => [...mails].reverse().find((m) => m.to === to);
  /** Password sign-in; returns the cookie (pending 2FA or signed in) and the reply. */
  const login = async (username: string, pw: string) => {
    const r = await send(port, 'POST', '/api/auth/login', { body: { username, password: pw } });
    return { r, cookie: cookieOf(r) };
  };

  // ── forgotten password ─────────────────────────────────────────────────────

  await t.test('the request answers the same thing for every address', async () => {
    const bodies = new Set<string>();
    for (const email of ['alice@example.com', 'nobody@example.com', 'og_bob@example.com', 'dave@example.com', 'not-an-address']) {
      const r = await send(port, 'POST', '/api/auth/password-reset', { body: { email } });
      assert.equal(r.status, 200, r.body);
      bodies.add(r.body);
    }
    assert.equal(bodies.size, 1, 'one answer whatever the address');
    const sent = await waitMail('alice@example.com', 1);
    assert.equal(sent.length, 1);
    await sleep(200);
    for (const to of ['nobody@example.com', 'og_bob@example.com', 'dave@example.com']) assert.equal(mails.filter((m) => m.to === to).length, 0, to);
  });

  await t.test('only an active local account with a verified address gets a link', async () => {
    assert.equal(await identityService.requestPasswordReset('og_bob@example.com', null), 'ignored', 'Obligate account');
    assert.equal(await identityService.requestPasswordReset('dave@example.com', null), 'ignored', 'unverified address');
    assert.equal(await identityService.requestPasswordReset('erin@example.com', null), 'ignored', 'disabled account');
    assert.equal(await identityService.requestPasswordReset('nobody@example.com', null), 'ignored');
    assert.equal(await identityService.requestPasswordReset({ email: 'x' }, null), 'ignored');
    assert.equal(await identityService.requestPasswordReset('ALICE@example.com', null), 'throttled', 'a link was sent less than a minute ago');
    assert.equal(await identityService.requestPasswordReset('carol@example.com', null), 'sent');
    const m = lastMailTo('carol@example.com')!;
    assert.match(m.subject, /Réinitialisation/, 'in the language of the account');
    const { url } = tokenIn(m.text, '/reset-password');
    assert.ok(url.startsWith('https://client.example.com/'), 'a client goes back to the client space');
    const a = tokenIn(mails.find((x) => x.to === 'alice@example.com')!.text, '/reset-password');
    assert.ok(a.url.startsWith('https://panel.example.com/'), 'staff go to the panel');
    const audits = await db('audit_logs').where({ action: 'user.password_reset_requested', user_id: alice }).select('details');
    assert.ok(audits.length >= 2, 'requests are audited (sent, throttled)');
  });

  await t.test('the token is stored hashed, single use, and the reset ends every session', async () => {
    const { token } = tokenIn(mails.find((x) => x.to === 'alice@example.com')!.text, '/reset-password');
    const row = await db('user_action_tokens').where({ user_id: alice, purpose: 'password_reset' }).first();
    assert.equal(row.token_hash, sha(token));
    assert.equal(JSON.stringify(await db('user_action_tokens').select('*')).includes(token), false, 'the raw token is stored nowhere');
    const ttl = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    assert.ok(Math.abs(ttl - 30 * 60_000) < 5_000, `30 min (${ttl} ms)`);

    // A signed-in session of alice (password + TOTP).
    const { r, cookie } = await login('alice', password);
    assert.equal(r.json?.data?.requires2fa, true, r.body);
    const v = await send(port, 'POST', '/api/profile/2fa/verify', { cookie, body: { code: await freshTotp(), method: 'totp' } });
    assert.equal(v.status, 200, v.body);
    const sess = cookieOf(v) ?? cookie;
    assert.equal((await send(port, 'GET', '/api/auth/me', { cookie: sess })).status, 200);
    const before = Number((await db('users').where({ id: alice }).first('credential_version')).credential_version);

    assert.equal((await send(port, 'POST', '/api/auth/password-reset/validate', { body: { token } })).json?.data?.valid, true);
    const bogus = await send(port, 'POST', '/api/auth/password-reset/validate', { body: { token: 'x'.repeat(43) } });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.json?.data?.valid, false);
    const short = await send(port, 'POST', '/api/auth/password-reset/confirm', { body: { token, newPassword: 'short' } });
    assert.equal(short.status, 400, short.body);

    const ok = await send(port, 'POST', '/api/auth/password-reset/confirm', { body: { token, newPassword: 'Brand-New-Password-002' } });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json?.data?.kind, 'staff');
    const again = await send(port, 'POST', '/api/auth/password-reset/confirm', { body: { token, newPassword: 'Another-Password-0003' } });
    assert.equal(again.status, 400);
    assert.equal(again.json?.code, 'invalidToken', 'single use');

    assert.ok(Number((await db('users').where({ id: alice }).first('credential_version')).credential_version) > before, 'credential_version moved');
    const live = await db.raw(`SELECT count(*)::int AS n FROM session WHERE (sess::jsonb ->> 'userId') = ?`, [String(alice)]);
    assert.equal(live.rows[0].n, 0, 'every session of the account ended');
    assert.equal((await send(port, 'GET', '/api/auth/me', { cookie: sess })).status, 401, 'the old session is refused');
    assert.ok(await db('audit_logs').where({ action: 'user.password_reset', user_id: alice }).first('id'), 'audited');
    const notice = await db('user_notifications').where({ user_id: alice, event: 'account.passwordReset' }).first();
    assert.equal(notice?.family, 'account');

    // The second factor is still asked with the new password.
    const after = await login('alice', 'Brand-New-Password-002');
    assert.equal(after.r.json?.data?.requires2fa, true, after.r.body);
    assert.equal((await login('alice', password)).r.status, 401, 'the old password no longer works');
  });

  await t.test('an expired link, or one sent to an address that changed since, does nothing', async () => {
    await db('user_action_tokens').delete();
    assert.equal(await identityService.requestPasswordReset('carol@example.com', null), 'sent');
    const { token } = tokenIn(lastMailTo('carol@example.com')!.text, '/reset-password');
    await db('user_action_tokens').where({ token_hash: sha(token) }).update({ expires_at: new Date(Date.now() - 1000) });
    const expired = await send(port, 'POST', '/api/auth/password-reset/confirm', { body: { token, newPassword: 'Carol-New-Password-01' } });
    assert.equal(expired.json?.code, 'invalidToken', expired.body);

    await db('user_action_tokens').delete();
    assert.equal(await identityService.requestPasswordReset('carol@example.com', null), 'sent');
    const second = tokenIn(lastMailTo('carol@example.com')!.text, '/reset-password').token;
    await db('users').where({ id: carol }).update({ email: 'carol.other@example.com', email_verified_for: 'carol.other@example.com' });
    const moved = await send(port, 'POST', '/api/auth/password-reset/confirm', { body: { token: second, newPassword: 'Carol-New-Password-01' } });
    assert.equal(moved.json?.code, 'invalidToken', moved.body);
    await db('users').where({ id: carol }).update({ email: 'carol@example.com', email_verified_for: 'carol@example.com' });
  });

  // ── recovery codes ─────────────────────────────────────────────────────────

  let codes: string[] = [];
  let aliceCookie = '';
  await t.test('a new batch needs the step-up, holds 10 codes shown once and stored hashed', async () => {
    const { cookie } = await login('alice', 'Brand-New-Password-002');
    const v = await send(port, 'POST', '/api/profile/2fa/verify', { cookie, body: { code: await freshTotp(), method: 'totp' } });
    assert.equal(v.status, 200, v.body);
    aliceCookie = cookieOf(v) ?? cookie!;
    const ask = await send(port, 'POST', '/api/profile/2fa/recovery-codes', { cookie: aliceCookie, body: {} });
    assert.equal(ask.status, 401, ask.body);
    assert.equal(ask.json?.twoFactorRequired, true);
    const gen = await send(port, 'POST', '/api/profile/2fa/recovery-codes', { cookie: aliceCookie, body: { twoFactorCode: await freshTotp() } });
    assert.equal(gen.status, 200, gen.body);
    codes = gen.json?.data?.codes;
    assert.equal(codes.length, 10);
    const rows = await db('user_recovery_codes').where({ user_id: alice }).select('code_hash');
    assert.equal(rows.length, 10);
    assert.equal(JSON.stringify(rows).includes(codes[0]), false, 'stored hashed');
    const st = await send(port, 'GET', '/api/profile/2fa/recovery-codes', { cookie: aliceCookie });
    assert.deepEqual([st.json?.data?.total, st.json?.data?.remaining], [10, 10]);
    assert.ok(await db('audit_logs').where({ action: 'user.recovery_codes_generated', user_id: alice }).first('id'));
  });

  await t.test('a sign-in with a recovery code: once, notified, then the authenticator can be replaced', async () => {
    const mailsBefore = mails.filter((m) => m.to === 'alice@example.com').length;
    const { cookie } = await login('alice', 'Brand-New-Password-002');
    const wrong = await send(port, 'POST', '/api/profile/2fa/verify', { cookie, body: { code: 'aaaaa-aaaaa', method: 'recovery' } });
    assert.equal(wrong.status, 401);
    const ok = await send(port, 'POST', '/api/profile/2fa/verify', { cookie, body: { code: codes[0].toUpperCase(), method: 'recovery' } });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json?.data?.recoveryCodesRemaining, 9);
    const sess = cookieOf(ok) ?? cookie!;

    const reuse = await login('alice', 'Brand-New-Password-002');
    const twice = await send(port, 'POST', '/api/profile/2fa/verify', { cookie: reuse.cookie, body: { code: codes[0], method: 'recovery' } });
    assert.equal(twice.status, 401, 'a code works once');

    const n = await db('user_notifications').where({ user_id: alice, event: 'account.recoveryCodeUsed' }).first();
    assert.equal(n?.family, 'account');
    assert.equal(n?.severity, 'warning');
    assert.match(n?.message ?? '', /9 codes left/);
    const sent = await waitMail('alice@example.com', mailsBefore + 1);
    assert.match(sent[sent.length - 1].subject, /Recovery code used/);
    const audit = await db('audit_logs').where({ action: 'user.recovery_code_used', user_id: alice }).first('details');
    assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).remaining, 9);
    assert.ok(await db('audit_logs').where({ action: 'auth.login', user_id: alice }).whereRaw(`details::text LIKE '%recovery_code%'`).first('id'));

    // Lost authenticator: this session removes it without a TOTP code (grace), its codes go with it.
    const off = await send(port, 'POST', '/api/profile/2fa/totp/disable', { cookie: sess, body: {} });
    assert.equal(off.status, 200, off.body);
    assert.equal((await db('users').where({ id: alice }).first('totp_enabled')).totp_enabled, false);
    assert.equal((await db('user_recovery_codes').where({ user_id: alice })).length, 0);
    // The other session (the TOTP one) did not get that grace: it was revoked anyway by the change.
    assert.equal((await send(port, 'GET', '/api/auth/me', { cookie: aliceCookie })).status, 401);
  });

  await t.test('enabling an authenticator hands out a new batch; the grace never covers the e-mail', async () => {
    const { r, cookie } = await login('alice', 'Brand-New-Password-002');
    assert.equal(r.status, 200, r.body);
    const sess = cookieOf(r) ?? cookie!;
    const setup = await send(port, 'POST', '/api/profile/2fa/totp/setup', { cookie: sess, body: { stepUpPassword: 'Brand-New-Password-002' } });
    assert.equal(setup.status, 200, setup.body);
    const secret = setup.json?.data?.secret as string;
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
    const en = await send(port, 'POST', '/api/profile/2fa/totp/enable', { cookie: sess, body: { code } });
    assert.equal(en.status, 200, en.body);
    assert.equal(en.json?.data?.recoveryCodes?.codes?.length, 10);
    assert.equal((await db('user_recovery_codes').where({ user_id: alice }).whereNull('used_at')).length, 10);

    // A recovery sign-in does not unlock an e-mail change (TOTP still asked).
    const fresh = await login('alice', 'Brand-New-Password-002');
    const rec = await send(port, 'POST', '/api/profile/2fa/verify', { cookie: fresh.cookie, body: { code: en.json?.data?.recoveryCodes?.codes?.[0], method: 'recovery' } });
    assert.equal(rec.status, 200, rec.body);
    const s2 = cookieOf(rec) ?? fresh.cookie!;
    const change = await send(port, 'POST', '/api/profile/email', { cookie: s2, body: { email: 'alice.new@example.com' } });
    assert.equal(change.status, 401, change.body);
    assert.equal(change.json?.twoFactorRequired, true);
  });

  // ── e-mail change ──────────────────────────────────────────────────────────

  await t.test('e-mail change: step-up, link to the new address, notice to the old one', async () => {
    const { r, cookie } = await login('carol', password);
    assert.equal(r.status, 200, r.body);
    const sess = cookieOf(r) ?? cookie!;
    const put = await send(port, 'PUT', '/api/profile', { cookie: sess, body: { email: 'carol.direct@example.com' } });
    assert.equal(put.status, 409, put.body);
    assert.equal(put.json?.code, 'emailChangeRequiresConfirmation');
    assert.equal((await send(port, 'PUT', '/api/profile', { cookie: sess, body: { email: 'carol@example.com', displayName: 'Carol' } })).status, 200, 'resending the same address is fine');

    const carolMailsBefore = mails.filter((m) => m.to === 'carol@example.com').length;
    const noProof = await send(port, 'POST', '/api/profile/email', { cookie: sess, body: { email: 'carol2@example.com' } });
    assert.equal(noProof.status, 401);
    assert.equal(noProof.json?.passwordRequired, true);
    const taken = await send(port, 'POST', '/api/profile/email', { cookie: sess, body: { email: 'ALICE@example.com', stepUpPassword: password } });
    assert.equal(taken.status, 409, taken.body);
    const req = await send(port, 'POST', '/api/profile/email', { cookie: sess, body: { email: 'Carol2@Example.com', stepUpPassword: password } });
    assert.equal(req.status, 200, req.body);
    assert.equal(req.json?.data?.status, 'pending');
    assert.equal(req.json?.data?.state?.pending?.email, 'carol2@example.com');
    assert.equal(req.json?.data?.state?.email, 'carol@example.com', 'unchanged until confirmed');
    const link = tokenIn((await waitMail('carol2@example.com', 1))[0].text, '/confirm-email');
    assert.ok(link.url.startsWith('https://client.example.com/'));
    const old = await waitMail('carol@example.com', carolMailsBefore + 1);
    assert.ok(old.some((m) => m.text.includes('carol2@example.com')), 'the current address is told');

    const ok = await send(port, 'POST', '/api/auth/email-change/confirm', { body: { token: link.token } });
    assert.equal(ok.status, 200, ok.body);
    const u = await db('users').where({ id: carol }).first('email', 'email_verified_for');
    assert.deepEqual([u.email, u.email_verified_for], ['carol2@example.com', 'carol2@example.com']);
    assert.equal((await send(port, 'POST', '/api/auth/email-change/confirm', { body: { token: link.token } })).json?.code, 'invalidToken');
    assert.ok(await db('audit_logs').where({ action: 'user.email_changed', user_id: carol }).first('id'));
    assert.ok(await db('user_notifications').where({ user_id: carol, event: 'account.emailChanged' }).first('id'));
    const prof = await send(port, 'GET', '/api/profile', { cookie: sess });
    assert.equal(prof.json?.data?.emailVerified, true);

    // The reset now follows the new address only.
    await db('user_action_tokens').delete();
    assert.equal(await identityService.requestPasswordReset('carol@example.com', null), 'ignored');
    assert.equal(await identityService.requestPasswordReset('carol2@example.com', null), 'sent');
  });

  await t.test('an Obligate account never changes its address here', async () => {
    const fake = { session: { userId: ogBob, currentTenantId: A }, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    await assert.rejects(identityService.requestEmailChange(fake, 'bob2@example.com'), (e: { statusCode?: number; code?: string }) => e.statusCode === 403 && e.code === 'ssoEmailManaged');
  });

  await t.test('without an e-mail sender: applied but unverified, no reset link ever goes to it', async () => {
    await senderOn(false);
    const fake = { session: { userId: dave, currentTenantId: A }, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    const r = await identityService.requestEmailChange(fake, 'dave2@example.com');
    assert.equal(r.status, 'changed');
    assert.equal(r.state.verified, false);
    await senderOn(true);
    assert.equal(await identityService.requestPasswordReset('dave2@example.com', null), 'ignored');
    // Verifying it later (link to the current address) makes it eligible.
    const v = await identityService.requestEmailChange(fake, 'dave2@example.com');
    assert.equal(v.status, 'pending');
    const { token } = tokenIn(lastMailTo('dave2@example.com')!.text, '/confirm-email');
    await identityService.confirmEmailChange(token, null);
    assert.equal(await identityService.requestPasswordReset('dave2@example.com', null), 'sent');
    assert.ok(await db('audit_logs').where({ action: 'user.email_verified', user_id: dave }).first('id'));
  });
});
