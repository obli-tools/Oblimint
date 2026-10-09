import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import nodemailer from 'nodemailer';
import {
  addressRange, hostNameProblem, isPublicAddress, resolvePublicHttpsTarget, resolveSmtpHost, SsrfError, type LookupFn,
} from './notifications/ssrf';
import { escapeHtml, plainText, sendToChannel, type PluginDeps, type RenderedNotification } from './notifications/plugins';
import { requestJson } from './notifications/http';
import { deliveryErrorText, toChannel } from './notifications.service';
import { SecretBoxError } from '../../utils/secretBox';

// Notification channels: anti-SSRF guard (invariant N1), each plugin against
// fakes (local HTTP server, nodemailer jsonTransport), secret masking.

const fakeLookup = (table: Record<string, string[]>): LookupFn => async (host) => {
  const a = table[host];
  if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const DNS = fakeLookup({
  'hooks.example.com': ['93.184.216.34'],
  'v6.example.com': ['2606:2800:220:1:248:1893:25c8:1946'],
  'rebind.example.com': ['93.184.216.34', '10.0.0.5'],
  'meta.example.com': ['169.254.169.254'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
  'cgnat.example.com': ['100.64.1.1'],
  'relay.corp-mail.net': ['192.168.10.25'],
  'smtp.example.net': ['185.70.41.25'],
  'oblimint-postgres': ['172.18.0.2'],
});

test('address ranges: only global unicast is public', () => {
  for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:7f00:1::1', 'ff02::1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(addressRange('[::1]'), 'loopback');
  assert.equal(addressRange('not-an-ip'), null);
});

test('host names: single label and internal suffixes refused', () => {
  for (const h of ['localhost', 'intranet', 'printer.local', 'db.internal', 'x.localhost', 'nas.lan', 'box.home.arpa', 'a.localdomain']) {
    assert.ok(hostNameProblem(h), h);
  }
  assert.equal(hostNameProblem('hooks.example.com'), null);
  assert.equal(hostNameProblem('example.com.'), null);
});

test('webhook URL guard: table of URLs', async () => {
  const ok = await resolvePublicHttpsTarget('https://hooks.example.com/x?y=1', DNS);
  assert.deepEqual([ok.address, ok.family, ok.url.hostname], ['93.184.216.34', 4, 'hooks.example.com']);
  assert.equal((await resolvePublicHttpsTarget('https://v6.example.com/', DNS)).family, 6);
  assert.equal((await resolvePublicHttpsTarget('https://93.184.216.34:8443/', DNS)).address, '93.184.216.34');

  const refused = [
    'http://hooks.example.com/',            // https only
    'ftp://hooks.example.com/',
    'https://user:pw@hooks.example.com/',   // credentials
    'https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.1/', 'https://172.16.5.4/', 'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://[fd00::1]/', 'https://[fe80::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://0.0.0.0/',
    'https://0x7f.1/', 'https://2130706433/',  // WHATWG URL normalizes to 127.0.0.1
    'https://localhost/', 'https://intranet/', 'https://printer.local/', 'https://db.internal/',
    'https://rebind.example.com/',            // one private answer among public ones
    'https://meta.example.com/', 'https://mapped.example.com/', 'https://cgnat.example.com/',
    'https://unknown.example.com/',           // unresolvable
    'not a url',
  ];
  for (const u of refused) {
    await assert.rejects(resolvePublicHttpsTarget(u, DNS), SsrfError, u);
  }
});

test('SMTP host policy: private relay for the operator, loopback for the platform admin only', async () => {
  const tenant = { allowPrivate: false, allowLoopback: false, lookup: DNS };
  const operator = { allowPrivate: true, allowLoopback: false, lookup: DNS };
  const admin = { allowPrivate: true, allowLoopback: true, lookup: DNS };
  assert.equal((await resolveSmtpHost('smtp.example.net', tenant)).address, '185.70.41.25');
  await assert.rejects(resolveSmtpHost('relay.corp-mail.net', tenant), SsrfError);
  assert.equal((await resolveSmtpHost('relay.corp-mail.net', operator)).address, '192.168.10.25');
  assert.equal((await resolveSmtpHost('oblimint-postgres', operator)).address, '172.18.0.2');
  await assert.rejects(resolveSmtpHost('oblimint-postgres', tenant), SsrfError);
  await assert.rejects(resolveSmtpHost('127.0.0.1', operator), SsrfError);
  await assert.rejects(resolveSmtpHost('localhost', operator), SsrfError);
  assert.equal((await resolveSmtpHost('127.0.0.1', admin)).address, '127.0.0.1');
  assert.equal((await resolveSmtpHost('localhost', admin)).address, '127.0.0.1');
  for (const p of [tenant, operator, admin]) {
    await assert.rejects(resolveSmtpHost('169.254.169.254', p), SsrfError);
    await assert.rejects(resolveSmtpHost('meta.example.com', p), SsrfError);
    await assert.rejects(resolveSmtpHost('0.0.0.0', p), SsrfError);
  }
});

// ── Plugins against a local HTTP server ─────────────────────────────────────

interface Hit { method: string; url: string; host: string; headers: http.IncomingHttpHeaders; body: unknown }
const hits: Hit[] = [];
let failNext = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let body: unknown = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* raw */ }
    hits.push({ method: req.method ?? '', url: req.url ?? '', host: String(req.headers.host ?? ''), headers: req.headers, body });
    if (failNext > 0) { failNext--; res.writeHead(500); res.end('nope'); return; }
    res.writeHead(req.url?.includes('/redirect') ? 302 : 204, req.url?.includes('/redirect') ? { location: 'http://169.254.169.254/' } : {});
    res.end();
  });
});
const ready = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
after(() => new Promise<void>((r) => server.close(() => r())));

