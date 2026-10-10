import { normalizeCidr } from '../../firewall/addresses';
import { ACCESS_USERNAME_RE } from '../validation';
import { auxPath } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// PURE union of the access lists of a proxy host / sub-route (docs/P4b-PLAN.md
// §8.8, Oblihub §1.5): deny rules first, then allow rules (deduplicated),
// `deny all` when any allow exists, `satisfy any` when ANY list asks for it
// (only meaningful with both IP rules and users), one merged htpasswd aux file
// (SHA512-CRYPT hashes, never a password). Invalid rules / users are dropped
// (validated at save time already, H5).
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderAccessList {
  id: number;
  name: string;
  satisfyAny: boolean;
  passAuth: boolean;
  rules: Array<{ action: 'allow' | 'deny'; cidr: string }>;
  users: Array<{ username: string; hash: string }>;
}

const HASH_RE = /^\$6\$(?:rounds=[0-9]{4,9}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/;

export interface AccessBlock {
  lines: string[];
  /** IP rules present (the ACL trap may be armed). */
  hasIpRules: boolean;
  hasUsers: boolean;
  /** Pass the Authorization header upstream (any list asks for it). */
  passAuth: boolean;
  /** Merged htpasswd content (null = no user). */
  htpasswd: string | null;
}

function safeCidr(c: string): string | null {
  try {
    return normalizeCidr(c, { 4: 0, 6: 0 }).cidr;
  } catch {
    return null;
  }
}

/**
 * The block for `lists` (union). `htpasswdName` = aux file name of the merged
 * users ('htpasswd', 'htpasswd-route-2'…), `indent` the line prefix.
 */
export function accessListBlock(lists: readonly RenderAccessList[], unitId: string, htpasswdName: string, indent: string): AccessBlock {
  const deny = new Set<string>();
  const allow = new Set<string>();
  for (const l of lists) {
    for (const r of l.rules ?? []) {
      const cidr = safeCidr(r.cidr);
      if (!cidr) continue;
      (r.action === 'deny' ? deny : allow).add(cidr);
    }
  }
  const users = new Map<string, string>();
  for (const l of lists) {
    for (const u of l.users ?? []) {
      if (!ACCESS_USERNAME_RE.test(u.username) || !HASH_RE.test(u.hash) || users.has(u.username)) continue;
      users.set(u.username, u.hash);
    }
  }
  const hasIpRules = deny.size > 0 || allow.size > 0;
  const hasUsers = users.size > 0;
  const lines: string[] = [];
  if (lists.length && (hasIpRules || hasUsers)) {
    lines.push(`${indent}# Access lists (union): ${lists.map((l) => `#${Number(l.id)}`).join(', ')}`);
    for (const c of deny) lines.push(`${indent}deny ${c};`);
    for (const c of allow) lines.push(`${indent}allow ${c};`);
    if (allow.size > 0) lines.push(`${indent}deny all;`);
    if (hasUsers) {
      if (hasIpRules) lines.push(`${indent}satisfy ${lists.some((l) => l.satisfyAny) ? 'any' : 'all'};`);
      lines.push(`${indent}auth_basic "Restricted";`, `${indent}auth_basic_user_file ${auxPath(unitId, htpasswdName)};`);
    }
  }
  return {
    lines,
    hasIpRules,
    hasUsers,
    passAuth: lists.some((l) => l.passAuth),
    htpasswd: hasUsers ? [...users].map(([u, h]) => `${u}:${h}`).join('\n') + '\n' : null,
  };
}
