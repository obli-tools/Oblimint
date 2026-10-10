import { X509Certificate, createPrivateKey } from 'node:crypto';
import type { SourceSession } from '../contracts/source';
import { parseMysqlBatch, cellStr } from './parsers/mysqlBatch';
import { pemCertificates } from './parsers/x509';

// ─────────────────────────────────────────────────────────────────────────────
// Just-in-time secret readers (docs/P5-PLAN.md §7.4, invariant MG2). OWNED BY
// MODULE `discovery` (it knows the CWP formats); consumed by the executors in
// a TRANSFER session. Values are returned to the caller only: never logged,
// never stored in the inventory / plan / run tables; the caller writes them
// into their sealed / hashed target column at once. Formats are validated
// here; an invalid value is DROPPED (or a generic error is thrown) and never
// echoed in an error message.
// ─────────────────────────────────────────────────────────────────────────────

export interface CwpMailboxHash {
  address: string;
  /** As stored ('{SHA512-CRYPT}$6$…' or a bare crypt string). */
  hash: string;
}

export interface CwpMysqlUserHash {
  user: string;
  host: string;
  plugin: string;
  /** '*' + 40 upper-case hex (mysql_native_password), from Password or authentication_string; null = none / not native. */
  nativeHash: string | null;
}

export interface CwpCertificateBundle {
  certificatePem: string;
  chainPem: string | null;
  privateKeyPem: string;
}

/** Generic error of a secret reader (no value, no output inside). */
export class CwpSecretError extends Error {
  readonly code = 'secretInvalid';
  constructor(message: string) {
    super(message);
    this.name = 'CwpSecretError';
  }
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$/;
const SELECTOR = /^[A-Za-z0-9._-]{1,63}$/;
const FQDN_FILE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,252})$/;
const MYSQL_USER = /^[A-Za-z0-9_$.-]{1,80}$/;
const FTP_LOGIN = /^[A-Za-z0-9._@+-]{1,128}$/;

/** '{SCHEME}…' or a crypt string; no whitespace / control characters; bounded. */
export const MAIL_HASH = /^(?:\{[A-Z0-9.-]{2,32}\})?[\x21-\x7e]{1,500}$/;
export const NATIVE_HASH = /^\*[0-9A-F]{40}$/;
export const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
const CRYPT_HASH = /^\$(?:1|5|6)\$[./A-Za-z0-9$=,+]{2,200}$/;
const PRIVATE_KEY_PEM = /-----BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n:,-]+?-----END \1PRIVATE KEY-----/;

function assertDomain(d: string): string {
  const v = d.trim().toLowerCase();
  if (!DOMAIN.test(v) || v.length > 253) throw new CwpSecretError('Domaine invalide');
  return v;
}

/** Native hash from the mysql.user columns (Password first, then authentication_string for '' / mysql_native_password). */
export function nativeHashOf(password: string | null, plugin: string, authString: string | null): string | null {
  const p = (password ?? '').trim().toUpperCase();
  if (NATIVE_HASH.test(p)) return p;
  if (plugin === '' || plugin === 'mysql_native_password') {
    const a = (authString ?? '').trim().toUpperCase();
    if (NATIVE_HASH.test(a)) return a;
  }
  return null;
}

/** Normalised private-key PEM block, null when the text holds none (unencrypted only). */
export function privateKeyPem(text: string): string | null {
  const m = PRIVATE_KEY_PEM.exec(text);
  if (!m || m[1] === 'ENCRYPTED ') return null;
  const pem = `${m[0].replace(/\r\n/g, '\n').trim()}\n`;
  try {
    createPrivateKey(pem);
  } catch {
    return null;
  }
  return pem;
}

