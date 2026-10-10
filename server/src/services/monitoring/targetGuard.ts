import { banKey, normalizeAddress } from '../firewall/addresses';
import { addressRange, hostNameProblem, systemLookup, type LookupFn } from '../usage/notifications/ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Anti-SSRF guard of the uptime monitors and SFTP targets (invariant MO1,
// docs/P4b-PLAN.md §10.2 / §11.3), aligned with the P2 notification guard
// (usage/notifications/ssrf.ts, invariant N1):
//   - a host name must not be single-label nor carry an internal suffix;
//   - EVERY resolved address must be global unicast; the checked address is
//     PINNED for the connection (no DNS rebinding between check and connect);
//   - `allowPrivate` (platform rows of the master tenant AND
//     settings.monitoring.allowPrivateTargets): RFC 1918 / ULA / CGNAT and
//     single-label names (Docker service names) are accepted too. Loopback,
//     link local (169.254.169.254 metadata), unspecified, multicast and
//     reserved ranges are refused in every case.
//   - `refuse` (the node's own public addresses, see nodeAddresses.ts): an
//     extra per-address refusal — from the panel container, the node's public
//     address goes through the host INPUT chain from a Docker bridge, not
//     from the Internet, and would reach services the external firewall hides.
// Error texts never carry the resolved addresses (they could leak the
// internal topology to a client).
// ─────────────────────────────────────────────────────────────────────────────

export class TargetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetRefusedError';
  }
}

export interface TargetPolicy {
  allowPrivate: boolean;
  lookup?: LookupFn;
  /** Extra refusal of a resolved / literal address (the node's own public addresses). */
  refuse?: (ip: string) => boolean;
}

/**
 * Is `ip` one of the node's public addresses (IPv6: inside the node's /64,
 * which also carries the Docker IPv6 range routed from it)?
 */
export function isNodeAddress(ip: string, nodeAddresses: readonly string[]): boolean {
  const a = normalizeAddress(ip);
  if (!a) return false;
  for (const n of nodeAddresses) {
    const node = normalizeAddress(n);
    if (!node || node.family !== a.family) continue;
    if (node.ip === a.ip) return true;
    if (a.family === 6 && banKey(node.ip) === banKey(a.ip)) return true;
  }
  return false;
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

const PRIVATE_RANGES = new Set(['private', 'uniqueLocal', 'carrierGradeNat']);

/** Is this address acceptable under the policy? */
export function addressAllowed(ip: string, allowPrivate: boolean): boolean {
  const range = addressRange(ip);
  if (range === 'unicast') return true;
  return allowPrivate && range !== null && PRIVATE_RANGES.has(range);
}

/** Bare host of a URL / a host field ([v6] brackets removed, lower case, no trailing dot). */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * Refusal found WITHOUT resolving (save time): literal addresses judged by
 * their range, host names by their form. null = acceptable so far.
 */
export function targetSyntaxProblem(rawHost: string, allowPrivate: boolean): string | null {
  const h = normalizeHost(rawHost);
  if (!h || h.length > 253) return 'invalid host';
  if (addressRange(h) !== null) return addressAllowed(h, allowPrivate) ? null : 'address not allowed';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) return 'invalid host name';
  const problem = hostNameProblem(h);
  if (problem && !allowPrivate) return 'internal host name';
  return null;
}

/** Resolves and checks every address; returns ONE pinned address. Throws TargetRefusedError. */
export async function resolveTarget(rawHost: string, policy: TargetPolicy): Promise<PinnedAddress> {
  const h = normalizeHost(rawHost);
  const problem = targetSyntaxProblem(h, policy.allowPrivate);
  if (problem) throw new TargetRefusedError(`destination refused (${problem})`);
  if (addressRange(h) !== null) {
    if (policy.refuse?.(h)) throw new TargetRefusedError('destination refused (address not allowed)');
    return { address: h, family: h.includes(':') ? 6 : 4 };
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (policy.lookup ?? systemLookup)(h);
  } catch (err) {
    throw new TargetRefusedError(`cannot resolve the host (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!answers.length) throw new TargetRefusedError('cannot resolve the host');
  for (const a of answers) {
    if (!addressAllowed(a.address, policy.allowPrivate) || policy.refuse?.(a.address)) throw new TargetRefusedError('destination refused (address not allowed)');
  }
  const first = answers.find((a) => a.family === 4) ?? answers[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * Save-time check: syntax always; resolution only when it answers (a DNS
 * failure at save time is not a refusal — every check / run resolves again).
 * Throws TargetRefusedError when a resolved address is not allowed.
 */
export async function assertTargetAllowed(rawHost: string, policy: TargetPolicy): Promise<void> {
  const h = normalizeHost(rawHost);
  const problem = targetSyntaxProblem(h, policy.allowPrivate);
  if (problem) throw new TargetRefusedError(`destination refused (${problem})`);
  if (addressRange(h) !== null) {
    if (policy.refuse?.(h)) throw new TargetRefusedError('destination refused (address not allowed)');
    return;
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (policy.lookup ?? systemLookup)(h);
  } catch {
    return;
  }
  for (const a of answers) {
    if (!addressAllowed(a.address, policy.allowPrivate) || policy.refuse?.(a.address)) throw new TargetRefusedError('destination refused (address not allowed)');
  }
}
