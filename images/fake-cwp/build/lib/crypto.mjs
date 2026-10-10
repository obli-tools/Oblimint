// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — key / hash / certificate material.
//
// realCrypto()        build host (Rocky 8 image build): openssl, htpasswd and
//                     ssh-keygen through execFileSync (no shell, fixed argv).
// placeholderCrypto() static checks on any OS: deterministic, obviously fake
//                     values with the right SHAPE (prefixes, lengths), so the
//                     plan is identical apart from the secrets.
// Salts are derived from the subject (stable hashes across rebuilds).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CRYPT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Deterministic crypt salt of `len` characters derived from a subject. */
export function saltFor(subject, len) {
  const digest = createHash('sha256').update(`fake-cwp:${subject}`).digest();
  let out = '';
  for (let i = 0; i < len; i += 1) out += CRYPT_ALPHABET[digest[i % digest.length] % 64];
  return out;
}

/** MySQL / MariaDB mysql_native_password hash: '*' + upper(hex(sha1(sha1(pw)))). Pure. */
export function mysqlNativeHash(password) {
  const inner = createHash('sha1').update(password, 'utf8').digest();
  return `*${createHash('sha1').update(inner).digest('hex').toUpperCase()}`;
}

function pemBody(pem) {
  return pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
}

const DAY = 86400000;

/** UTCTime YYMMDDHHMMSSZ (openssl ca -startdate / -enddate). */
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function validityWindow(validity, now = new Date()) {
  if (validity === 'expired') return { start: new Date(Date.UTC(2023, 0, 1)), end: new Date(Date.UTC(2024, 0, 1)) };
  // Let's Encrypt-like: issued 10 days ago, 90 days lifetime.
  return { start: new Date(now.getTime() - 10 * DAY), end: new Date(now.getTime() + 80 * DAY) };
}

