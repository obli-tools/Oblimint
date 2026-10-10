import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import selfsigned from 'selfsigned';
import { AppError } from '../../middleware/errorHandler';
import { AUTH_NETWORK, LABELS, P4B_LABELS } from '../hosting/naming';
import { PLATFORM_OOM_SCORE_ADJ } from '../docker/specs';
import { AuthSpecError, authRedisSpec, authSidecarSpec, type AuthSidecarInput } from './authSpec';
import { hashAccessPassword, verifyAccessPassword } from './htpasswd';
import {
  importedCertificateFilesExist, namesNotOwned, parseImportedCertificate, removeImportedCertificateFiles, writeImportedCertificateFiles,
} from './importedCerts';
import { normalizeRules, normalizeUsers } from './lists.service';
import { addressProblem, assertExternalHost, DOCKER_DEFAULT_RANGES } from './targets';
import { forbiddenCidrs, nodeAddressCidrs, resolveExternal } from './externalTargets';
import { isValidRoutePath, isAllowedUpstreamHeader, isSafeHeaderValue } from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// Pure parts of proxy-hosts: external targets (PX2, injectable resolver),
// imported certificates (self-generated), forward-auth sidecar specs (PX5),
// SHA512-CRYPT users (PX4), access list rules / users, path / header rules.
// ─────────────────────────────────────────────────────────────────────────────

const forbidden = ['10.224.0.0/12', '10.240.0.0/12', ...DOCKER_DEFAULT_RANGES, '192.168.50.0/24'];

async function rejects(p: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof AppError && err.code === code && err.statusCode === status);
}

test('external targets: public only, private with allowPrivate, never loopback / link local / Docker / panel ranges', async () => {
  const lookup = async (h: string) => {
    if (h === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }];
    if (h === 'rebind.example.com') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    if (h === 'lan.example.com') return [{ address: '192.168.1.20', family: 4 }];
    if (h === 'meta.example.com') return [{ address: '169.254.169.254', family: 4 }];
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  };
  const pub = { allowPrivate: false, forbiddenCidrs: forbidden };
  const priv = { allowPrivate: true, forbiddenCidrs: forbidden };
  assert.equal(await assertExternalHost('93.184.216.34', pub, lookup), '93.184.216.34');
  assert.equal(await assertExternalHost('Public.Example.com.', pub, lookup), 'public.example.com');
  assert.equal(await assertExternalHost('2606:2800:220:1::1', pub, lookup), '2606:2800:220:1::1');
  for (const ip of ['127.0.0.1', '127.8.8.8', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', '224.0.0.1', '255.255.255.255', '::ffff:127.0.0.1']) {
    await rejects(assertExternalHost(ip, pub, lookup), 'targetNotAllowed', 403);
    await rejects(assertExternalHost(ip, priv, lookup), 'targetNotAllowed', 403);
  }
  for (const ip of ['10.0.0.5', '192.168.1.20', '100.64.1.1', 'fd00::1', '172.20.0.1']) await rejects(assertExternalHost(ip, pub, lookup), 'targetNotAllowed', 403);
  assert.equal(await assertExternalHost('10.0.0.5', priv, lookup), '10.0.0.5');
  assert.equal(await assertExternalHost('fd00::1', priv, lookup), 'fd00::1');
  assert.equal(await assertExternalHost('lan.example.com', priv, lookup), 'lan.example.com');
  // Docker / panel ranges stay refused even with allowPrivate.
  for (const ip of ['10.224.3.4', '10.250.0.9', '172.17.0.2', '192.168.50.7']) await rejects(assertExternalHost(ip, priv, lookup), 'targetNotAllowed', 403);
  // Names: every resolved address must pass.
  await rejects(assertExternalHost('rebind.example.com', priv, lookup), 'targetNotAllowed', 403);
  await rejects(assertExternalHost('meta.example.com', priv, lookup), 'targetNotAllowed', 403);
  await rejects(assertExternalHost('lan.example.com', pub, lookup), 'targetNotAllowed', 403);
  await rejects(assertExternalHost('nx.example.com', pub, lookup), 'targetInvalid', 400);
  await rejects(assertExternalHost('localhost', pub, lookup), 'targetInvalid', 400);
  await rejects(assertExternalHost('db.internal', pub, lookup), 'targetNotAllowed', 403);
  await rejects(assertExternalHost('a b;c', pub, lookup), 'targetInvalid', 400);
  await rejects(assertExternalHost('0x7f.1', pub, lookup), 'targetInvalid', 400);
  assert.equal(addressProblem('8.8.8.8', pub), null);
});

