import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import selfsigned from 'selfsigned';
import type * as acme from 'acme-client';
import {
  accountKeyPath, directoryUrl, isPublicAcmeName, issueCertificate, readCertificateDates, type AcmeClientFactory, type AcmeClientLike, type IssueDeps,
} from './acmeIssuer';

const DAY = 24 * 3600_000;

/** A self-signed PEM (+ its RSA key) covering `names`, valid `days` days (selfsigned → node-forge). */
function makeCert(names: string[], days: number) {
  const pems = selfsigned.generate([{ name: 'commonName', value: names[0] }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
  });
  // acme-client imports keys through WebCrypto: PKCS#8, not forge's PKCS#1.
  const key = createPrivateKey(pems.private).export({ type: 'pkcs8', format: 'pem' }).toString();
  return { cert: pems.cert, key, publicKey: pems.public };
}

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-acme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('certificate dates are read from the PEM (X509Certificate), not assumed', () => {
  const { cert } = makeCert(['dates.example.net'], 45);
  const { notBefore, notAfter } = readCertificateDates(cert + cert); // chain: first certificate wins
  const x = new X509Certificate(cert);
  assert.equal(notAfter.getTime(), new Date(x.validTo).getTime());
  assert.equal(notBefore.getTime(), new Date(x.validFrom).getTime());
  const span = notAfter.getTime() - notBefore.getTime();
  assert.ok(Math.abs(span - 45 * DAY) < 2 * DAY, `~45 days, got ${span / DAY}`);
  assert.throws(() => readCertificateDates('not a pem'));
});

test('ACME flow with a fake client: persistent account key, HTTP-01 token files, installed cert', async (t) => {
  const root = tempRoot(t);
  const names = ['example.com', 'www.example.com'];
  const issued = makeCert(names, 90);

  const accountKeys: string[] = [];
  const directories: string[] = [];
  const tokensSeenOnDisk: string[] = [];
  let createAccountCalls = 0;
  const factory: AcmeClientFactory = ({ directoryUrl: url, accountKey }) => {
    accountKeys.push(accountKey.toString());
    directories.push(url);
    const challenges = new Map<string, string>();
    const client: AcmeClientLike = {
      async createAccount(data) {
        createAccountCalls++;
        assert.deepEqual(data, { termsOfServiceAgreed: true, contact: ['mailto:ops@example.com'] });
        return {};
      },
      async createOrder(data) {
        assert.deepEqual(data.identifiers.map((i) => i.value), names);
        return { url: 'order-1', status: 'pending', identifiers: data.identifiers, authorizations: [], finalize: 'f' } as unknown as acme.Order;
      },
      async getAuthorizations() {
        return names.map((value, i) => ({
          url: `authz-${i}`, status: 'pending', identifier: { type: 'dns', value },
          challenges: [
            { type: 'dns-01', url: `dns-${i}`, token: `dnsTOKEN${i}xxxxxxxx`, status: 'pending' },
            { type: 'http-01', url: `http-${i}`, token: `httpTOKEN${i}_abc-def`, status: 'pending' },
          ],
        })) as unknown as acme.Authorization[];
      },
      async getChallengeKeyAuthorization(ch) {
        const ka = `${ch.token}.thumbprint`;
        challenges.set(ch.token, ka);
        return ka;
      },
      async completeChallenge(ch) {
        // Let's Encrypt would fetch the token now: it must be on disk.
        const file = path.join(root, 'edge', 'acme', '.well-known', 'acme-challenge', ch.token);
        assert.equal(fs.readFileSync(file, 'utf8'), challenges.get(ch.token));
        tokensSeenOnDisk.push(ch.token);
        return ch;
      },
      async waitForValidStatus(item) { return item; },
      async finalizeOrder(order, csr) {
        assert.match(csr.toString(), /BEGIN CERTIFICATE REQUEST/);
        return order;
      },
      async getCertificate() { return issued.cert + issued.cert; },
    };
    return client;
  };

  const logLines: string[] = [];
  const selfTests: string[] = [];
  const deps: IssueDeps = {
    edgeDir: path.join(root, 'edge'),
    acmeWebroot: path.join(root, 'edge', 'acme'),
    certsDir: path.join(root, 'edge', 'certs'),
    createClient: factory,
    createCertificateKey: async () => issued.key,
    selfTest: async (host, token) => { selfTests.push(`${host}:${token}`); return { ok: true, detail: 'fake' }; },
    log: (level, message) => { logLines.push(`${level}: ${message}`); },
  };

  const first = await issueCertificate({ names, email: 'ops@example.com', directory: 'staging' }, deps);
  assert.equal(first.issuer, 'letsencrypt-staging');
  assert.equal(first.primaryName, 'example.com');
  assert.equal(first.notAfter.getTime(), new Date(new X509Certificate(issued.cert).validTo).getTime());
  assert.deepEqual(tokensSeenOnDisk, ['httpTOKEN0_abc-def', 'httpTOKEN1_abc-def']);
  assert.equal(selfTests.length, 2);
  assert.equal(directories[0], directoryUrl('staging'));

  // Token files removed afterwards; the webroot holds nothing else.
  const challengeDir = path.join(root, 'edge', 'acme', '.well-known', 'acme-challenge');
  assert.deepEqual(fs.readdirSync(challengeDir), []);

  // Installed files (E1: the private key is outside the webroot).
  const certDir = path.join(root, 'edge', 'certs', 'example.com');
  assert.deepEqual(fs.readdirSync(certDir).sort(), ['fullchain.pem', 'privkey.pem']);
  assert.equal(fs.readFileSync(path.join(certDir, 'privkey.pem'), 'utf8'), issued.key);
  assert.match(fs.readFileSync(path.join(certDir, 'fullchain.pem'), 'utf8'), /BEGIN CERTIFICATE/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(certDir, 'privkey.pem')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(accountKeyPath(deps.edgeDir, 'staging')).mode & 0o777, 0o600);
  }

  // FIX 1: the account key is created once and reused by the next request.
  const keyFile = accountKeyPath(deps.edgeDir, 'staging');
  const keyOnDisk = fs.readFileSync(keyFile, 'utf8');
  assert.match(keyOnDisk, /PRIVATE KEY/);
  await issueCertificate({ names, email: 'ops@example.com', directory: 'staging' }, deps);
  assert.equal(accountKeys.length, 2);
  assert.equal(accountKeys[0], accountKeys[1]);
  assert.equal(accountKeys[0], keyOnDisk);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), keyOnDisk);
  assert.equal(createAccountCalls, 2);
  assert.ok(logLines.some((l) => l.includes('Created the ACME account key')));
  assert.ok(logLines.some((l) => l.includes('Using the ACME account key')));

  // Production uses its own key.
  await issueCertificate({ names, email: 'ops@example.com', directory: 'production' }, deps);
  assert.notEqual(accountKeys[2], accountKeys[0]);
  assert.equal(directories[2], directoryUrl('production'));
  assert.ok(!fs.readdirSync(path.join(root, 'edge', 'acme-account')).some((f) => !f.endsWith('.key')));
});

