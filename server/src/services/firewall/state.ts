import { randomBytes } from 'crypto';
import type { AccessMode, FileServerMode, IpProbeResult } from '@oblimint/shared';
import type { HostdFirewallAccountState } from '../hostd/client';
import { normalizeAddress } from './addresses';

// ─────────────────────────────────────────────────────────────────────────────
// Pure parts of the firewall module (no database, no Docker): the state
// pushed to hostd, the authentication failure window (bans), the IP probe
// store and the activity throttle. Unit-tested in firewall.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountStateInput {
  accountId: number;
  mode: AccessMode;
  /** config.hosting.portGateway: hostd owns the SFTP port (else Docker publishes it). */
  portGateway: boolean;
  filesrvMode: FileServerMode;
  filesrvPort: number | null;
  /** External SQL ports (databaseService.externalPorts). */
  publishedPorts: number[];
  rules: Array<{ cidr: string; expiresAt: Date | string | null }>;
  grants: Array<{ ip: string; expiresAt: Date | string }>;
  bans: Array<{ ip: string; expiresAt: Date | string }>;
  now: Date;
}

/**
 * Live bans per account, well below hostd's maxBanEntries (10 000, whole
 * state refused above it): enforced at ban time (newest kept) and again
 * when the state is built.
 */
export const MAX_BANS_PER_ACCOUNT = 5000;

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const live = (v: Date | string | null, now: Date): boolean => v === null || toDate(v).getTime() > now.getTime();

function validPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
}

/**
 * Full state of one account for hostd:
 * - gatewayPorts: the SFTP port when hostd owns it (port gateway on, file server not off);
 *   without the gateway the port is published by Docker → filtered as a published port;
 * - allow: the live rules, plus the live auto-2fa grants in auto-2fa mode only
 *   (allowlist = the rules alone; open = ignored by hostd);
 * - bans: live bans, every mode.
 */
export function buildAccountState(i: AccountStateInput): HostdFirewallAccountState {
  const sftp = i.filesrvMode !== 'off' && validPort(i.filesrvPort) ? [i.filesrvPort as number] : [];
  const published = [...new Set(i.publishedPorts.filter(validPort))];
  const gatewayPorts = i.portGateway ? sftp : [];
  const publishedPorts = [...new Set([...published, ...(i.portGateway ? [] : sftp)])].sort((a, b) => a - b);

  const allow: HostdFirewallAccountState['allow'] = [];
  for (const r of i.rules) {
    if (live(r.expiresAt, i.now)) allow.push({ cidr: r.cidr, expiresAt: r.expiresAt === null ? null : toDate(r.expiresAt).toISOString() });
  }
  if (i.mode === 'auto-2fa') {
    for (const g of i.grants) {
      if (live(g.expiresAt, i.now)) allow.push({ cidr: g.ip, expiresAt: toDate(g.expiresAt).toISOString() });
    }
  }
  // Capped (defence in depth: hostd refuses the WHOLE state over its limit): the latest-expiring win.
  const bans = i.bans.filter((b) => live(b.expiresAt, i.now))
    .sort((a, b) => toDate(b.expiresAt).getTime() - toDate(a.expiresAt).getTime())
    .slice(0, MAX_BANS_PER_ACCOUNT)
    .map((b) => ({ ip: b.ip, expiresAt: toDate(b.expiresAt).toISOString() }));
  return { accountId: i.accountId, mode: i.mode, gatewayPorts, publishedPorts, allow, bans };
}

// ── Bans: failures in a sliding window ──────────────────────────────────────

/** Authentication failures per key (account | service | ban key) in a sliding window. */
export class FailureWindow {
  private hits = new Map<string, number[]>();

  constructor(private readonly maxKeys = 50_000) {}

  /**
   * Records one failure at nowMs. Returns the failure count when it reaches
   * the threshold (the key is then reset), null otherwise.
   */
  record(key: string, nowMs: number, windowMs: number, threshold: number): number | null {
    const from = nowMs - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    list.push(nowMs);
    if (list.length >= Math.max(1, threshold)) {
      this.hits.delete(key);
      return list.length;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.prune(nowMs, windowMs);
    this.hits.set(key, list);
    return null;
  }