function derOf(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

export const cwpSecrets = {
  async mailboxHashes(session: SourceSession, domain: string): Promise<CwpMailboxHash[]> {
    const d = assertDomain(domain);
    const r = await session.run('secret.mailboxHashes', { domain: d });
    const out: CwpMailboxHash[] = [];
    for (const row of parseMysqlBatch(r.stdout, { header: true })) {
      const address = (cellStr(row.username) ?? '').trim().toLowerCase();
      const hash = (cellStr(row.password) ?? '').trim();
      if (!address.endsWith(`@${d}`) || hash === '' || !MAIL_HASH.test(hash)) continue;
      out.push({ address, hash });
    }
    return out;
  },

  async mysqlUserHashes(session: SourceSession, users: string[]): Promise<CwpMysqlUserHash[]> {
    const list = [...new Set(users.filter((u) => MYSQL_USER.test(u)))];
    if (list.length === 0) return [];
    const r = await session.run('secret.mysqlUserHashes', { users: list });
    const wanted = new Set(list);
    const out: CwpMysqlUserHash[] = [];
    for (const row of parseMysqlBatch(r.stdout, { header: true })) {
      const user = cellStr(row.User) ?? '';
      if (!wanted.has(user)) continue;
      const plugin = cellStr(row.plugin) ?? '';
      out.push({
        user,
        host: cellStr(row.Host) ?? '',
        plugin,
        nativeHash: nativeHashOf(cellStr(row.Password), plugin, cellStr(row.authentication_string)),
      });
    }
    return out;
  },

  /** PEM of /etc/opendkim/userkeys/<domain>/<selector>.private, null = missing. */
  async dkimPrivateKey(session: SourceSession, domain: string, selector: string): Promise<string | null> {
    const d = assertDomain(domain);
    if (!SELECTOR.test(selector)) throw new CwpSecretError('Sélecteur DKIM invalide');
    const r = await session.run('secret.dkimPrivateKey', { domain: d, selector }, { allowNonZeroExit: true });
    if (r.exitCode !== 0 || r.stdout.trim() === '') return null;
    const pem = privateKeyPem(r.stdout);
    if (!pem) throw new CwpSecretError(`Clé DKIM ${selector}._domainkey.${d} illisible (format inattendu)`);
    return pem;
  },

  /** cert + bundle (public, fs.cat) + key (secret.certificateKey), null = incomplete. */
  async certificateBundle(session: SourceSession, fqdn: string): Promise<CwpCertificateBundle | null> {
    const f = fqdn.trim();
    if (!FQDN_FILE.test(f) || f.includes('..')) throw new CwpSecretError('Nom de certificat invalide');
    const cert = await session.run('fs.cat', { path: `/etc/pki/tls/certs/${f}.cert` }, { allowNonZeroExit: true });
    if (cert.exitCode !== 0) return null;
    const certificatePem = pemCertificates(cert.stdout)[0];
    if (!certificatePem) return null;
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(certificatePem);
    } catch {
      return null;
    }
    const bundle = await session.run('fs.cat', { path: `/etc/pki/tls/certs/${f}.bundle` }, { allowNonZeroExit: true });
    const leafDer = derOf(certificatePem);
    const chain = bundle.exitCode === 0 ? pemCertificates(bundle.stdout).filter((p) => !derOf(p).equals(leafDer)) : [];
    const key = await session.run('secret.certificateKey', { fqdn: f }, { allowNonZeroExit: true });
    if (key.exitCode !== 0 || key.stdout.trim() === '') return null;
    const privateKey = privateKeyPem(key.stdout);
    if (!privateKey) throw new CwpSecretError(`Clé du certificat ${f} illisible (format inattendu)`);
    if (!x509.checkPrivateKey(createPrivateKey(privateKey))) throw new CwpSecretError(`La clé du certificat ${f} ne correspond pas au certificat`);
    return { certificatePem, chainPem: chain.length > 0 ? chain.join('') : null, privateKeyPem: privateKey };
  },

  /** bcrypt / crypt hash of a Pure-FTPd virtual user, null = unknown login. */
  async ftpUserHash(session: SourceSession, login: string): Promise<string | null> {
    if (!FTP_LOGIN.test(login)) throw new CwpSecretError('Identifiant FTP invalide');
    const r = await session.run('secret.ftpUserHash', { login }, { allowNonZeroExit: true });
    if (r.exitCode !== 0) return null;
    const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
    if (BCRYPT_HASH.test(line) || CRYPT_HASH.test(line)) return line;
    return null;
  },
};