test('a failed challenge removes the token file and installs nothing', async (t) => {
  const root = tempRoot(t);
  const factory: AcmeClientFactory = () => ({
    async createAccount() { return {}; },
    async createOrder() { return { url: 'o' } as unknown as acme.Order; },
    async getAuthorizations() {
      return [{ url: 'a', status: 'pending', identifier: { type: 'dns', value: 'fail.example.net' },
        challenges: [{ type: 'http-01', url: 'c', token: 'failTOKEN_123456', status: 'pending' }] }] as unknown as acme.Authorization[];
    },
    async getChallengeKeyAuthorization() { return 'ka'; },
    async completeChallenge() { throw new Error('Invalid response from http://fail.example.net: 404'); },
    async waitForValidStatus(item) { return item; },
    async finalizeOrder() { throw new Error('must not finalize'); },
    async getCertificate() { throw new Error('must not download'); },
  });
  const deps: IssueDeps = {
    edgeDir: path.join(root, 'edge'), acmeWebroot: path.join(root, 'edge', 'acme'), certsDir: path.join(root, 'edge', 'certs'),
    createClient: factory, log: () => {},
  };
  await assert.rejects(issueCertificate({ names: ['fail.example.net'], email: 'ops@example.com', directory: 'staging' }, deps), /404/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'edge', 'acme', '.well-known', 'acme-challenge')), []);
  assert.equal(fs.existsSync(path.join(root, 'edge', 'certs', 'fail.example.net')), false);
});

test('a hostile token (path traversal) is refused before touching the disk', async (t) => {
  const root = tempRoot(t);
  const factory: AcmeClientFactory = () => ({
    async createAccount() { return {}; },
    async createOrder() { return { url: 'o' } as unknown as acme.Order; },
    async getAuthorizations() {
      return [{ url: 'a', status: 'pending', identifier: { type: 'dns', value: 'x.example.net' },
        challenges: [{ type: 'http-01', url: 'c', token: '../../../certs/x', status: 'pending' }] }] as unknown as acme.Authorization[];
    },
    async getChallengeKeyAuthorization() { return 'ka'; },
    async completeChallenge() { return {}; },
    async waitForValidStatus(item) { return item; },
    async finalizeOrder(o) { return o; },
    async getCertificate() { return ''; },
  });
  const deps: IssueDeps = {
    edgeDir: path.join(root, 'edge'), acmeWebroot: path.join(root, 'edge', 'acme'), certsDir: path.join(root, 'edge', 'certs'),
    createClient: factory, log: () => {},
  };
  await assert.rejects(issueCertificate({ names: ['x.example.net'], email: 'ops@example.com', directory: 'staging' }, deps), /invalid ACME challenge token/);
  assert.equal(fs.existsSync(path.join(root, 'edge', 'certs')), false);
});

