import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { RELAY_TEST_RECIPIENT, RELAY_TEST_SENDER, runRelayTest } from './relayTest';

interface FakeSmtpOptions {
  /** Answer to RCPT TO an external address without AUTH. */
  rcptExternal: string;
  /** EHLO capability lines (after the greeting line). */
  caps: string[];
  /** Answer to MAIL FROM (default 250). */
  mailFrom?: string;
  /** Answer to MAIL FROM per connection number (1-based), overrides mailFrom. */
  mailFromFor?: (conn: number) => string;
}

/** Minimal SMTP server: records every command, never accepts DATA. */
function fakeSmtp(opts: FakeSmtpOptions): Promise<{ port: number; commands: string[]; close: () => Promise<void> }> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  let conns = 0;
  const server = net.createServer((sock) => {
    const conn = ++conns;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('latin1');
    sock.write('220 mx.test ESMTP\r\n');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          const all = ['mx.test', ...opts.caps];
          sock.write(all.map((c, k) => `250${k === all.length - 1 ? ' ' : '-'}${c}\r\n`).join(''));
        } else if (verb === 'MAIL') sock.write(`${opts.mailFromFor?.(conn) ?? opts.mailFrom ?? '250 2.1.0 Ok'}\r\n`);
        else if (verb === 'RCPT') sock.write(`${opts.rcptExternal}\r\n`);
        else if (verb === 'DATA') sock.write('554 never\r\n');
        else if (verb === 'RSET') sock.write('250 Ok\r\n');
        else if (verb === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('502 unknown\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    commands,
    close: () => new Promise((r) => { for (const k of sockets) k.destroy(); server.close(() => r()); }),
  })));
}

/** A free port with nothing listening (connection refused). */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('relay test: a closed relay passes every check, no DATA ever sent', async () => {
  const mx = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: ['PIPELINING', 'SIZE 52428800'] });
  const sub = await fakeSmtp({ rcptExternal: '530 5.7.0 Must issue a STARTTLS command first', caps: ['STARTTLS', 'SIZE 52428800'] });
  try {
    const r = await runRelayTest({
      host: '127.0.0.1',
      ports: { smtp: mx.port, submission: sub.port, siteRelay: await closedPort(), engineRelay: await closedPort() },
      localDomain: 'exemple.fr',
      timeoutMs: 3000,
    });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.deepEqual(r.checks.map((c) => c.id), ['unauthRelay', 'senderMismatch', 'submissionNoTls', 'submissionNoAuth', 'relayPort']);
    assert.ok(r.checks.every((c) => c.passed));
    for (const cmds of [mx.commands, sub.commands]) {
      assert.ok(!cmds.some((c) => c.toUpperCase().startsWith('DATA')), 'DATA never sent');
      assert.ok(!cmds.some((c) => c.toUpperCase().startsWith('AUTH')), 'never authenticates');
    }
    assert.ok(mx.commands.includes('MAIL FROM:<postmaster@exemple.fr>'), 'spoofed local sender tried');
    assert.ok(mx.commands.includes('RSET') && mx.commands.includes('QUIT'));
  } finally {
    await mx.close();
    await sub.close();
  }
});

test('relay test: open relay, AUTH in clear and reachable internal ports are detected', async () => {
  const open = await fakeSmtp({ rcptExternal: '250 2.1.5 Ok', caps: ['AUTH PLAIN LOGIN', 'STARTTLS'] });
  // Accepts then drops every connection (an internal port wrongly reachable).
  const internal = net.createServer((s) => { s.on('error', () => {}); s.destroy(); });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
  try {
    const r = await runRelayTest({
      host: '127.0.0.1',
      ports: { smtp: open.port, submission: open.port, siteRelay: (internal.address() as net.AddressInfo).port, engineRelay: await closedPort() },
      localDomain: null,
      timeoutMs: 3000,
    });
    assert.equal(r.ok, false);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(by.unauthRelay.passed, false);
    assert.match(by.unauthRelay.detail, /relais ouvert/);
    assert.equal(by.senderMismatch, undefined, 'skipped without a local domain');
    assert.equal(by.submissionNoTls.passed, false);
    assert.equal(by.submissionNoAuth.passed, false);
    assert.equal(by.relayPort.passed, false);
    assert.ok(!open.commands.some((c) => c.toUpperCase().startsWith('DATA')));
  } finally {
    await open.close();
    await new Promise<void>((r) => internal.close(() => r()));
  }
});

test('relay test: closed public ports are not an open relay', async () => {
  const p = await closedPort();
  const r = await runRelayTest({ host: '127.0.0.1', ports: { smtp: p, submission: p, siteRelay: p, engineRelay: p }, localDomain: null, timeoutMs: 2000 });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.target, '127.0.0.1');
});

