import crypto from 'crypto';
import { deriveKey } from '../../utils/secretBox';

// ─────────────────────────────────────────────────────────────────────────────
// Frozen parameters of a pending action (spec §1.4, §3.3).
//
// An approved request is consumed by the SAME request sent again: the match
// is the HMAC of (action, tenant, principal, canonical JSON of the
// parameters ∪ the secret parameters ∪ the digests of the contents). Change
// one parameter and the fingerprint differs: a new request. The secrets are
// never stored — only this HMAC — and the parameters shown to the decider
// are masked by name (ported from Obliance approvalSecrets.ts /
// approvalDescribe.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical JSON: keys sorted, strings NFC, -0 → 0, undefined dropped, Buffers as their digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, 0));
}

function canonicalize(v: unknown, depth: number): unknown {
  if (depth > 32) throw new Error('canonicalJson: value too deep');
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.normalize('NFC');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Object.is(v, -0) ? 0 : v;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return contentDigest(Buffer.from(v));
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => canonicalize(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || typeof x === 'function') continue;
      out[k.normalize('NFC')] = canonicalize(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/** A binary content as it enters the fingerprint and the description: sha256 + size. */
export function contentDigest(buf: Buffer): { sha256: string; size: number } {
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

export interface HmacInput {
  action: string;
  tenantId: number;
  userId: number;
  apiKeyId: number | null;
  params: Record<string, unknown>;
  secretParams?: Record<string, unknown> | null;
}

let keyOverride: Buffer | null = null;
/** Tests: a fixed HMAC key (null restores the derived one). */
export function setHmacKeyForTests(key: Buffer | null): void {
  keyOverride = key;
}

/** HMAC-SHA256 (hex, 64 chars) of the frozen request. Key = HKDF(master secret, 'pending-actions'). */
export function paramsHmac(i: HmacInput): string {
  const body = canonicalJson({
    a: i.action,
    t: i.tenantId,
    u: i.userId,
    k: i.apiKeyId ?? 0,
    p: i.params ?? {},
    s: i.secretParams ?? {},
  });
  return crypto.createHmac('sha256', keyOverride ?? deriveKey('pending-actions')).update(body).digest('hex');
}

// ── secrets (Obliance approvalSecrets.ts) ────────────────────────────────────

const SECRET_KEY = /(password|passwd|passphrase|^pwd$|^pass$|secret|token|apikey|privatekey|credential|twofactorcode|^totp|^otp$|assertion)/;

/**
 * Is this key name the name of a credential? Identifiers (`keyId`,
 * `tokenIds`…) are not; dotted keys (action keys of a map) never are.
 * A secret the server knows (an env value marked secret) goes to
 * secretParams instead: it is never displayed at all.
 */
export function isSecretKey(key: string): boolean {
  if (key.includes('.')) return false;
  const n = key.toLowerCase().replace(/[_\-\s]/g, '');
  if (/(id|ids)$/.test(n)) return false;
  return SECRET_KEY.test(n);
}

/** Deep copy with the secret-named fields shown as ••• (display only). */
export function maskSecrets(v: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const d = contentDigest(Buffer.from(v));
    return `<${d.size} bytes, sha256 ${d.sha256.slice(0, 12)}…>`;
  }
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, depth + 1));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = isSecretKey(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean' ? '•••' : maskSecrets(x, depth + 1);
    }
    return o;
  }
  return v;
}

/** What may be stored and shown of the parameters: masked, bounded (≤ 16 KiB of JSON). */
export function displayParams(params: Record<string, unknown>): Record<string, unknown> {
  const masked = maskSecrets(params ?? {}) as Record<string, unknown>;
  let json: string;
  try { json = JSON.stringify(masked); } catch { return { note: 'unserializable parameters' }; }
  if (json.length <= 16_384) return JSON.parse(json) as Record<string, unknown>;
  return { note: `parameters too large to display (${json.length} characters)` };
}
