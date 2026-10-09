// Pure helpers of the hosting UI (no React, no i18n instance): formatting,
// validation and small derivations shared by the hosting pages. Kept free of
// runtime imports so they can be unit-tested with node:test.

/** System / SFTP user name of a hosting account (server rule, migration 002). */
export const ACCOUNT_USERNAME_RE = /^[a-z][a-z0-9-]{2,31}$/;

/** Login of a client user (server rule: hostingValidation.service CLIENT_USERNAME_RE). */
export const CLIENT_USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;

/** Server rule (isValidClientUsername): 3-64 chars, the og_ prefix is reserved for Obligate users. */
export function isValidClientUsername(v: string): boolean {
  return CLIENT_USERNAME_RE.test(v) && !v.toLowerCase().startsWith('og_');
}

/** Server rule (clientUserCreateSchema): password.min(12). */
export const MIN_CLIENT_PASSWORD = 12;

export type UsernameIssue = 'empty' | 'tooShort' | 'tooLong' | 'firstChar' | 'chars' | null;

/** Why an account username is invalid (null = valid), for live validation. */
export function accountUsernameIssue(v: string): UsernameIssue {
  if (!v) return 'empty';
  if (!/^[a-z]/.test(v)) return 'firstChar';
  if (!/^[a-z0-9-]+$/.test(v)) return 'chars';
  if (v.length < 3) return 'tooShort';
  if (v.length > 32) return 'tooLong';
  return ACCOUNT_USERNAME_RE.test(v) ? null : 'chars';
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';

/** Random password from the Web Crypto RNG (no look-alike characters). */
export function generatePassword(length = 20): string {
  const out: string[] = [];
  const max = 256 - (256 % PASSWORD_ALPHABET.length); // rejection sampling: no modulo bias
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < max && out.length < length) out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
    }
  }
  return out.join('');
}

/** Rounded number for display (≤ 2 decimals, no trailing zeros). */
export function trimNumber(n: number, decimals = 2): string {
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
}

/** MiB → "512 MB" / "1.5 GB" with the given (translated) unit labels. */
export function formatMb(mb: number | null | undefined, units: { mb: string; gb: string }): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  if (Math.abs(mb) >= 1024) return `${trimNumber(mb / 1024, mb >= 10240 ? 0 : 1)} ${units.gb}`;
  return `${trimNumber(mb, 0)} ${units.mb}`;
}

/** used / quota in percent, clamped 0..100; null when the quota is unknown or unlimited. */
export function usagePct(used: number | null | undefined, quota: number | null | undefined): number | null {
  if (used == null || quota == null || quota <= 0) return null;
  return Math.min(100, Math.max(0, (used / quota) * 100));
}

/** Bar colour for a usage percentage (green → amber → red), CSS colour. */
export function usageColor(pct: number | null): string {
  if (pct == null) return 'rgb(var(--c-text-muted))';
  if (pct >= 90) return '#ef4444';
  if (pct >= 75) return '#f5a623';
  return '#1edd8a';
}

/** "1 h 05 min" / "4 min 07 s" / "12 s" — remaining time of an on-demand activation. */
export function formatCountdown(ms: number, labels: { h: string; min: string; s: string }): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ${labels.h} ${String(m).padStart(2, '0')} ${labels.min}`;
  if (m > 0) return `${m} ${labels.min} ${String(s).padStart(2, '0')} ${labels.s}`;
  return `${s} ${labels.s}`;
}

export type TlsState = 'none' | 'pending' | 'valid' | 'expiring' | 'failed' | 'expired';

const DAY_MS = 86_400_000;

/**
 * Display state of a domain's TLS: `none` when TLS is off, `pending` while
 * no certificate exists yet, `expiring` when valid but < 30 days remain.
 */
export function tlsState(
  tlsMode: 'letsencrypt' | 'none',
  cert: { status: 'pending' | 'valid' | 'failed' | 'expired'; notAfter: string | null } | null,
  now = Date.now(),
): TlsState {
  if (tlsMode === 'none') return 'none';
  if (!cert) return 'pending';
  if (cert.status === 'valid') {
    const end = cert.notAfter ? Date.parse(cert.notAfter) : NaN;
    if (Number.isFinite(end) && end <= now) return 'expired';
    if (Number.isFinite(end) && end - now < 30 * DAY_MS) return 'expiring';
    return 'valid';
  }
  return cert.status;
}

/** Number field ('' = unlimited) → value. null = unlimited, NaN = invalid. */
export function parseLimitField(v: string, opts: { multiplier?: number; integer?: boolean } = {}): number | null {
  const s = v.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  const r = n * (opts.multiplier ?? 1);
  return opts.integer === false ? Math.round(r * 100) / 100 : Math.round(r);
}

/** Value → number field (divided by `divisor`), '' for unlimited. */
export function limitToField(n: number | null | undefined, divisor = 1): string {
  if (n == null) return '';
  return trimNumber(n / divisor);
}

/** Example SFTP command line of an account. */
export function sftpCommand(user: string, host: string | null, port: number | null): string {
  const target = `${user}@${host ?? '<host>'}`;
  return port != null && port !== 22 ? `sftp -P ${port} ${target}` : `sftp ${target}`;
}

/** True when a layout entry of the file access belongs to the site of `slug`. */
export function layoutMatchesSlug(entry: { stagingPath: string; dataPath: string }, slug: string | undefined): boolean {
  if (!slug) return false;
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(entry.stagingPath).endsWith(`/staging/${slug}`) || norm(entry.dataPath).endsWith(`/data/${slug}`);
}

const FQDN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Domain name as the server stores it: trimmed, lower-case, no trailing dot,
 * IDN converted to punycode (WHATWG URL host parser). null when invalid.
 */
export function normalizeDomainName(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/\.$/, '');
  if (!s || /[\s/:@?#\\]/.test(s)) return null;
  try {
    s = new URL(`http://${s}/`).hostname;
  } catch {
    return null;
  }
  return FQDN_RE.test(s) ? s : null;
}

/** Cheap shape check of one OpenSSH public key line (the server validates for real). */
export function looksLikeSshPublicKey(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return false;
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/.test(parts[0])
    && /^[A-Za-z0-9+/]+={0,3}$/.test(parts[1]);
}

/** Suggested key name: the comment of the key line, if any. */
export function sshKeyComment(line: string): string {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 3 ? parts.slice(2).join(' ').slice(0, 64) : '';
}

/**
 * Form state following server-side changes without losing edits: for each
 * field, the new server value is taken only while the field still holds the
 * previous server value (untouched); an edited field keeps the user's value.
 */
export function followServerValues<T extends object>(form: T, prevServer: T, nextServer: T): T {
  let changed = false;
  const out = { ...form };
  for (const k of Object.keys(nextServer) as Array<keyof T>) {
    if (Object.is(form[k], prevServer[k]) && !Object.is(form[k], nextServer[k])) {
      out[k] = nextServer[k];
      changed = true;
    }
  }
  return changed ? out : form;
}

/** True when a HOSTING_CHANGED site event concerns a site routed by this domain. */
export function domainRoutesSite(routes: ReadonlyArray<{ siteId: number }>, siteId: number | null): boolean {
  return siteId !== null && routes.some((r) => r.siteId === siteId);
}