test('relay test: inconclusive answers are never green (4xx, sender refused before the relay decision)', async () => {
  const run = async (mx: { port: number }, sub: { port: number }) => runRelayTest({
    host: '127.0.0.1',
    ports: { smtp: mx.port, submission: sub.port, siteRelay: await closedPort(), engineRelay: await closedPort() },
    localDomain: 'exemple.fr',
    timeoutMs: 3000,
    retryWindowMs: 0,
  });
  // Milter restarting: 451 at MAIL FROM on every port (seen on the Linux test host, reported green before).
  const tmp = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: [], mailFrom: '451 4.7.1 Service unavailable - try again later' });
  try {
    const r = await run(tmp, tmp);
    assert.equal(r.ok, false);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    for (const id of ['unauthRelay', 'senderMismatch', 'submissionNoAuth']) {
      assert.equal(by[id].passed, false, id);
      assert.match(by[id].detail, /non concluant/);
    }
  } finally { await tmp.close(); }

  // Sender refused (null MX, 550 5.7.27): proves nothing about relaying on 25,
  // but on 587 without AUTH (530) the refusal IS the protection.
  const nullMx = await fakeSmtp({ rcptExternal: '250 2.1.5 Ok', caps: [], mailFrom: '550 5.7.27 Sender address has null MX' });
  const sub = await fakeSmtp({ rcptExternal: '250 2.1.5 Ok', caps: ['STARTTLS'], mailFrom: '530 5.7.0 Authentication required' });
  try {
    const r = await run(nullMx, sub);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(by.unauthRelay.passed, false);
    assert.match(by.unauthRelay.detail, /avant la décision de relais/);
    assert.equal(by.senderMismatch.passed, true, 'spoofed local sender refused');
    assert.equal(by.submissionNoAuth.passed, true);
    assert.ok(!nullMx.commands.some((c) => c.startsWith('RCPT')));
  } finally { await nullMx.close(); await sub.close(); }

  // RCPT refused temporarily (greylisting): not a proof either.
  const grey = await fakeSmtp({ rcptExternal: '450 4.2.0 Greylisted', caps: [] });
  try {
    const r = await run(grey, grey);
    const c = r.checks.find((x) => x.id === 'unauthRelay')!;
    assert.equal(c.passed, false);
    assert.match(c.detail, /5xx est attendu/);
  } finally { await grey.close(); }
});

test('relay test: default external addresses have real MX records (not the null-MX example.* domains)', async () => {
  for (const a of [RELAY_TEST_SENDER, RELAY_TEST_RECIPIENT]) assert.doesNotMatch(a, /@example\.(com|net|org)$/);
  const mx = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: [] });
  try {
    await runRelayTest({ host: '127.0.0.1', ports: { smtp: mx.port, submission: await closedPort(), siteRelay: await closedPort(), engineRelay: await closedPort() }, localDomain: null, timeoutMs: 3000 });
    assert.ok(mx.commands.includes(`MAIL FROM:<${RELAY_TEST_SENDER}>`));
    assert.ok(mx.commands.includes(`RCPT TO:<${RELAY_TEST_RECIPIENT}>`));
  } finally { await mx.close(); }
});

test('relay test: a temporary refusal (milter restarting) is retried within the window, then judged on the real answer', async () => {
  // 451 to the first 3 connections (Rspamd restarting after a configuration change), then a closed relay.
  const mx = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: [], mailFromFor: (n) => (n <= 3 ? '451 4.7.1 Service unavailable - try again later' : '250 2.1.0 Ok') });
  const sub = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: ['STARTTLS'], mailFrom: '530 5.7.0 Authentication required' });
  const slept: number[] = [];
  try {
    const r = await runRelayTest({
      host: '127.0.0.1',
      ports: { smtp: mx.port, submission: sub.port, siteRelay: await closedPort(), engineRelay: await closedPort() },
      localDomain: 'exemple.fr',
      timeoutMs: 3000,
      retryWindowMs: 60_000,
      retryDelayMs: 5_000,
      sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.match(by.unauthRelay.detail, /destinataire externe refusé .*\(4 essais\)$/);
    assert.ok(!/essais/.test(by.senderMismatch.detail), 'the milter is back: no retry needed');
    assert.deepEqual(slept, [5_000, 5_000, 5_000]);
    assert.ok(!mx.commands.some((c) => c.toUpperCase().startsWith('DATA')));
  } finally { await mx.close(); await sub.close(); }

  // Still refusing when the window closes: inconclusive, never green; the wait is bounded.
  const down = await fakeSmtp({ rcptExternal: '554 5.7.1 Relay access denied', caps: [], mailFrom: '451 4.7.1 Service unavailable - try again later' });
  const realNow = Date.now;
  const t0 = realNow();
  let clock = 0;
  Date.now = () => t0 + clock;
  try {
    const r = await runRelayTest({
      host: '127.0.0.1',
      ports: { smtp: down.port, submission: down.port, siteRelay: await closedPort(), engineRelay: await closedPort() },
      localDomain: null,
      timeoutMs: 3000,
      retryWindowMs: 12_000,
      retryDelayMs: 5_000,
      sleep: async (ms) => { clock += ms; },
    });
    assert.equal(r.ok, false);
    const c = r.checks.find((x) => x.id === 'unauthRelay')!;
    assert.equal(c.passed, false);
    assert.match(c.detail, /non concluant.*\(3 essais\)$/);
    assert.equal(clock, 10_000, 'bounded by the window (shared by every check)');
  } finally {
    Date.now = realNow;
    await down.close();
  }
});