test('a certificate that does not match the key or the names is refused', async (t) => {
  const root = tempRoot(t);
  const other = makeCert(['other.example.net'], 90);
  const mine = makeCert(['mine.example.net'], 90);
  const factory: AcmeClientFactory = () => ({
    async createAccount() { return {}; },
    async createOrder() { return { url: 'o' } as unknown as acme.Order; },
    async getAuthorizations() { return [] as acme.Authorization[]; },
    async getChallengeKeyAuthorization() { return 'ka'; },
    async completeChallenge() { return {}; },
    async waitForValidStatus(item) { return item; },
    async finalizeOrder(o) { return o; },
    async getCertificate() { return other.cert; },
  });
  const deps: IssueDeps = {
    edgeDir: path.join(root, 'edge'), acmeWebroot: path.join(root, 'edge', 'acme'), certsDir: path.join(root, 'edge', 'certs'),
    createClient: factory, createCertificateKey: async () => mine.key, log: () => {},
  };
  await assert.rejects(issueCertificate({ names: ['mine.example.net'], email: 'ops@example.com', directory: 'production' }, deps), /does not match/);
  assert.equal(fs.existsSync(path.join(root, 'edge', 'certs', 'mine.example.net')), false);
});

test('every ACME call is bounded: a hung request times out, an aborted issuance installs nothing', async (t) => {
  const root = tempRoot(t);
  const deps = (factory: AcmeClientFactory, extra: Partial<IssueDeps> = {}): IssueDeps => ({
    edgeDir: path.join(root, 'edge'), acmeWebroot: path.join(root, 'edge', 'acme'), certsDir: path.join(root, 'edge', 'certs'),
    createClient: factory, log: () => {}, ...extra,
  });
  const never = <T>() => new Promise<T>(() => { /* dropped connection */ });
  const base: AcmeClientLike = {
    async createAccount() { return {}; },
    async createOrder() { return { url: 'o' } as unknown as acme.Order; },
    async getAuthorizations() { return [] as acme.Authorization[]; },
    async getChallengeKeyAuthorization() { return 'ka'; },
    async completeChallenge() { return {}; },
    async waitForValidStatus(item) { return item; },
    async finalizeOrder(o) { return o; },
    async getCertificate() { return ''; },
  };
  // A hung createOrder / finalizeOrder → rejected after callTimeoutMs.
  await assert.rejects(issueCertificate({ names: ['hang.example.net'], email: 'ops@example.com', directory: 'staging' },
    deps(() => ({ ...base, createOrder: () => never<acme.Order>() }), { callTimeoutMs: 50 })), /createOrder timed out/);
  await assert.rejects(issueCertificate({ names: ['hang.example.net'], email: 'ops@example.com', directory: 'staging' },
    deps(() => ({ ...base, finalizeOrder: () => never<acme.Order>() }), { callTimeoutMs: 50 })), /finalizeOrder timed out/);

  // The caller's deadline aborts a pending call at once, with its reason.
  const ctrl = new AbortController();
  const p = issueCertificate({ names: ['hang.example.net'], email: 'ops@example.com', directory: 'staging' },
    deps(() => ({ ...base, getCertificate: () => never<string>() }), { signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(new Error('issuance deadline')), 30);
  await assert.rejects(p, /issuance deadline/);
  assert.equal(fs.existsSync(path.join(root, 'edge', 'certs', 'hang.example.net')), false);

  // Already aborted: no ACME call at all.
  let calls = 0;
  const dead = new AbortController();
  dead.abort(new Error('too late'));
  await assert.rejects(issueCertificate({ names: ['hang.example.net'], email: 'ops@example.com', directory: 'staging' },
    deps(() => ({ ...base, async createAccount() { calls++; return {}; } }), { signal: dead.signal })), /too late/);
  assert.equal(calls, 1, 'the call may be issued but its result is ignored');
});

test('non-public names (special-use TLDs, IP literals) never reach the CA', async () => {
  for (const n of ['example.com', 'shop.example.net', 'www.oblimint.fr', 'xn--bcher-kva.de']) assert.equal(isPublicAcmeName(n), true, n);
  for (const n of [
    'panel.oblimint.test', 'a.example', 'x.invalid', 'localhost', 'app.localhost', 'nas.local', 'svc.internal',
    'router.home.arpa', 'srv.lan', 'dc.corp', 'box.home', 'h.alt', 'abc.onion', '10.0.0.1', '192.168.1.20', 'single', '',
  ]) assert.equal(isPublicAcmeName(n), false, n);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-acme-np-'));
  let called = 0;
  const deps = {
    edgeDir: path.join(root, 'edge'), acmeWebroot: path.join(root, 'edge', 'acme'), certsDir: path.join(root, 'edge', 'certs'),
    createClient: () => { called++; throw new Error('the CA must not be contacted'); },
    log: () => {},
  };
  await assert.rejects(
    issueCertificate({ names: ['panel.oblimint.test'], email: 'ops@example.com', directory: 'production' }, deps as never),
    /not publicly resolvable/,
  );
  assert.equal(called, 0);
  assert.equal(fs.existsSync(path.join(root, 'edge', 'acme-account')), false, 'no ACME account key created either');
});
