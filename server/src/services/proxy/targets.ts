import ipaddr from 'ipaddr.js';
import { AppError } from '../../middleware/errorHandler';
import { addressRange, hostNameProblem, type LookupFn } from '../usage/notifications/ssrf';
import { isValidServerName } from '../edge/nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// External proxy targets (docs/P4b-PLAN.md §8.8, invariant PX2). Rules:
//   - an IP literal or a host name (resolved now: EVERY address must pass);
//   - NEVER: loopback (127/8, ::1), link local (169.254/16, fe80::/10 — cloud
//     metadata), unspecified, multicast, broadcast, reserved, the Docker /
//     panel ranges (the panel's fabric and app pools, Docker's default bridge
//     pools 172.16/12, and every subnet of the local Docker networks) and
//     the node's own public addresses (IPv6: its /64), even for the platform
//     staff (externalTargets.ts forbiddenCidrs);
//   - private (RFC 1918), CGNAT (100.64/10), ULA (fc00::/7): only when the
//     target carries allowPrivate, which only PLATFORM staff may set;
//   - everything else must be global unicast.
// The check is PURE apart from the injected resolver. It runs at save time
// AND at every edge pass (externalTargets.ts): nginx never resolves a tenant
// name — the provider renders the validated address (DNS rebinding, PX2) and
// the worker re-resolves the pinned names periodically (sync on change).
// ─────────────────────────────────────────────────────────────────────────────

export const ALWAYS_REFUSED_RANGES = new Set([
  'unspecified', 'loopback', 'linkLocal', 'multicast', 'broadcast', 'reserved', 'benchmarking', 'amt', 'as112', 'as112v6',
  'deprecated', 'orchid2', 'droneRemoteIdProtocolEntityTags', 'rfc6145', 'rfc6052', '6to4', 'teredo', 'discard',
]);
export const PRIVATE_RANGES = new Set(['private', 'carrierGradeNat', 'uniqueLocal']);

/** Docker's default bridge pools (docker0 + default-address-pools 172.17–172.31). */
export const DOCKER_DEFAULT_RANGES = ['172.16.0.0/12'];

export interface ExternalTargetPolicy {
  allowPrivate: boolean;
  /** CIDRs never reachable (panel pools + Docker subnets). */
  forbiddenCidrs: readonly string[];
}

function parseIp(text: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const raw = text.replace(/^\[|\]$/g, '');
  if (raw.includes('%') || !ipaddr.isValid(raw)) return null;
  if (!raw.includes(':') && !ipaddr.IPv4.isValidFourPartDecimal(raw)) return null;
  let a = ipaddr.parse(raw);
  if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress()) a = (a as ipaddr.IPv6).toIPv4Address();
  return a;
}

/** Normalized textual form of an IP literal, null when not one. */
export function normalizeIp(text: string): string | null {
  const a = parseIp(text);
  return a ? a.toString() : null;
}

function inCidr(a: ipaddr.IPv4 | ipaddr.IPv6, cidr: string): boolean {
  try {
    const [net, bits] = ipaddr.parseCIDR(cidr);
    if (net.kind() !== a.kind()) return false;
    return (a as ipaddr.IPv4).match(net as ipaddr.IPv4, bits);
  } catch {
    return false;
  }
}

/** Why an address is refused as an external target (null = acceptable). */
export function addressProblem(ip: string, policy: ExternalTargetPolicy): string | null {
  const a = parseIp(ip);
  if (!a) return 'not an IP address';
  const range = addressRange(a.toString()) ?? 'invalid';
  if (ALWAYS_REFUSED_RANGES.has(range)) return `${range} address`;
  for (const c of policy.forbiddenCidrs) if (inCidr(a, c)) return 'internal (Docker / panel / node) address';
  if (PRIVATE_RANGES.has(range)) return policy.allowPrivate ? null : `${range} address`;
  if (range !== 'unicast') return `${range} address`;
  return null;
}

/**
 * Validates an external target host (IP literal or FQDN). Throws 400
 * targetInvalid (malformed) or 403 targetNotAllowed (refused address).
 * Returns the normalized host (IP literals normalized, names lower case).
 */
export async function assertExternalHost(host: string, policy: ExternalTargetPolicy, lookup: LookupFn): Promise<string> {
  const raw = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  const ip = parseIp(raw);
  if (ip) {
    const problem = addressProblem(ip.toString(), policy);
    if (problem) throw new AppError(403, `This target address is not allowed (${problem})`, 'targetNotAllowed', { reason: problem });
    return ip.toString();
  }
  if (!isValidServerName(raw)) throw new AppError(400, 'Invalid target host', 'targetInvalid');
  const nameProblem = hostNameProblem(raw);
  if (nameProblem) throw new AppError(403, `This target host is not allowed (${nameProblem})`, 'targetNotAllowed', { reason: nameProblem });
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(raw);
  } catch (err) {
    throw new AppError(400, `The target host does not resolve (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`, 'targetInvalid');
  }
  if (!answers.length) throw new AppError(400, 'The target host does not resolve', 'targetInvalid');
  for (const ans of answers) {
    const problem = addressProblem(ans.address, policy);
    if (problem) throw new AppError(403, `The target host resolves to a refused address (${problem})`, 'targetNotAllowed', { reason: problem });
  }
  return raw;
}

/** host:port as written in an upstream (IPv6 literals bracketed). */
export function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}
