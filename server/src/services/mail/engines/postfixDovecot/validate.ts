import { isIP } from 'net';
import { MAIL_PASSWORD_SCHEMES, type MailPasswordScheme } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Validation of every value that reaches a generated file (module
// engine-postfix). mail-core already validated the desired state; the driver
// validates again for ITS formats (driver.ts rules): a Postfix map line is
// "key<space>value", a Dovecot passwd-file line is ':'-separated with
// space-separated extra fields, Rspamd UCL expands $VARS inside strings,
// Postfix main.cf expands $names, Sieve strings end at '"'. The whitelists
// below exclude every separator / expansion character of every format, so a
// value that passes can be written as is; anything else is REFUSED (never
// "cleaned"), and the error never echoes a secret.
// ─────────────────────────────────────────────────────────────────────────────

/** Local part: same grammar as mail.routes.ts LOCAL_PART_RE (letters, digits, . _ + -). */
export const LOCAL_PART_RE = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** Domain name: at least two labels, lower case, ≤ 253. */
export const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
/** Address: same grammar as mail.routes.ts MAIL_ADDRESS_RE. */
export const ADDRESS_RE = new RegExp(`^(?!.*\\.\\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
/** DKIM selector (migration 006 CHECK). */
export const SELECTOR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Postfix queue id (short hex ids: enable_long_queue_ids stays off). */
export const QUEUE_ID_RE = /^[A-F0-9]{6,20}$/;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export function assertDomain(name: string, what = 'domain'): string {
  if (typeof name !== 'string' || !DOMAIN_RE.test(name)) throw new RenderError(`invalid ${what} name`);
  return name;
}

export function assertHostname(name: string): string {
  if (name === 'localhost') return name;
  return assertDomain(name, 'host');
}

export function assertAddress(addr: string, what = 'address'): string {
  if (typeof addr !== 'string' || addr.length > 254 || !ADDRESS_RE.test(addr)) throw new RenderError(`invalid ${what}`);
  return addr;
}

export function assertLocalPart(local: string): string {
  if (typeof local !== 'string' || !LOCAL_PART_RE.test(local)) throw new RenderError('invalid mailbox name');
  return local;
}

export function assertSelector(sel: string): string {
  if (typeof sel !== 'string' || !SELECTOR_RE.test(sel)) throw new RenderError('invalid DKIM selector');
  return sel;
}

/** Positive integer within bounds. */
export function assertInt(n: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(n) || n < min || n > max) throw new RenderError(`invalid ${what}`);
  return n;
}

/** Finite number within bounds (spam scores). */
export function assertNumber(n: number, min: number, max: number, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new RenderError(`invalid ${what}`);
  return n;
}

/**
 * '{SCHEME}hash' of a Dovecot passdb line. The hash alphabet of the 7 schemes
 * (crypt(3) [./0-9A-Za-z$], bcrypt, base64 of SSHA* [+/=]) never contains ':'
 * (field separator), whitespace (extra fields), '%' (variable expansion) nor
 * '#'. The message never contains the hash (MA4).
 */
export function assertPasswordHash(hash: string, scheme: MailPasswordScheme): string {
  if (!(MAIL_PASSWORD_SCHEMES as readonly string[]).includes(scheme)) throw new RenderError('unsupported password scheme');
  if (typeof hash !== 'string' || hash.length > 512) throw new RenderError('invalid password hash');
  const prefix = `{${scheme}}`;
  if (!hash.startsWith(prefix)) throw new RenderError('password hash does not match its scheme');
  const body = hash.slice(prefix.length);
  if (!/^[A-Za-z0-9./$+=_-]{8,500}$/.test(body)) throw new RenderError('invalid password hash');
  return hash;
}

/** Absolute container / host path made of safe characters only (no space, quote, '$', '%', '..'). */
export function assertSafePath(p: string, what = 'path'): string {
  if (typeof p !== 'string' || !/^\/[A-Za-z0-9._/@+-]{1,400}$/.test(p) || p.split('/').includes('..')) {
    throw new RenderError(`invalid ${what}`);
  }
  return p;
}

// ── IP / CIDR ────────────────────────────────────────────────────────────────

export interface Cidr {
  family: 4 | 6;
  /** Network address (host bits cleared). */
  base: bigint;
  prefix: number;
}

function ipToBig(ip: string): { family: 4 | 6; value: bigint } | null {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (v === 6) {
    if (ip.includes('.')) return null; // IPv4-mapped / embedded forms: refused (never needed here)
    const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const missing = 8 - h.length - t.length;
    if (tail === null ? h.length !== 8 : missing < 1) return null;
    const groups = [...h, ...Array(tail === null ? 0 : missing).fill('0'), ...t];
    let value = 0n;
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      value = (value << 16n) | BigInt(parseInt(g, 16));
    }
    return { family: 6, value };
  }
  return null;
}

function bigToIp(family: 4 | 6, value: bigint): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join('.');
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  // RFC 5952: longest run (≥ 2) of zero groups → '::'
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

const bitsOf = (family: 4 | 6): number => (family === 4 ? 32 : 128);

/** Strict CIDR (or bare address = host route). Host bits must be zero. */
export function parseCidr(input: string): Cidr {
  if (typeof input !== 'string') throw new RenderError('invalid network');
  const [addr, len, extra] = input.trim().split('/');
  if (extra !== undefined) throw new RenderError('invalid network');
  const ip = ipToBig(addr);
  if (!ip) throw new RenderError('invalid network');
  const bits = bitsOf(ip.family);
  const prefix = len === undefined ? bits : Number(len);
  if (!/^\d{1,3}$/.test(len ?? String(bits)) || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new RenderError('invalid network');
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  if ((ip.value & ~mask & ((1n << BigInt(bits)) - 1n)) !== 0n) throw new RenderError('invalid network (host bits set)');
  return { family: ip.family, base: ip.value, prefix };
}

export function formatCidr(c: Cidr): string {
  return `${bigToIp(c.family, c.base)}/${c.prefix}`;
}

export function cidrContains(c: Cidr, ip: string): boolean {
  const a = ipToBig(ip);
  if (!a || a.family !== c.family) return false;
  const bits = bitsOf(c.family);
  const shift = BigInt(bits - c.prefix);
  return (a.value >> shift) === (c.base >> shift);
}

/**
 * `cidr` minus one address, as a list of CIDR blocks (≤ prefix length
 * blocks). Used to keep the Docker gateway of the mail network out of the
 * trusted networks: behind Docker's userland proxy every PUBLIC connection
 * arrives from the gateway (risk R-MAIL-CLIENTIP), it must never count as
 * "inside the mail network" (MA1, MA6).
 */
export function subtractAddress(c: Cidr, ip: string): Cidr[] {
  if (!cidrContains(c, ip)) return [c];
  const a = ipToBig(ip)!.value;
  const bits = bitsOf(c.family);
  const out: Cidr[] = [];
  for (let p = c.prefix + 1; p <= bits; p++) {
    // sibling of the block of length p that contains `ip`
    const shift = BigInt(bits - p);
    const block = (a >> shift) ^ 1n;
    out.push({ family: c.family, base: block << shift, prefix: p });
  }
  return out;
}

/** Normalized list of networks minus the excluded addresses (invalid entries refused). */
export function networksExcluding(networks: string[], exclude: string[]): string[] {
  let blocks: Cidr[] = networks.map(parseCidr);
  for (const ip of exclude) {
    if (!ipToBig(ip)) continue;
    blocks = blocks.flatMap((b) => subtractAddress(b, ip));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of blocks) {
    const s = formatCidr(b);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/** Exact host route of an address (relay_clients: never a subnet, MA2). */
export function hostCidr(ip: string): string {
  const a = ipToBig(ip.trim());
  if (!a) throw new RenderError('invalid relay address');
  return `${bigToIp(a.family, a.value)}/${bitsOf(a.family)}`;
}

/** First host of a subnet (Docker's default gateway when IPAM does not say). */
export function firstHost(cidr: string): string | null {
  try {
    const c = parseCidr(cidr);
    if (c.prefix >= bitsOf(c.family) - 1) return null;
    return bigToIp(c.family, c.base + 1n);
  } catch {
    return null;
  }
}
