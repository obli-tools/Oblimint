import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { parseImageRef } from './compose/image';
import { MANIFEST_ACCEPT, parseBearerChallenge, remoteDigest, RegistryCheckError } from './registryClient';
import { cloneArgs, gitDetail, gitEnv, gitFailure, lsRemoteArgs, normalizeComposePath, normalizeRepoUrl, parseLsRemote, redactGit, assertBranch, repoPinArgs } from './git';
import { AppError } from '../../middleware/errorHandler';
import { activityOf, SleepManager, WAKE_DEBOUNCE_MS } from './sleep';
import { reconcileDecision, SUSPENDED_MESSAGE } from './worker';
import { INTERRUPTED_MESSAGE } from './deployments';
import { setAppsDepsForTests } from './deps';
import type { EdgeLogEntry } from '../usage/edgeLog';

// Registry v2 digest checks (Docker Hub token flow, OCI index Accept), git command construction (no token
// in args / logs), sleep activity filtering + wake debounce, reconcile decisions.

const D1 = `sha256:${'1'.repeat(64)}`;

type FakeAnswer = { status: number; headers?: Record<string, string | undefined>; body?: unknown };

function fakeFetch(handler: (url: string, init: RequestInit) => FakeAnswer) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers });
  }) as typeof fetch;
  return { f, calls };
}

test('Docker Hub: anonymous token flow, index digest, Accept headers', async () => {
  const { f, calls } = fakeFetch((url, init): FakeAnswer => {
    if (url.startsWith('https://auth.docker.io/token')) return { status: 200, body: { token: 'tkn' } };
    const auth = (init.headers as Record<string, string>).Authorization;
    if (!auth) return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' } };
    assert.equal(auth, 'Bearer tkn');
    return { status: 200, headers: { 'docker-content-digest': D1 } };
  });
  const digest = await remoteDigest({ ref: parseImageRef('nginx:1.27')!, auth: null, fetch: f });
  assert.equal(digest, D1);
  assert.equal(calls[0].url, 'https://registry-1.docker.io/v2/library/nginx/manifests/1.27');
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, MANIFEST_ACCEPT);
  assert.match(MANIFEST_ACCEPT, /oci\.image\.index/);
  assert.match(MANIFEST_ACCEPT, /manifest\.list\.v2/);
  const tokenUrl = new URL(calls[1].url);
  assert.equal(tokenUrl.searchParams.get('service'), 'registry.docker.io');
  assert.equal(tokenUrl.searchParams.get('scope'), 'repository:library/nginx:pull');
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, undefined, 'anonymous token');
});