export function realCrypto({ workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cwp-crypto-')) } = {}) {
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  const tmp = (name) => path.join(workDir, name);
  let ca = null;

  function ensureCa() {
    if (ca) return ca;
    const dir = tmp('ca');
    fs.mkdirSync(path.join(dir, 'newcerts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.txt'), '');
    fs.writeFileSync(path.join(dir, 'serial'), '1000\n');
    fs.writeFileSync(path.join(dir, 'openssl.cnf'), [
      '[ ca ]', 'default_ca = fake', '',
      '[ fake ]', `dir = ${dir}`, 'database = $dir/index.txt', 'new_certs_dir = $dir/newcerts', 'serial = $dir/serial',
      'default_md = sha256', 'policy = policy_any', 'copy_extensions = copy', 'unique_subject = no', 'email_in_dn = no',
      'x509_extensions = leaf_ext', '',
      '[ policy_any ]', 'commonName = supplied', '',
      '[ leaf_ext ]', 'basicConstraints = CA:FALSE', 'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth', 'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid', '',
    ].join('\n'));
    run('openssl', ['genrsa', '-out', path.join(dir, 'ca.key'), '2048']);
    run('openssl', ['req', '-x509', '-new', '-key', path.join(dir, 'ca.key'), '-sha256', '-days', '3650',
      '-subj', '/O=fake-cwp TEST ONLY/CN=fake-cwp Test CA R1', '-out', path.join(dir, 'ca.crt')]);
    ca = { dir, cert: fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8') };
    return ca;
  }

  return {
    kind: 'real',
    sha512crypt(password, subject) {
      return run('openssl', ['passwd', '-6', '-salt', saltFor(subject, 16), password]).trim();
    },
    md5crypt(password, subject) {
      return run('openssl', ['passwd', '-1', '-salt', saltFor(subject, 8), password]).trim();
    },
    /** Pure-FTPd bcrypt: htpasswd emits $2y$, CWP stores $2a$ (same algorithm). */
    bcrypt(password, login) {
      const line = run('htpasswd', ['-nbBC', '10', login, password]).trim();
      const hash = line.slice(line.indexOf(':') + 1);
      return hash.replace(/^\$2y\$/, '$2a$');
    },
    mysqlNative: mysqlNativeHash,
    /** PKCS#1 RSA private key (openssl 1.1 genrsa), like opendkim-genkey / acme.sh. */
    rsaKey(bits, id) {
      const file = tmp(`rsa-${id.replace(/[^A-Za-z0-9.-]/g, '_')}.key`);
      run('openssl', ['genrsa', '-out', file, String(bits)]);
      return fs.readFileSync(file, 'utf8');
    },
    /** Base64 of the SubjectPublicKeyInfo DER (the p= of a DKIM record). */
    rsaPublicB64(privatePem) {
      return pemBody(run('openssl', ['rsa', '-pubout'], { input: privatePem }));
    },
    certificate(spec) {
      const id = spec.name.replace(/[^A-Za-z0-9.-]/g, '_');
      const keyFile = tmp(`${id}.key`);
      const csrFile = tmp(`${id}.csr`);
      const crtFile = tmp(`${id}.crt`);
      if (spec.key === 'ec') {
        run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile]);
      } else {
        run('openssl', ['genrsa', '-out', keyFile, '2048']);
      }
      const san = `subjectAltName=${spec.names.map((n) => `DNS:${n}`).join(',')}`;
      const { start, end } = validityWindow(spec.validity);
      if (spec.issuer === 'self') {
        const days = String(Math.max(1, Math.round((end.getTime() - Date.now()) / DAY)));
        run('openssl', ['req', '-x509', '-new', '-key', keyFile, '-sha256', '-days', days,
          '-subj', `/CN=${spec.names[0]}`, '-addext', san, '-out', crtFile]);
        return { certPem: fs.readFileSync(crtFile, 'utf8'), chainPem: '', keyPem: fs.readFileSync(keyFile, 'utf8') };
      }
      const authority = ensureCa();
      run('openssl', ['req', '-new', '-key', keyFile, '-subj', `/CN=${spec.names[0]}`, '-addext', san, '-out', csrFile]);
      run('openssl', ['ca', '-batch', '-notext', '-config', path.join(authority.dir, 'openssl.cnf'),
        '-cert', path.join(authority.dir, 'ca.crt'), '-keyfile', path.join(authority.dir, 'ca.key'),
        '-startdate', utcTime(start), '-enddate', utcTime(end), '-in', csrFile, '-out', crtFile]);
      return { certPem: fs.readFileSync(crtFile, 'utf8'), chainPem: authority.cert, keyPem: fs.readFileSync(keyFile, 'utf8') };
    },
    caCertificate() {
      return ensureCa().cert;
    },
    sshPublicKey(comment) {
      const file = tmp(`ssh-${comment.replace(/[^A-Za-z0-9.-]/g, '_')}`);
      run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
      const pub = fs.readFileSync(`${file}.pub`, 'utf8').trim();
      fs.rmSync(file, { force: true });
      return pub;
    },
    tsigSecret() {
      return run('openssl', ['rand', '-base64', '32']).trim();
    },
    cleanup() {
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Same shapes, fake values: the static checker never needs real secrets. */
export function placeholderCrypto() {
  const fakeB64 = (subject, len) => createHash('sha512').update(subject).digest('base64').replace(/[^A-Za-z0-9]/g, 'A').padEnd(len, 'A').slice(0, len);
  const fakePem = (label, subject) => `-----BEGIN ${label}-----\n${fakeB64(subject, 64)}\n-----END ${label}-----\n`;
  return {
    kind: 'placeholder',
    sha512crypt: (password, subject) => `$6$${saltFor(subject, 16)}$${fakeB64(`sha512:${subject}`, 86)}`,
    md5crypt: (password, subject) => `$1$${saltFor(subject, 8)}$${fakeB64(`md5:${subject}`, 22)}`,
    bcrypt: (password, login) => `$2a$10$${fakeB64(`bcrypt:${login}`, 53)}`,
    mysqlNative: mysqlNativeHash,
    rsaKey: (bits, id) => fakePem('RSA PRIVATE KEY', `rsa:${bits}:${id}`),
    rsaPublicB64: (pem) => `MIIB${fakeB64(`pub:${pem}`, 388)}`,
    certificate: (spec) => ({
      certPem: fakePem('CERTIFICATE', `cert:${spec.name}`),
      chainPem: spec.issuer === 'self' ? '' : fakePem('CERTIFICATE', 'ca'),
      keyPem: fakePem(spec.key === 'ec' ? 'EC PRIVATE KEY' : 'RSA PRIVATE KEY', `key:${spec.name}`),
    }),
    caCertificate: () => fakePem('CERTIFICATE', 'ca'),
    sshPublicKey: (comment) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fakeB64(`ssh:${comment}`, 43)} ${comment}`,
    tsigSecret: () => `${fakeB64('tsig', 43)}=`,
    cleanup() {},
  };
}
