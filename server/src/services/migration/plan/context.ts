import type { MigrationObjectKind, MigrationTargetCatalog, PlanLimits } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Target context of the planner (docs/P5-PLAN.md §8.1): everything computePlan
// needs to know about the Oblimint side, read once from the database by
// targetContext.ts and handed to the PURE computation (no I/O in there). The
// object map rows of THIS source let a re-computation recognise what earlier
// runs created: those objects are reused, never reported as conflicts.
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetAccountFact {
  id: number;
  tenantId: number;
  username: string;
  planId: number;
}

export interface TargetDomainFact {
  id: number;
  /** domains.name (lower case). */
  name: string;
  accountId: number;
  tenantId: number;
}

export interface TargetSiteFact {
  id: number;
  accountId: number;
  slug: string;
}

export interface TargetDbInstanceFact {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  engine: string;
  version: string;
  databases: Array<{ id: number; name: string }>;
}

export interface TargetObjectMapFact {
  kind: MigrationObjectKind;
  sourceKey: string;
  targetId: number;
  cwpUsername: string | null;
}

export interface PlanTargetContext {
  /** What GET /targets returns (tenants, plans with limits, bases, engines, mail engine, platform IPs, NS). */
  catalog: MigrationTargetCatalog;
  /** Tenant id → the tenant policy allows external proxy targets (apps policy, PX2). Absent = unknown → refused. */
  externalTargetsByTenant: Record<string, boolean>;
  accounts: TargetAccountFact[];
  domains: TargetDomainFact[];
  sites: TargetSiteFact[];
  dbInstances: TargetDbInstanceFact[];
  /** Object map rows of the plan's source (objects created by earlier runs). */
  objectMap: TargetObjectMapFact[];
  /** Reference time of the computation (certificate expiry, computedAt). ISO. */
  now: string;
}

/** Limits of a catalog plan (null = unknown plan). */
export function catalogPlan(ctx: PlanTargetContext, planId: number): { id: number; tenantId: number; name: string; limits: PlanLimits } | null {
  return ctx.catalog.plans.find((p) => p.id === planId) ?? null;
}

/** An empty context (tests, defaults): Default tenant only, no plan, nothing on the platform. */
export function emptyTargetContext(over: Partial<PlanTargetContext> = {}): PlanTargetContext {
  return {
    catalog: {
      tenants: [{ id: 1, name: 'Default' }],
      plans: [],
      nodes: [{ id: 1, name: 'local' }],
      bases: [],
      dbVersions: [],
      mailEngine: null,
      mailPasswordSchemes: [],
      platformIpv4: null,
      platformIpv6: null,
      nameservers: [],
      dnsEnabled: true,
    },
    externalTargetsByTenant: { 1: true },
    accounts: [],
    domains: [],
    sites: [],
    dbInstances: [],
    objectMap: [],
    now: new Date(0).toISOString(),
    ...over,
  };
}