test('private registry: credentials on the token request, denial reported as auth', async () => {
  const { f, calls } = fakeFetch((url): FakeAnswer => {
    if (url.startsWith('https://ghcr.io/token')) return { status: 200, body: { access_token: 'x' } };
    return url.includes('manifests') && calls.length === 1
      ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } }
      : { status: 200, headers: { 'docker-content-digest': D1 } };
  });
  assert.equal(await remoteDigest({ ref: parseImageRef('ghcr.io/acme/app:2')!, auth: { username: 'bot', password: 'pw' }, fetch: f }), D1);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('bot:pw').toString('base64')}`);
  const denied = fakeFetch((url) => (url.includes('/token') ? { status: 401 } : { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' } }));
  await assert.rejects(remoteDigest({ ref: parseImageRef('ghcr.io/acme/app:2')!, auth: null, fetch: denied.f }), (e: unknown) => e instanceof RegistryCheckError && e.auth);
});

test('HEAD without digest header falls back to GET; 404; invalid realm', async () => {
  let n = 0;
  const { f } = fakeFetch((_url, init) => {
    n++;
    return init.method === 'HEAD' ? { status: 200 } : { status: 200, headers: { 'docker-content-digest': D1 }, body: {} };
  });
  assert.equal(await remoteDigest({ ref: parseImageRef('quay.io/x/y:1')!, auth: null, fetch: f }), D1);
  assert.equal(n, 2);
  const nf = fakeFetch(() => ({ status: 404 }));
  await assert.rejects(remoteDigest({ ref: parseImageRef('nginx:nope')!, auth: null, fetch: nf.f }), /not found/);
  const http = fakeFetch(() => ({ status: 401, headers: { 'www-authenticate': 'Bearer realm="http://evil/token"' } }));
  await assert.rejects(remoteDigest({ ref: parseImageRef('nginx:1')!, auth: null, fetch: http.f }), /not https/);
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://a/t",service="s"'), { realm: 'https://a/t', service: 's', scope: null });
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
});

test('git: hardened commands, the token is never in the arguments', () => {
  const token = 'ghp_SuperSecretToken123';
  const args = cloneArgs('https://github.com/acme/app', 'main', 'src.new');
  const env = gitEnv(token);
  assert.ok(!args.join(' ').includes(token));
  for (const flag of ['protocol.allow=never', 'protocol.https.allow=always', 'core.hooksPath=/dev/null', 'credential.helper=']) assert.ok(args.includes(flag), flag);
  for (const a of ['--depth', '1', '--no-recurse-submodules', '--single-branch', '--']) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf('--') + 1], 'https://github.com/acme/app', 'URL after -- (never parsed as an option)');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.equal(gitEnv(null).GIT_CONFIG_COUNT, undefined);
  assert.ok(!lsRemoteArgs('https://h/r', 'dev').join(' ').includes(token));
  // outputs redacted
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  const out = redactGit(`fatal: auth ${token} header Authorization: Basic ${b64} https://user:${token}@h/r`, token);
  assert.ok(!out.includes(token) && !out.includes(b64));
  const fail = gitFailure({ code: 128, stdout: '', stderr: `remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/app' ${token}` }, token);
  assert.equal(fail.code, 'gitAuthFailed');
  assert.equal(fail.details, undefined, 'no raw git output in the API error (A6)');
  assert.ok(!gitDetail({ code: 128, stdout: '', stderr: `fatal: ${token}` }, token).includes(token));
  assert.equal(gitFailure({ code: 128, stdout: '', stderr: 'Could not resolve host' }, null).code, 'gitUnreachable');
});

test('git: URL / branch / compose path validation', () => {
  assert.equal(normalizeRepoUrl('https://GitHub.com/acme/app.git/'), 'https://github.com/acme/app.git');
  for (const bad of ['http://h/r', 'ssh://git@h/r', 'file:///etc', 'https://u:p@h/r', 'https://h/r?x=1', 'ext::sh -c id']) assert.throws(() => normalizeRepoUrl(bad), bad);
  // anti-SSRF: internal names and non-public literal addresses are refused before any resolution
  for (const bad of ['https://localhost/r', 'https://gitlab/r', 'https://git.internal/r', 'https://127.0.0.1/r', 'https://10.0.0.5/r', 'https://169.254.169.254/r', 'https://10.224.3.4:8443/r', 'https://192.168.1.1/r']) {
    assert.throws(() => normalizeRepoUrl(bad), bad);
  }
  assert.equal(normalizeRepoUrl('https://93.184.216.34/r'), 'https://93.184.216.34/r');
  assert.equal(assertBranch('release/1.2'), 'release/1.2');
  for (const bad of ['-u', 'a..b', 'x@{y}', 'a//b', 'a.', '']) assert.throws(() => assertBranch(bad), bad);
  assert.equal(normalizeComposePath('./deploy/compose.yml'), 'deploy/compose.yml');
  for (const bad of ['../x.yml', '/etc/x', 'a//b.yml']) assert.throws(() => normalizeComposePath(bad), bad);
  assert.equal(parseLsRemote(`${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/mainline\n`, 'main'), 'a'.repeat(40));
  assert.equal(parseLsRemote('', 'main'), null);
});

const entry = (over: Partial<EdgeLogEntry>): EdgeLogEntry => ({
  time: new Date().toISOString(), host: 'h', remoteAddr: '1.2.3.4', method: 'GET', uri: '/', status: 200, bytes: 0, bytesOut: 0, bytesIn: 0,
  requestTime: 0, upstream: null, upstreamStatus: null, userAgent: 'Mozilla/5.0', referer: null, siteId: null, accountId: 1, tenantId: 1, kind: 'proxy',
  appStackId: 9, ...over,
});

