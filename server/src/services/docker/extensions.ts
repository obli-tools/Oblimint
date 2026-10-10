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
//      mail      → mailReconcileHook.afterAccountPass (P4 mail-core: account
//                  status → mailboxes suspended / resumed, engine sync request)
//      mailRelay → mailRelayReconcileHook.afterAccountPass (P4 outbound-security:
//                  relay attached to the account network, per-site relay
//                  credentials + msmtprc of the account's sites)
//  - infra components: dns (PowerDNS) and dbadmin (phpMyAdmin + Adminer),
//    scanner (P3: ClamAV + YARA + scand, module scanners),
//    mail (P4 mail-core: the active engine's containers), mail-relay (P4
//    outbound-security), webmail (P4 webmail),
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
    // P4 (docs/P4-PLAN.md §7): mail account status, then the site relay of the account.
    ['mail', async () => (await import('../mail/reconcileHook')).mailReconcileHook],
    ['mailRelay', async () => (await import('../mail/outbound/reconcileHook')).mailRelayReconcileHook],
    // P4b (docs/P4b-PLAN.md §7): app stacks follow the account status (suspended → stopped), then the
    // segmentation module migrates a legacy account / requests the policy push of the account.
    ['apps', async () => (await import('../apps/reconcileHook')).appsReconcileHook],
    ['segments', async () => (await import('../network/reconcileHook')).segmentReconcileHook],
  ];
  for (const [name, load] of hooks) {
    try {
      await (await load()).afterAccountPass(ctx);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message ?? String(err), hook: name, accountId: ctx.state.account.id }, 'afterAccountPass hook failed');
    }
  }
}

// ── P4b: account teardown (docs/P4b-PLAN.md §7) ─────────────────────────────

export interface AccountTeardownContext {
  docker: Docker;
  accountId: number;
  purge: boolean;
  /** Append failures here (the destroy is reported failed, rows kept, retried). */
  errors: string[];
}

export interface AccountTeardownHook {
  /**
   * Called by reconcileService.destroyAccount INSIDE the account lock, after
   * every container labelled oblimint.account was removed and BEFORE the
   * account networks are removed. Must not call withAccountLock.
   */
  beforeNetworksRemoved(ctx: AccountTeardownContext): Promise<void>;
}

/** Runs the teardown hooks (apps then segments); failures are appended to ctx.errors, never thrown. */
export async function runAccountTeardownHooks(ctx: AccountTeardownContext): Promise<void> {
  const hooks: Array<[string, () => Promise<AccountTeardownHook>]> = [
    ['apps', async () => (await import('../apps/teardownHook')).appsTeardownHook],
    ['segments', async () => (await import('../network/teardownHook')).segmentTeardownHook],
  ];
  for (const [name, load] of hooks) {
    try {
      await (await load()).beforeNetworksRemoved(ctx);
    } catch (err) {
      ctx.errors.push(`${name} teardown: ${(err as Error)?.message ?? String(err)}`);
    }
  }
}

/** A platform component deployed by a P2 module (Nodes page, setup wizard, boot). */
export interface InfraComponentProvider {
  id: Extract<InfraComponentId, 'dns' | 'dbadmin' | 'scanner' | 'mail' | 'mail-relay' | 'webmail' | 'proxy-auth'>;
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
  // P4: mail engine (mail-core, delegates to the active driver), site relay (outbound-security), webmail (webmail).
  try { out.push((await import('../mail/infra')).mailInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'mail infra component unavailable'); }
  try { out.push((await import('../mail/outbound/relayInfra')).mailRelayInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'mail-relay infra component unavailable'); }
  try { out.push((await import('../mail/webmail/webmailInfra')).webmailInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'webmail infra component unavailable'); }
  // P4b: forward-auth sidecars (oauth2-proxy per provider + Redis), module proxy-hosts.
  try { out.push((await import('../proxy/authInfra')).proxyAuthInfraComponent); } catch (err) { logger.warn({ err: (err as Error)?.message }, 'proxy-auth infra component unavailable'); }
  return out;
}