test('external targets: never the node own public address (IPv4, IPv6 /64), at save time and at render time', async () => {
  const node = ['95.216.1.10', '2a01:4f8:5:6::1'];
  assert.deepEqual(nodeAddressCidrs([...node, 'garbage', '']), ['95.216.1.10/32', '2a01:4f8:5:6::1/64']);
  const cidrs = forbiddenCidrs([], node);
  const pub = { allowPrivate: false, forbiddenCidrs: cidrs };
  const priv = { allowPrivate: true, forbiddenCidrs: cidrs };
  const lookup = async (h: string) => {
    if (h === 'self.example.com') return [{ address: '95.216.1.10', family: 4 }];
    if (h === 'self6.example.com') return [{ address: '2a01:4f8:5:6::abcd', family: 6 }];
    return [{ address: '95.216.2.7', family: 4 }];
  };
  for (const host of ['95.216.1.10', '2a01:4f8:5:6::1', '2a01:4f8:5:6:ffff::2', '::ffff:95.216.1.10', 'self.example.com', 'self6.example.com']) {
    await rejects(assertExternalHost(host, pub, lookup), 'targetNotAllowed', 403);
    await rejects(assertExternalHost(host, priv, lookup), 'targetNotAllowed', 403);
  }
  assert.equal(await assertExternalHost('95.216.1.11', pub, lookup), '95.216.1.11');
  assert.equal(await assertExternalHost('2a01:4f8:5:7::1', pub, lookup), '2a01:4f8:5:7::1');
  // Render pass (DNS rebinding toward the node): unit invalid, nothing rendered.
  const r = await resolveExternal('self.example.com', false, cidrs, lookup);
  assert.equal(r.address, null);
  assert.match(r.problem ?? '', /refused/);
  assert.equal((await resolveExternal('other.example.com', false, cidrs, lookup)).address, '95.216.2.7');
});

function selfSigned(names: string[], days = 30): Promise<{ cert: string; key: string }> {
  return new Promise((resolve, reject) => {
    selfsigned.generate([{ name: 'commonName', value: names[0] }], {
      keySize: 2048, days, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
    }, (err, pems) => (err ? reject(err) : resolve({ cert: pems.cert, key: pems.private })));
  });
}

