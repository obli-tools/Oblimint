import type {
  AppCatalogSource, AppDeployment, AppDeploymentAction, AppDeploymentStatus, AppDeploymentTrigger, AppGitSource, AppRegistryCredential,
  AppSleepPolicy, AppSourceType, AppStack, AppStackStatus, AppUpdatePolicy, ComposeValidationResult, EffectiveStackConfig,
} from '@oblimint/shared';
import { DEFAULT_APP_SLEEP_POLICY, DEFAULT_APP_UPDATE_POLICY } from '@oblimint/shared';
import { iso, json } from '../hosting/rows';
import type { AppStackRow } from './access';

// Rows of the apps tables (migration 007) and their API mappers.

export interface StackRow extends AppStackRow {
  description: string | null;
  source_type: AppSourceType;
  compose_yaml: string;
  env_sealed: string | null;
  env_keys: unknown;
  git_repo_url: string | null;
  git_branch: string | null;
  git_compose_path: string | null;
  git_token_sealed: string | null;
  git_build: boolean;
  git_poll_interval_sec: number | null;
  git_auto_deploy: boolean;
  git_last_commit: string | null;
  git_last_checked_at: Date | string | null;
  git_last_error: string | null;
  template_slug: string | null;
  template_version: string | null;
  template_values: unknown;
  status: AppStackStatus;
  status_message: string | null;
  validation: unknown;
  effective: unknown;
  effective_hash: string | null;
  update_policy: unknown;
  sleep_policy: unknown;
  last_activity_at: Date | string | null;
  last_deployed_at: Date | string | null;
  last_update_check_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ServiceRow {
  id: number;
  stack_id: number;
  account_id: number;
  name: string;
  image: string | null;
  current_digest: string | null;
  latest_digest: string | null;
  previous_digest: string | null;
  excluded_from_updates: boolean;
  checked_at: Date | string | null;
  check_error: string | null;
  notified_digest: string | null;
}

export interface DeploymentRow {
  id: number;
  stack_id: number;
  account_id: number;
  tenant_id: number;
  action: AppDeploymentAction;
  trigger: AppDeploymentTrigger;
  status: AppDeploymentStatus;
  commit_sha: string | null;
  user_id: number | null;
  compose_snapshot: string | null;
  effective_snapshot: unknown;
  images: unknown;
  log: unknown;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  /** joined */ user_name?: string | null;
}

/** effective_snapshot of a deployment (internal shape: never values, only hashes / masked YAML). */
export interface EffectiveSnapshot {
  effective: EffectiveStackConfig | null;
  effectiveYaml: string | null;
  /** service → spec hash deployed (reconcile reference). */
  specHashes: Record<string, string>;
  /**
   * Immutable source snapshot the deployment's binds / builds used (snapshots/<id>), null when it used no
   * source file. Absent on deployments made before the snapshots (deployments.ts sourceSnapshotOf).
   */
  sourceSnapshot?: number | null;
}

export interface CredentialRow {
  id: number;
  tenant_id: number;
  account_id: number;
  registry: string;
  username: string;
  password_sealed: string;
  created_at: Date | string;
  updated_at: Date | string;
  [column: string]: unknown;
}

export function updatePolicyOf(row: { update_policy: unknown }): AppUpdatePolicy {
  return { ...DEFAULT_APP_UPDATE_POLICY, ...json<Partial<AppUpdatePolicy>>(row.update_policy, {}) };
}

export function sleepPolicyOf(row: { sleep_policy: unknown }): AppSleepPolicy {
  return { ...DEFAULT_APP_SLEEP_POLICY, ...json<Partial<AppSleepPolicy>>(row.sleep_policy, {}) };
}

export function effectiveOf(row: { effective: unknown; validation?: unknown }): EffectiveStackConfig | null {
  const deployed = json<EffectiveStackConfig | null>(row.effective, null);
  if (deployed && Array.isArray(deployed.services)) return deployed;
  const v = json<ComposeValidationResult | null>(row.validation ?? null, null);
  return v?.effective && Array.isArray(v.effective.services) ? v.effective : null;
}

export function envKeysOf(row: { env_keys: unknown }): string[] {
  const k = json<unknown[]>(row.env_keys, []);
  return Array.isArray(k) ? k.filter((x): x is string => typeof x === 'string') : [];
}

export function gitSourceOf(row: StackRow): AppGitSource | null {
  if (row.source_type !== 'git' || !row.git_repo_url) return null;
  return {
    repoUrl: row.git_repo_url,
    branch: row.git_branch ?? 'main',
    composePath: row.git_compose_path ?? 'docker-compose.yml',
    hasToken: !!row.git_token_sealed,
    build: !!row.git_build,
    pollIntervalSec: row.git_poll_interval_sec,
    autoDeploy: !!row.git_auto_deploy,
    lastCommit: row.git_last_commit,
    lastCheckedAt: iso(row.git_last_checked_at),
    lastError: row.git_last_error,
  };
}

export function catalogSourceOf(row: StackRow): AppCatalogSource | null {
  if (row.source_type !== 'catalog' || !row.template_slug) return null;
  return { templateSlug: row.template_slug, templateVersion: row.template_version ?? '', values: json<AppCatalogSource['values']>(row.template_values, {}) };
}

export function toAppStack(row: StackRow, extras: {
  accountUsername: string; runningCount: number; updateAvailable: boolean; catalog: AppStack['catalog'];
}): AppStack {
  const eff = effectiveOf(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    accountUsername: extras.accountUsername,
    nodeId: row.node_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    sourceType: row.source_type,
    status: row.status,
    statusMessage: row.status_message,
    desiredState: row.desired_state,
    serviceCount: eff?.services.length ?? 0,
    runningCount: extras.runningCount,
    updateAvailable: extras.updateAvailable,
    catalog: extras.catalog,
    lastDeployedAt: iso(row.last_deployed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export function toDeployment(row: DeploymentRow): AppDeployment {
  const images = json<Record<string, string>>(row.images, {});
  return {
    id: row.id,
    stackId: row.stack_id,
    action: row.action,
    trigger: row.trigger,
    status: row.status,
    commitSha: row.commit_sha,
    userName: row.user_name ?? null,
    images,
    canRollback: row.status === 'succeeded' && !!row.compose_snapshot && ['deploy', 'redeploy', 'recreate', 'update', 'rollback'].includes(row.action),
    error: row.error,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function toCredential(row: CredentialRow): AppRegistryCredential {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    registry: row.registry,
    username: row.username,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}
