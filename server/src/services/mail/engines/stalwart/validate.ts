import { isIP } from 'net';
import { MailDriverError } from '../../driver';

// ─────────────────────────────────────────────────────────────────────────────
// Strict validation of every value that reaches config.toml, a Stalwart
// expression, a sieve script or an API path (module engine-stalwart). The
// desired state is validated by mail-core already; these checks are the last
// line (driver rule "every value is still escaped / validated for its target
// format"): a value that does not match is REFUSED, never escaped into an
// expression.
// ─────────────────────────────────────────────────────────────────────────────

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`);
/** Local part: the subset the panel accepts (routes/mail.routes.ts MAIL_ADDRESS_RE): no quote, space, %, $, braces. */
const LOCAL_RE = /^(?!.*\.\.)[a-z0-9._+-]{1,64}$/;
const SELECTOR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Certificate directory name under mail/certs (a host name, possibly a wildcard primary name). */
const CERT_NAME_RE = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)*${LABEL}$`);

export function invalid(what: string): MailDriverError {
  return new MailDriverError('invalidState', `stalwart: invalid ${what} in the desired state`);
}

export function isDomainName(v: string): boolean {
  return typeof v === 'string' && DOMAIN_RE.test(v);
}

export function isMailAddress(v: string): boolean {
  if (typeof v !== 'string' || v.length > 254) return false;
  const at = v.lastIndexOf('@');
  if (at < 1) return false;
  const local = v.slice(0, at);
  return local.length <= 64 && LOCAL_RE.test(local) && isDomainName(v.slice(at + 1));
}

/** Lower-cased domain, or throws invalidState. */
export function domainName(v: string, what = 'domain name'): string {
  const d = String(v ?? '').trim().toLowerCase();
  if (!isDomainName(d)) throw invalid(what);
  return d;
}

/** Lower-cased address, or throws invalidState. */
export function mailAddress(v: string, what = 'address'): string {
  const a = String(v ?? '').trim().toLowerCase();
  if (!isMailAddress(a)) throw invalid(what);
  return a;
}

export function selector(v: string): string {
  if (typeof v !== 'string' || !SELECTOR_RE.test(v)) throw invalid('DKIM selector');
  return v;
}

export function certName(v: string): string {
  const n = String(v ?? '').toLowerCase();
  if (!CERT_NAME_RE.test(n) || n.length > 253) throw invalid('certificate name');
  return n;
}

/** Bare IPv4 / IPv6 address (no CIDR: the relay is trusted by EXACT address, MA2). */
export function ipAddress(v: string): string {
  const ip = String(v ?? '').trim();
  if (isIP(ip) === 0) throw invalid('relay address');
  return ip.toLowerCase();
}

export function positiveInt(v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw invalid(what);
  return v;
}