/** Test deps: every URL is "resolved" to the local server (http allowed only here). */
async function testDeps(extra: Partial<PluginDeps> = {}): Promise<PluginDeps> {
  const port = await ready;
  return {
    resolveTarget: async (url) => {
      const u = new URL(url);
      if (u.protocol === 'https:') { u.protocol = 'http:'; }
      u.port = String(port);
      return { url: u, address: '127.0.0.1', family: 4 };
    },
    smtpTransport: () => nodemailer.createTransport({ jsonTransport: true }) as never,
    telegramApiBase: `http://api.telegram.test:${port}`,
    timeoutMs: 2000,
    deadlineMs: 5000,
    lookup: DNS,
    ...extra,
  };
}

const N: RenderedNotification = {
  event: 'quota.exceeded', eventLabel: 'Quota dépassé', title: 'Compte <b>shop</b> : quota disque dépassé (100 %)',
  message: 'Le compte « shop » utilise 5,0 Gio sur 5,0 Gio.\n@everyone', severity: 'critical', url: 'https://panel.example.com/accounts/3?tab=usage',
  tenantId: 2, accountId: 3, key: 'k', timestamp: '2026-10-09T10:00:00.000Z',
};
const POLICY = { allowPrivate: false, allowLoopback: false };

test('webhook plugin: JSON body, method, secret header, pinned address keeps the Host', async () => {
  hits.length = 0;
  await sendToChannel({ type: 'webhook', url: 'https://hooks.example.com/in/abc', method: 'PUT', headerName: 'Authorization', headerValue: null },
    { headerValue: 'Bearer s3cr3t' }, N, await testDeps(), POLICY);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.method, 'PUT');
  assert.equal(h.url, '/in/abc');
  assert.match(h.host, /^hooks\.example\.com/, 'connected to the pinned address, Host header kept');
  assert.equal(h.headers.authorization, 'Bearer s3cr3t');
  assert.equal(h.headers['content-type'], 'application/json');
  const b = h.body as Record<string, unknown>;
  assert.equal(b.event, 'quota.exceeded');
  assert.equal(b.severity, 'critical');
  assert.equal(b.accountId, 3);
  assert.equal(b.url, N.url);
});

test('webhook plugin: non-2xx and redirects are failures (never followed)', async () => {
  hits.length = 0;
  failNext = 1;
  await assert.rejects(sendToChannel({ type: 'webhook', url: 'https://hooks.example.com/x', method: 'POST' }, {}, N, await testDeps(), POLICY), /HTTP 500/);
  await assert.rejects(sendToChannel({ type: 'webhook', url: 'https://hooks.example.com/redirect', method: 'POST' }, {}, N, await testDeps(), POLICY), /HTTP 302/);
  assert.equal(hits.length, 2, 'the redirect target was not requested');
});

