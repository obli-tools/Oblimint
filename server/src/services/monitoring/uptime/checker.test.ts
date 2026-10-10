import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net, { type AddressInfo } from 'net';
import { runCheck, statusExpected, MAX_BODY, type CheckTarget } from './checker';
import { assertTargetAllowed, resolveTarget, targetSyntaxProblem, TargetRefusedError } from '../targetGuard';

// Local servers on 127.0.0.1 stand for "public" hosts: the fake resolver maps
// every *.test name to the loopback (the guard itself is tested separately
// with a fake lookup). Every server is closed by the test that starts it.

async function serve(t: TestContext, handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return (server.address() as AddressInfo).port;
}

const resolved: string[] = [];
const deps = {
  async resolve(host: string) {
    resolved.push(host);
    if (host === 'private.test') throw new TargetRefusedError('destination refused (address not allowed)');
    return { address: '127.0.0.1', family: 4 as const };
  },
};

const target = (over: Partial<CheckTarget>): CheckTarget => ({
  kind: 'http', url: null, host: null, port: null, keyword: null, keywordInvert: false, method: 'GET', expectedStatus: [200], timeoutMs: 3000, ...over,
});

test('expected statuses: explicit list, empty = 2xx / 3xx', () => {
  assert.equal(statusExpected(200, [200]), true);
  assert.equal(statusExpected(204, [200]), false);
  assert.equal(statusExpected(301, []), true);
  assert.equal(statusExpected(404, []), false);
});

test('http: up, unexpected status, latency, pinned connection to the resolved address', async (t) => {
  const port = await serve(t, (req, res) => {
    if (req.url === '/down') { res.writeHead(503); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host=${req.headers.host}`);
  });
  const up = await runCheck(target({ url: `http://site.test:${port}/` }), deps);
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.statusCode, 200);
  assert.ok(up.latencyMs !== null && up.latencyMs >= 0);
  assert.equal(resolved.at(-1), 'site.test');
  const down = await runCheck(target({ url: `http://site.test:${port}/down` }), deps);
  assert.deepEqual([down.ok, down.statusCode, down.error], [false, 503, 'unexpected status 503']);
});

test('keyword: present / absent / inverted, body read at most 1 MiB', async (t) => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200);
    if (req.url === '/big') {
      // 2 MiB of filler then the keyword: beyond the cap, never seen.
      res.write(Buffer.alloc(2 * MAX_BODY, 'a'));
      res.end('NEEDLE');
      return;
    }
    res.end('<html>status: ALL GOOD</html>');
  });
  const url = `http://site.test:${port}/`;
  assert.equal((await runCheck(target({ kind: 'keyword', url, keyword: 'ALL GOOD' }), deps)).ok, true);
  const missing = await runCheck(target({ kind: 'keyword', url, keyword: 'ERROR' }), deps);
  assert.deepEqual([missing.ok, missing.error], [false, 'keyword not found']);
  assert.equal((await runCheck(target({ kind: 'keyword', url, keyword: 'ERROR', keywordInvert: true }), deps)).ok, true);
  const inverted = await runCheck(target({ kind: 'keyword', url, keyword: 'ALL GOOD', keywordInvert: true }), deps);
  assert.deepEqual([inverted.ok, inverted.error], [false, 'keyword found']);
  const big = await runCheck(target({ kind: 'keyword', url: `${url}big`, keyword: 'NEEDLE' }), deps);
  assert.deepEqual([big.ok, big.error], [false, 'keyword not found']);
});

test('redirects: followed up to 5, each hop re-resolved through the guard, refused hop fails', async (t) => {
  let port = 0;
  port = await serve(t, (req, res) => {
    const m = /^\/r(\d+)$/.exec(req.url ?? '');
    if (m) {
      const n = Number(m[1]);
      res.writeHead(302, { location: n > 0 ? `/r${n - 1}` : '/ok' });
      res.end();
      return;
    }
    if (req.url === '/to-private') { res.writeHead(301, { location: `http://private.test:${port}/ok` }); res.end(); return; }
    if (req.url === '/to-file') { res.writeHead(301, { location: 'file:///etc/passwd' }); res.end(); return; }
    res.writeHead(200);
    res.end('ok');
  });
  const base = `http://site.test:${port}`;
  const five = await runCheck(target({ url: `${base}/r4` }), deps); // r4 → r3 → r2 → r1 → r0 → ok = 5 redirects
  assert.equal(five.ok, true, JSON.stringify(five));
  const six = await runCheck(target({ url: `${base}/r5` }), deps);
  assert.deepEqual([six.ok, six.error], [false, 'too many redirects']);
  const priv = await runCheck(target({ url: `${base}/to-private` }), deps);
  assert.deepEqual([priv.ok, priv.error], [false, 'destination refused']);
  const file = await runCheck(target({ url: `${base}/to-file` }), deps);
  assert.deepEqual([file.ok, file.error], [false, 'unsupported redirect']);
  // Auto monitors (expected [] = 2xx / 3xx) follow the redirect to its final answer.
  const redirectOnly = await runCheck(target({ url: `${base}/r0`, expectedStatus: [] }), deps);
  assert.equal(redirectOnly.ok, true);
});

