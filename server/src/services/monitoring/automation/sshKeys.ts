import crypto from 'crypto';
import { utils as ssh2Utils } from 'ssh2';

// ─────────────────────────────────────────────────────────────────────────────
// SSH keys of the automation (docs/P4b-PLAN.md §11.2) — PURE crypto part:
//   - generated: ed25519 through node:crypto, written in the OpenSSH
//     "openssh-key-v1" format (unencrypted: the private key is sealed by
//     secretBox('automation') at rest), the format ssh2 reads;
//   - imported: any unencrypted private key ssh2 parses (ed25519, ecdsa,
//     rsa ≥ 2048), refused when encrypted / malformed;
//   - public key line `<type> <base64> <comment>` and fingerprint
//     `SHA256:<base64 without padding>` (ssh-keygen -l -E sha256).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_PRIVATE_KEY_BYTES = 16 * 1024;

export interface KeyMaterial {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

export class SshKeyError extends Error {}

function sshString(b: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** SHA256 fingerprint of a public key blob (wire format), as ssh-keygen prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function wrap(b64: string, width = 70): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join('\n');
}

/** Sanitized comment (no line break / control character). */
export function keyComment(name: string): string {
  return `oblimint/${name}`.replace(/[^\x21-\x7e]+/g, '_').slice(0, 64);
}

/** New ed25519 key pair. */
export function generateEd25519(comment: string): KeyMaterial {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!pubJwk.x || !privJwk.d) throw new SshKeyError('ed25519 export failed');
  const pub = Buffer.from(pubJwk.x, 'base64url');
  const seed = Buffer.from(privJwk.d, 'base64url');
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap(body.toString('base64'))}\n-----END OPENSSH PRIVATE KEY-----\n`,
    fingerprint: fingerprintOf(pubBlob),
  };
}

/** Imported private key → public line + fingerprint (throws SshKeyError). */
export function importPrivateKey(text: string, comment: string): KeyMaterial {
  if (typeof text !== 'string' || !text.trim()) throw new SshKeyError('Empty key');
  if (Buffer.byteLength(text, 'utf8') > MAX_PRIVATE_KEY_BYTES) throw new SshKeyError('Key too large');
  const normalized = `${text.replace(/\r\n/g, '\n').trim()}\n`;
  if (/ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(normalized)) throw new SshKeyError('Encrypted keys are not supported (remove the passphrase first)');
  let parsed: ReturnType<typeof ssh2Utils.parseKey>;
  try {
    parsed = ssh2Utils.parseKey(normalized);
  } catch {
    throw new SshKeyError('Unreadable private key');
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new SshKeyError(key instanceof Error && /passphrase|encrypt/i.test(key.message) ? 'Encrypted keys are not supported (remove the passphrase first)' : 'Unreadable private key');
  if (!key.isPrivateKey()) throw new SshKeyError('This is not a private key');
  if (key.type === 'ssh-dss') throw new SshKeyError('DSA keys are not supported');
  const blob = key.getPublicSSH();
  if (key.type === 'ssh-rsa') {
    // RSA modulus from the blob (string type, mpint e, mpint n): ≥ 2048 bits.
    const tl = blob.readUInt32BE(0);
    const el = blob.readUInt32BE(4 + tl);
    const nl = blob.readUInt32BE(8 + tl + el);
    if ((nl - 1) * 8 < 2048) throw new SshKeyError('RSA keys must be at least 2048 bits');
  }
  return { publicKey: `${key.type} ${blob.toString('base64')} ${comment}`, privateKey: normalized, fingerprint: fingerprintOf(blob) };
}
