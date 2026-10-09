import { generateKeyPair } from 'crypto';
import { promisify } from 'util';
import type { DkimAlgorithm, DkimKeyStatus } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE DKIM helpers of module mail-dns-tls (docs/P4-PLAN.md §9.3), tested by
// keys.test.ts: key generation (node:crypto), selector naming, rotation state
// machine. The private key only lives in memory here; dkim.service seals it
// (secretBox 'mail-dkim') before it touches the database (MA4).
// ─────────────────────────────────────────────────────────────────────────────

const generate = promisify(generateKeyPair);

/** DER prefix of an ed25519 SubjectPublicKeyInfo (RFC 8410): the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface DkimKeyMaterial {
  /** The p= value: RSA = base64 SPKI DER; ed25519 = base64 of the RAW 32-byte key (RFC 8463). */
  publicKey: string;
  /** PKCS#8 PEM — never logged, never returned. */
  privateKeyPem: string;
}

export async function generateDkimKey(algorithm: DkimAlgorithm): Promise<DkimKeyMaterial> {
  if (algorithm === 'ed25519') {
    const { publicKey, privateKey } = await generate('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }) as unknown as { publicKey: Buffer; privateKey: string };
    if (publicKey.length !== ED25519_SPKI_PREFIX.length + 32 || !publicKey.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      throw new Error('unexpected ed25519 public key encoding');
    }
    return { publicKey: publicKey.subarray(ED25519_SPKI_PREFIX.length).toString('base64'), privateKeyPem: privateKey };
  }
  const { publicKey, privateKey } = await generate('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }) as unknown as { publicKey: Buffer; privateKey: string };
  return { publicKey: publicKey.toString('base64'), privateKeyPem: privateKey };
}

/** p= value → SPKI DER (what node:crypto createPublicKey takes), for verification. */
export function spkiFromRecordKey(algorithm: DkimAlgorithm, p: string): Buffer {
  const raw = Buffer.from(p, 'base64');
  return algorithm === 'ed25519' ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
}

/** Selector om<yyyymm>[e][-n] (UTC month, e = ed25519, -n on collision with any selector the domain ever had). */
export function dkimSelector(algorithm: DkimAlgorithm, now: Date, existing: ReadonlySet<string>): string {
  const base = `om${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${algorithm === 'ed25519' ? 'e' : ''}`;
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`;
    if (!existing.has(s)) return s;
  }
}

// ── rotation ─────────────────────────────────────────────────────────────────

export const DKIM_TIMING = {
  /** A 'next' key of a zone hosted (and active) on our PowerDNS is promoted after this delay even if no resolver saw it. */
  hostedPublishMs: 48 * 3600_000,
  /** The previous key stays published this long once replaced. */
  retiringMs: 7 * 86400_000,
  /** A retired key's private part is erased from the row after this. */
  purgeMs: 30 * 86400_000,
} as const;

export interface RotationKey {
  id: number;
  algorithm: DkimAlgorithm;
  status: DkimKeyStatus;
  createdAt: Date;
  activatedAt: Date | null;
  retireAfter: Date | null;
  /** private_key_sealed still holds the key. */
  hasPrivateKey: boolean;
}

export interface RotationUpdate {
  id: number;
  status?: DkimKeyStatus;
  activatedAt?: Date;
  retireAfter?: Date | null;
  clearPrivateKey?: true;
}

/**
 * One step of the rotation machine (§9.3):
 *  - the newest 'next' key of an algorithm that is `ready` (its record is
 *    visible, or the zone is hosted and it is 48 h old) becomes 'active'; the
 *    active key(s) of that algorithm become 'retiring' for 7 days; older
 *    'next' keys of that algorithm are 'retired';
 *  - a 'retiring' key whose delay passed is 'retired' (record removed);
 *  - a 'retired' key loses its private key 30 days later.
 */
export function rotationUpdates(keys: RotationKey[], now: Date, ready: (k: RotationKey) => boolean): RotationUpdate[] {
  const out = new Map<number, RotationUpdate>();
  const set = (u: RotationUpdate) => out.set(u.id, { ...(out.get(u.id) ?? { id: u.id }), ...u });
  const t = now.getTime();
  for (const algorithm of ['rsa-2048', 'ed25519'] as const) {
    const nexts = keys.filter((k) => k.algorithm === algorithm && k.status === 'next')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    const newest = nexts[0];
    if (!newest || !ready(newest)) continue;
    set({ id: newest.id, status: 'active', activatedAt: now, retireAfter: null });
    for (const k of keys) {
      if (k.algorithm !== algorithm || k.id === newest.id) continue;
      if (k.status === 'active') set({ id: k.id, status: 'retiring', retireAfter: new Date(t + DKIM_TIMING.retiringMs) });
      else if (k.status === 'next') set({ id: k.id, status: 'retired', retireAfter: now });
    }
  }
  for (const k of keys) {
    if (out.has(k.id)) continue;
    if (k.status === 'retiring' && (!k.retireAfter || k.retireAfter.getTime() <= t)) {
      set({ id: k.id, status: 'retired', retireAfter: now });
    } else if (k.status === 'retired' && k.hasPrivateKey) {
      const since = (k.retireAfter ?? k.createdAt).getTime();
      if (since + DKIM_TIMING.purgeMs <= t) set({ id: k.id, clearPrivateKey: true });
    }
  }
  return [...out.values()];
}

/** Is a 'next' key ready? Visible to the public resolvers, or 48 h old in a zone hosted and active on our PowerDNS. */
export function nextKeyReady(k: Pick<RotationKey, 'createdAt'>, now: Date, opts: { visible: boolean; hostedActive: boolean }): boolean {
  if (opts.visible) return true;
  return opts.hostedActive && now.getTime() - k.createdAt.getTime() >= DKIM_TIMING.hostedPublishMs;
}

/** settings mail.dkimRotationDays: the active key of `algorithm` is old enough and no rotation is under way. */
export function needsAutoRotation(keys: RotationKey[], algorithm: DkimAlgorithm, now: Date, rotationDays: number | null): boolean {
  if (!rotationDays || rotationDays <= 0) return false;
  if (keys.some((k) => k.algorithm === algorithm && k.status === 'next')) return false;
  const active = keys.filter((k) => k.algorithm === algorithm && k.status === 'active');
  if (active.length === 0) return false;
  const newest = Math.max(...active.map((k) => (k.activatedAt ?? k.createdAt).getTime()));
  return now.getTime() - newest >= rotationDays * 86400_000;
}
