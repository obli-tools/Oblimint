import crypto, { X509Certificate } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AppError } from '../../middleware/errorHandler';
import { isValidServerName } from '../edge/nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Imported certificates (docs/P4b-PLAN.md §8.1, invariant PX4).
//   - parse (PURE): the certificate PEM with node:crypto X509Certificate, the
//     optional chain, the private key (matched against the certificate),
//     expiry, names (SAN DNS, else CN);
//   - names ⊂ the account's VERIFIED domains or their subdomains (wildcards
//     included) — 403 certificateNamesNotOwned otherwise;
//   - files: <edge>/certs/imported-<id>/{fullchain,privkey}.pem written
//     atomically (exclusive tmp + rename, key 0600), the directory itself is
//     never a symbolic link (R1). The key is sealed in the database
//     (secretBox 'proxy-cert') and rewritten from there if the files vanish.
// ─────────────────────────────────────────────────────────────────────────────

export const CERT_PEM_MAX = 64 * 1024;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface ParsedCertificate {
  names: string[];
  issuer: string | null;
  notBefore: Date;
  notAfter: Date;
  /** Leaf + chain, normalized (one PEM block per certificate). */
  fullchain: string;
  /** Normalized PKCS#8 PEM of the key. */
  privateKey: string;
  leafPem: string;
  chainPem: string | null;
}

function invalid(message: string): AppError {
  return new AppError(400, message, 'certificateInvalid');
}

function dnLine(dn: string, key: string): string | null {
  for (const part of String(dn ?? '').split(/\n|,\s*/)) {
    const [k, ...v] = part.split('=');
    if (k?.trim() === key) return v.join('=').trim() || null;
  }
  return null;
}

/** DNS names of a certificate (SAN, else CN), lower case, valid entries only. */
export function certificateNames(x: X509Certificate): string[] {
  const out: string[] = [];
  for (const entry of (x.subjectAltName ?? '').split(/,\s*/)) {
    const m = /^DNS:(.+)$/.exec(entry.trim());
    if (m) out.push(m[1].trim().toLowerCase());
  }
  if (!out.length) {
    const cn = dnLine(x.subject, 'CN');
    if (cn) out.push(cn.toLowerCase());
  }
  return [...new Set(out.filter((n) => isValidServerName(n.startsWith('*.') ? n.slice(2) : n)))];
}

/** Parses + checks a certificate / key pair. Throws 400 certificateInvalid. */
export function parseImportedCertificate(certificatePem: string, privateKeyPem: string, chainPem: string | null | undefined, now = new Date()): ParsedCertificate {
  if (typeof certificatePem !== 'string' || certificatePem.length > CERT_PEM_MAX) throw invalid('Invalid certificate');
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length > CERT_PEM_MAX) throw invalid('Invalid private key');
  if (chainPem && (typeof chainPem !== 'string' || chainPem.length > CERT_PEM_MAX)) throw invalid('Invalid chain');
  const leafBlocks = certificatePem.match(PEM_CERT_RE) ?? [];
  const first = leafBlocks[0];
  if (!first) throw invalid('No certificate found in the PEM');
  // A pasted full chain: first block = leaf, the others = chain.
  const chainBlocks = [...leafBlocks.slice(1), ...((chainPem ?? '').match(PEM_CERT_RE) ?? [])];
  if (chainPem && !(chainPem.match(PEM_CERT_RE) ?? []).length) throw invalid('No certificate found in the chain');
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(first);
    for (const c of chainBlocks) void new X509Certificate(c);
  } catch {
    throw invalid('Unreadable certificate');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    throw invalid('Unreadable private key (encrypted keys are not supported)');
  }
  if (!leaf.checkPrivateKey(key)) throw invalid('The private key does not match the certificate');
  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (!Number.isFinite(notAfter.getTime()) || notAfter.getTime() <= now.getTime()) throw invalid('The certificate is expired');
  const names = certificateNames(leaf);
  if (!names.length) throw invalid('The certificate has no DNS name');
  const leafPem = `${first.trim()}\n`;
  const chain = chainBlocks.map((c) => `${c.trim()}\n`).join('');
  return {
    names,
    issuer: (dnLine(leaf.issuer, 'O') ?? dnLine(leaf.issuer, 'CN'))?.slice(0, 255) ?? null,
    notBefore,
    notAfter,
    fullchain: leafPem + chain,
    privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString(),
    leafPem,
    chainPem: chain || null,
  };
}

/** Is every certificate name one of `verifiedDomains` or a subdomain (wildcards included)? Returns the names that are not. */
export function namesNotOwned(names: readonly string[], verifiedDomains: readonly string[]): string[] {
  const owned = verifiedDomains.map((d) => d.toLowerCase());
  return names.filter((n) => {
    const base = n.startsWith('*.') ? n.slice(2) : n;
    return !owned.some((d) => base === d || base.endsWith(`.${d}`));
  });
}

export const importedCertDirName = (id: number): string => `imported-${Number(id)}`;

function assertRealDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
}

/** Writes fullchain.pem (0644) + privkey.pem (0600) under <certsDir>/imported-<id>/ without following links. */
export function writeImportedCertificateFiles(certsDir: string, id: number, fullchain: string, privateKey: string): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid certificate id');
  fs.mkdirSync(certsDir, { recursive: true, mode: 0o755 });
  assertRealDir(certsDir);
  const dir = path.join(certsDir, importedCertDirName(id));
  try {
    assertRealDir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(dir, { mode: 0o755 });
  }
  const write = (name: string, content: string, mode: number) => {
    const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, path.join(dir, name));
  };
  write('privkey.pem', privateKey, 0o600);
  write('fullchain.pem', fullchain, 0o644);
}

export function importedCertificateFilesExist(certsDir: string, id: number): boolean {
  const dir = path.join(certsDir, importedCertDirName(id));
  try {
    assertRealDir(dir);
    return fs.lstatSync(path.join(dir, 'fullchain.pem')).isFile() && fs.lstatSync(path.join(dir, 'privkey.pem')).isFile();
  } catch {
    return false;
  }
}

export function removeImportedCertificateFiles(certsDir: string, id: number): void {
  if (!Number.isInteger(id) || id <= 0) return;
  fs.rmSync(path.join(certsDir, importedCertDirName(id)), { recursive: true, force: true });
}