test('imported certificates: parse, key match, expiry, names ⊂ verified domains, files 0600 without following links', async () => {
  const a = await selfSigned(['shop.acme.fr', '*.acme.fr']);
  const b = await selfSigned(['other.fr']);
  const parsed = parseImportedCertificate(a.cert, a.key, null);
  assert.deepEqual(parsed.names, ['shop.acme.fr', '*.acme.fr']);
  assert.ok(parsed.notAfter.getTime() > Date.now());
  assert.ok(parsed.privateKey.includes('BEGIN PRIVATE KEY'));
  assert.ok(parsed.fullchain.startsWith('-----BEGIN CERTIFICATE-----'));
  // Chain pasted with the leaf: first block = leaf.
  const withChain = parseImportedCertificate(`${a.cert}\n${b.cert}`, a.key, null);
  assert.equal(withChain.names[0], 'shop.acme.fr');
  assert.ok(withChain.chainPem?.includes('BEGIN CERTIFICATE'));
  const invalid = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === 'certificateInvalid' && e.statusCode === 400);
  invalid(() => parseImportedCertificate(a.cert, b.key, null));
  invalid(() => parseImportedCertificate('nothing', a.key, null));
  invalid(() => parseImportedCertificate(a.cert, 'not a key', null));
  invalid(() => parseImportedCertificate(a.cert, a.key, 'garbage'));
  invalid(() => parseImportedCertificate(a.cert, a.key, null, new Date(Date.now() + 400 * 86400_000)));

  assert.deepEqual(namesNotOwned(['shop.acme.fr', '*.acme.fr'], ['acme.fr']), []);
  assert.deepEqual(namesNotOwned(['shop.acme.fr', 'evil.fr', '*.notacme.fr'], ['acme.fr']), ['evil.fr', '*.notacme.fr']);
  assert.deepEqual(namesNotOwned(['xacme.fr'], ['acme.fr']), ['xacme.fr']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-proxy-cert-'));
  try {
    writeImportedCertificateFiles(dir, 5, parsed.fullchain, parsed.privateKey);
    assert.ok(importedCertificateFilesExist(dir, 5));
    assert.equal(fs.readFileSync(path.join(dir, 'imported-5', 'privkey.pem'), 'utf8'), parsed.privateKey);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'imported-5', 'privkey.pem')).mode & 0o777, 0o600);
    writeImportedCertificateFiles(dir, 5, parsed.fullchain, parsed.privateKey); // atomic overwrite
    assert.deepEqual(fs.readdirSync(path.join(dir, 'imported-5')).sort(), ['fullchain.pem', 'privkey.pem'], 'no temp file left');
    removeImportedCertificateFiles(dir, 5);
    assert.ok(!importedCertificateFilesExist(dir, 5));
    // A symbolic link in place of the directory is refused.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-proxy-link-'));
    let linked = false;
    try { fs.symlinkSync(target, path.join(dir, 'imported-6'), 'junction'); linked = true; } catch { /* no symlink right on this box */ }
    if (linked) {
      assert.throws(() => writeImportedCertificateFiles(dir, 6, parsed.fullchain, parsed.privateKey));
      assert.deepEqual(fs.readdirSync(target), [], 'nothing written through the link');
    }
    fs.rmSync(target, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sidecarInput: AuthSidecarInput = {
  providerId: 4, image: 'quay.io/oauth2-proxy/oauth2-proxy:v7.7.1', azureTenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', clientSecret: 's3cr3t~value', cookieSecret: '0123456789abcdef0123456789abcdef',
  allowedEmailDomains: ['acme.fr', 'bad domain'], allowedGroups: ['g-1', 'bad;group'], whitelistDomains: ['vault.acme.fr', 'www.acme.fr', '*evil'],
  redisPassword: 'abcdefghijklmnopqrstuvwxyz012345',
};

test('forward-auth sidecar spec: hardened, AUTH_NETWORK only, never an account label, env from validated values', () => {
  const spec = authSidecarSpec(sidecarInput);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-oauth2-4');
  assert.equal(hc.NetworkMode, AUTH_NETWORK);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.ok(!hc.CapAdd?.length);
  assert.ok(hc.SecurityOpt?.some((o: string) => o.startsWith('no-new-privileges')));
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Memory, 64 * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.ok((hc.PidsLimit ?? 0) > 0);
  assert.equal(hc.OomScoreAdj, PLATFORM_OOM_SCORE_ADJ);
  assert.ok(hc.LogConfig);
  assert.ok(!hc.Binds?.length && !hc.Mounts?.length, 'no bind: no Docker socket, no account tree');
  assert.ok(!hc.PortBindings || Object.keys(hc.PortBindings).length === 0);
  assert.ok(!hc.Privileged);
  assert.ok(spec.User && !spec.User.startsWith('0'));
  const labels = spec.Labels!;
  assert.equal(labels[LABELS.internal], 'true');
  assert.equal(labels[LABELS.role], 'proxy-auth');
  assert.equal(labels[P4B_LABELS.authProvider], '4');
  assert.ok(!(LABELS.account in labels), 'never oblimint.account');
  assert.ok(labels[LABELS.specHash]);
  const env = new Map(spec.Env!.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  assert.equal(env.get('OAUTH2_PROXY_OIDC_ISSUER_URL'), 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0');
  assert.equal(env.get('OAUTH2_PROXY_CLIENT_ID'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(env.get('OAUTH2_PROXY_REVERSE_PROXY'), 'true');
  assert.equal(env.get('OAUTH2_PROXY_SET_XAUTHREQUEST'), 'true');
  assert.equal(env.get('OAUTH2_PROXY_UPSTREAMS'), 'static://202');
  assert.equal(env.get('OAUTH2_PROXY_SESSION_STORE_TYPE'), 'redis');
  assert.equal(env.get('OAUTH2_PROXY_REDIS_CONNECTION_URL'), 'redis://oblimint-auth-redis:6379');
  assert.equal(env.get('OAUTH2_PROXY_COOKIE_NAME'), '_oblimint_auth_4');
  assert.equal(env.get('OAUTH2_PROXY_EMAIL_DOMAINS'), 'acme.fr');
  assert.equal(env.get('OAUTH2_PROXY_ALLOWED_GROUPS'), 'g-1');
  assert.equal(env.get('OAUTH2_PROXY_WHITELIST_DOMAINS'), 'vault.acme.fr,www.acme.fr');
  // Same input → same hash (no needless recreation); a change → another hash.
  assert.equal(authSidecarSpec(sidecarInput).Labels![LABELS.specHash], labels[LABELS.specHash]);
  assert.notEqual(authSidecarSpec({ ...sidecarInput, whitelistDomains: ['x.acme.fr'] }).Labels![LABELS.specHash], labels[LABELS.specHash]);
  for (const bad of [{ azureTenantId: 'x/../y' }, { clientId: 'not-a-guid' }, { clientSecret: 'a\nOAUTH2_PROXY_X=1' }, { cookieSecret: 'short' },
    { providerId: 0 }, { redisPassword: 'short' }]) {
    assert.throws(() => authSidecarSpec({ ...sidecarInput, ...bad }), AuthSpecError);
  }
  const allDomains = authSidecarSpec({ ...sidecarInput, allowedEmailDomains: [], allowedGroups: [], whitelistDomains: [] });
  assert.ok(allDomains.Env!.includes('OAUTH2_PROXY_EMAIL_DOMAINS=*'));
  assert.ok(!allDomains.Env!.some((e) => e.startsWith('OAUTH2_PROXY_ALLOWED_GROUPS=')));
});

test('forward-auth redis spec: hardened, password, no persistence', () => {
  const spec = authRedisSpec('redis:7.4-alpine', sidecarInput.redisPassword);
  assert.equal(spec.name, 'oblimint-auth-redis');
  assert.equal(spec.HostConfig!.NetworkMode, AUTH_NETWORK);
  assert.deepEqual(spec.HostConfig!.CapDrop, ['ALL']);
  assert.equal(spec.HostConfig!.ReadonlyRootfs, true);
  assert.ok(spec.Cmd!.includes('--requirepass'));
  assert.ok(spec.Cmd!.includes('--save'));
  assert.ok(!(LABELS.account in spec.Labels!));
  assert.throws(() => authRedisSpec('redis', 'x y'), AuthSpecError);
});

test('access list users: SHA512-CRYPT only, rename keeps the hash, new users need a password', () => {
  const h = hashAccessPassword('correct horse battery');
  assert.match(h, /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  assert.ok(verifyAccessPassword('correct horse battery', h));
  assert.ok(!verifyAccessPassword('wrong', h));
  const existing = [{ username: 'alice', hash: h }];
  const out = normalizeUsers([{ username: 'alice2', previousUsername: 'alice' }, { username: 'bob', password: 'another password' }], existing);
  assert.equal(out[0].hash, h, 'rename keeps the hash');
  assert.ok(verifyAccessPassword('another password', out[1].hash));
  assert.deepEqual(normalizeUsers([{ username: 'alice' }], existing), existing, 'no password = kept');
  const code = (fn: () => unknown, c: string) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === c);
  code(() => normalizeUsers([{ username: 'carol' }], existing), 'validation');
  code(() => normalizeUsers([{ username: 'x:y', password: 'long enough' }], []), 'validation');
  code(() => normalizeUsers([{ username: 'a', password: 'short' }], []), 'weakPassword');
  code(() => normalizeUsers([{ username: 'a', password: 'long enough' }, { username: 'a', password: 'long enough' }], []), 'validation');
});

test('access list rules: normalized CIDR, deduplicated, never all', () => {
  assert.deepEqual(normalizeRules([{ action: 'allow', cidr: '10.1.2.3/8' }, { action: 'allow', cidr: '10.0.0.0/8' }, { action: 'deny', cidr: '2001:DB8::1' }]),
    [{ action: 'allow', cidr: '10.0.0.0/8' }, { action: 'deny', cidr: '2001:db8::1' }]);
  for (const bad of ['all', '1.2.3.4; deny all', '300.1.1.1', '0.0.0.0/0', '10.0.0.0/33']) {
    assert.throws(() => normalizeRules([{ action: 'allow', cidr: bad }]), AppError, bad);
  }
});

test('paths and headers', () => {
  for (const ok of ['/api/', '/health', '/a/b.c/', '/v1/~user@x:y+z-/']) assert.ok(isValidRoutePath(ok), ok);
  for (const bad of ['/', 'api/', '/a b/', '/a/../b/', '/.well-known/acme-challenge/x', '/oauth2/', '/__oblimint_px/', '/a;b', '/a{b}/', '/a$b', '/a"b', '/é/']) {
    assert.ok(!isValidRoutePath(bad), bad);
  }
  assert.ok(isSafeHeaderValue('text/html; charset=utf-8') === false, '; refused');
  assert.ok(isSafeHeaderValue('max-age=60, public'));
  assert.ok(!isAllowedUpstreamHeader('X-Forwarded-For') && !isAllowedUpstreamHeader('remote-user') && isAllowedUpstreamHeader('X-Api-Key'));
});
