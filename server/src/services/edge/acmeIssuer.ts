import fs from 'fs';
import http from 'http';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import * as acme from 'acme-client';
import { isValidServerName } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Let's Encrypt HTTP-01 issuance (acme-client), ported from Oblihub
// certificate.service.ts WITH the fixes:
//   FIX 1  the ACME ACCOUNT KEY is persistent, one per directory, in
//          edge/acme-account/<production|staging>.key (0600, created once —
//          never under the ACME webroot nor mounted in the edge). Oblihub
//          created a new account for every certificate (LE rate limit on
//          new registrations); createAccount() with an existing key simply
//          returns the existing account.
//   FIX 2  not_before / not_after are READ FROM THE ISSUED CERTIFICATE
//          (node:crypto X509Certificate), not assumed to be "now + 90 days".
//   FIX 3  staging directory option (issuer 'letsencrypt-staging').
// The ACME client is injected (tests use a fake: no network call).
// Invariant E1: private keys 0600, outside the webroot; the webroot only
// receives token files under .well-known/acme-challenge/, removed afterwards.
// ─────────────────────────────────────────────────────────────────────────────

export type AcmeDirectoryName = 'production' | 'staging';

/** The subset of acme.Client used here (tests implement it). */
export interface AcmeClientLike {
  createAccount(data: { termsOfServiceAgreed: boolean; contact: string[] }): Promise<unknown>;
  createOrder(data: { identifiers: Array<{ type: 'dns'; value: string }> }): Promise<acme.Order>;
  getAuthorizations(order: acme.Order): Promise<acme.Authorization[]>;
  getChallengeKeyAuthorization(challenge: acme.Authorization['challenges'][number]): Promise<string>;
  completeChallenge(challenge: acme.Authorization['challenges'][number]): Promise<unknown>;
  waitForValidStatus<T>(item: T): Promise<T>;
  finalizeOrder(order: acme.Order, csr: Buffer | string): Promise<acme.Order>;
  getCertificate(order: acme.Order): Promise<string>;
}

export type AcmeClientFactory = (opts: { directoryUrl: string; accountKey: Buffer }) => AcmeClientLike;

/** Per-HTTP-request timeout of the ACME client (a silently dropped connection must not hang an issuance). */
export const ACME_HTTP_TIMEOUT_MS = 60_000;

export const defaultAcmeClientFactory: AcmeClientFactory = (opts) => {
  // acme-client's shared axios instance: without a timeout, a TCP connection
  // dropped without RST (NAT / firewall) never settles.
  if (!acme.axios.defaults.timeout) acme.axios.defaults.timeout = ACME_HTTP_TIMEOUT_MS;
  return new acme.Client(opts) as unknown as AcmeClientLike;
};

export type IssueLog = (level: 'info' | 'warn' | 'error', message: string) => void | Promise<void>;

export interface IssueDeps {
  /** localPaths.edge() — account keys go to <edgeDir>/acme-account/. */
  edgeDir: string;
  /** localPaths.edgeAcme() — mounted read-only at /var/www/acme in the edge. */
  acmeWebroot: string;
  /** localPaths.edgeCerts() — <certsDir>/<primaryName>/{fullchain,privkey}.pem. */
  certsDir: string;
  createClient: AcmeClientFactory;
  /** Internal HTTP-01 self-test (best effort: a failure is only logged). */
  selfTest?: (host: string, token: string, keyAuthorization: string) => Promise<{ ok: boolean; detail: string }>;
  log: IssueLog;
  /** Private key of the certificate (default: ECDSA P-256; tests inject an RSA key). */
  createCertificateKey?: () => Promise<Buffer | string>;
  /** Hard timeout of one challenge validation (default 180 s). */
  challengeTimeoutMs?: number;
  /** Hard timeout of every other ACME call (account, order, authorizations, finalize, download; default 120 s). */
  callTimeoutMs?: number;
  /**
   * Overall deadline of the issuance (the caller's): once aborted, every
   * pending ACME call is abandoned and nothing more is written (no token, no
   * certificate file installed after the deadline).
   */
  signal?: AbortSignal;
}

export interface IssueParams {
  /** First = primary name (certificate directory), all covered as SAN. */
  names: string[];
  email: string;
  directory: AcmeDirectoryName;
}

