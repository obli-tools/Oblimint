import { isIpv4, isIpv6 } from '@/components/security/accessFormat';
import { sameRegistrableDomain } from './registrableDomain';

// Pure validators of the platform settings forms, mirroring the zod schema of
// server/src/services/platformSettings.ts (the server stays the authority).

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Fully qualified host name (lower case, at least one dot, no trailing dot). */
export function isHostname(v: string): boolean {
  return HOSTNAME_RE.test(v);
}

/** Lower case, trimmed, without the trailing dot. */
export function normalizeHostname(v: string): string {
  return v.trim().toLowerCase().replace(/\.$/, '');
}

export function isIp(v: string): boolean {
  return isIpv4(v) || isIpv6(v);
}

/** IP or CIDR (prefix within the family range). */
export function isIpOrCidr(v: string): boolean {
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined) return false;
  const v4 = isIpv4(addr);
  if (!v4 && !isIpv6(addr)) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/** Integer of a number field within [min, max], null otherwise. */
export function intInRange(v: string, min: number, max: number): number | null {
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** True when `host` is `domain` itself or one of its sub-domains. */
export function isUnder(host: string, domain: string): boolean {
  return !!host && !!domain && (host === domain || host.endsWith(`.${domain}`));
}

/**
 * R-SAMESITE: a host serving tenant code or tenant-reachable tools (preview
 * domain, DB admin host) must be on a registrable domain distinct from the
 * panel host: not the panel, a parent or a sub-domain of it, nor a sibling on
 * the same registrable domain (preview.example.com next to panel.example.com
 * is same-site and could toss Domain=example.com cookies).
 */
export function sameSiteAsPanel(host: string, panel: string | null): boolean {
  const h = normalizeHostname(host);
  const p = normalizeHostname(panel ?? '');
  if (!h || !p) return false;
  return isUnder(p, h) || isUnder(h, p) || sameRegistrableDomain(h, p);
}

/** The preview domain must be a registrable domain distinct from the panel one (R-SAMESITE). */
export function previewConflictsWithPanel(preview: string, panel: string | null): boolean {
  return sameSiteAsPanel(preview, panel);
}

/** The DB admin host must not be same-site with the panel either (R-SAMESITE). */
export function dbAdminConflictsWithPanel(host: string, panel: string | null): boolean {
  return sameSiteAsPanel(host, panel);
}
