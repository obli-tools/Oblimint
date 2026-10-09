import { db } from '../../db';
import { logger } from '../../utils/logger';
import { pdns } from './pdnsClient';
import { fqdnOf, renderTxt, SYSTEM_RECORD_TTL } from './records';
import { loadContext, zoneForName, zoneVerified, type ZoneRow } from './store';
import { syncZone } from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// ACME DNS-01 through our PowerDNS (module dns, docs/P2-PLAN.md §9.1).
// Consumed by the edge-ownership module (edge/acmeIssuer.ts) for wildcard
// certificates (*.<domain>, *.<preview domain>) and whenever HTTP-01 is
// impossible.
//
// Contract:
//  - canSolve(name): true only when `name` (a leading '*.' is stripped) lies in
//    a zone of kind 'hosted', status 'active', served by OUR PowerDNS, AND the
//    domain is verified (or the zone is a platform zone). Never throws (false).
//  - setChallenge(name, value): adds TXT _acme-challenge.<name without *.> =
//    value (origin 'system', system_purpose 'acme', expires_at now + 1 h),
//    bumps the serial, pushes to PowerDNS and resolves once OUR server answers
//    it (query the PowerDNS API / port 53 directly, not a public resolver:
//    Let's Encrypt queries the authoritative servers). Several values may
//    coexist (name + *.name in one order). Throws on failure.
//  - removeChallenge(name, value): removes that value. Never throws (logs).
//  - The worker of the dns module purges expired system records.
// ─────────────────────────────────────────────────────────────────────────────

export interface Dns01Provider {
  canSolve(name: string): Promise<boolean>;
  setChallenge(name: string, value: string): Promise<void>;
  removeChallenge(name: string, value: string): Promise<void>;
}

const CHALLENGE_LABEL = '_acme-challenge';
const CHALLENGE_TTL_MS = 60 * 60_000;
const SERVE_TIMEOUT_MS = 20_000;
const SERVE_POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait budget of setChallenge (tests shorten it). */
export const acmeTiming = { serveTimeoutMs: SERVE_TIMEOUT_MS, pollMs: SERVE_POLL_MS };

function bareName(name: string): string {
  return String(name ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
}

/** Relative owner name of the challenge record in `zone`. */
export function challengeRecordName(name: string, zone: string): string {
  const bare = bareName(name);
  const rel = bare === zone ? '' : bare.slice(0, -(zone.length + 1));
  return rel ? `${CHALLENGE_LABEL}.${rel}` : CHALLENGE_LABEL;
}

/** The zone that may carry the challenge of `name`, or null (D1: hosted, active, verified / platform). */
async function solvableZone(name: string): Promise<ZoneRow | null> {
  const bare = bareName(name);
  if (!bare.includes('.')) return null;
  const zone = await zoneForName(bare);
  if (!zone || zone.kind !== 'hosted' || zone.status !== 'active') return null;
  if (!(await loadContext()).settings.enabled) return null;
  if (!(await zoneVerified(zone))) return null;
  return zone;
}

/** Does OUR PowerDNS serve TXT `fqdn` with `value`? (API read, not a public resolver) */
async function served(zone: string, fqdn: string, value: string): Promise<boolean> {
  const z = await (await pdns()).getZone(zone);
  const rr = z?.rrsets.find((r) => r.type === 'TXT' && r.name === fqdn);
  const want = renderTxt(value);
  return !!rr?.records.some((r) => !r.disabled && r.content === want);
}

export const dns01Provider: Dns01Provider = {
  async canSolve(name: string): Promise<boolean> {
    try {
      return !!(await solvableZone(name));
    } catch (err) {
      logger.debug({ name, err: (err as Error)?.message }, 'dns01: canSolve failed');
      return false;
    }
  },

  async setChallenge(name: string, value: string): Promise<void> {
    const zone = await solvableZone(name);
    if (!zone) throw new Error(`DNS-01: ${bareName(name)} is not in a hosted, active and verified zone`);
    const text = String(value ?? '').trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(text)) throw new Error('DNS-01: invalid challenge value');
    const rel = challengeRecordName(name, zone.name);
    // A CNAME there (delegated challenge) cannot coexist with our TXT: PowerDNS would refuse the whole zone.
    if (await db('dns_records').where({ zone_id: zone.id, name: rel, type: 'CNAME' }).first('id')) {
      throw new Error(`DNS-01: ${rel}.${zone.name} is a CNAME in the zone`);
    }
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const existing = await db('dns_records').where({ zone_id: zone.id, name: rel, type: 'TXT', content: text, origin: 'system' }).first('id') as { id: number } | undefined;
    if (existing) {
      await db('dns_records').where({ id: existing.id }).update({ expires_at: expiresAt, updated_at: db.fn.now() });
    } else {
      await db('dns_records').insert({
        zone_id: zone.id, name: rel, type: 'TXT', content: text, ttl: SYSTEM_RECORD_TTL, origin: 'system',
        system_purpose: 'acme', expires_at: expiresAt,
      });
    }
    const r = await syncZone(zone.id, 'acme-challenge');
    if (!r.ok || !r.published) throw new Error(`DNS-01: zone ${zone.name} could not be published (${r.error ?? 'not served'})`);
    const fqdn = fqdnOf(rel, zone.name);
    const deadline = Date.now() + acmeTiming.serveTimeoutMs;
    for (;;) {
      try {
        if (await served(zone.name, fqdn, text)) return;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`DNS-01: PowerDNS check failed (${(err as Error)?.message})`);
      }
      if (Date.now() > deadline) throw new Error(`DNS-01: ${fqdn} is not served by our name servers after ${acmeTiming.serveTimeoutMs / 1000} s`);
      await sleep(acmeTiming.pollMs);
    }
  },

  async removeChallenge(name: string, value: string): Promise<void> {
    try {
      const bare = bareName(name);
      const zone = await zoneForName(bare);
      if (!zone) return;
      const rel = challengeRecordName(name, zone.name);
      const n = await db('dns_records')
        .where({ zone_id: zone.id, name: rel, type: 'TXT', content: String(value ?? '').trim(), origin: 'system', system_purpose: 'acme' })
        .delete();
      if (n) {
        const r = await syncZone(zone.id, 'acme-challenge-removed');
        if (!r.ok) logger.warn({ zone: zone.name, err: r.error }, 'dns01: challenge removal not pushed (purged later)');
      }
    } catch (err) {
      logger.warn({ name, err: (err as Error)?.message }, 'dns01: removeChallenge failed');
    }
  },
};