test('sleep: robots, monitors and probes are not activity', () => {
  assert.equal(activityOf(entry({})), 9);
  assert.equal(activityOf(entry({ userAgent: 'Googlebot/2.1' })), null);
  assert.equal(activityOf(entry({ userAgent: 'Uptime-Kuma/1.23' })), null);
  assert.equal(activityOf(entry({ userAgent: 'curl/8.0' })), null);
  assert.equal(activityOf(entry({ kind: 'probe' })), null);
  assert.equal(activityOf(entry({ appStackId: null })), null);
});

test('sleep: a 502 on a sleeping stack wakes it, debounced', () => {
  let now = 1_000_000;
  setAppsDepsForTests({ now: () => now });
  try {
    const wakes: number[] = [];
    const m = new SleepManager(async (id) => { wakes.push(id); });
    m.onEntry(entry({ status: 502 }));
    m.onEntry(entry({ status: 503 }));
    m.onEntry(entry({ status: 200 }));
    assert.deepEqual(wakes, [9], 'one wake within the debounce window');
    now += WAKE_DEBOUNCE_MS + 1;
    m.onEntry(entry({ status: 504 }));
    assert.deepEqual(wakes, [9, 9]);
  } finally { setAppsDepsForTests(null); }
});

test('reconcile decisions', () => {
  const eff = { services: [{ name: 'web' }, { name: 'db' }], networks: [], volumes: [], totals: { cpus: 0, memoryMb: 0, containers: 2 } };
  const stack = { status: 'running' as const, desired_state: 'running' as const, status_message: null, effective: eff };
  const c = (state: string, hash = 'h') => ({ State: state, Labels: { 'oblimint.spec-hash': hash } }) as unknown as Docker.ContainerInfo;
  const all = new Map([['web', c('running', 'hw')], ['db', c('running', 'hd')]]);
  const hashes = { web: 'hw', db: 'hd' };
  assert.deepEqual(reconcileDecision(stack, 'active', all, hashes), { action: 'none' });
  assert.deepEqual(reconcileDecision(stack, 'suspended', all, hashes), { action: 'stop', message: SUSPENDED_MESSAGE });
  assert.deepEqual(reconcileDecision(stack, 'deleting', new Map([['web', c('exited')]]), hashes), { action: 'none' });
  assert.equal(reconcileDecision(stack, 'active', new Map([['web', c('running', 'hw')]]), hashes).action, 'start', 'missing container');
  assert.equal(reconcileDecision(stack, 'active', new Map([['web', c('running', 'tampered')], ['db', c('running', 'hd')]]), hashes).action, 'start', 'drift');
  assert.deepEqual(reconcileDecision({ ...stack, status: 'sleeping' }, 'active', new Map(), hashes), { action: 'none' }, 'a sleeping stack stays asleep');
  assert.deepEqual(reconcileDecision({ ...stack, status: 'error' }, 'active', new Map(), hashes), { action: 'none' }, 'a failed stack is never retried in a loop');
  assert.equal(reconcileDecision({ ...stack, status: 'error' }, 'suspended', all, hashes).action, 'stop', 'suspension still stops a failed stack');
  assert.deepEqual(reconcileDecision({ ...stack, desired_state: 'stopped' }, 'active', new Map(), hashes), { action: 'none' });
  // binds of a live source path (container older than the snapshots): recreated
  assert.equal(reconcileDecision(stack, 'active', all, hashes, ['web']).action, 'start', 'unsafe binds');
  assert.deepEqual(reconcileDecision({ ...stack, desired_state: 'stopped' }, 'active', all, hashes, ['web']), { action: 'none' }, 'never for a stopped stack');
  // an action cut by a panel restart is repaired (never left in error), a real failure is not
  const interrupted = { ...stack, status: 'partial' as const, status_message: INTERRUPTED_MESSAGE };
  const halfDown = new Map([['web', c('exited', 'hw')], ['db', c('running', 'hd')]]);
  assert.equal(reconcileDecision(interrupted, 'active', halfDown, hashes).action, 'start', 'interrupted: brought back');
  assert.deepEqual(reconcileDecision(interrupted, 'active', all, hashes), { action: 'none' }, 'interrupted but all up');
  assert.deepEqual(reconcileDecision({ ...stack, status: 'partial' as const, status_message: '1 service(s) arrêté(s) sur 2' }, 'active', halfDown, hashes), { action: 'none' });
  assert.deepEqual(reconcileDecision({ ...stack, status: 'draft' }, 'active', new Map(), null), { action: 'none' });
  assert.deepEqual(reconcileDecision(stack, 'active', all, null), { action: 'none' }, 'never deployed: nothing to converge');
  const stopped = { ...stack, status: 'stopped' as const, status_message: SUSPENDED_MESSAGE };
  const exited = new Map([['web', c('exited', 'hw')], ['db', c('exited', 'hd')]]);
  assert.equal(reconcileDecision(stopped, 'active', exited, hashes).action, 'start', 'account resumed');
  assert.deepEqual(reconcileDecision({ ...stopped, status_message: null }, 'active', exited, hashes), { action: 'none' }, 'stopped by the user stays stopped');
});