test('webhook plugin: the real guard refuses a private destination at send time', async () => {
  const deps = await testDeps({ resolveTarget: (url) => resolvePublicHttpsTarget(url, DNS) });
  await assert.rejects(sendToChannel({ type: 'webhook', url: 'https://rebind.example.com/', method: 'POST' }, {}, N, deps, POLICY), SsrfError);
  await assert.rejects(sendToChannel({ type: 'webhook', url: 'http://hooks.example.com/', method: 'POST' }, {}, N, deps, POLICY), SsrfError);
});

test('discord plugin: embed, mentions disabled', async () => {
  hits.length = 0;
  await sendToChannel({ type: 'discord', webhookUrl: null }, { webhookUrl: 'https://discord.com/api/webhooks/1/tok' }, N, await testDeps(), POLICY);
  const b = hits[0].body as { username: string; allowed_mentions: { parse: unknown[] }; embeds: Array<Record<string, unknown>> };
  assert.equal(hits[0].url, '/api/webhooks/1/tok');
  assert.deepEqual(b.allowed_mentions, { parse: [] });
  assert.equal(b.username, 'Oblimint');
  assert.match(String(b.embeds[0].title), /quota disque dépassé/);
  assert.equal(b.embeds[0].color, 0xe03a3a);
  assert.equal(b.embeds[0].url, N.url);
  await assert.rejects(sendToChannel({ type: 'discord' }, {}, N, await testDeps(), POLICY), /absente/);
});

test('telegram plugin: bot API path, plain text, the token never in an error', async () => {
  hits.length = 0;
  const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc';
  await sendToChannel({ type: 'telegram', botToken: null, chatId: '-100123' }, { botToken: token }, N, await testDeps(), POLICY);
  assert.equal(hits[0].url, `/bot${token}/sendMessage`);
  const b = hits[0].body as Record<string, unknown>;
  assert.equal(b.chat_id, '-100123');
  assert.equal(b.parse_mode, undefined);
  assert.match(String(b.text), /Le compte « shop » utilise/);
  failNext = 1;
  const err = await sendToChannel({ type: 'telegram', chatId: '1' }, { botToken: token }, N, await testDeps(), POLICY).catch((e) => e as Error);
  assert.ok(err instanceof Error);
  assert.ok(!deliveryErrorText(err).includes(token));
});

test('smtp plugin: message through nodemailer (jsonTransport), pinned host, TLS name kept', async () => {
  let options: Record<string, unknown> = {};
  let sent: { message: string } | null = null;
  const deps = await testDeps({
    smtpTransport: (o) => {
      options = o;
      const t = nodemailer.createTransport({ jsonTransport: true });
      return { sendMail: async (m) => { sent = await t.sendMail(m as never) as unknown as { message: string }; return sent; } };
    },
  });
  await sendToChannel({
    type: 'smtp', host: 'smtp.example.net', port: 587, secure: false, username: 'mailer', password: null,
    from: 'Oblimint <noreply@example.net>', to: ['ops@example.org', 'boss@example.org'],
  }, { password: 'pw' }, N, deps, POLICY);
  assert.equal(options.host, '185.70.41.25');
  assert.deepEqual(options.tls, { servername: 'smtp.example.net' });
  assert.deepEqual(options.auth, { user: 'mailer', pass: 'pw' });
  const msg = JSON.parse(sent!.message) as { subject: string; text: string; html: string; to: Array<{ address: string }> };
  assert.equal(msg.subject, '[Oblimint] Compte <b>shop</b> : quota disque dépassé (100 %)');
  assert.deepEqual(msg.to.map((t) => t.address), ['ops@example.org', 'boss@example.org']);
  assert.match(msg.text, /Ouvrir dans le panel : https:\/\/panel\.example\.com/);
  assert.ok(msg.html.includes('Compte &lt;b&gt;shop&lt;/b&gt;'), 'HTML escaped');
  assert.ok(!msg.html.includes('<b>shop</b>'));
  // A private relay is refused for a tenant channel.
  await assert.rejects(sendToChannel({ type: 'smtp', host: 'relay.corp-mail.net', port: 25, secure: false, username: null, from: 'a@b.cd', to: ['x@y.zz'] },
    {}, N, deps, POLICY), SsrfError);
});

