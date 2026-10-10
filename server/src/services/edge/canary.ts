import type { EdgeApplyRecord } from '@oblimint/shared';
import { isValidServerName } from './nginxConfig';
import { httpStatusWith, type EdgeExec } from './probe';

// ─────────────────────────────────────────────────────────────────────────────
// Canary of an edge reload (docs/P4b-PLAN.md §8.6). Before the reload, the
// default server's /__oblimint/ping and a sample of hosts are requested from
// inside the edge (HTTP on 127.0.0.1 with the Host header); after the reload,
// the same requests again. Failure = the ping no longer answers 200 (when it
// did before), or a host that answered (any status, a 502 of a stopped
// upstream included) no longer answers at all — connection refused / reset /
// empty reply. A request the edge accepted but whose upstream is slower than
// the probe timeout is an answer (SLOW_ANSWER). The caller then restores the
// whole previous good configuration.
// ─────────────────────────────────────────────────────────────────────────────

export type CanaryResult = NonNullable<EdgeApplyRecord['canary']>;

export interface CanarySnapshot {
  ping: number | null;
  hosts: Map<string, number | null>;
}

/**
 * Up to `size` host names: the units changed by this pass first (they are the
 * likeliest culprits), then the others in a stable order. Wildcards skipped.
 */
export function pickCanaryHosts(changed: string[][], others: string[][], size: number): string[] {
  const out: string[] = [];
  const n = Math.max(0, Math.min(100, Math.floor(size)));
  for (const names of [...changed, ...others]) {
    if (out.length >= n) break;
    const name = names.find((x) => isValidServerName(x));
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Status recorded for a host whose request was ACCEPTED by the edge but got
 * no response within the probe timeout: a slow / cold upstream behind a live
 * edge (§8.6: slowness of an upstream is not a canary failure). It counts as
 * an answer; a wedged edge is told apart by the ping of the default server,
 * which never reaches an upstream and must keep answering 200.
 */
export const SLOW_ANSWER = 0;

/** Canary requests run this many at a time (each may wait the probe's 5 s on a slow upstream). */
export const CANARY_CONCURRENCY = 8;

export async function measureCanary(exec: EdgeExec, hosts: string[]): Promise<CanarySnapshot> {
  const results = new Array<number | null>(hosts.length);
  let ping: number | null = null;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= hosts.length) return;
      const r = await httpStatusWith(exec, hosts[i]);
      results[i] = r.slow ? SLOW_ANSWER : r.status;
    }
  };
  await Promise.all([
    (async () => { ping = (await httpStatusWith(exec, null)).status; })(),
    ...Array.from({ length: Math.min(CANARY_CONCURRENCY, hosts.length) }, () => worker()),
  ]);
  const out = new Map<string, number | null>();
  hosts.forEach((h, i) => out.set(h, results[i] ?? null));
  return { ping, hosts: out };
}

export function compareCanary(before: CanarySnapshot, after: CanarySnapshot): CanaryResult {
  const failures: CanaryResult['failures'] = [];
  if (after.ping !== 200 && before.ping === 200) {
    failures.push({ host: '__oblimint/ping', status: after.ping, error: after.ping === null ? 'no answer' : `status ${after.ping}` });
  }
  for (const [host, was] of before.hosts) {
    const now = after.hosts.get(host) ?? null;
    if (was !== null && now === null) failures.push({ host, status: null, error: `answered ${was} before the reload, no answer after` });
  }
  return { ok: failures.length === 0, checked: 1 + before.hosts.size, failures };
}
