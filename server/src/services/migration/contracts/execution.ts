import type { Request } from 'express';
import type {
  CwpInventory, MigrationAccountPlan, MigrationEventLevel, MigrationFollowUp, MigrationMessage, MigrationPlanResult,
  MigrationResyncPart, MigrationRun, MigrationRunKind, MigrationWarning,
} from '@oblimint/shared';
import type { HostingActor } from '../../hosting/access';
import type { SourceSession } from './source';

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT of the execution engine (docs/P5-PLAN.md §9). ARCHITECT FILE,
// frozen during the phase. The engine (module `executor-web-db`,
// services/migration/execution/engine.ts) builds the step list of a run from
// the registered providers, persists it (migration_run_steps), executes the
// steps in (phase, position) order and resumes after a restart. Providers:
//   web-db    (executor-web-db)    execution/webDb/provider.ts
//   mail-dns  (executor-mail-dns)  execution/mailDns/provider.ts
// A provider registers itself at import time (the engine imports both).
//
// IDEMPOTENCY (invariant MG5): every step can run again at any time (retry,
// resume after a crash, re-run of the initial migration): it looks its target
// object up in the object map (objectMap.ts) and UPSERTS — it never deletes or
// recreates a target object that exists. Only a resync step overwrites the
// CONTENT it migrated (staging files, re-imported database, maildir delta).
// ─────────────────────────────────────────────────────────────────────────────

export type MigrationProviderId = 'web-db' | 'mail-dns';

/** Global order of the steps (lower first; same phase: provider order web-db, mail-dns, then position). */
export const MIGRATION_PHASES = {
  plan: 10,
  account: 20,
  domains: 30,
  dnsZones: 35,
  verification: 40,
  sites: 50,
  siteData: 55,
  siteFiles: 60,
  publish: 70,
  dbInstance: 80,
  dbUsers: 82,
  databases: 84,
  dbGrants: 86,
  mailDomains: 90,
  dkim: 92,
  mailboxes: 94,
  maildirs: 96,
  aliases: 98,
  proxies: 110,
  certificates: 120,
  crons: 130,
  ftp: 140,
  finalize: 190,
} as const;

export type MigrationPhaseName = keyof typeof MIGRATION_PHASES;

export interface MigrationStepSpec {
  /** Unique in the run, STABLE across runs of the account (e.g. 'site:example.tld:files', 'db:acct1_wp:import'). ≤ 200 chars. */
  key: string;
  provider: MigrationProviderId;
  phase: number;
  label: MigrationMessage;
  /** Relative weight in the progress bar (default 1; file / dump / maildir steps: their estimated MiB). */
  weight?: number;
}

/** The run as the providers see it (row of migration_runs, decoded). */
export interface MigrationRunRecord {
  id: number;
  planId: number;
  sourceId: number;
  cwpUsername: string;
  kind: MigrationRunKind;
  parts: MigrationResyncPart[];
  mirrorDeletes: boolean;
  targetTenantId: number;
  targetAccountId: number | null;
  createdBy: number | null;
}

export interface MigrationStepPlanningInput {
  run: MigrationRunRecord;
  /** Account plan from the plan result the run was started with (frozen copy kept by the engine). */
  account: MigrationAccountPlan;
  plan: MigrationPlanResult;
  inventory: CwpInventory;
}

export interface MigrationStepContext extends MigrationStepPlanningInput {
  /** Transfer-phase session on the source, opened lazily, shared by the steps of the run, closed by the engine. */
  session(): Promise<SourceSession>;
  /** Platform-admin actor of the user who started the run, ON THE TARGET TENANT (migrationActor(createdBy, targetTenantId), re-resolved at each start: lost rights = run fails). */
  actor: HostingActor;
  /** Synthetic request for the services' audit (user = run creator, tenant = target tenant). */
  req: Request;
  /** Target account once the account step ran (also stored on the run). */
  targetAccountId(): number | null;
  setTargetAccountId(accountId: number): Promise<void>;
  /** Persisted run event (migration_run_events) + socket ping. NEVER pass a secret. */
  log(level: MigrationEventLevel, code: string, params?: Record<string, string | number | boolean | null>, message?: string | null): Promise<void>;
  /** In-step progress (bytes copied, items done) — throttled socket emit. */
  progress(p: { done?: number; total?: number; bytes?: number }): void;
  /** Aborted on cancel / pause / shutdown. Long operations pass it down (rsync, dumps). */
  signal: AbortSignal;
  /** Throws MigrationInterruptedError when a pause / cancel was requested (call between items). */
  checkpoint(): Promise<void>;
  /** Result of another step of this account: this run first, then the latest successful run of the account. */
  stepResult(key: string): Promise<Record<string, unknown> | null>;
}

export interface MigrationStepOutcome {
  status: 'done' | 'warning' | 'skipped';
  /** Target ids etc. — persisted as the step result (JSON, never a secret). */
  result?: Record<string, unknown>;
  warnings?: MigrationWarning[];
  followUps?: MigrationFollowUp[];
}

export interface MigrationStepProvider {
  id: MigrationProviderId;
  /** Steps of this provider for the run (kind / parts / include flags decide). Pure: no I/O. */
  steps(input: MigrationStepPlanningInput): MigrationStepSpec[];
  /** Executes one of ITS steps. Throws to fail the step (the engine records the error and stops the run). */
  run(step: MigrationStepSpec, ctx: MigrationStepContext): Promise<MigrationStepOutcome>;
}

/** Thrown by checkpoint() / long operations when the run is paused or cancelled. */
export class MigrationInterruptedError extends Error {
  constructor(public readonly action: 'pause' | 'cancel' | 'shutdown') {
    super(`Run interrupted (${action})`);
    this.name = 'MigrationInterruptedError';
  }
}

// ── registries (implemented here) ───────────────────────────────────────────

const providers = new Map<MigrationProviderId, MigrationStepProvider>();

export function registerMigrationStepProvider(provider: MigrationStepProvider): void {
  providers.set(provider.id, provider);
}

/** Registered providers in execution order (web-db first). */
export function migrationStepProviders(): MigrationStepProvider[] {
  return (['web-db', 'mail-dns'] as const).map((id) => providers.get(id)).filter((p): p is MigrationStepProvider => !!p);
}

export type RunFinishedHook = (run: MigrationRun) => Promise<void> | void;

const runFinishedHooks: RunFinishedHook[] = [];

/** Called by the engine when a run ends (done / failed / cancelled). Hooks never throw into the engine. */
export function registerRunFinishedHook(hook: RunFinishedHook): void {
  runFinishedHooks.push(hook);
}

export async function runRunFinishedHooks(run: MigrationRun): Promise<void> {
  for (const hook of runFinishedHooks) {
    try { await hook(run); } catch { /* a hook never breaks the engine */ }
  }
}
