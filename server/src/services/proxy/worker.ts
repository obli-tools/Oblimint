import { logger } from '../../utils/logger';
import { registerEdgeUnitProvider, unregisterEdgeUnitProvider } from '../edge/units';
import { convergeAuth, refreshStates } from './authInfra';
import { proxyDeps } from './deps';
import { pinnedNamesChanged } from './externalTargets';
import { proxyEdgeUnitProvider } from './provider';

// Worker of the proxy-hosts module (docs/P4b-PLAN.md §17): registers the edge unit provider 'proxy'
// (edge/units.ts), converges the forward-auth sidecars (at start, then every 5 min, and on demand after a
// provider / host change), refreshes the sidecar states every minute, asks one edge sync once registered,
// re-resolves the external target names pinned by the last edge pass every 5 min (DNS rebinding, PX2: a changed
// answer ⇒ edge sync, which re-pins the validated address or invalidates the unit).
// Domain bindings of deleted domains are swept by the database itself (edge_domain_bindings → domains ON
// DELETE CASCADE). start() returns at once and never throws. OWNED BY MODULE `proxy-hosts`.

const FIRST_CONVERGE_MS = 15_000;
const CONVERGE_EVERY_MS = 5 * 60_000;
const STATES_EVERY_MS = 60_000;
const EXTERNAL_RECHECK_MS = 5 * 60_000;

let rechecking = false;

/** Periodic pass over the pinned external names. Never throws. */
export async function recheckExternalTargets(): Promise<boolean> {
  if (rechecking) return false;
  rechecking = true;
  try {
    const deps = proxyDeps();
    const changed = await pinnedNamesChanged(deps.lookup, () => deps.dockerSubnets(), () => deps.nodeAddresses());
    if (changed) deps.scheduleEdgeSync('proxy: external target addresses changed');
    return changed;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'proxy: external target re-check failed (retried later)');
    return false;
  } finally {
    rechecking = false;
  }
}

let timers: NodeJS.Timeout[] = [];

async function converge(reason: string): Promise<void> {
  try {
    await convergeAuth((line) => logger.info({ component: 'proxy-auth', reason }, line));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, reason }, 'proxy-auth: convergence failed (retried later)');
  }
}

export const proxyWorker = {
  start(): void {
    try {
      registerEdgeUnitProvider(proxyEdgeUnitProvider);
      proxyDeps().scheduleEdgeSync('proxy provider registered');
      if (timers.length) return;
      const first = setTimeout(() => { void converge('start'); }, FIRST_CONVERGE_MS);
      const every = setInterval(() => { void converge('periodic'); }, CONVERGE_EVERY_MS);
      const states = setInterval(() => { void refreshStates(); }, STATES_EVERY_MS);
      const external = setInterval(() => { void recheckExternalTargets(); }, EXTERNAL_RECHECK_MS);
      for (const t of [first, every, states, external]) t.unref?.();
      timers = [first, every, states, external];
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'proxy worker: start failed');
    }
  },

  stop(): void {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
    try { unregisterEdgeUnitProvider(proxyEdgeUnitProvider.id); } catch { /* never throws */ }
  },
};
