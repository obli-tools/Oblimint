import fs from 'fs';
import path from 'path';
import { X509Certificate } from 'crypto';
import selfsigned from 'selfsigned';
import { logger } from '../../utils/logger';
import { isValidServerName, SELF_SIGNED_CERT_DIR } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Self-signed fallback certificate of the PLATFORM vhosts (panel, DB admin,
// IP probes). Module `edge-ownership`.
// Let's Encrypt never issues for private / reserved names (.test, .internal,
// a LAN-only panel…) and needs time (or fails) for public ones. Without TLS
// on those names the platform does not work at all: the panel's __Host-
// session cookie, the phpMyAdmin / Adminer SSO cookies (Secure) and the
// https:// SSO and probe URLs all need HTTPS. So the edge serves them with
// ONE self-signed certificate covering every platform name, kept in
// <edge>/certs/_selfsigned/{fullchain,privkey}.pem + names.json, until an
// ACME certificate exists for the name (vhostPlan prefers it).
// Regenerated when the set of names changes or 30 days before it expires.
// Never used for a tenant domain or a preview (nginxConfig refuses it).
// ─────────────────────────────────────────────────────────────────────────────

export const SELF_SIGNED_VALIDITY_DAYS = 397;
export const SELF_SIGNED_RENEW_BEFORE_MS = 30 * 24 * 3600_000;
const META_FILE = 'names.json';

export interface SelfSignedState {
  /** Names the certificate on disk covers (sorted). */
  names: string[];
  notAfter: Date;
}

/** Sorted, de-duplicated, valid platform names. */
export function fallbackNames(names: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(names.filter((n): n is string => !!n).map((n) => n.toLowerCase()).filter(isValidServerName))].sort();
}

/** The certificate on disk (null: missing, unreadable, or its files disagree with names.json). */
export function readSelfSigned(certsDir: string): SelfSignedState | null {
  const dir = path.join(certsDir, SELF_SIGNED_CERT_DIR);
  try {
    const certPem = fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf8');
    if (!fs.existsSync(path.join(dir, 'privkey.pem'))) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as { names?: unknown };
    const names = Array.isArray(meta.names) ? fallbackNames(meta.names.map(String)) : [];
    const x509 = new X509Certificate(certPem);
    // The SANs of the certificate are the truth (names.json only caches them).
    const san = (x509.subjectAltName ?? '').split(',').map((e) => e.trim()).filter((e) => e.startsWith('DNS:')).map((e) => e.slice(4).toLowerCase());
    if (names.some((n) => !san.includes(n))) return null;
    return { names, notAfter: new Date(x509.validTo) };
  } catch {
    return null;
  }
}

/** Does the certificate on disk need to be (re)generated for these names? */
export function needsRegeneration(current: SelfSignedState | null, names: readonly string[], now: number): boolean {
  if (!current) return true;
  if (current.names.length !== names.length || current.names.some((n, i) => n !== names[i])) return true;
  return current.notAfter.getTime() - now < SELF_SIGNED_RENEW_BEFORE_MS;
}

function generate(names: readonly string[]): Promise<{ cert: string; key: string }> {
  return new Promise((resolve, reject) => {
    selfsigned.generate([
      { name: 'commonName', value: names[0] },
      { name: 'organizationName', value: 'Oblimint (self-signed fallback)' },
    ], {
      keySize: 2048,
      days: SELF_SIGNED_VALIDITY_DAYS,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) },
      ],
    }, (err, pems) => (err ? reject(err) : resolve({ cert: pems.cert, key: pems.private })));
  });
}

let inflight: Promise<string[] | null> | null = null;

/**
 * Makes sure the fallback certificate covers exactly `platformNames`.
 * Returns the names it covers (what vhostPlan may serve with it), or null when
 * there is no certificate (no names, edge not deployed: certs dir missing,
 * generation / write failed — logged, the vhosts stay HTTP only as before).
 * Single-flight: concurrent syncs share one generation.
 */
export async function ensureSelfSignedFallback(certsDir: string, platformNames: ReadonlyArray<string | null | undefined>,
  now = Date.now()): Promise<string[] | null> {
  const names = fallbackNames(platformNames);
  if (!names.length || !fs.existsSync(certsDir)) return null;
  const current = readSelfSigned(certsDir);
  if (!needsRegeneration(current, names, now)) return current!.names;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { cert, key } = await generate(names);
      const dir = path.join(certsDir, SELF_SIGNED_CERT_DIR);
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      const keyFile = path.join(dir, 'privkey.pem');
      const certFile = path.join(dir, 'fullchain.pem');
      const metaFile = path.join(dir, META_FILE);
      fs.writeFileSync(`${keyFile}.tmp`, key, { mode: 0o600 });
      fs.chmodSync(`${keyFile}.tmp`, 0o600);
      fs.writeFileSync(`${certFile}.tmp`, cert, { mode: 0o644 });
      fs.writeFileSync(`${metaFile}.tmp`, JSON.stringify({ names }), { mode: 0o644 });
      // Key first, then certificate, then names: a reader never sees names the certificate does not cover.
      fs.renameSync(`${keyFile}.tmp`, keyFile);
      fs.renameSync(`${certFile}.tmp`, certFile);
      fs.renameSync(`${metaFile}.tmp`, metaFile);
      logger.info({ names }, 'edge: self-signed fallback certificate generated for the platform names');
      return names;
    } catch (err) {
      logger.warn({ err: (err as Error).message, names }, 'edge: self-signed fallback certificate not generated');
      // A previous certificate still covering some names keeps serving them.
      return current ? current.names.filter((n) => names.includes(n)) : null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
