import { config } from '../../config';
import { hostNameProblem, type LookupFn } from '../usage/notifications/ssrf';
import { DOCKER_DEFAULT_RANGES, addressProblem, normalizeIp } from './targets';

// ─────────────────────────────────────────────────────────────────────────────
// External targets at RENDER time (docs/P4b-PLAN.md §8.8, PX2 — DNS rebinding).
// A host name is never handed to nginx: the provider resolves it at every
// edge pass, validates EVERY address (same rules as at save time) and renders
// the chosen address literally (the name stays for the Host header and the
// TLS name). A name that now resolves to a refused address (or no longer
// resolves) makes its unit invalid: edge-robustness keeps the last good
// version (pinned to the old, validated address) or serves the 503 stub, and
// the problem is shown on the object. The worker re-resolves the pinned names
// periodically (proxyWorker) and asks an edge sync when an answer changes.
// ─────────────────────────────────────────────────────────────────────────────

export const EXTERNAL_LOOKUP_TIMEOUT_MS = 5_000;

export interface ExternalResolution {
  /** Address rendered in the upstream (null when refused / unresolved). */
  address: string | null;
  /** Every address of the answer, sorted (fingerprint of the periodic re-check). */
  addresses: string[];
  /** Why the target cannot be served now (null = fine). Safe to show to the account. */
  problem: string | null;
}

/**
 * CIDRs an external target never reaches: panel pools, Docker ranges and the node's OWN public addresses
 * (IPv4 /32, IPv6 its /64 — the Docker IPv6 range is routed from it). From the edge container the node's
 * public address enters through the host INPUT chain from a Docker bridge, not from the Internet: it would
 * reach services the provider / external firewall hides (SSRF with response, port-scan oracle through the
 * upstream probe). Same rule as the monitoring guard (monitoring/targetGuard.ts isNodeAddress).
 */
export function forbiddenCidrs(dockerSubnets: readonly string[], nodeAddresses: readonly string[] = []): string[] {
  return [config.hosting.fabricPool, config.hosting.appNetworkPool, ...DOCKER_DEFAULT_RANGES, ...dockerSubnets, ...nodeAddressCidrs(nodeAddresses)];
}

/** The node's public addresses as refused CIDRs (IPv4 /32, IPv6 /64). Invalid entries skipped. */
export function nodeAddressCidrs(nodeAddresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of nodeAddresses) {
    const ip = normalizeIp(String(raw ?? '').trim());
    if (!ip) continue;
    out.push(ip.includes(':') ? `${ip}/64` : `${ip}/32`);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_r, reject) => { setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms).unref?.(); }),
  ]);
}

/** Deterministic choice: the first IPv4 of the sorted answer (the edge resolves IPv4 only), else the first IPv6. */
export function pickAddress(addresses: readonly string[]): string | null {
  return addresses.find((a) => !a.includes(':')) ?? addresses[0] ?? null;
}

/**
 * Resolves + validates one external target host (IP literal or name). Never
 * throws. `cache` shares the answers of one pass (key host|allowPrivate).
 */
export async function resolveExternal(host: string, allowPrivate: boolean, forbidden: readonly string[], lookup: LookupFn,
  cache?: Map<string, Promise<ExternalResolution>>): Promise<ExternalResolution> {
  const key = `${host}|${allowPrivate ? 1 : 0}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const run = (async (): Promise<ExternalResolution> => {
    const raw = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
    const policy = { allowPrivate, forbiddenCidrs: forbidden };
    const ip = normalizeIp(raw);
    if (ip) {
      const problem = addressProblem(ip, policy);
      return { address: problem ? null : ip, addresses: [ip], problem: problem ? `target address refused (${problem})` : null };
    }
    const nameProblem = hostNameProblem(raw);
    if (nameProblem) return { address: null, addresses: [], problem: `target host refused (${nameProblem})` };
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await withTimeout(lookup(raw), EXTERNAL_LOOKUP_TIMEOUT_MS);
    } catch (err) {
      return { address: null, addresses: [], problem: `target host ${raw} does not resolve (${(err as NodeJS.ErrnoException)?.code ?? 'error'})` };
    }
    const addresses = [...new Set(answers.map((a) => normalizeIp(a.address)).filter((a): a is string => !!a))].sort();
    if (!addresses.length) return { address: null, addresses: [], problem: `target host ${raw} does not resolve` };
    for (const a of addresses) {
      const problem = addressProblem(a, policy);
      if (problem) return { address: null, addresses, problem: `target host ${raw} resolves to a refused address (${problem})` };
    }
    return { address: pickAddress(addresses), addresses, problem: null };
  })();
  cache?.set(key, run);
  return run;
}

/** Names pinned by the last provider pass (key name|allowPrivate) → their answer (the worker compares). */
export const pinnedNames = new Map<string, { name: string; allowPrivate: boolean; fingerprint: string }>();

export function fingerprintOf(r: ExternalResolution): string {
  return r.problem ? `!${r.problem}` : r.addresses.join(',');
}

/**
 * Periodic re-check (worker): re-resolves every name pinned by the last pass;
 * true when an answer changed (new address, refused address, no answer) — the
 * caller then asks an edge sync, which re-pins or invalidates the units.
 */
export async function pinnedNamesChanged(lookup: LookupFn, dockerSubnets: () => Promise<string[]>, nodeAddresses: () => Promise<string[]> = async () => []): Promise<boolean> {
  if (!pinnedNames.size) return false;
  const forbidden = forbiddenCidrs(await dockerSubnets(), await nodeAddresses());
  const cache = new Map<string, Promise<ExternalResolution>>();
  for (const pin of [...pinnedNames.values()]) {
    const r = await resolveExternal(pin.name, pin.allowPrivate, forbidden, lookup, cache);
    if (fingerprintOf(r) !== pin.fingerprint) return true;
  }
  return false;
}