test('timeouts and refused connections give generic errors', async (t) => {
  const port = await serve(t, () => { /* never answers */ });
  const slow = await runCheck(target({ url: `http://site.test:${port}/`, timeoutMs: 600 }), deps);
  assert.deepEqual([slow.ok, slow.error], [false, 'timed out']);
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const freePort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const refused = await runCheck(target({ url: `http://site.test:${freePort}/` }), deps);
  assert.deepEqual([refused.ok, refused.error], [false, 'connection refused']);
  const slowDns = await runCheck(target({ url: 'http://site.test/', timeoutMs: 600 }), { resolve: () => new Promise(() => { /* hangs */ }) });
  assert.deepEqual([slowDns.ok, slowDns.error], [false, 'timed out']);
  const creds = await runCheck(target({ url: `http://u:p@site.test:${port}/` }), deps);
  assert.deepEqual([creds.ok, creds.error], [false, 'credentials in the URL are not allowed']);
});

test('tcp: connect ok / refused / refused destination', async (t) => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const ok = await runCheck(target({ kind: 'tcp', host: 'db.test', port }), deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.statusCode, null);
  const priv = await runCheck(target({ kind: 'tcp', host: 'private.test', port }), deps);
  assert.deepEqual([priv.ok, priv.error], [false, 'destination refused']);
});

test('anti-SSRF guard: every resolved address public; private only when allowed; never loopback / link local', async () => {
  const lookup = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const l = lookup({
    'public.example': ['93.184.216.34'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
    'rebind.example': ['169.254.169.254'],
    'lan.example': ['192.168.1.10'],
    'v6.example': ['2606:2800:220:1:248:1893:25c8:1946'],
    'v6local.example': ['fd00::1'],
    'mapped.example': ['::ffff:127.0.0.1'],
  });
  assert.deepEqual(await resolveTarget('public.example', { allowPrivate: false, lookup: l }), { address: '93.184.216.34', family: 4 });
  await assert.rejects(resolveTarget('mixed.example', { allowPrivate: false, lookup: l }), TargetRefusedError, 'one private answer refuses');
  await assert.rejects(resolveTarget('rebind.example', { allowPrivate: true, lookup: l }), TargetRefusedError, 'metadata never');
  await assert.rejects(resolveTarget('lan.example', { allowPrivate: false, lookup: l }), TargetRefusedError);
  assert.equal((await resolveTarget('lan.example', { allowPrivate: true, lookup: l })).address, '192.168.1.10');
  assert.equal((await resolveTarget('v6.example', { allowPrivate: false, lookup: l })).family, 6);
  await assert.rejects(resolveTarget('v6local.example', { allowPrivate: false, lookup: l }), TargetRefusedError);
  await assert.rejects(resolveTarget('mapped.example', { allowPrivate: true, lookup: l }), TargetRefusedError, 'IPv4-mapped loopback');
  await assert.rejects(resolveTarget('127.0.0.1', { allowPrivate: true, lookup: l }), TargetRefusedError, 'loopback never');
  await assert.rejects(resolveTarget('[::1]', { allowPrivate: true, lookup: l }), TargetRefusedError);
  await assert.rejects(resolveTarget('localhost', { allowPrivate: false, lookup: l }), TargetRefusedError);
  await assert.rejects(resolveTarget('nas.local', { allowPrivate: false, lookup: l }), TargetRefusedError);
  await assert.rejects(resolveTarget('nothing.example', { allowPrivate: false, lookup: l }), TargetRefusedError, 'no answer');
  assert.equal(targetSyntaxProblem('oblimint-edge', true), null, 'Docker names for platform rows');
  assert.equal(targetSyntaxProblem('oblimint-edge', false), 'internal host name');
  assert.equal(targetSyntaxProblem('bad_host!', false), 'invalid host name');
  // Save time: a DNS failure is not a refusal, a private answer is.
  await assertTargetAllowed('nothing.example', { allowPrivate: false, lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  await assert.rejects(assertTargetAllowed('lan.example', { allowPrivate: false, lookup: l }), TargetRefusedError);
  await assert.rejects(assertTargetAllowed('10.1.2.3', { allowPrivate: false, lookup: l }), TargetRefusedError);
});
