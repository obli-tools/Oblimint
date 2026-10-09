import crypto from 'crypto';
import type { AccountSshKey } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { isUniqueViolation } from './hostingValidation.service';
import { toSshKey, type SshKeyRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// SSH public keys of the file server (invariant F2): one OpenSSH line
// "<algo> <base64 blob> [comment]"; allowed algorithms ssh-ed25519,
// ecdsa-sha2-nistp256/384/521 and ssh-rsa with a modulus ≥ 3072 bits. The
// blob is parsed (wire format, RFC 4253 §6.6 / RFC 5656 §3.1 / RFC 8709):
// its embedded algorithm must match the declared one and nothing may trail.
// Fingerprint = OpenSSH "SHA256:" + unpadded base64(sha256(blob)).
// ─────────────────────────────────────────────────────────────────────────────

export const ALLOWED_SSH_ALGORITHMS = [
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa',
] as const;
export type SshAlgorithm = typeof ALLOWED_SSH_ALGORITHMS[number];

export const MIN_RSA_BITS = 3072;

/** Uncompressed EC point length (0x04 || X || Y) per curve. */
const EC_POINT_LENGTH: Record<string, number> = { nistp256: 65, nistp384: 97, nistp521: 133 };

export interface ParsedSshKey {
  algorithm: SshAlgorithm;
  blob: Buffer;
  /** Canonical line stored in the DB: "<algo> <base64> [comment]". */
  line: string;
  comment: string | null;
  fingerprint: string;
  /** RSA modulus size, null for the other algorithms. */
  bits: number | null;
}

export class SshKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshKeyError';
  }
}

/** Minimal reader of the SSH wire format. */
class WireReader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}

  string(): Buffer {
    if (this.off + 4 > this.buf.length) throw new SshKeyError('Truncated key');
    const len = this.buf.readUInt32BE(this.off);
    this.off += 4;
    if (len > this.buf.length - this.off) throw new SshKeyError('Truncated key');
    const out = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return out;
  }

  done(): boolean {
    return this.off === this.buf.length;
  }
}

export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Bit length of an SSH mpint (big-endian, two's complement, leading 0x00 when positive with the high bit set). */
function mpintBits(v: Buffer): number {
  let i = 0;
  while (i < v.length && v[i] === 0) i++;
  if (i === v.length) return 0;
  return (v.length - i - 1) * 8 + (32 - Math.clz32(v[i]));
}

/** Parses and validates one OpenSSH public key line. Throws SshKeyError with an English reason. */
export function parseSshPublicKey(input: string): ParsedSshKey {
  const text = String(input ?? '').trim();
  if (!text) throw new SshKeyError('Empty key');
  if (text.length > 16 * 1024) throw new SshKeyError('Key too long');
  if (/[\r\n\0]/.test(text)) throw new SshKeyError('One key per line');
  const parts = text.split(/[ \t]+/);
  if (parts.length < 2) throw new SshKeyError('Expected "<algorithm> <base64> [comment]"');
  const [algo, b64, ...rest] = parts;
  if (!(ALLOWED_SSH_ALGORITHMS as readonly string[]).includes(algo)) {
    throw new SshKeyError(`Unsupported key type ${algo.slice(0, 40)} (allowed: ${ALLOWED_SSH_ALGORITHMS.join(', ')})`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new SshKeyError('Invalid base64');
  const blob = Buffer.from(b64, 'base64');
  if (blob.toString('base64') !== b64) throw new SshKeyError('Invalid base64');

  const r = new WireReader(blob);
  const embedded = r.string().toString('latin1');
  if (embedded !== algo) throw new SshKeyError('Key type does not match the key data');

  let bits: number | null = null;
  if (algo === 'ssh-ed25519') {
    if (r.string().length !== 32) throw new SshKeyError('Invalid ed25519 key');
  } else if (algo === 'ssh-rsa') {
    const e = r.string();
    const n = r.string();
    if (e.length === 0 || n.length === 0) throw new SshKeyError('Invalid RSA key');
    bits = mpintBits(n);
    if (bits < MIN_RSA_BITS) throw new SshKeyError(`RSA keys must be at least ${MIN_RSA_BITS} bits (got ${bits})`);
  } else {
    const curve = algo.slice('ecdsa-sha2-'.length);
    if (r.string().toString('latin1') !== curve) throw new SshKeyError('Curve does not match the key type');
    const q = r.string();
    if (q.length !== EC_POINT_LENGTH[curve] || q[0] !== 0x04) throw new SshKeyError('Invalid ECDSA public point');
  }
  if (!r.done()) throw new SshKeyError('Trailing data after the key');

  // Comment: printable, bounded (it is only a label for the user).
  const comment = rest.join(' ').replace(/[^\x20-\x7e]/g, '').slice(0, 200).trim() || null;
  return {
    algorithm: algo as SshAlgorithm,
    blob,
    line: comment ? `${algo} ${b64} ${comment}` : `${algo} ${b64}`,
    comment,
    fingerprint: sshFingerprint(blob),
    bits,
  };
}

/** Fingerprint of a key line, null when it does not parse (never throws). */
export function tryFingerprint(line: string | null | undefined): string | null {
  if (!line) return null;
  try { return parseSshPublicKey(line).fingerprint; } catch { return null; }
}

export const sshKeysService = {
  async list(accountId: number): Promise<AccountSshKey[]> {
    const rows = await db('account_ssh_keys').where({ account_id: accountId }).orderBy('id') as SshKeyRow[];
    return rows.map(toSshKey);
  },

  /** Adds a key (400 invalid key, 409 keyExists). */
  async add(accountId: number, input: { name: string; publicKey: string }): Promise<AccountSshKey> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) throw new AppError(400, 'The key name must be 1 to 100 characters', 'invalidKeyName');
    let parsed: ParsedSshKey;
    try {
      parsed = parseSshPublicKey(input.publicKey);
    } catch (err) {
      throw new AppError(400, err instanceof SshKeyError ? err.message : 'Invalid SSH public key', 'invalidSshKey');
    }
    const dup = await db('account_ssh_keys').where({ account_id: accountId, fingerprint: parsed.fingerprint }).first('id');
    if (dup) throw new AppError(409, 'This key is already registered for the account', 'keyExists');
    try {
      const [row] = await db('account_ssh_keys').insert({
        account_id: accountId, name, public_key: parsed.line, fingerprint: parsed.fingerprint, algorithm: parsed.algorithm,
      }).returning('*') as SshKeyRow[];
      return toSshKey(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This key is already registered for the account', 'keyExists');
      throw err;
    }
  },

  /** Deletes a key of THIS account; null when it does not exist there. */
  async remove(accountId: number, keyId: number): Promise<SshKeyRow | null> {
    const row = await db('account_ssh_keys').where({ id: keyId, account_id: accountId }).first() as SshKeyRow | undefined;
    if (!row) return null;
    await db('account_ssh_keys').where({ id: keyId, account_id: accountId }).del();
    return row;
  },

  async hasFingerprint(accountId: number, fingerprint: string): Promise<boolean> {
    return !!(await db('account_ssh_keys').where({ account_id: accountId, fingerprint }).first('id'));
  },
};