test('git: the host is resolved before every run, private answers refused, the checked address pinned', async () => {
  const pub = async () => [{ address: '140.82.121.3', family: 4 }];
  assert.deepEqual(await repoPinArgs('https://github.com/acme/app', pub), ['-c', 'http.curloptResolve=github.com:443:140.82.121.3']);
  assert.deepEqual(await repoPinArgs('https://git.example.com:8443/a', async () => [{ address: '2606:4700::1', family: 6 }]), ['-c', 'http.curloptResolve=git.example.com:8443:[2606:4700::1]']);
  for (const priv of ['127.0.0.1', '10.240.0.7', '172.17.0.2', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    await assert.rejects(repoPinArgs('https://rebind.example.com/r', async () => [{ address: '140.82.121.3', family: 4 }, { address: priv, family: priv.includes(':') ? 6 : 4 }]),
      (e: unknown) => e instanceof AppError && e.code === 'validation', priv);
  }
  await assert.rejects(repoPinArgs('https://nx.example.com/r', async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); }),
    (e: unknown) => e instanceof AppError && e.code === 'gitUnreachable');
  const args = cloneArgs('https://github.com/acme/app', 'main', 'src.new', ['-c', 'http.curloptResolve=github.com:443:140.82.121.3']);
  assert.ok(args.indexOf('http.curloptResolve=github.com:443:140.82.121.3') < args.indexOf('clone'), 'pin is a global option');
  assert.ok(args.includes('http.followRedirects=false'), 'redirects never followed');
  assert.ok(args.includes('core.symlinks=false'), 'symbolic links never checked out');
  // The node's own public address (IPv6: its /64) is never a repository host.
  const node = ['140.82.121.3', '2a01:4f8:1:2::1'];
  await assert.rejects(repoPinArgs('https://github.com/acme/app', pub, node), (e: unknown) => e instanceof AppError && e.code === 'validation');
  await assert.rejects(repoPinArgs('https://140.82.121.3/acme/app', pub, node), (e: unknown) => e instanceof AppError && e.code === 'validation');
  await assert.rejects(repoPinArgs('https://v6.example.com/r', async () => [{ address: '2a01:4f8:1:2::99', family: 6 }], node),
    (e: unknown) => e instanceof AppError && e.code === 'validation');
  await assert.rejects(repoPinArgs('https://mixed.example.com/r', async () => [{ address: '8.8.8.8', family: 4 }, { address: '140.82.121.3', family: 4 }], node),
    (e: unknown) => e instanceof AppError && e.code === 'validation', 'any answer pointing at the node');
  assert.deepEqual(await repoPinArgs('https://github.com/acme/app', async () => [{ address: '140.82.121.4', family: 4 }], node), ['-c', 'http.curloptResolve=github.com:443:140.82.121.4']);
});