export interface IssuedCertificate {
  primaryName: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  issuer: 'letsencrypt' | 'letsencrypt-staging';
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;

export function directoryUrl(dir: AcmeDirectoryName): string {
  return dir === 'staging' ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

export function accountKeyPath(edgeDir: string, dir: AcmeDirectoryName): string {
  return path.join(edgeDir, 'acme-account', `${dir}.key`);
}

/** The persistent account key of a directory, created (0600) on first use. */
export async function loadOrCreateAccountKey(edgeDir: string, dir: AcmeDirectoryName): Promise<{ key: Buffer; created: boolean }> {
  const file = accountKeyPath(edgeDir, dir);
  try {
    return { key: fs.readFileSync(file), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = await acme.crypto.createPrivateEcdsaKey('P-256');
  try {
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    // Lost a creation race: use the key that won.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { key: fs.readFileSync(file), created: false };
    throw err;
  }
  return { key, created: true };
}

/** Validity of the FIRST certificate of a PEM chain (FIX 2). */
export function readCertificateDates(pem: string): { notBefore: Date; notAfter: Date } {
  const x509 = new X509Certificate(firstCertificate(pem));
  const notBefore = new Date(x509.validFrom);
  const notAfter = new Date(x509.validTo);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) throw new Error('unreadable certificate validity');
  return { notBefore, notAfter };
}

export function firstCertificate(pem: string): string {
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error('no certificate in the PEM returned by the CA');
  return `${m[0]}\n`;
}

/** Writes fullchain.pem (0644) + privkey.pem (0600) into <certsDir>/<primaryName>/ (tmp + rename). */
export function writeCertificateFiles(certsDir: string, primaryName: string, fullchain: string, privateKey: string | Buffer): string {
  if (!isValidServerName(primaryName)) throw new Error(`invalid certificate name ${primaryName}`);
  const dir = path.join(certsDir, primaryName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const keyFile = path.join(dir, 'privkey.pem');
  const certFile = path.join(dir, 'fullchain.pem');
  fs.writeFileSync(`${keyFile}.tmp`, privateKey, { mode: 0o600 });
  fs.chmodSync(`${keyFile}.tmp`, 0o600);
  fs.writeFileSync(`${certFile}.tmp`, fullchain, { mode: 0o644 });
  fs.renameSync(`${keyFile}.tmp`, keyFile);
  fs.renameSync(`${certFile}.tmp`, certFile);
  return dir;
}

/** Removes the certificate directory of a primary name (no-op when absent). */
export function removeCertificateFiles(certsDir: string, primaryName: string): void {
  if (!isValidServerName(primaryName)) return;
  fs.rmSync(path.join(certsDir, primaryName), { recursive: true, force: true });
}

function challengeFile(acmeWebroot: string, token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error('invalid ACME challenge token');
  return path.join(acmeWebroot, '.well-known', 'acme-challenge', token);
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason as unknown;
  return r instanceof Error ? r : new Error(typeof r === 'string' && r ? r : 'certificate issuance aborted');
}

/**
 * Races `p` against a timeout and the overall abort signal (the underlying
 * request cannot be cancelled: it is abandoned, its late result ignored).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal, hint = ''): Promise<T> {
  if (signal?.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s${hint}`)), ms);
      if (signal) {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

const PORT80_HINT = ' — is port 80 reachable from the internet?';

/**
 * Internal self-test: GET http://<edgeHost>/.well-known/acme-challenge/<token>
 * with `Host: <host>` straight to the edge container over the shared Docker
 * network (bypasses public DNS / hairpin NAT: checks that the vhost serves the
 * webroot for THIS name). node:http, because fetch() may drop a Host header.
 */
export function httpSelfTest(edgeHost: string, timeoutMs = 5000) {
  return (host: string, token: string, keyAuthorization: string): Promise<{ ok: boolean; detail: string }> => new Promise((resolve) => {
    const req = http.request({
      host: edgeHost, port: 80, method: 'GET', path: `/.well-known/acme-challenge/${token}`,
      headers: { Host: host }, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        const ok = res.statusCode === 200 && body.trim() === keyAuthorization.trim();
        resolve({ ok, detail: ok ? 'HTTP 200, body matches' : `HTTP ${res.statusCode}${body ? `, body starts: ${body.slice(0, 60)}` : ''}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, detail: err.message }));
    req.end();
  });
}

/** Full HTTP-01 issuance. Throws on failure (the caller records it). */
export async function issueCertificate(params: IssueParams, deps: IssueDeps): Promise<IssuedCertificate> {
  const names = [...new Set(params.names.map((n) => n.toLowerCase()))];
  if (!names.length || !names.every(isValidServerName)) throw new Error('invalid certificate names');
  if (!params.email || /[\s<>]/.test(params.email) || !params.email.includes('@')) throw new Error('invalid ACME contact email');
  const primaryName = names[0];
  const log = async (level: 'info' | 'warn' | 'error', message: string) => { await deps.log(level, message); };
  const signal = deps.signal;
  const callMs = deps.callTimeoutMs ?? 120_000;
  /** Bounded ACME call (never hangs the serial issuance queue). */
  const call = <T>(p: Promise<T>, label: string): Promise<T> => withTimeout(p, callMs, label, signal);
  const checkAborted = (): void => { if (signal?.aborted) throw abortError(signal); };

  const { key: accountKey, created } = await loadOrCreateAccountKey(deps.edgeDir, params.directory);
  await log('info', `${created ? 'Created' : 'Using'} the ACME account key (${params.directory} directory)`);
  const client = deps.createClient({ directoryUrl: directoryUrl(params.directory), accountKey });
  await call(client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${params.email}`] }), 'createAccount');

  await log('info', `Creating order for ${names.join(', ')}`);
  const order = await call(client.createOrder({ identifiers: names.map((value) => ({ type: 'dns' as const, value })) }), 'createOrder');
  const authorizations = await call(client.getAuthorizations(order), 'getAuthorizations');
  const timeoutMs = deps.challengeTimeoutMs ?? 180_000;

  for (const auth of authorizations) {
    const host = auth.identifier.value;
    if (auth.status === 'valid') {
      await log('info', `[${host}] Authorization already valid`);
      continue;
    }
    const challenge = auth.challenges.find((c) => c.type === 'http-01');
    if (!challenge) throw new Error(`No HTTP-01 challenge offered for ${host}`);
    const file = challengeFile(deps.acmeWebroot, challenge.token);
    const keyAuthorization = await call(client.getChallengeKeyAuthorization(challenge), 'getChallengeKeyAuthorization');
    checkAborted();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, keyAuthorization, { mode: 0o644 });
      await log('info', `[${host}] HTTP-01 token written`);

      if (deps.selfTest) {
        try {
          const r = await deps.selfTest(host, challenge.token, keyAuthorization);
          await log(r.ok ? 'info' : 'warn', `[${host}] Internal self-test ${r.ok ? 'passed' : 'failed'}: ${r.detail}`);
        } catch (err) {
          await log('warn', `[${host}] Internal self-test error: ${(err as Error).message}`);
        }
      }

      await log('info', `[${host}] Asking Let's Encrypt to validate the challenge`);
      await withTimeout(client.completeChallenge(challenge), timeoutMs, 'completeChallenge', signal, PORT80_HINT);
      await withTimeout(client.waitForValidStatus(challenge), timeoutMs, 'waitForValidStatus', signal, PORT80_HINT);
      await log('info', `[${host}] Challenge validated`);
    } catch (err) {
      await log('error', `[${host}] Challenge failed: ${(err as Error).message}`);
      await log('info', `Check: ${host} resolves to this server, port 80 is open (firewall / NAT), no CDN proxy in front during validation.`);
      throw err;
    } finally {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }

  const certKey = deps.createCertificateKey ? await deps.createCertificateKey() : await acme.crypto.createPrivateEcdsaKey('P-256');
  const [, csr] = await acme.crypto.createCsr({ commonName: primaryName, altNames: names }, certKey);
  await log('info', 'All challenges validated — finalizing the order');
  await call(client.finalizeOrder(order, csr), 'finalizeOrder');
  const fullchain = await call(client.getCertificate(order), 'getCertificate');

  // Sanity checks before installing: parsable, matches our key, covers the names.
  const leaf = new X509Certificate(firstCertificate(fullchain));
  if (!leaf.checkPrivateKey(createPrivateKey(certKey))) throw new Error('the issued certificate does not match the private key');
  for (const n of names) {
    if (!leaf.checkHost(n)) throw new Error(`the issued certificate does not cover ${n}`);
  }
  const { notBefore, notAfter } = readCertificateDates(fullchain);
  checkAborted(); // past the deadline: the caller already recorded a failure, install nothing
  writeCertificateFiles(deps.certsDir, primaryName, fullchain, certKey);
  await log('info', `Certificate installed (valid until ${notAfter.toISOString()})`);
  return { primaryName, names, notBefore, notAfter, issuer: params.directory === 'staging' ? 'letsencrypt-staging' : 'letsencrypt' };
}
