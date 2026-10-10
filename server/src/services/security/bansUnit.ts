import type { HostdWebFirewallState } from '../hostd/client';
import type { EdgeConfigUnit } from '../edge/units';
import { parseBanInput } from './addresses';

// ─────────────────────────────────────────────────────────────────────────────
// PURE renderers of the enforcement of the web bans (docs/P4b-PLAN.md §9.2,
// §9.4) — bansUnit.test.ts:
//
//  - global edge unit `g-bans` (http level, included before every server):
//      geo $remote_addr $oblimint_ban_p { default 0; <key> 1; … }        platform bans
//      geo $remote_addr $oblimint_ban_a { default ""; <key> "|12|15|"; } account bans
//    read by banCheckLines() in every server block. fallbackConfig = both geos
//    with their default only (the variables always exist, nobody is banned);
//  - hostd PUT /v1/firewall/web body: the live PLATFORM bans (nftables drops
//    on 80 / 443, BN3), permanent and latest expiry first, capped.
// Every key is parsed again here (an IPv4 address or an IPv6 /64): a row that
// does not parse never reaches nginx nor hostd (H5).
// ─────────────────────────────────────────────────────────────────────────────

export const BANS_UNIT_ID = 'g-bans';
/** hostd refuses a state above 50 000 entries. */
export const MAX_FIREWALL_BANS = 50_000;
export const WEB_PORTS: readonly number[] = [80, 443];

export interface ActiveBan {
  ip: string;
  scope: 'account' | 'platform';
  accountId: number | null;
  bannedUntil: Date | null;
}

const GEO_P_HEAD = 'geo $remote_addr $oblimint_ban_p {';
const GEO_A_HEAD = 'geo $remote_addr $oblimint_ban_a {';

export const BANS_FALLBACK_CONFIG = [
  '# Oblimint web bans (fallback: nobody banned)',
  GEO_P_HEAD, '    default 0;', '}',
  GEO_A_HEAD, '    default "";', '}',
  '',
].join('\n');

/** Bans still in force at `now`, keys re-validated. */
function live(bans: readonly ActiveBan[], now: Date): Array<ActiveBan & { key: string }> {
  const out: Array<ActiveBan & { key: string }> = [];
  for (const b of bans) {
    if (b.bannedUntil && b.bannedUntil.getTime() <= now.getTime()) continue;
    const key = parseBanInput(b.ip);
    if (!key || key !== b.ip) continue;
    if (b.scope === 'account' && !(Number.isInteger(b.accountId) && (b.accountId as number) > 0)) continue;
    out.push({ ...b, key });
  }
  return out;
}

/** The config of the g-bans unit (deterministic: sorted keys, sorted account ids). */
export function renderBansConfig(bans: readonly ActiveBan[], now: Date): string {
  const platform = new Set<string>();
  const byKey = new Map<string, Set<number>>();
  for (const b of live(bans, now)) {
    if (b.scope === 'platform') platform.add(b.key);
    else {
      const set = byKey.get(b.key) ?? new Set<number>();
      set.add(b.accountId as number);
      byKey.set(b.key, set);
    }
  }
  const lines = [`# Oblimint web bans: ${platform.size} platform, ${byKey.size} account address(es)`, GEO_P_HEAD, '    default 0;'];
  for (const k of [...platform].sort()) lines.push(`    ${k} 1;`);
  lines.push('}', GEO_A_HEAD, '    default "";');
  for (const k of [...byKey.keys()].sort()) {
    // A platform ban already closes everything for that key: no account entry needed.
    if (platform.has(k)) continue;
    const ids = [...byKey.get(k)!].sort((a, b) => a - b);
    lines.push(`    ${k} "|${ids.join('|')}|";`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

export function bansUnit(bans: readonly ActiveBan[], now: Date, enabled = true): EdgeConfigUnit {
  return {
    id: BANS_UNIT_ID,
    scope: 'http',
    level: 'global',
    owner: { kind: 'global', id: null, accountId: null, tenantId: null, label: 'web bans' },
    serverNames: [],
    listen: [],
    tls: null,
    config: enabled ? renderBansConfig(bans, now) : BANS_FALLBACK_CONFIG,
    files: {},
    upstreams: [],
    rawSnippets: [],
    fallbackConfig: BANS_FALLBACK_CONFIG,
  };
}

/** hostd body: live platform bans (permanent first, then latest expiry), deduplicated, capped. */
export function buildWebFirewallState(bans: readonly ActiveBan[], now: Date, enabled: boolean): HostdWebFirewallState {
  const ports = [...WEB_PORTS];
  if (!enabled) return { ports, bans: [] };
  const rows = live(bans, now)
    .filter((b) => b.scope === 'platform')
    // nft cannot express a timeout under a second: such a ban is gone anyway.
    .filter((b) => b.bannedUntil === null || b.bannedUntil.getTime() - now.getTime() >= 1000)
    .sort((a, b) => {
      const ta = a.bannedUntil?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const tb = b.bannedUntil?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return tb - ta || a.key.localeCompare(b.key);
    });
  const seen = new Set<string>();
  const out: HostdWebFirewallState['bans'] = [];
  for (const b of rows) {
    if (seen.has(b.key)) continue;
    seen.add(b.key);
    out.push({ cidr: b.key, expiresAt: b.bannedUntil ? b.bannedUntil.toISOString() : null });
    if (out.length >= MAX_FIREWALL_BANS) break;
  }
  return { ports, bans: out };
}
