import fs from 'fs';
import http from 'http';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import * as acme from 'acme-client';
import type { Dns01Provider } from '../dns/acmeChallenge';
import { clientCertificateError } from './certificateMessages';
import { isValidServerName } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Let's Encrypt issuance (acme-client), ported from Oblihub
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
//   P2     DNS-01 through our PowerDNS (services/dns/acmeChallenge.ts
//          dns01Provider) for wildcard names (*.name: Let's Encrypt only
//          offers dns-01 for them), for every name of an order that prefers
//          it (wildcard domains, *.previewDomain) and whenever HTTP-01 is not
//          offered; the TXT value is ALWAYS removed afterwards, even on
//          failure. HTTP-01 stays the default (P1 path unchanged).
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

/**
 * Progress log of an issuance. `message` is shown to the tenant (client users
 * included): it never embeds raw error text — that goes to `detail` (staff and
 * server log only, invariant A6, certificateMessages.ts).
 */
export type IssueLog = (level: 'info' | 'warn' | 'error', message: string, detail?: string) => void | Promise<void>;

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
  /** DNS-01 solver (our PowerDNS). Absent → HTTP-01 only (a wildcard name then fails). */
  dns01?: Dns01Provider;
  /** Hard timeout of publishing / removing one DNS-01 TXT value (default 120 s). */
  dnsTimeoutMs?: number;
  /**
   * Overall deadline of the issuance (the caller's): once aborted, every
   * pending ACME call is abandoned and nothing more is written (no token, no
   * certificate file installed after the deadline).
   */
  signal?: AbortSignal;
}

export interface IssueParams {
  /** First = primary name (certificate directory, never a wildcard), all covered as SAN; '*.x' allowed after it. */
  names: string[];
  email: string;
  directory: AcmeDirectoryName;
  /** Solve every name by DNS-01 when the provider can (wildcard orders). Default: HTTP-01 first. */
  preferDns01?: boolean;
}

export interface IssuedCertificate {
  primaryName: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  issuer: 'letsencrypt' | 'letsencrypt-staging';
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Top-level labels a public CA never issues for: RFC 6761 / RFC 2606
 * special-use names (test, example, invalid, localhost), RFC 6762 .local,
 * RFC 9476 .alt, .onion, .internal (ICANN private use), reverse zones
 * (.arpa, home.arpa) and the usual private-network suffixes. An order for
 * them is refused by Let's Encrypt anyway: the panel never sends it (no
 * pointless orders on the platform's shared ACME account, no internal host
 * name sent to the public CA).
 */
const NON_PUBLIC_TLDS = new Set([
  'test', 'example', 'invalid', 'localhost', 'local', 'alt', 'onion', 'internal', 'arpa',
  'lan', 'home', 'corp', 'intranet', 'private', 'localdomain',
]);

/** A certificate name: a valid server name, or '*.' + a valid server name. */
export function isValidCertificateName(name: string): boolean {
  return typeof name === 'string' && (name.startsWith('*.') ? isValidServerName(name.slice(2)) : isValidServerName(name));
}

/**
 * True when a public CA can issue for this name: a valid DNS name under a
 * public-looking TLD, not an IP literal ('*.name' is judged on 'name').
 */
export function isPublicAcmeName(name: string): boolean {
  if (typeof name !== 'string') return false;
  let n = name.trim().toLowerCase();
  if (n.startsWith('*.')) n = n.slice(2);
  if (!isValidServerName(n)) return false;
  const tld = n.slice(n.lastIndexOf('.') + 1);
  if (/^[0-9]+$/.test(tld)) return false; // IPv4 literal (a TLD is never all-numeric)
  return !NON_PUBLIC_TLDS.has(tld);
}

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

type AcmeChallenge = acme.Authorization['challenges'][number];

const HTTP01_FAILURE = Symbol('oblimint.http01Failure');

/** Tags an HTTP-01 validation failure (same error, same message). */
function markHttp01Failure(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  (e as Error & { [HTTP01_FAILURE]?: true })[HTTP01_FAILURE] = true;
  return e;
}

/**
 * True when issueCertificate failed while an HTTP-01 challenge was being
 * validated (port 80 unreachable, wrong address…): the caller may retry
 * with a NEW order solved by DNS-01 (a failed authorization is final).
 */
export function isHttp01Failure(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { [HTTP01_FAILURE]?: true })[HTTP01_FAILURE] === true;
}

/**
 * Picks the challenge of an authorization: dns-01 for a wildcard (the only
 * type offered), dns-01 first when preferred and solvable, else http-01,
 * else dns-01 when solvable. Throws when none is usable.
 */
export async function pickChallenge(
  auth: Pick<acme.Authorization, 'identifier' | 'challenges'> & { wildcard?: boolean },
  opts: { preferDns01: boolean; dns01?: Dns01Provider },
): Promise<AcmeChallenge> {
  const host = auth.identifier.value;
  const http = auth.challenges.find((c) => c.type === 'http-01');
  const dns = auth.challenges.find((c) => c.type === 'dns-01');
  const label = auth.wildcard ? `*.${host}` : host;
  const canDns = async (): Promise<boolean> => {
    if (!dns || !opts.dns01) return false;
    try { return await opts.dns01.canSolve(label); } catch { return false; }
  };
  if (auth.wildcard) {
    if (dns && await canDns()) return dns;
    throw new Error(`No usable DNS-01 challenge for ${label}: the zone must be hosted on this platform's DNS servers`);
  }
  if (opts.preferDns01 && dns && await canDns()) return dns;
  if (http) return http;
  if (dns && await canDns()) return dns;
  throw new Error(`No HTTP-01 challenge offered for ${host}`);
}