  count(key: string, nowMs: number, windowMs: number): number {
    return (this.hits.get(key) ?? []).filter((t) => t > nowMs - windowMs).length;
  }

  clear(prefix: string): void {
    for (const k of this.hits.keys()) if (k.startsWith(prefix)) this.hits.delete(k);
  }

  /** Drops the keys without a failure in the window (and the oldest keys over the cap). */
  prune(nowMs: number, windowMs: number): void {
    for (const [k, list] of this.hits) if (!list.some((t) => t > nowMs - windowMs)) this.hits.delete(k);
    while (this.hits.size >= this.maxKeys) {
      const first = this.hits.keys().next().value as string;
      this.hits.delete(first);
    }
  }
}

// ── IP probes ────────────────────────────────────────────────────────────────

export const PROBE_NONCE_TTL_MS = 60_000;
export const PROBE_IP_TTL_MS = 30 * 60_000;
const MAX_NONCES = 20_000;
const MAX_SESSIONS = 50_000;
const NONCE_RE = /^[0-9a-f]{32}$/;

interface ProbedIp { ip: string; at: number }

/**
 * Probe nonces (60 s, bound to the sha256 of a session id) and the addresses
 * each session was seen with by the v4-only / v6-only probe hosts (30 min).
 * A nonce may be used by both probes (one per family) while it lives.
 */
export class ProbeStore {
  private nonces = new Map<string, { sessionHash: string; expiresAt: number }>();
  private sessions = new Map<string, { v4?: ProbedIp; v6?: ProbedIp }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(sessionHash: string): { nonce: string; expiresAt: number } {
    this.prune();
    if (this.nonces.size >= MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value as string);
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = this.now() + PROBE_NONCE_TTL_MS;
    this.nonces.set(nonce, { sessionHash, expiresAt });
    return { nonce, expiresAt };
  }

  /**
   * Records the probe of a live nonce; null for an unknown / expired nonce, a
   * bad address, or an address of the other family than the probe host's
   * (expectedFamily: the v4-only host can only learn an IPv4, and the reverse).
   */
  record(nonce: unknown, rawIp: string, expectedFamily?: 4 | 6): IpProbeResult | null {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
    const entry = this.nonces.get(nonce);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.nonces.delete(nonce);
      return null;
    }
    const a = normalizeAddress(rawIp);
    if (!a || (expectedFamily !== undefined && a.family !== expectedFamily)) return null;
    if (!this.sessions.has(entry.sessionHash) && this.sessions.size >= MAX_SESSIONS) this.prune(true);
    const s = this.sessions.get(entry.sessionHash) ?? {};
    s[a.family === 4 ? 'v4' : 'v6'] = { ip: a.ip, at: this.now() };
    this.sessions.set(entry.sessionHash, s);
    return { ip: a.ip, family: a.family };
  }

  /** Addresses probed for a session in the last 30 min. */
  ipsOf(sessionHash: string): { ipv4: string | null; ipv6: string | null } {
    const s = this.sessions.get(sessionHash);
    const fresh = (p?: ProbedIp) => (p && this.now() - p.at < PROBE_IP_TTL_MS ? p.ip : null);
    return { ipv4: fresh(s?.v4), ipv6: fresh(s?.v6) };
  }

  dropSession(sessionHash: string): void {
    this.sessions.delete(sessionHash);
    for (const [n, e] of this.nonces) if (e.sessionHash === sessionHash) this.nonces.delete(n);
  }

  prune(force = false): void {
    const now = this.now();
    for (const [n, e] of this.nonces) if (e.expiresAt <= now) this.nonces.delete(n);
    for (const [h, s] of this.sessions) {
      const alive = [s.v4, s.v6].some((p) => p && now - p.at < PROBE_IP_TTL_MS);
      if (!alive) this.sessions.delete(h);
    }
    if (force) while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
  }
}

// ── Activity throttle ────────────────────────────────────────────────────────

/** "At most once per interval and key" (auto-2fa grant refresh: per (session, addresses)). */
export class Throttle {
  private last = new Map<string, number>();

  constructor(private readonly intervalMs: number, private readonly maxKeys = 50_000) {}

