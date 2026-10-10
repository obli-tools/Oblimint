import type { Knex } from 'knex';
import type { AppSourceType, PlanLimits } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { open, SecretBoxError } from '../../utils/secretBox';
import { localPaths } from '../hosting/paths';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { parseDotenv } from './compose/dotenv';
import type { ComposeContext, SourceInspector } from './compose/validate';
import { stackInspector } from './fsSafe';
import { effectivePolicyWith, type EffectiveAppPolicy } from './policy.service';
import { effectiveOf } from './rows';

// Validation context of a stack from the database (docs/P4b-PLAN.md §5.2, §5.6): the .env (opened), the
// effective image policy of the tenant, the plan of the account, the resources of its OTHER stacks, the
// node ceiling and the stack tree inspector (no-follow).

export interface AccountPlan {
  id: number;
  tenantId: number;
  nodeId: number;
  status: string;
  limits: PlanLimits;
}

export async function accountPlan(accountId: number, conn: Knex | Knex.Transaction = db): Promise<AccountPlan> {
  const row = await conn('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('a.id', 'a.tenant_id', 'a.node_id', 'a.status', 'p.limits') as { id: number; tenant_id: number; node_id: number; status: string; limits: unknown } | undefined;
  if (!row) throw new AppError(404, 'Account not found', 'notFound');
  return { id: Number(row.id), tenantId: Number(row.tenant_id), nodeId: Number(row.node_id), status: row.status, limits: planLimits(row.limits) };
}

/** Sum of the resources of the account's stacks, except `exceptStackId`. */
export async function otherStacksUsage(accountId: number, exceptStackId: number | null, conn: Knex | Knex.Transaction = db): Promise<{ cpus: number; memoryMb: number; containers: number; stacks: number }> {
  const qb = conn('app_stacks').where({ account_id: accountId }).select('id', 'effective', 'validation');
  if (exceptStackId) qb.whereNot({ id: exceptStackId });
  const rows = await qb as Array<{ id: number; effective: unknown; validation: unknown }>;
  const out = { cpus: 0, memoryMb: 0, containers: 0, stacks: rows.length };
  for (const r of rows) {
    const eff = effectiveOf(r);
    if (!eff) continue;
    out.cpus += eff.totals.cpus;
    out.memoryMb += eff.totals.memoryMb;
    out.containers += eff.totals.containers;
  }
  out.cpus = Math.round(out.cpus * 100) / 100;
  return out;
}

/** Opens a sealed .env (empty when null). A value sealed with a rotated secret → 409 envUnreadable. */
export function openEnv(sealed: string | null): string {
  if (!sealed) return '';
  try {
    return open('apps', sealed);
  } catch (err) {
    if (err instanceof SecretBoxError) throw new AppError(409, 'The .env of this stack can no longer be read (the panel secret changed): enter it again', 'envUnreadable');
    throw err;
  }
}

export function envMap(text: string): Map<string, string> {
  const r = parseDotenv(text);
  if (r.errors.length) {
    const e = r.errors[0];
    throw new AppError(400, `Invalid .env (line ${e.line}): ${e.message}`, 'validation', { line: e.line });
  }
  return r.values;
}

/** Where relative compose paths resolve: files/ (editor) or src/[<dir of the compose>]. */
export function sourceDirs(sourceType: AppSourceType, gitComposePath: string | null): { baseDir: string; rootDir: 'files' | 'src' } {
  if (sourceType === 'editor') return { baseDir: 'files', rootDir: 'files' };
  if (sourceType === 'git' && gitComposePath) {
    const dir = gitComposePath.includes('/') ? gitComposePath.slice(0, gitComposePath.lastIndexOf('/')) : '';
    return { baseDir: dir ? `src/${dir}` : 'src', rootDir: 'src' };
  }
  return { baseDir: 'src', rootDir: 'src' };
}

export interface StackContextInput {
  stackId: number | null;
  accountId: number;
  sourceType: AppSourceType;
  gitComposePath: string | null;
  env: Map<string, string>;
  /** Check paths on disk (false for a stack that has no tree yet: judged again at deploy). */
  inspect: boolean;
  /**
   * Tree the paths are checked in (with inspect): default the stack directory; a deployment snapshot
   * (snapshots/<id>) or a staged source (remappedInspector) otherwise.
   */
  inspector?: SourceInspector;
}

export async function composeContext(input: StackContextInput, conn: Knex | Knex.Transaction = db): Promise<{ ctx: ComposeContext; plan: AccountPlan; policy: EffectiveAppPolicy }> {
  const plan = await accountPlan(input.accountId, conn);
  const settings = await platformSettings.getWith(conn).then((s) => s.apps);
  const policy = await effectivePolicyWith(conn, plan.tenantId);
  const others = await otherStacksUsage(input.accountId, input.stackId, conn);
  const dirs = sourceDirs(input.sourceType, input.gitComposePath);
  const ctx: ComposeContext = {
    env: input.env,
    ...dirs,
    inspector: input.inspect && input.stackId ? input.inspector ?? stackInspector(localPaths.appStack(input.accountId, input.stackId)) : null,
    policy: {
      allowedRegistries: policy.allowedRegistries,
      deniedImages: policy.deniedImages,
      allowBuild: policy.allowBuild && plan.limits.appsBuild === true,
      capAddAllowed: policy.capAddAllowed,
    },
    maxServices: settings.maxServicesPerStack,
    defaults: { memoryMb: settings.defaultServiceMemoryMb, cpus: settings.defaultServiceCpus },
    plan: {
      cpus: plan.limits.appsCpuCores ?? null,
      memoryMb: plan.limits.appsMemoryMb ?? null,
      containers: plan.limits.maxAppContainers ?? null,
      pidsPerContainer: Math.max(16, plan.limits.appsPidsPerContainer ?? 512),
    },
    node: { memoryMb: config.hosting.siteMaxMemoryMb, cpus: config.hosting.siteMaxCpus },
    others: { cpus: others.cpus, memoryMb: others.memoryMb, containers: others.containers },
  };
  return { ctx, plan, policy };
}

/** Build resources of an account (plan totals capped by the node ceiling). */
export function buildLimitsOf(plan: AccountPlan): { memoryMb: number; cpus: number } {
  const mem = Math.min(plan.limits.appsMemoryMb ?? config.hosting.siteMaxMemoryMb, config.hosting.siteMaxMemoryMb || Infinity);
  const cpus = Math.min(plan.limits.appsCpuCores ?? config.hosting.siteMaxCpus, config.hosting.siteMaxCpus || Infinity);
  return { memoryMb: Math.max(256, mem), cpus: Math.max(0.5, cpus) };
}
