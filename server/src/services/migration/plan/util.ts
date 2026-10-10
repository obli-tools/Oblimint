import crypto from 'crypto';
import ipaddr from 'ipaddr.js';
import type { MigrationPlanChoices, MigrationScope, MigrationSeverity, MigrationWarning } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers of the planner: canonical JSON + choices hash (§8.1),
// warning builder, IP helpers (exact source-IP match of D-DNS), byte units.
// ─────────────────────────────────────────────────────────────────────────────

export const MIB = 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** JSON with object keys sorted at every level (undefined members dropped, as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): Json => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : norm(x)));
    if (typeof v === 'object') {
      const out: { [k: string]: Json } = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    return null;
  };
  return JSON.stringify(norm(value));
}

/** sha256 (hex) of the canonical choices + the discovery they apply to: a run requires result.choicesHash = this. */
export function choicesHash(choices: MigrationPlanChoices, discoveryId: number): string {
  return crypto.createHash('sha256').update(canonicalJson({ choices, discoveryId })).digest('hex');
}

export function warning(
  severity: MigrationSeverity, code: string, scope: MigrationScope, params?: Record<string, string | number | boolean | null>,
): MigrationWarning {
  return params ? { severity, code, scope, params } : { severity, code, scope };
}

/** Canonical text of an IP (null when not an IP). */
export function canonicalIp(text: string | null | undefined): string | null {
  const s = String(text ?? '').trim();
  if (!s || s.includes('%')) return null;
  try {
    if (!ipaddr.isValid(s)) return null;
    const a = ipaddr.parse(s);
    if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress()) return (a as ipaddr.IPv6).toIPv4Address().toString();
    return a.toString();
  } catch {
    return null;
  }
}

export function ipFamily(ip: string): 4 | 6 {
  return ip.includes(':') ? 6 : 4;
}

/** RFC 1918 / ULA / loopback / link-local / CGNAT (a proxy target behind the source LAN: PX2 allowPrivate). */
export function isPrivateAddress(host: string): boolean {
  const ip = canonicalIp(host);
  if (!ip) return host.trim().toLowerCase() === 'localhost';
  const range = ipaddr.parse(ip).range();
  return ['private', 'uniqueLocal', 'loopback', 'linkLocal', 'carrierGradeNat'].includes(range);
}

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const ip = canonicalIp(h);
  return !!ip && ipaddr.parse(ip).range() === 'loopback';
}

export function ceilMib(bytes: number | null | undefined): number | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  return Math.max(0, Math.ceil(bytes / MIB));
}

/** fqdn is name or below name (both lower case, no trailing dot). */
export function inZone(fqdn: string, zone: string): boolean {
  return fqdn === zone || fqdn.endsWith(`.${zone}`);
}

export function lower(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** POSIX path without trailing slash ('/' kept). */
export function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** child is parent or below it (absolute POSIX paths). */
export function pathWithin(child: string, parent: string): boolean {
  const c = trimSlash(child);
  const p = trimSlash(parent);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
}

export function dirname(p: string): string {
  const t = trimSlash(p);
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
}

export function basename(p: string): string {
  const t = trimSlash(p);
  return t.slice(t.lastIndexOf('/') + 1);
}

/** Absolute, normalized (no '.', '..', '//', control characters). */
export function isCleanAbsolutePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!p.startsWith('/') || p.length > 1024 || /[\x00-\x1f\x7f]/.test(p)) return false;
  return trimSlash(p).split('/').slice(1).every((seg) => seg !== '' && seg !== '.' && seg !== '..') || p === '/';
}
