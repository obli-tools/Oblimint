import type Docker from 'dockerode';
import type { InfraComponentId, InfraComponentStatus } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { AccountState, ReconcileReport } from './reconcile.service';

// ─────────────────────────────────────────────────────────────────────────────
// P2 extension points of the orchestration (docs/P2-PLAN.md §7) — ARCHITECT
// FILE (frozen). The P1 reconcile / infra code calls these; the P2 modules
// implement the targets in THEIR directories (lazy imports: no import cycle,
// a module that throws never breaks a pass).
//
//  - afterAccountPass: once per reconcile pass of an account, INSIDE the
//    account lock (withAccountLock), after the statuses are persisted.
//    Targets MUST NOT call withAccountLock / reconcileAccountNow (not
//    reentrant → deadlock) and must return quickly (queue long work).
//      databases → databaseReconcileHook.afterAccountPass (instances
//                  converge: create / start / stop with the account status)
//      firewall  → firewallReconcileHook.afterAccountPass (gateway target of
//                  the file server, nftables state of the account)
//      quarantine → quarantineReconcileHook.afterAccountPass (P3: typed-path
//                  watch specs of the account's sites pushed to hostd)
//  - infra components: dns (PowerDNS) and dbadmin (phpMyAdmin + Adminer),
//    scanner (P3: ClamAV + YARA + scand, module scanners),
//    shown on the Nodes page, deployable from /api/system/infra/:id/deploy,
//    ensured at boot.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountPassContext {
  state: AccountState;
  docker: Docker;
  report: ReconcileReport;
}

export interface AccountPassHook {
  afterAccountPass(ctx: AccountPassContext): Promise<void>;
}

/** Runs every module hook; failures are logged, never thrown. */
export async function runAfterAccountPassHooks(ctx: AccountPassContext): Promise<void> {
  const hooks: Array<[string, () => Promise<AccountPassHook>]> = [
    ['databases', async () => (await import('../databases/reconcileHook')).databaseReconcileHook],
    ['firewall', async () => (await import('../firewall/reconcileHook')).firewallReconcileHook],
    // P3 (docs/P3-PLAN.md §7): typed-path watch specs of the account's sites → hostd.
    ['quarantine', async () => (await import('../quarantine/reconcileHook')).quarantineReconcileHook],
  ];
  for (const [name, load] of hooks) {
    try {
      await (await load()).afterAccountPass(ctx);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message ?? String(err), hook: name, accountId: ctx.state.account.id }, 'afterAccountPass hook failed');
    }
  }
}

/** A platform component deployed by a P2 module (Nodes page, setup wizard, boot). */
export interface InfraComponentProvider {
  id: Extract<InfraComponentId, 'dns' | 'dbadmin' | 'scanner'>;
  /** Pull + (re)create when missing / drifted. Idempotent. Throws on failure (the caller logs / reports). */
  ensure(log: (line: string) => void): Promise<void>;
  /** Never throws: errors go to `detail`. docker null = engine unreachable (dockerError). */
  status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus>;
  /** Ensure at boot? (dns: settings dns.enabled; dbadmin: settings dbAdmin.hostname set). */
  wantedAtBoot(): Promise<boolean>;
}

export async function extraInfraComponents(): Promise<InfraComponentProvider[]> {
  const out: InfraComponentProvider[] = [];
  try { out.push((await import('../dns/infra')).dnsInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'dns infra component unavailable'); }
  try { out.push((await import('../databases/dbadminInfra')).dbAdminInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'dbadmin infra component unavailable'); }
  // P3: shared change scanner (ClamAV + YARA), module scanners.
  try { out.push((await import('../scan/scannerInfra')).scannerInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'scanner infra component unavailable'); }
  return out;
}