test('requestJson: timeout and connection errors carry no URL', async () => {
  const silent = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const port = (silent.address() as AddressInfo).port;
  try {
    const u = new URL(`http://secret-host.example:${port}/bot123:SECRET/sendMessage`);
    const err = (await requestJson({ url: u, address: '127.0.0.1', family: 4 }, { method: 'POST', body: {}, timeoutMs: 200 }).catch((e: unknown) => e)) as Error;
    assert.match(String(err.message), /timed out/);
    assert.ok(!String(err.message).includes('SECRET'));
  } finally {
    silent.closeAllConnections?.();
    await new Promise<void>((r) => silent.close(() => r()));
  }
  const refused = (await requestJson({ url: new URL('http://x.example:1/bot1:SECRET'), address: '127.0.0.1', family: 4 }, { method: 'POST', body: {} }).catch((e: unknown) => e)) as Error;
  assert.match(String(refused.message), /connection failed/);
  assert.ok(!String(refused.message).includes('SECRET'));
});

test('requestJson: hard deadline against a trickling endpoint, body cut at 1 KiB', async () => {
  const timers: NodeJS.Timeout[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('x'.repeat(2048));
      // never ends: the client must answer from the first KiB and cut the rest
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    // one byte every 50 ms: never idle for 200 ms, never finished
    timers.push(setInterval(() => res.write('.'), 50));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    const err = (await requestJson({ url: new URL(`http://hooks.example:${port}/trickle`), address: '127.0.0.1', family: 4 },
      { method: 'POST', body: {}, timeoutMs: 200, deadlineMs: 400 }).catch((e: unknown) => e)) as Error;
    assert.match(String(err.message), /timed out/);
    assert.ok(Date.now() - started < 2_000, 'the deadline ends the request');
    const big = await requestJson({ url: new URL(`http://hooks.example:${port}/big`), address: '127.0.0.1', family: 4 },
      { method: 'POST', body: {}, timeoutMs: 5_000, deadlineMs: 5_000 });
    assert.equal(big.status, 200);
    assert.equal(big.body.length, 1024);
  } finally {
    for (const t of timers) clearInterval(t);
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('smtp plugin: a stalled send ends at the deadline and closes the transport', async () => {
  let closed = 0;
  const deps = await testDeps({
    deadlineMs: 100,
    smtpTransport: () => ({ sendMail: () => new Promise(() => { /* stalled server */ }), close: () => { closed++; } }),
  });
  const err = await sendToChannel({ type: 'smtp', host: 'smtp.example.net', port: 587, secure: false, username: null, from: 'a@b.cd', to: ['x@y.zz'] },
    {}, N, deps, POLICY).catch((e: unknown) => e as Error);
  assert.match(String((err as Error).message), /timed out/);
  assert.ok(closed >= 1);
});

test('rendering helpers', () => {
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;');
  const t = plainText({ ...N, url: null });
  assert.ok(t.startsWith('🚨 Compte <b>shop</b>'));
  assert.ok(!t.includes('Ouvrir dans le panel'));
  assert.ok(!/\n\n\n/.test(t));
  assert.equal(deliveryErrorText(new SecretBoxError('x')), 'Secrets illisibles (clé du panel changée) : ressaisissez-les');
  assert.match(deliveryErrorText(new SsrfError('refused destination (loopback address)')), /^Destination refusée/);
  assert.equal(deliveryErrorText(Object.assign(new Error('Invalid login'), { responseCode: 535 })), 'SMTP 535: Invalid login');
});

test('secret masking: secrets never returned, secretsSet listed', () => {
  const now = new Date();
  const base = { id: 1, tenant_id: 2, name: 'c', enabled: true, last_sent_at: null, last_error: null, created_at: now, updated_at: now, secrets: 'v1:sealed' };
  const discord = toChannel({ ...base, type: 'discord', config: { type: 'discord', __secretsSet: ['webhookUrl'] }, events: ['quota.exceeded', 'bogus'] });
  assert.deepEqual(discord.config, { type: 'discord', webhookUrl: null });
  assert.deepEqual(discord.secretsSet, ['webhookUrl']);
  assert.deepEqual(discord.events, ['quota.exceeded']);
  const smtp = toChannel({ ...base, type: 'smtp', config: { type: 'smtp', host: 'h.example', port: 25, secure: false, username: 'u', from: 'a@b.cd', to: ['x@y.zz'], __secretsSet: [] }, events: [] });
  assert.equal((smtp.config as { password?: unknown }).password, null);
  assert.deepEqual(smtp.secretsSet, []);
  assert.ok(!JSON.stringify(smtp).includes('sealed'));
});
