import ipaddr from 'ipaddr.js';
import type { EdgeExecResult } from './confSync';
import { isValidServerName } from './nginxConfig';
import type { EdgeUpstreamRef } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// Probes run from INSIDE oblimint-edge (docs/P4b-PLAN.md §8.4, §8.6) through
// the script baked in the image (images/edge/oblimint-edge-probe):
//   oblimint-edge-probe tcp <host> <port>   exit 0 = connected, 1 = refused /
//                                           unreachable / timeout (3 s)
//   oblimint-edge-probe http <host>         GET http://127.0.0.1/ with Host
//                                           <host>; prints the status (000 =
//                                           no answer at all, "slow" = the
//                                           edge accepted the connection but
//                                           the response took > 5 s)
//   oblimint-edge-probe ping                GET /__oblimint/ping (default server)
// Always an argv (docker exec), never a shell string; every argument is
// validated here AND again by the script. UDP upstreams are not probed.
// ─────────────────────────────────────────────────────────────────────────────

export const PROBE_SCRIPT = 'oblimint-edge-probe';
/** Bounded on the panel side too (the script itself gives up after ~5 s). */
export const PROBE_EXEC_TIMEOUT_MS = 10_000;

export type EdgeExec = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<EdgeExecResult>;

const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/** A host the probe accepts: DNS name / container alias ([a-z0-9.-], never a leading '-') or an IP literal. */
export function isProbeHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  const h = host.toLowerCase();
  if (HOST_RE.test(h)) return true;
  return h.includes(':') && /^[0-9a-f:.]+$/.test(h) && ipaddr.IPv6.isValid(h);
}

/** argv of a TCP probe, or null when the reference is not probe-able (invalid / UDP). */
export function tcpProbeArgs(ref: Pick<EdgeUpstreamRef, 'host' | 'port' | 'protocol'>): string[] | null {
  if (ref.protocol !== 'tcp') return null;
  if (!isProbeHost(ref.host) || !Number.isInteger(ref.port) || ref.port < 1 || ref.port > 65535) return null;
  return [PROBE_SCRIPT, 'tcp', ref.host.toLowerCase(), String(ref.port)];
}

export interface ProbeOutcome { reachable: boolean | null; error: string | null }

/** TCP connect from inside the edge. UDP: { reachable: null }. Never throws. */
export async function probeUpstreamWith(exec: EdgeExec, ref: EdgeUpstreamRef): Promise<ProbeOutcome> {
  if (ref?.protocol === 'udp') return { reachable: null, error: null };
  const argv = ref ? tcpProbeArgs(ref) : null;
  if (!argv) return { reachable: false, error: 'invalid upstream host / port' };
  try {
    const r = await exec(argv, { timeoutMs: PROBE_EXEC_TIMEOUT_MS });
    if (r.exitCode === 0) return { reachable: true, error: null };
    if (r.exitCode === 1) return { reachable: false, error: `${ref.host}:${ref.port} unreachable from the edge` };
    return { reachable: false, error: `probe failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  } catch (err) {
    return { reachable: false, error: `probe failed: ${(err as Error).message}`.slice(0, 300) };
  }
}

/**
 * HTTP status seen from inside the edge for `host` (null = no answer at all).
 * `slow`: the edge accepted the request but nothing came back within the
 * probe timeout (a slow / cold upstream behind it): status null, slow true.
 * Never throws.
 */
export async function httpStatusWith(exec: EdgeExec, host: string | null): Promise<{ status: number | null; error: string | null; slow?: boolean }> {
  if (host !== null && !isValidServerName(host)) return { status: null, error: 'invalid host' };
  try {
    const r = await exec(host === null ? [PROBE_SCRIPT, 'ping'] : [PROBE_SCRIPT, 'http', host], { timeoutMs: PROBE_EXEC_TIMEOUT_MS });
    const out = r.stdout ?? '';
    const m = /\b(\d{3})\b/.exec(out);
    const status = m ? Number(m[1]) : 0;
    if (status >= 100 && status <= 599) return { status, error: null };
    if (/^\s*slow\s*$/.test(out)) return { status: null, error: 'no response within the probe timeout', slow: true };
    return { status: null, error: (r.stderr || 'no answer').trim().slice(0, 200) || 'no answer' };
  } catch (err) {
    return { status: null, error: (err as Error).message.slice(0, 200) };
  }
}