/** Full issuance (HTTP-01, DNS-01 for wildcards). Throws on failure (the caller records it). */
export async function issueCertificate(params: IssueParams, deps: IssueDeps): Promise<IssuedCertificate> {
  const names = [...new Set(params.names.map((n) => n.toLowerCase()))];
  if (!names.length || !names.every(isValidCertificateName) || names[0].startsWith('*.')) throw new Error('invalid certificate names');
  // Last guard before the CA (callers already skip these names).
  const nonPublic = names.find((n) => !isPublicAcmeName(n));
  if (nonPublic) throw new Error(`${nonPublic} is not publicly resolvable (reserved or private name): Let's Encrypt cannot issue for it`);
  if (!params.email || /[\s<>]/.test(params.email) || !params.email.includes('@')) throw new Error('invalid ACME contact email');
  const primaryName = names[0];
  const log = async (level: 'info' | 'warn' | 'error', message: string, detail?: string) => { await deps.log(level, message, detail); };
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
  const dnsMs = deps.dnsTimeoutMs ?? 120_000;

  /** DNS-01: TXT _acme-challenge.<name> published on our PowerDNS, validated, then ALWAYS removed. */
  const solveDns01 = async (host: string, challenge: AcmeChallenge): Promise<void> => {
    const dns01 = deps.dns01 as Dns01Provider;
    // acme-client returns the base64url SHA-256 digest of the key authorization for dns-01.
    const value = await call(client.getChallengeKeyAuthorization(challenge), 'getChallengeKeyAuthorization');
    checkAborted();
    let published = false;
    try {
      await withTimeout(dns01.setChallenge(host, value), dnsMs, 'DNS-01 TXT publication', signal);
      published = true;
      await log('info', `[${host}] DNS-01 TXT record published`);
      await log('info', `[${host}] Asking Let's Encrypt to validate the DNS-01 challenge`);
      await withTimeout(client.completeChallenge(challenge), timeoutMs, 'completeChallenge (dns-01)', signal);
      await withTimeout(client.waitForValidStatus(challenge), timeoutMs, 'waitForValidStatus (dns-01)', signal);
      await log('info', `[${host}] Challenge validated`);
    } catch (err) {
      const raw = (err as Error)?.message || String(err);
      await log('error', `[${host}] DNS-01 challenge failed: ${clientCertificateError(`dns-01 ${raw}`)}`, raw);
      throw err;
    } finally {
      // Removed even when the publication failed half-way (never throws by contract; bounded anyway).
      try {
        await withTimeout(dns01.removeChallenge(host, value), dnsMs, 'DNS-01 TXT removal');
        if (published) await log('info', `[${host}] DNS-01 TXT record removed`);
      } catch (err) {
        await log('warn', `[${host}] DNS-01 TXT record removal failed`, (err as Error)?.message || String(err));
      }
    }
  };

  for (const auth of authorizations as Array<acme.Authorization & { wildcard?: boolean }>) {
    const host = auth.wildcard ? `*.${auth.identifier.value}` : auth.identifier.value;
    if (auth.status === 'valid') {
      await log('info', `[${host}] Authorization already valid`);
      continue;
    }
    const challenge = await pickChallenge(auth, { preferDns01: !!params.preferDns01, dns01: deps.dns01 });
    if (challenge.type === 'dns-01') {
      await solveDns01(host, challenge);
      continue;
    }
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
          // The detail (edge address, start of the body) is for the staff only.
          await log(r.ok ? 'info' : 'warn', `[${host}] Internal self-test ${r.ok ? 'passed' : 'failed'}`, r.detail);
        } catch (err) {
          await log('warn', `[${host}] Internal self-test error`, (err as Error).message);
        }
      }

      await log('info', `[${host}] Asking Let's Encrypt to validate the challenge`);
      await withTimeout(client.completeChallenge(challenge), timeoutMs, 'completeChallenge', signal, PORT80_HINT);
      await withTimeout(client.waitForValidStatus(challenge), timeoutMs, 'waitForValidStatus', signal, PORT80_HINT);
      await log('info', `[${host}] Challenge validated`);
    } catch (err) {
      await log('error', `[${host}] Challenge failed: ${clientCertificateError((err as Error)?.message || String(err))}`, (err as Error)?.message || String(err));
      await log('info', `Check: ${host} resolves to this server, port 80 is open (firewall / NAT), no CDN proxy in front during validation.`);
      throw markHttp01Failure(err);
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
    // A wildcard is checked on a sample name one label below it.
    const probe = n.startsWith('*.') ? `oblimint-check.${n.slice(2)}` : n;
    if (!leaf.checkHost(probe)) throw new Error(`the issued certificate does not cover ${n}`);
  }
  const { notBefore, notAfter } = readCertificateDates(fullchain);
  checkAborted(); // past the deadline: the caller already recorded a failure, install nothing
  writeCertificateFiles(deps.certsDir, primaryName, fullchain, certKey);
  await log('info', `Certificate installed (valid until ${notAfter.toISOString()})`);
  return { primaryName, names, notBefore, notAfter, issuer: params.directory === 'staging' ? 'letsencrypt-staging' : 'letsencrypt' };
}