  /** true = go ahead (and remember now), false = too soon. */
  hit(key: string, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.intervalMs) return false;
    if (prev === undefined && this.last.size >= this.maxKeys) {
      for (const [k, t] of this.last) if (nowMs - t >= this.intervalMs) this.last.delete(k);
      if (this.last.size >= this.maxKeys) this.last.clear();
    }
    this.last.set(key, nowMs);
    return true;
  }

  forget(prefix: string): void {
    for (const k of this.last.keys()) if (k.startsWith(prefix)) this.last.delete(k);
  }
}

// ── Database log ban source ──────────────────────────────────────────────────

// The user name comes from the CLIENT and is logged unescaped (quotes, '@',
// even newlines): an attacker must never choose the address a failure is
// attributed to. Hence:
//  - the address is the one of the SERVER-written part, anchored: the suffix
//    '@'<ip>' (using password: YES|NO) at the END of the line for MariaDB /
//    MySQL (the greedy user group makes it the LAST '@'), the %h of the line
//    prefix for PostgreSQL;
//  - the line must START with the server's own prefix (timestamp, thread /
//    pid): a newline in a user name cannot put a forged record on a line of
//    its own without forging that prefix too. PostgreSQL truncates user names
//    to 63 bytes, shorter than any such line; MariaDB accepts longer names,
//    so DbLogSource also ignores the failures that follow an unterminated
//    record (isUnterminatedDbAuthLine);
//  - a user name with control characters or an embedded '@' quote is refused.
const TS = String.raw`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`;
// MariaDB "<ts> <thread> [Warning] Access denied for user '<u>'@'<ip>' (using password: YES)";
// MySQL 8 "<ts> <thread> [Note] [MY-010926] [Server] Access denied …".
const MYSQL_HEAD = String.raw`^${TS}\s+\d+\s+\[(?:Warning|Note)\]\s+(?:\[[^\]]{1,32}\]\s+){0,2}Access denied for user '`;
const MYSQL_HEAD_RE = new RegExp(MYSQL_HEAD);
const MYSQL_DENIED = new RegExp(MYSQL_HEAD + String.raw`(.{0,400})'@'([0-9A-Fa-f:.]{2,64})' \(using password: (?:YES|NO)\)\s*$`);
const MYSQL_TERMINATED = /'@'[^']{1,255}' \(using password: (?:YES|NO)\)\s*$/;
// PostgreSQL with log_line_prefix '%m [%p] %h ' (module databases):
// "<ts> <tz> [pid] <host> FATAL:  password authentication failed for user "x"".
const PG_HEAD_RE = new RegExp(String.raw`^${TS} \S+ \[\d+\] \S+ FATAL:\s+password authentication failed for user "`);
const PG_FAILED = new RegExp(String.raw`^${TS} \S+ \[\d+\] ([0-9A-Fa-f:.]{2,64}) FATAL:\s+password authentication failed for user "(.{0,200})"\s*$`);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An authentication failure line of a MariaDB / MySQL / PostgreSQL instance log; null otherwise. */
export function parseDbAuthFailure(line: string): { ip: string; username: string } | null {
  if (line.length > 4096) return null;
  const m = MYSQL_DENIED.exec(line);
  if (m) {
    const username = m[1];
    if (CONTROL.test(username) || username.includes("'@'")) return null;
    const a = normalizeAddress(m[2]);
    return a ? { ip: a.ip, username } : null;
  }
  const p = PG_FAILED.exec(line);
  if (p) {
    const username = p[2];
    if (CONTROL.test(username)) return null;
    const a = normalizeAddress(p[1]);
    return a ? { ip: a.ip, username: username.replace(/""/g, '"') } : null;
  }
  return null;
}

/**
 * The start of an authentication failure record whose line does NOT end with
 * the server's suffix: the user name contained a newline, and the rest of the
 * record (attacker text, possibly whole forged lines) follows on the next lines.
 */
export function isUnterminatedDbAuthLine(line: string): boolean {
  if (line.length > 4096) return false;
  if (MYSQL_HEAD_RE.test(line)) return !MYSQL_TERMINATED.test(line);
  if (PG_HEAD_RE.test(line)) return !/"\s*$/.test(line);
  return false;
}
