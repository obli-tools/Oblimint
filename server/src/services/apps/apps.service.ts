import type { Request } from 'express';
import type Docker from 'dockerode';
import type { Knex } from 'knex';
import type {
  AppActionRequest, AppContainerAction, AppContainerInspect, AppDeployment, AppDeploymentDetail, AppEnvResponse, AppImageRollbackRequest,
  AppLogsResponse, AppResourceSummary, AppRollbackRequest, AppServiceInfo, AppServiceUpdate, AppSleepPolicy, AppStack, AppStackCreate,
  AppStackDeleteRequest, AppStackDetail, AppStackStatus, AppStackUpdate, AppUpdateApplyRequest, AppUpdateCheck, AppUpdatePolicy,
  ComposeValidateRequest, ComposeValidationResult, EffectiveService,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { seal } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import { errText } from '../setup/docker';
import { containerState, listByLabel, restartContainer, startContainer, stopContainer, removeContainer, removeNetwork } from '../docker/dockerOps';
import { actorCan, loadAccount, type HostingActor } from '../hosting/access';
import { appContainer, appServiceAlias, LABELS, P4B_LABELS } from '../hosting/naming';
import { assertUsable, scopeOwned } from '../hosting/p4bAccess';
import { iso, json } from '../hosting/rows';
import { clientStatusMessage, forActor } from '../hosting/statusMessage';
import { demuxBuffer, isoOfDockerTs } from '../logs/dockerLogs';
import { platformSettings } from '../platformSettings';
import { loadStack } from './access';
import { removeVolume, unpauseContainer } from './appDocker';
import { catalogService } from './catalog.service';
import { renderFieldValues } from './catalog/render';
import { ENV_MAX_BYTES, stringifyDotenv } from './compose/dotenv';
import { inspectEnvValue, inspectLabels, secretValues, validateCompose } from './compose/validate';
import { accountPlan, composeContext, envMap, openEnv, otherStacksUsage } from './context';
import { appsDeps } from './deps';
import {
  assertAccountSegmented, cancelDeployment, isStackBusy, loadStackRow, releaseStack, reserveStack, runningDeploymentLog, stackRefWith, startAction, wakeEtaSec,
} from './deployments';
import { stackContainersOf, unsafeBindSources } from './engine';
import type { SourceInspector } from './compose/validate';
import { emitAppUpdated, clientLine } from './events';
import { assertBranch, normalizeComposePath, normalizeRepoUrl } from './git';
import { appPolicyService } from './policy.service';
import {
  catalogSourceOf, effectiveOf, envKeysOf, gitSourceOf, sleepPolicyOf, toAppStack, toDeployment, updatePolicyOf,
  type DeploymentRow, type EffectiveSnapshot, type ServiceRow, type StackRow,
} from './rows';
import { sleepManager } from './sleep';
import { pullGitSource, removeStackTree, uploadZipSource } from './sources';
import { checkStackUpdates } from './updates';
import { appsWorker } from './worker';

// ─────────────────────────────────────────────────────────────────────────────
// Docker applications of the hosting accounts (docs/P4b-PLAN.md §5, §6.1).
// OWNED BY MODULE `apps-core`. Signatures FROZEN (other modules consume the
// "internal API" part). Every route method checks access through
// apps/access.ts loadStack() (404 invisible / 403 without need); hooks never
// throw. Docker / hostd / registry failures are 502 backendUnavailable (A6:
// the raw cause for the staff only, errorHandler).
// ─────────────────────────────────────────────────────────────────────────────

export interface AppListQuery {
  accountId?: number | null;
  tenantId?: number | null;
  status?: AppStackStatus | null;
  search?: string | null;
}

/** What the proxy-hosts module needs to render / validate an app target (docs §7). */
export interface AppTargetInfo {
  stackId: number;
  accountId: number;
  tenantId: number;
  nodeId: number;
  service: string;
  /** DNS alias of the service on the account FRONT fabric (naming.appServiceAlias), the edge upstream host. */
  alias: string;
  exposedPorts: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  status: AppStackStatus;
  sleeping: boolean;
  /** The service joins the front fabric (it has exposed ports). */
  onFront: boolean;
  /** sleepPolicy.enabled: proxy-hosts renders the waking page for 502 / 503 / 504 (docs §5.7). */
  sleepEnabled: boolean;
  /** sleepPolicy.wakingPageId (null = host option / platform default). */
  wakingPageId: number | null;
  /** Average of the past wake-ups (s), for {{WAKE_ETA_SEC}}; null = unknown. */
  wakeEtaSec: number | null;
}

export interface AppStackSummary {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  displayName: string;
  status: AppStackStatus;
}

export const STACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const READY_PATH_RE = /^\/[A-Za-z0-9._~/?=&%:+-]{0,255}$/;
const LOG_TAIL_MAX = 2000;
const manualChecks = new Map<number, number>();

// ── helpers ──────────────────────────────────────────────────────────────────

const backend = (label: string, err: unknown) => new AppError(502, `${label}: ${errText(err)}`, 'backendUnavailable');

async function stackFor(actor: HostingActor, id: number, need: 'read' | 'apps.manage' | 'apps.console' = 'read'): Promise<StackRow> {
  return await loadStack(actor, id, need) as StackRow;
}

/** Secret values of the stack .env (inspect masking); null when the .env cannot be read. */
function inspectSecrets(stack: StackRow): string[] | null {
  try {
    return secretValues(envMap(openEnv(stack.env_sealed)));
  } catch {
    return null;
  }
}

function assertAccountUsable(status: string): void {
  if (status === 'suspended' || status === 'deleting') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
}

async function assertAppsEnabled(): Promise<void> {
  if (!(await platformSettings.section('apps')).enabled) throw new AppError(409, 'Applications are disabled on this platform', 'appsDisabled');
}

/** Maps a failed validation to the route error codes (details.issues always set). */
export function validationFailure(result: ComposeValidationResult): AppError | null {
  const errors = result.issues.filter((i) => i.severity === 'error');
  if (!errors.length) return null;
  const plan: Record<string, string> = { planCpuExceeded: 'appsCpu', planMemoryExceeded: 'appsMemory', planContainersExceeded: 'appContainers' };
  const imageCodes = new Set(['imageNotAllowed', 'registryNotAllowed']);
  const general = errors.filter((e) => !plan[e.code] && e.code !== 'buildNotAllowed' && !imageCodes.has(e.code));
  if (general.length) return new AppError(400, `The compose file is not valid: ${general[0].message}`, 'composeInvalid', { issues: result.issues });
  if (errors.some((e) => e.code === 'buildNotAllowed')) return new AppError(403, 'Building images is not allowed for this account', 'buildNotAllowed', { issues: result.issues });
  const img = errors.find((e) => imageCodes.has(e.code));
  if (img) return new AppError(400, img.message, 'imageNotAllowed', { issues: result.issues });
  const p = errors.find((e) => plan[e.code])!;
  return new AppError(409, p.message, 'planLimit', { dimension: plan[p.code], issues: result.issues });
}

function checkEnvText(env: string | undefined): void {
  if (env !== undefined && Buffer.byteLength(env, 'utf8') > ENV_MAX_BYTES) throw new AppError(400, '.env too large', 'validation');
}

async function normalizeUpdatePolicy(actor: HostingActor, accountId: number, current: AppUpdatePolicy, patch: Partial<AppUpdatePolicy> | undefined): Promise<AppUpdatePolicy> {
  const s = await platformSettings.section('apps');
  const next = { ...current, ...(patch ?? {}) };
  next.checkIntervalMin = Math.min(10080, Math.max(s.updateCheckMinMinutes, Math.round(next.checkIntervalMin)));
  if (patch?.maintenanceWindowId !== undefined && patch.maintenanceWindowId !== null) {
    await assertUsable(actor, 'app_maintenance_windows', patch.maintenanceWindowId, accountId, 'Maintenance window');
  }
  return next;
}

async function normalizeSleepPolicy(actor: HostingActor, accountId: number, current: AppSleepPolicy, patch: Partial<AppSleepPolicy> | undefined): Promise<AppSleepPolicy> {
  const next = { ...current, ...(patch ?? {}) };
  next.idleMinutes = Math.min(10080, Math.max(5, Math.round(next.idleMinutes)));
  next.wakeTimeoutSec = Math.min(600, Math.max(10, Math.round(next.wakeTimeoutSec)));
  if (next.mode !== 'stop' && next.mode !== 'pause') throw new AppError(400, 'Invalid sleep mode', 'validation');
  if (next.readyPath !== null && !READY_PATH_RE.test(next.readyPath)) throw new AppError(400, 'Invalid ready path (it must start with /)', 'validation');
  if (patch?.wakingPageId !== undefined && patch.wakingPageId !== null) await assertUsable(actor, 'custom_pages', patch.wakingPageId, accountId, 'Page');
  return next;
}

/** Registry credentials referenced by a body must belong to the stack's account (404 otherwise). */
async function assertCredentials(accountId: number, ids: number[] | undefined): Promise<number[]> {
  if (!ids?.length) return [];
  const unique = [...new Set(ids)];
  const rows = await db('app_registry_credentials').whereIn('id', unique).where({ account_id: accountId }).pluck('id') as number[];
  if (rows.length !== unique.length) throw new AppError(404, 'Registry credential not found', 'notFound');
  return unique;
}

async function setCredentials(trx: Knex.Transaction | Knex, stackId: number, accountId: number, ids: number[]): Promise<void> {
  await trx('app_stack_credentials').where({ stack_id: stackId }).delete();
  if (ids.length) await trx('app_stack_credentials').insert(ids.map((credentialId) => ({ stack_id: stackId, credential_id: credentialId, account_id: accountId })));
}

/** Locks the account row (plan sums / stack count never race between two requests). */
async function lockAccount(trx: Knex.Transaction, accountId: number): Promise<void> {
  await trx.raw('SELECT id FROM hosting_accounts WHERE id = ? FOR UPDATE', [accountId]);
}

function serviceInfo(stackId: number, svc: EffectiveService, row: ServiceRow | undefined, c: Docker.ContainerInfo | undefined, ins: Docker.ContainerInspectInfo | null): AppServiceInfo {
  const st = ins?.State as (Docker.ContainerInspectInfo['State'] & { Health?: { Status?: string } }) | undefined;
  const healthRaw = st?.Health?.Status ?? (/\(healthy\)/.test(c?.Status ?? '') ? 'healthy' : /\(unhealthy\)/.test(c?.Status ?? '') ? 'unhealthy' : /health: starting/.test(c?.Status ?? '') ? 'starting' : null);
  const health = healthRaw === 'healthy' || healthRaw === 'unhealthy' || healthRaw === 'starting' ? healthRaw : null;
  const state = c ? containerState(c.State) : 'missing';
  const updateAvailable = !!row?.latest_digest && !!row.current_digest && row.latest_digest !== row.current_digest && !row.excluded_from_updates;
  return {
    name: svc.name,
    image: svc.image ?? row?.image ?? null,
    containerName: appContainer(stackId, svc.name),
    state,
    health,
    exposedPorts: svc.exposedPorts,
    currentDigest: row?.current_digest ?? null,
    latestDigest: row?.latest_digest ?? null,
    updateAvailable,
    excludedFromUpdates: !!row?.excluded_from_updates,
    previousDigest: row?.previous_digest ?? null,
    startedAt: st?.Running && st.StartedAt && !st.StartedAt.startsWith('0001') ? iso(st.StartedAt) : null,
    restartCount: (ins as { RestartCount?: number } | null)?.RestartCount ?? 0,
    limits: svc.limits,
  };
}

async function dockerFor(nodeId: number): Promise<Docker | null> {
  try {
    return await appsDeps().docker(nodeId);
  } catch {
    return null;
  }
}

/** Containers of a stack, empty when Docker is unreachable (lists never fail on Docker). */
async function containersOrEmpty(stack: StackRow): Promise<Map<string, Docker.ContainerInfo>> {
  const docker = await dockerFor(stack.node_id);
  if (!docker) return new Map();
  try {
    return await stackContainersOf(docker, stack.id);
  } catch {
    return new Map();
  }
}

async function catalogInfo(stack: StackRow): Promise<AppStack['catalog']> {
  if (stack.source_type !== 'catalog' || !stack.template_slug) return null;
  const t = await db('app_templates').where({ slug: stack.template_slug }).where((w) => { w.whereNull('tenant_id').orWhere('tenant_id', stack.tenant_id); })
    .orderByRaw('tenant_id IS NULL').first('slug', 'name', 'icon') as { slug: string; name: string; icon: string } | undefined;
  return t ? { slug: t.slug, name: t.name, icon: t.icon } : { slug: stack.template_slug, name: stack.template_slug, icon: 'box' };
}

async function toStackFor(actor: HostingActor, stack: StackRow, containers: Map<string, Docker.ContainerInfo>, accountUsername?: string): Promise<AppStack> {
  const username = accountUsername ?? (await db('hosting_accounts').where({ id: stack.account_id }).first('username') as { username: string } | undefined)?.username ?? '';
  const eff = effectiveOf(stack);
  let running = 0;
  for (const s of eff?.services ?? []) if (containers.get(s.name)?.State === 'running') running++;
  const updates = await db('app_services').where({ stack_id: stack.id, excluded_from_updates: false }).whereNotNull('latest_digest')
    .whereRaw('latest_digest IS DISTINCT FROM current_digest').first('id');
  return forActor(actor, toAppStack(stack, { accountUsername: username, runningCount: running, updateAvailable: !!updates, catalog: await catalogInfo(stack) }));
}

function deploymentFor(actor: HostingActor, row: DeploymentRow): AppDeployment {
  const d = toDeployment(row);
  return actor.kind === 'client' ? { ...d, error: clientStatusMessage(d.error) } : d;
}

async function deploymentRow(stackId: number, deploymentId: number): Promise<DeploymentRow> {
  if (!Number.isInteger(deploymentId) || deploymentId <= 0) throw new AppError(404, 'Deployment not found', 'deploymentNotFound');
  const row = await db('app_deployments as d').leftJoin('users as u', 'u.id', 'd.user_id').where('d.id', deploymentId).andWhere('d.stack_id', stackId)
    .first('d.*', 'u.username as user_name') as DeploymentRow | undefined;
  if (!row) throw new AppError(404, 'Deployment not found', 'deploymentNotFound');
  return row;
}

function auditStack(req: Request, stack: { tenant_id: number; id: number }, action: string, details: Record<string, unknown> = {}): Promise<void> {
  return auditService.logReqAs(req, stack.tenant_id, action, { resourceType: 'app_stack', resourcePath: String(stack.id), details });
}

function emitStack(stack: { id: number; tenant_id: number; account_id: number }, action: 'created' | 'updated' | 'deleted'): void {
  emitAppUpdated({ entity: 'stack', id: stack.id, stackId: stack.id, accountId: stack.account_id, action }, { tenantId: stack.tenant_id, accountId: stack.account_id });
}

/** Revalidates a compose for a stack inside the account lock (plan sums), throws the mapped error. */
/** Validates the compose of a STAGED source tree (sources.ts StagedValidator): throws the refusal, returns the result. */
async function validateStaged(
  stack: StackRow, sourceType: StackRow['source_type'], gitComposePath: string | null, composeYaml: string, env: Map<string, string>, inspector: SourceInspector,
): Promise<ComposeValidationResult> {
  return db.transaction(async (trx) => {
    await lockAccount(trx, stack.account_id);
    const { ctx } = await composeContext({ stackId: stack.id, accountId: stack.account_id, sourceType, gitComposePath, env, inspect: true, inspector }, trx);
    const out = validateCompose(composeYaml, ctx);
    const failure = validationFailure(out.result);
    if (failure) throw failure;
    return out.result;
  });
}

async function validateForSave(trx: Knex.Transaction, input: {
  stackId: number | null; accountId: number; sourceType: StackRow['source_type']; gitComposePath: string | null; composeYaml: string; env: Map<string, string>;
}): Promise<ComposeValidationResult> {
  const { ctx } = await composeContext({ ...input, inspect: !!input.stackId }, trx);
  const out = validateCompose(input.composeYaml, ctx);
  const failure = validationFailure(out.result);
  if (failure) throw failure;
  return out.result;
}

/** Stack deletion, the stack reserved by the caller (appsService.remove). */
async function removeStackReserved(req: Request, stack: StackRow, body: AppStackDeleteRequest): Promise<{ deleted: true }> {
  const id = stack.id;
  const force = req.query.force === '1' || req.query.force === 'true';
  const deps = appsDeps();
  let hosts: Awaited<ReturnType<typeof deps.proxy.hostsTargetingStack>> = [];
  try {
    hosts = await deps.proxy.hostsTargetingStack(id);
  } catch (err) {
    logger.warn({ err: errText(err), stackId: id }, 'apps: proxy hosts of the stack unknown (proxy-hosts unavailable)');
  }
  if (hosts.length && !force) {
    throw new AppError(409, 'Proxy hosts still target this application', 'stackInUse', { hosts: hosts.map((h) => ({ id: h.id, name: h.name, domains: h.domains })) });
  }
  await db('app_stacks').where({ id }).update({ status: 'deleting', updated_at: db.fn.now() });
  try {
    const docker = await deps.docker(stack.node_id);
    for (const c of await listByLabel(docker, `${P4B_LABELS.app}=${id}`)) {
      if (c.Labels?.[LABELS.role] === 'app') await removeContainer(docker, (c.Names?.[0] ?? '').replace(/^\//, ''));
    }
    const nets = await docker.listNetworks({ filters: { label: [`${P4B_LABELS.appNetwork}=${id}`] } }) as Array<{ Name: string }>;
    for (const n of nets) await removeNetwork(docker, n.Name);
    const vols = await docker.listVolumes({ filters: { label: [`${P4B_LABELS.app}=${id}`] } }) as { Volumes?: Array<{ Name: string }> | null };
    for (const v of vols.Volumes ?? []) await removeVolume(docker, v.Name);
    try {
      const images = await docker.listImages({ filters: { label: [`${P4B_LABELS.app}=${id}`] } }) as Array<{ Id: string; RepoTags?: string[] }>;
      for (const img of images) await docker.getImage(img.RepoTags?.[0] ?? img.Id).remove({ force: true }).catch(() => undefined);
    } catch { /* built images: best effort */ }
  } catch (err) {
    await db('app_stacks').where({ id }).update({ status: 'error', status_message: `Suppression impossible : ${errText(err)}` });
    throw backend('The application could not be removed', err);
  }
  try {
    await deps.segments.releaseAppNetworks(id);
  } catch (err) {
    logger.warn({ err: errText(err), stackId: id }, 'apps: app network subnets not released');
  }
  let tombstone: string | null = null;
  try {
    tombstone = removeStackTree(stack, !body.removeVolumes);
  } catch (err) {
    logger.warn({ err: errText(err), stackId: id }, 'apps: stack tree not fully removed');
  }
  if (tombstone) {
    await db('app_volume_tombstones').insert({ account_id: stack.account_id, stack_id: id, path: tombstone, purge_after: new Date(Date.now() + 7 * 86_400_000) });
  }
  if (hosts.length) {
    try { await deps.proxy.stackDeleted(id); } catch { /* never throws by contract */ }
  }
  await db('app_stacks').where({ id }).delete();
  await auditStack(req, stack, 'apps.stack.delete', { name: stack.name, removeVolumes: !!body.removeVolumes, forced: hosts.length > 0 });
  deps.segments.requestPolicySync('apps');
  deps.edgeSync('apps');
  emitStack(stack, 'deleted');
  return { deleted: true };
}

// ── service ──────────────────────────────────────────────────────────────────

export const appsService = {
  // ── REST (routes/apps.routes.ts) ──
  async list(actor: HostingActor, q: AppListQuery): Promise<AppStack[]> {
    const qb = db('app_stacks as s').join('hosting_accounts as a', 'a.id', 's.account_id').orderBy('s.id');
    scopeOwned(actor, qb, 's', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('s.account_id', q.accountId);
    if (q.status) qb.where('s.status', q.status);
    if (q.search) {
      const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      qb.where((w) => { w.whereILike('s.name', s).orWhereILike('s.display_name', s); });
    }
    const rows = await qb.select('s.*', 'a.username as account_username') as Array<StackRow & { account_username: string }>;
    // One container listing per node (never one per stack).
    const byNode = new Map<number, Map<string, Map<string, Docker.ContainerInfo>>>();
    for (const nodeId of new Set(rows.map((r) => r.node_id))) {
      const map = new Map<string, Map<string, Docker.ContainerInfo>>();
      const docker = await dockerFor(nodeId);
      if (docker) {
        try {
          for (const c of await listByLabel(docker, `${LABELS.role}=app`)) {
            const stackId = c.Labels?.[P4B_LABELS.app];
            const svc = c.Labels?.[P4B_LABELS.appService];
            if (!stackId || !svc) continue;
            if (!map.has(stackId)) map.set(stackId, new Map());
            map.get(stackId)!.set(svc, c);
          }
        } catch { /* Docker unreachable: counts at 0 */ }
      }
      byNode.set(nodeId, map);
    }
    const out: AppStack[] = [];
    for (const r of rows) out.push(await toStackFor(actor, r, byNode.get(r.node_id)?.get(String(r.id)) ?? new Map(), r.account_username));
    return out;
  },

  async get(actor: HostingActor, id: number): Promise<AppStackDetail> {
    const stack = await stackFor(actor, id, 'read');
    const containers = await containersOrEmpty(stack);
    const base = await toStackFor(actor, stack, containers);
    const eff = effectiveOf(stack);
    const rows = new Map((await db('app_services').where({ stack_id: id }) as ServiceRow[]).map((r) => [r.name, r]));
    const docker = containers.size ? await dockerFor(stack.node_id) : null;
    const services: AppServiceInfo[] = [];
    for (const svc of eff?.services ?? []) {
      let ins: Docker.ContainerInspectInfo | null = null;
      if (docker && containers.has(svc.name)) {
        try { ins = await docker.getContainer(appContainer(id, svc.name)).inspect(); } catch { ins = null; }
      }
      services.push(serviceInfo(id, svc, rows.get(svc.name), containers.get(svc.name), ins));
    }
    let proxyHosts: AppStackDetail['proxyHosts'] = [];
    try {
      proxyHosts = await appsDeps().proxy.hostsTargetingStack(id);
    } catch { /* proxy-hosts not available yet */ }
    const credentialIds = await db('app_stack_credentials').where({ stack_id: id }).orderBy('credential_id').pluck('credential_id') as number[];
    return {
      ...base,
      composeYaml: stack.compose_yaml,
      envKeys: envKeysOf(stack),
      git: gitSourceOf(stack),
      catalogSource: catalogSourceOf(stack),
      registryCredentialIds: credentialIds.map(Number),
      updatePolicy: updatePolicyOf(stack),
      sleepPolicy: sleepPolicyOf(stack),
      services,
      validation: json<ComposeValidationResult | null>(stack.validation, null),
      proxyHosts,
    };
  },

  async create(req: Request, actor: HostingActor, input: AppStackCreate): Promise<AppStackDetail> {
    const account = await loadAccount(actor, input.accountId, 'apps.manage');
    assertAccountUsable(account.status);
    await assertAppsEnabled();
    if (!STACK_NAME_RE.test(input.name)) throw new AppError(400, 'Invalid name (lowercase letters, digits and -, 31 max)', 'validation');
    checkEnvText(input.env);
    const credentials = await assertCredentials(account.id, input.registryCredentialIds);
    const settings = await platformSettings.section('apps');

    let composeYaml = '';
    let envText = input.env ?? '';
    const git: Record<string, unknown> = {};
    const catalog: Record<string, unknown> = {};
    switch (input.sourceType) {
      case 'editor':
        if (!input.composeYaml?.trim()) throw new AppError(400, 'composeYaml is required', 'validation');
        composeYaml = input.composeYaml;
        break;
      case 'git': {
        if (!input.git) throw new AppError(400, 'git is required', 'validation');
        const plan = await accountPlan(account.id);
        const policy = await appPolicyService.effective(account.tenant_id);
        if (input.git.build && !(policy.allowBuild && plan.limits.appsBuild)) throw new AppError(403, 'Building images is not allowed for this account', 'buildNotAllowed');
        const poll = input.git.pollIntervalSec ?? null;
        Object.assign(git, {
          git_repo_url: normalizeRepoUrl(input.git.repoUrl),
          git_branch: assertBranch(input.git.branch ?? 'main'),
          git_compose_path: normalizeComposePath(input.git.composePath),
          git_token_sealed: input.git.token ? seal('apps', input.git.token) : null,
          git_build: !!input.git.build,
          git_poll_interval_sec: poll === null ? null : Math.max(settings.gitPollMinSec, Math.round(poll)),
          git_auto_deploy: !!input.git.autoDeploy,
        });
        break;
      }
      case 'zip':
        break;
      case 'catalog': {
        if (!input.catalog) throw new AppError(400, 'catalog is required', 'validation');
        const tpl = await catalogService.forTenant(account.tenant_id, input.catalog.templateSlug);
        if (!tpl || !tpl.enabled) throw new AppError(404, 'Template not found', 'templateNotFound');
        const rendered = renderFieldValues(json(tpl.fields, []), input.catalog.values ?? {});
        const extra = envMap(envText);
        for (const [k, v] of rendered.env) extra.set(k, v);
        envText = stringifyDotenv(extra);
        composeYaml = tpl.compose_yaml;
        Object.assign(catalog, { template_slug: tpl.slug, template_version: tpl.version, template_values: JSON.stringify(rendered.values) });
        break;
      }
      default:
        throw new AppError(400, 'Invalid source type', 'validation');
    }
    const env = envMap(envText);
    const updatePolicy = await normalizeUpdatePolicy(actor, account.id, updatePolicyOf({ update_policy: null }), input.updatePolicy);
    const sleepPolicy = await normalizeSleepPolicy(actor, account.id, sleepPolicyOf({ sleep_policy: null }), input.sleepPolicy);
    const plan = await accountPlan(account.id);

    const stack = await db.transaction(async (trx) => {
      await lockAccount(trx, account.id);
      const usage = await otherStacksUsage(account.id, null, trx);
      if (plan.limits.maxAppStacks !== null && plan.limits.maxAppStacks !== undefined && usage.stacks >= plan.limits.maxAppStacks) {
        throw new AppError(409, `The plan allows ${plan.limits.maxAppStacks} application(s)`, 'planLimit', { dimension: 'appStacks', limit: plan.limits.maxAppStacks });
      }
      if (await trx('app_stacks').where({ account_id: account.id, name: input.name }).first('id')) {
        throw new AppError(409, 'An application with this name already exists in the account', 'stackNameTaken');
      }
      const validation = composeYaml
        ? await validateForSave(trx, { stackId: null, accountId: account.id, sourceType: input.sourceType, gitComposePath: (git.git_compose_path as string) ?? null, composeYaml, env })
        : null;
      const [row] = await trx('app_stacks').insert({
        tenant_id: account.tenant_id, account_id: account.id, node_id: account.node_id, name: input.name,
        display_name: (input.displayName?.trim() || input.name).slice(0, 128), description: input.description ?? null,
        source_type: input.sourceType, compose_yaml: composeYaml, env_sealed: envText.trim() ? seal('apps', envText) : null,
        env_keys: JSON.stringify([...env.keys()]), ...git, ...catalog, status: 'draft', desired_state: 'running',
        validation: validation ? JSON.stringify(validation) : null, update_policy: JSON.stringify(updatePolicy), sleep_policy: JSON.stringify(sleepPolicy),
      }).returning('*') as StackRow[];
      await setCredentials(trx, row.id, account.id, credentials);
      return row;
    });

    let current = stack;
    if (input.sourceType === 'git') {
      try {
        const res = await pullGitSource(stack, true);
        const fresh = (await loadStackRow(stack.id))!;
        const validation = await db.transaction((trx) => validateForSave(trx, {
          stackId: stack.id, accountId: account.id, sourceType: 'git', gitComposePath: fresh.git_compose_path, composeYaml: res.composeYaml, env,
        }));
        await db('app_stacks').where({ id: stack.id }).update({ validation: JSON.stringify(validation) });
        current = (await loadStackRow(stack.id))!;
      } catch (err) {
        // The repository could not be read (or its compose is invalid): nothing is kept.
        await db('app_stacks').where({ id: stack.id }).delete();
        try { removeStackTree(stack, false); } catch { /* best effort */ }
        throw err;
      }
    }
    await auditStack(req, stack, 'apps.stack.create', {
      name: stack.name, accountId: account.id, sourceType: input.sourceType, template: (catalog.template_slug as string) ?? undefined,
      repoUrl: (git.git_repo_url as string) ?? undefined, envKeys: [...env.keys()],
    });
    emitStack(stack, 'created');
    if (input.deploy !== false && input.sourceType !== 'zip') {
      const trigger = input.sourceType === 'catalog' ? 'catalog' : input.sourceType === 'git' ? 'git' : 'user';
      await startAction(current, 'deploy', trigger, { userId: actor.userId, commitSha: current.git_last_commit });
    }
    return this.get(actor, stack.id);
  },

  async update(req: Request, actor: HostingActor, id: number, input: AppStackUpdate): Promise<AppStackDetail> {
    const stack = await stackFor(actor, id, 'apps.manage');
    checkEnvText(input.env);
    const settings = await platformSettings.section('apps');
    if (input.composeYaml !== undefined && stack.source_type !== 'editor' && stack.source_type !== 'zip') {
      throw new AppError(409, 'The compose of this application comes from its source', 'sourceTypeMismatch');
    }
    if (input.git !== undefined && stack.source_type !== 'git') throw new AppError(409, 'This application has no git source', 'sourceTypeMismatch');
    if (input.catalogValues !== undefined && stack.source_type !== 'catalog') throw new AppError(409, 'This application does not come from the catalog', 'sourceTypeMismatch');
    const credentials = input.registryCredentialIds !== undefined ? await assertCredentials(stack.account_id, input.registryCredentialIds) : null;

    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    const changed: string[] = [];
    let envText = input.env !== undefined ? input.env : openEnv(stack.env_sealed);
    const composeYaml = input.composeYaml ?? stack.compose_yaml;
    if (input.displayName !== undefined) { patch.display_name = input.displayName.trim().slice(0, 128) || stack.name; changed.push('displayName'); }
    if (input.description !== undefined) { patch.description = input.description; changed.push('description'); }
    if (input.composeYaml !== undefined) { patch.compose_yaml = composeYaml; changed.push('compose'); }
    if (input.catalogValues !== undefined) {
      const tpl = await catalogService.forTenant(stack.tenant_id, stack.template_slug ?? '');
      if (!tpl) throw new AppError(404, 'Template not found', 'templateNotFound');
      const existing = envMap(envText);
      const rendered = renderFieldValues(json(tpl.fields, []), input.catalogValues, existing);
      for (const [k, v] of rendered.env) existing.set(k, v);
      envText = stringifyDotenv(existing);
      patch.template_values = JSON.stringify(rendered.values);
      changed.push('catalogValues');
    }
    const env = envMap(envText);
    if (input.env !== undefined || input.catalogValues !== undefined) {
      patch.env_sealed = envText.trim() ? seal('apps', envText) : null;
      patch.env_keys = JSON.stringify([...env.keys()]);
      changed.push('env');
    }
    if (input.git !== undefined) {
      const g = input.git;
      if (g.build) {
        const plan = await accountPlan(stack.account_id);
        const policy = await appPolicyService.effective(stack.tenant_id);
        if (!(policy.allowBuild && plan.limits.appsBuild)) throw new AppError(403, 'Building images is not allowed for this account', 'buildNotAllowed');
      }
      if (g.repoUrl !== undefined) patch.git_repo_url = normalizeRepoUrl(g.repoUrl);
      if (g.branch !== undefined) patch.git_branch = assertBranch(g.branch);
      if (g.composePath !== undefined) patch.git_compose_path = normalizeComposePath(g.composePath);
      if (g.token !== undefined) patch.git_token_sealed = g.token === null || g.token === '' ? null : seal('apps', g.token);
      // The stored token goes to the repository host (Authorization: Basic): another repository never
      // inherits it (M2). A new URL comes with its token, or with token null / '' to drop the stored one.
      if (patch.git_repo_url !== undefined && patch.git_repo_url !== stack.git_repo_url && g.token === undefined && stack.git_token_sealed) {
        throw new AppError(400, 'The repository changed: enter its access token again, or remove the stored token', 'gitTokenRequired');
      }
      if (g.build !== undefined) patch.git_build = g.build;
      if (g.pollIntervalSec !== undefined) patch.git_poll_interval_sec = g.pollIntervalSec === null ? null : Math.max(settings.gitPollMinSec, Math.round(g.pollIntervalSec));
      if (g.autoDeploy !== undefined) patch.git_auto_deploy = g.autoDeploy;
      changed.push('git');
    }
    if (input.updatePolicy !== undefined) {
      patch.update_policy = JSON.stringify(await normalizeUpdatePolicy(actor, stack.account_id, updatePolicyOf(stack), input.updatePolicy));
      changed.push('updatePolicy');
    }
    if (input.sleepPolicy !== undefined) {
      patch.sleep_policy = JSON.stringify(await normalizeSleepPolicy(actor, stack.account_id, sleepPolicyOf(stack), input.sleepPolicy));
      changed.push('sleepPolicy');
    }
    await db.transaction(async (trx) => {
      await lockAccount(trx, stack.account_id);
      if ((input.composeYaml !== undefined || input.env !== undefined || input.catalogValues !== undefined) && composeYaml.trim()) {
        const validation = await validateForSave(trx, {
          stackId: stack.id, accountId: stack.account_id, sourceType: stack.source_type,
          gitComposePath: (patch.git_compose_path as string | undefined) ?? stack.git_compose_path, composeYaml, env,
        });
        patch.validation = JSON.stringify(validation);
      }
      await trx('app_stacks').where({ id }).update(patch);
      if (credentials) { await setCredentials(trx, id, stack.account_id, credentials); changed.push('registryCredentials'); }
    });
    if (input.git?.repoUrl !== undefined || input.git?.branch !== undefined || input.git?.composePath !== undefined) {
      // New repository / branch: the next pull fetches it again.
      await db('app_stacks').where({ id }).update({ git_last_commit: null });
    }
    await auditStack(req, stack, 'apps.stack.update', { changed });
    emitStack(stack, 'updated');
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number, body: AppStackDeleteRequest): Promise<{ deleted: true }> {
    const stack = await stackFor(actor, id, 'apps.manage');
    if (body.confirm !== stack.name) throw new AppError(400, 'Type the name of the application to confirm', 'confirmMismatch');
    // Reserved synchronously (no await between the check and the reservation): no wake, git poll, reconcile
    // start or auto-update can start an action that would recreate containers while they are removed.
    if (!reserveStack(id)) throw new AppError(409, 'An action is running on this application', 'stackBusy');
    try {
      return await removeStackReserved(req, stack, body);
    } finally {
      releaseStack(id);
    }
  },

  async getEnv(req: Request, actor: HostingActor, id: number): Promise<AppEnvResponse> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const env = openEnv(stack.env_sealed);
    await auditStack(req, stack, 'apps.stack.env.read', { keys: envKeysOf(stack) });
    return { env };
  },

  async validate(actor: HostingActor, input: ComposeValidateRequest): Promise<ComposeValidationResult> {
    const account = await loadAccount(actor, input.accountId, 'apps.manage');
    let stack: StackRow | null = null;
    if (input.stackId) {
      stack = await stackFor(actor, input.stackId, 'apps.manage');
      if (stack.account_id !== account.id) throw new AppError(404, 'Application not found', 'notFound');
    }
    checkEnvText(input.env);
    const env = envMap(input.env !== undefined ? input.env : openEnv(stack?.env_sealed ?? null));
    const { ctx } = await composeContext({
      stackId: stack?.id ?? null, accountId: account.id, sourceType: stack?.source_type ?? 'editor', gitComposePath: stack?.git_compose_path ?? null, env, inspect: !!stack,
    });
    return validateCompose(input.composeYaml, ctx).result;
  },

  /** application/zip request body (streamed, bounded by settings apps.zipMaxMb / zipMaxExpandedMb). */
  async uploadZip(req: Request, actor: HostingActor, id: number, body: NodeJS.ReadableStream): Promise<AppStackDetail> {
    const stack = await stackFor(actor, id, 'apps.manage');
    if (stack.source_type !== 'zip') throw new AppError(409, 'This application has no ZIP source', 'sourceTypeMismatch');
    if (isStackBusy(id)) throw new AppError(409, 'An action is running on this application', 'stackBusy');
    const account = await accountPlan(stack.account_id);
    assertAccountUsable(account.status);
    const env = envMap(openEnv(stack.env_sealed));
    let validation: ComposeValidationResult | null = null;
    // Validated against the STAGED tree: a refused archive never replaces the current source.
    const composeYaml = await uploadZipSource(stack, body, {
      validate: async (yaml, inspector) => { validation = await validateStaged(stack, 'zip', null, yaml, env, inspector); },
    });
    await db('app_stacks').where({ id }).update({ compose_yaml: composeYaml, validation: JSON.stringify(validation), updated_at: db.fn.now() });
    await auditStack(req, stack, 'apps.stack.update', { changed: ['source:zip'] });
    emitStack(stack, 'updated');
    if (stack.status === 'draft') await startAction((await loadStackRow(id))!, 'deploy', 'user', { userId: actor.userId });
    return this.get(actor, id);
  },

  /** git source: fetch now; redeploys when a new commit is found and autoDeploy (or `deploy`). */
  async gitPull(req: Request, actor: HostingActor, id: number, opts: { deploy: boolean }): Promise<{ commit: string | null; changed: boolean; deployment: AppDeployment | null }> {
    const stack = await stackFor(actor, id, 'apps.manage');
    if (stack.source_type !== 'git') throw new AppError(409, 'This application has no git source', 'sourceTypeMismatch');
    if (isStackBusy(id)) throw new AppError(409, 'An action is running on this application', 'stackBusy');
    const env = envMap(openEnv(stack.env_sealed));
    let validation: ComposeValidationResult | null = null;
    // Validated against the STAGED checkout: a refused commit never replaces src/ (running containers bind
    // their deployment snapshot anyway).
    const res = await pullGitSource(stack, false, {
      validate: async (yaml, inspector) => { validation = await validateStaged(stack, 'git', stack.git_compose_path, yaml, env, inspector); },
    });
    if (res.changed && validation) await db('app_stacks').where({ id }).update({ validation: JSON.stringify(validation) });
    await auditStack(req, stack, 'apps.stack.update', { changed: ['source:git'], commit: res.commit });
    let deployment: AppDeployment | null = null;
    if (opts.deploy || (res.changed && stack.git_auto_deploy)) {
      const fresh = (await loadStackRow(id))!;
      const account = await accountPlan(stack.account_id);
      assertAccountUsable(account.status);
      deployment = deploymentFor(actor, await startAction(fresh, 'deploy', 'git', { userId: actor.userId, commitSha: res.commit, build: fresh.git_build }));
    }
    emitStack(stack, 'updated');
    return { commit: res.commit, changed: res.changed, deployment };
  },

  async action(req: Request, actor: HostingActor, id: number, body: AppActionRequest): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const account = await accountPlan(stack.account_id);
    if (body.action !== 'stop' && body.action !== 'down') {
      assertAccountUsable(account.status);
      await assertAppsEnabled();
    }
    if (body.build) {
      const policy = await appPolicyService.effective(stack.tenant_id);
      if (!(policy.allowBuild && account.limits.appsBuild)) throw new AppError(403, 'Building images is not allowed for this account', 'buildNotAllowed');
    }
    const row = await startAction(stack, body.action, 'user', { userId: actor.userId, build: !!body.build || (stack.source_type === 'git' && stack.git_build && body.action === 'redeploy') });
    await auditStack(req, stack, 'apps.stack.action', { action: body.action, deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async listDeployments(actor: HostingActor, id: number, q: { limit: number; offset: number }): Promise<{ items: AppDeployment[]; total: number }> {
    await stackFor(actor, id, 'read');
    const limit = Math.min(200, Math.max(1, q.limit || 50));
    const offset = Math.max(0, q.offset || 0);
    const rows = await db('app_deployments as d').leftJoin('users as u', 'u.id', 'd.user_id').where('d.stack_id', id)
      .orderBy('d.id', 'desc').limit(limit).offset(offset)
      .select('d.id', 'd.stack_id', 'd.account_id', 'd.tenant_id', 'd.action', 'd.trigger', 'd.status', 'd.commit_sha', 'd.user_id', 'd.images', 'd.error',
        'd.created_at', 'd.started_at', 'd.finished_at', db.raw('(d.compose_snapshot IS NOT NULL) AS has_snapshot'), 'u.username as user_name') as Array<DeploymentRow & { has_snapshot: boolean }>;
    const [{ count }] = await db('app_deployments').where({ stack_id: id }).count<{ count: string }[]>('id as count');
    return {
      items: rows.map((r) => deploymentFor(actor, { ...r, compose_snapshot: r.has_snapshot ? 'x' : null, effective_snapshot: null, log: [] })),
      total: Number(count),
    };
  },

  async getDeployment(actor: HostingActor, id: number, deploymentId: number): Promise<AppDeploymentDetail> {
    await stackFor(actor, id, 'read');
    const row = await deploymentRow(id, deploymentId);
    const live = runningDeploymentLog(row.id);
    const log = live ?? json<string[]>(row.log, []);
    const snap = json<EffectiveSnapshot | null>(row.effective_snapshot, null);
    const base = deploymentFor(actor, row);
    return { ...base, log: actor.kind === 'client' ? log.map(clientLine) : log, effectiveYaml: snap?.effectiveYaml ?? null };
  },

  async cancelDeployment(req: Request, actor: HostingActor, id: number, deploymentId: number): Promise<{ cancelled: boolean }> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const row = await deploymentRow(id, deploymentId);
    const cancelled = await cancelDeployment(row.id);
    if (cancelled) await auditStack(req, stack, 'apps.stack.action', { action: 'cancel', deploymentId: row.id });
    return { cancelled };
  },

  async rollback(req: Request, actor: HostingActor, id: number, body: AppRollbackRequest): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const target = await deploymentRow(id, body.deploymentId);
    if (!toDeployment(target).canRollback) throw new AppError(409, 'This deployment cannot be restored', 'nothingToRollback');
    const account = await accountPlan(stack.account_id);
    assertAccountUsable(account.status);
    const row = await startAction(stack, 'rollback', 'rollback', { userId: actor.userId, rollbackOf: target });
    await auditStack(req, stack, 'apps.stack.rollback', { toDeploymentId: target.id, deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async checkUpdates(_req: Request, actor: HostingActor, id: number): Promise<AppUpdateCheck> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const now = Date.now();
    const last = manualChecks.get(id) ?? 0;
    if (now - last < 60_000) throw new AppError(429, 'Updates were checked less than a minute ago', 'tooManyRequests');
    manualChecks.set(id, now);
    return checkStackUpdates(stack, { notify: true });
  },

  async applyUpdates(req: Request, actor: HostingActor, id: number, body: AppUpdateApplyRequest): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const account = await accountPlan(stack.account_id);
    assertAccountUsable(account.status);
    if (body.services?.length) {
      const known = new Set(await db('app_services').where({ stack_id: id }).pluck('name') as string[]);
      const unknown = body.services.find((s) => !known.has(s));
      if (unknown) throw new AppError(404, `Service ${unknown} not found`, 'serviceNotFound');
    }
    const row = await startAction(stack, 'update', 'user', { userId: actor.userId, services: body.services ?? null });
    await auditStack(req, stack, 'apps.stack.update', { action: 'applyUpdates', services: body.services ?? null, deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async rollbackImage(req: Request, actor: HostingActor, id: number, body: AppImageRollbackRequest): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const svc = await db('app_services').where({ stack_id: id, name: body.service }).first() as ServiceRow | undefined;
    if (!svc) throw new AppError(404, `Service ${body.service} not found`, 'serviceNotFound');
    if (!svc.previous_digest) throw new AppError(409, 'No previous image for this service', 'nothingToRollback');
    const row = await startAction(stack, 'update', 'rollback', { userId: actor.userId, imageRollback: body.service });
    await auditStack(req, stack, 'apps.stack.rollback', { service: body.service, toDigest: svc.previous_digest, deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async updateService(req: Request, actor: HostingActor, id: number, service: string, body: AppServiceUpdate): Promise<AppServiceInfo> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const svc = effectiveOf(stack)?.services.find((s) => s.name === service);
    if (!svc) throw new AppError(404, `Service ${service} not found`, 'serviceNotFound');
    if (body.excludedFromUpdates !== undefined) {
      const n = await db('app_services').where({ stack_id: id, name: service }).update({ excluded_from_updates: body.excludedFromUpdates, updated_at: db.fn.now() });
      if (!n) await db('app_services').insert({ stack_id: id, account_id: stack.account_id, name: service, image: svc.image, excluded_from_updates: body.excludedFromUpdates });
    }
    await auditStack(req, stack, 'apps.stack.update', { service, excludedFromUpdates: body.excludedFromUpdates });
    emitStack(stack, 'updated');
    return this.serviceStatus(stack, svc);
  },

  /** Internal: AppServiceInfo of one service (inspect). */
  async serviceStatus(stack: StackRow, svc: EffectiveService): Promise<AppServiceInfo> {
    const row = await db('app_services').where({ stack_id: stack.id, name: svc.name }).first() as ServiceRow | undefined;
    const containers = await containersOrEmpty(stack);
    let ins: Docker.ContainerInspectInfo | null = null;
    const docker = containers.has(svc.name) ? await dockerFor(stack.node_id) : null;
    if (docker) { try { ins = await docker.getContainer(appContainer(stack.id, svc.name)).inspect(); } catch { ins = null; } }
    return serviceInfo(stack.id, svc, row, containers.get(svc.name), ins);
  },

  async sleep(req: Request, actor: HostingActor, id: number): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const row = await startAction(stack, 'sleep', 'user', { userId: actor.userId });
    await auditStack(req, stack, 'apps.stack.sleep', { deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async wake(req: Request, actor: HostingActor, id: number): Promise<AppDeployment> {
    const stack = await stackFor(actor, id, 'apps.manage');
    assertAccountUsable((await accountPlan(stack.account_id)).status);
    const row = await startAction(stack, 'wake', 'user', { userId: actor.userId });
    await auditStack(req, stack, 'apps.stack.wake', { deploymentId: row.id });
    return deploymentFor(actor, row);
  },

  async containerAction(req: Request, actor: HostingActor, id: number, service: string, action: AppContainerAction): Promise<AppServiceInfo> {
    const stack = await stackFor(actor, id, 'apps.manage');
    const svc = effectiveOf(stack)?.services.find((s) => s.name === service);
    if (!svc) throw new AppError(404, `Service ${service} not found`, 'serviceNotFound');
    if (isStackBusy(id)) throw new AppError(409, 'An action is running on this application', 'stackBusy');
    if (action !== 'stop') assertAccountUsable((await accountPlan(stack.account_id)).status);
    // SG1: never (re)start an app container where the segment policy does not filter it.
    if (action !== 'stop') await assertAccountSegmented(stack.account_id);
    const name = appContainer(id, service);
    let docker: Docker;
    try {
      docker = await appsDeps().docker(stack.node_id);
      const containers = await stackContainersOf(docker, id);
      if (!containers.has(service)) throw new AppError(404, 'This service has no container: deploy the application first', 'serviceNotFound');
      if (action !== 'stop' && unsafeBindSources(stackRefWith(stack, null), containers.get(service)!.Mounts).length > 0) {
        // Its binds are not an immutable deployment snapshot (created before them): Docker would re-resolve
        // a live source path at start. Recreated from the deployed snapshot by a restart action instead.
        const row = await startAction(stack, 'restart', 'user', { userId: actor.userId, services: [service] });
        await auditService.logReqAs(req, stack.tenant_id, 'apps.container.action', { resourceType: 'app_stack', resourcePath: String(id), details: { service, action, deploymentId: row.id } });
        emitStack(stack, 'updated');
        return this.serviceStatus(stack, svc);
      }
      if (action === 'start') {
        if (containers.get(service)!.State === 'paused') await unpauseContainer(docker, name);
        else await startContainer(docker, name);
      } else if (action === 'stop') await stopContainer(docker, name, 30);
      else await restartContainer(docker, name, 30);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw backend(`Container ${action} failed`, err);
    }
    await auditService.logReqAs(req, stack.tenant_id, 'apps.container.action', { resourceType: 'app_stack', resourcePath: String(id), details: { service, action } });
    emitStack(stack, 'updated');
    return this.serviceStatus(stack, svc);
  },

  async containerLogs(actor: HostingActor, id: number, service: string, q: { tail?: number; since?: string | null }): Promise<AppLogsResponse> {
    const stack = await stackFor(actor, id, 'read');
    if (!effectiveOf(stack)?.services.some((s) => s.name === service)) throw new AppError(404, `Service ${service} not found`, 'serviceNotFound');
    const tail = Math.min(LOG_TAIL_MAX, Math.max(1, q.tail ?? 200));
    let since: number | undefined;
    if (q.since) {
      const t = Date.parse(q.since);
      if (Number.isNaN(t)) throw new AppError(400, 'Invalid since', 'validation');
      since = Math.floor(t / 1000);
    }
    try {
      const docker = await appsDeps().docker(stack.node_id);
      const container = docker.getContainer(appContainer(id, service));
      const info = await container.inspect();
      const buf = await container.logs({ stdout: true, stderr: true, timestamps: true, tail, ...(since !== undefined ? { since } : {}), follow: false }) as unknown as Buffer;
      const lines = demuxBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), !!info.Config?.Tty);
      return { lines: lines.map((l) => ({ at: isoOfDockerTs(l.at) || null, stream: l.stream, text: l.text })), truncated: lines.length >= tail };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) throw new AppError(404, 'This service has no container', 'serviceNotFound');
      throw backend('Container logs unavailable', err);
    }
  },

  async containerInspect(actor: HostingActor, id: number, service: string): Promise<AppContainerInspect> {
    const stack = await stackFor(actor, id, 'read');
    // Values of the environment: apps.manage only (the right that reads the .env, getEnv); a reader
    // gets the names (M9). Secret values of the .env masked wherever they appear; an unreadable .env
    // (rotated panel secret) gives the names only too. Labels are interpolated from the .env as well:
    // their values are masked by the same rule for every caller, hidden when the .env cannot be read.
    const labelSecrets = inspectSecrets(stack);
    const secrets = actorCan(actor, 'apps.manage', { tenantId: stack.tenant_id, accountId: stack.account_id }) ? labelSecrets : null;
    if (!effectiveOf(stack)?.services.some((s) => s.name === service)) throw new AppError(404, `Service ${service} not found`, 'serviceNotFound');
    let info: Docker.ContainerInspectInfo;
    try {
      const docker = await appsDeps().docker(stack.node_id);
      info = await docker.getContainer(appContainer(id, service)).inspect();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) throw new AppError(404, 'This service has no container', 'serviceNotFound');
      throw backend('Container inspect unavailable', err);
    }
    const st = info.State as Docker.ContainerInspectInfo['State'] & { Health?: { Log?: Array<{ Start: string; ExitCode: number; Output: string }> } };
    const hc = info.HostConfig ?? {};
    const image = info.Config?.Image ?? null;
    return {
      name: (info.Name ?? '').replace(/^\//, ''),
      service,
      image,
      imageDigest: image && image.includes('@') ? image.slice(image.indexOf('@') + 1) : null,
      state: containerState(st?.Status),
      createdAt: iso((info as { Created?: string }).Created ?? null),
      startedAt: st?.StartedAt && !st.StartedAt.startsWith('0001') ? iso(st.StartedAt) : null,
      restartCount: (info as { RestartCount?: number }).RestartCount ?? 0,
      env: (info.Config?.Env ?? []).map((e) => {
        const eq = e.indexOf('=');
        const key = eq < 0 ? e : e.slice(0, eq);
        return { key, value: secrets === null ? null : inspectEnvValue(key, eq < 0 ? '' : e.slice(eq + 1), secrets) };
      }),
      envValuesHidden: secrets === null,
      mounts: (info.Mounts ?? []).map((m) => ({
        kind: m.Type === 'bind' ? 'bind' as const : m.Type === 'tmpfs' ? 'tmpfs' as const : 'volume' as const,
        // Host paths are never shown to a client (A6): only the stack-relative part.
        source: m.Type === 'bind' ? (m.Source ?? '').replace(/^.*\/apps\/\d+\//, '') : (m as { Name?: string }).Name ?? m.Source ?? '',
        target: m.Destination ?? '',
        readOnly: m.RW === false,
      })),
      networks: Object.entries(info.NetworkSettings?.Networks ?? {}).map(([name, ep]) => ({
        name, ip: (ep as { IPAddress?: string }).IPAddress || null, aliases: (ep as { Aliases?: string[] | null }).Aliases ?? [],
      })),
      labels: inspectLabels(info.Config?.Labels ?? {}, labelSecrets),
      labelValuesHidden: labelSecrets === null,
      limits: {
        cpus: hc.NanoCpus ? hc.NanoCpus / 1e9 : null,
        memoryMb: hc.Memory ? Math.round(hc.Memory / 1048576) : null,
        pids: hc.PidsLimit ?? null,
      },
      capAdd: hc.CapAdd ?? [],
      healthLog: (st?.Health?.Log ?? []).slice(-10).map((l) => ({ at: l.Start, exitCode: l.ExitCode, output: l.Output.slice(0, 2000) })),
    };
  },

  async resources(actor: HostingActor, accountId: number): Promise<AppResourceSummary> {
    const account = await loadAccount(actor, accountId, 'read');
    const plan = await accountPlan(account.id);
    const used = await otherStacksUsage(account.id, null);
    const policy = await appPolicyService.effective(account.tenant_id);
    return {
      accountId: account.id,
      limits: {
        stacks: plan.limits.maxAppStacks ?? null, containers: plan.limits.maxAppContainers ?? null, cpus: plan.limits.appsCpuCores ?? null,
        memoryMb: plan.limits.appsMemoryMb ?? null, pidsPerContainer: plan.limits.appsPidsPerContainer,
      },
      used: { stacks: used.stacks, containers: used.containers, cpus: used.cpus, memoryMb: used.memoryMb },
      build: policy.allowBuild && plan.limits.appsBuild === true,
      console: policy.allowConsole && plan.limits.appsConsole === true,
    };
  },

  // ── internal API (other modules — signatures frozen) ──
  /** proxy-hosts: target of a proxy host / route / stream; null when the stack or the service does not exist. */
  async targetInfo(stackId: number, service: string): Promise<AppTargetInfo | null> {
    if (!Number.isInteger(stackId) || stackId <= 0) return null;
    const stack = await loadStackRow(stackId);
    if (!stack) return null;
    const svc = effectiveOf(stack)?.services.find((s) => s.name === service);
    if (!svc) return null;
    const sleep = sleepPolicyOf(stack);
    return {
      stackId, accountId: stack.account_id, tenantId: stack.tenant_id, nodeId: stack.node_id, service,
      alias: appServiceAlias(stackId, service), exposedPorts: svc.exposedPorts, status: stack.status, sleeping: stack.status === 'sleeping',
      onFront: svc.exposedPorts.length > 0 && svc.networks.length > 0, sleepEnabled: sleep.enabled, wakingPageId: sleep.wakingPageId, wakeEtaSec: wakeEtaSec(stackId),
    };
  },

  /** proxy-hosts / monitoring: label + ownership of a stack; null when missing. */
  async stackSummary(stackId: number): Promise<AppStackSummary | null> {
    if (!Number.isInteger(stackId) || stackId <= 0) return null;
    const s = await loadStackRow(stackId);
    return s ? { id: s.id, accountId: s.account_id, tenantId: s.tenant_id, name: s.name, displayName: s.display_name, status: s.status } : null;
  },

  /** monitoring-automation (stats): containers of a stack. */
  async stackContainers(stackId: number): Promise<Array<{ service: string; container: string }>> {
    const s = await loadStackRow(stackId);
    if (!s) return [];
    return (effectiveOf(s)?.services ?? []).map((svc) => ({ service: svc.name, container: appContainer(stackId, svc.name) }));
  },

  /** monitoring-automation (workflow action restart-app): restarts (all / some) services; trigger 'workflow'. */
  async restartForWorkflow(stackId: number, services: string[] | null): Promise<{ deploymentId: number }> {
    const stack = await loadStackRow(stackId);
    if (!stack) throw new AppError(404, 'Application not found', 'notFound');
    const known = new Set((effectiveOf(stack)?.services ?? []).map((s) => s.name));
    const wanted = services?.length ? services.filter((s) => known.has(s)) : null;
    if (services?.length && !wanted!.length) throw new AppError(404, 'Service not found', 'serviceNotFound');
    const row = await startAction(stack, 'restart', 'workflow', { userId: null, services: wanted });
    return { deploymentId: row.id };
  },

  /** A proxied request reached a sleeping stack (edge log): wake it. Never throws. */
  wakeForRequest(stackId: number): void {
    try {
      sleepManager.wakeForRequest(stackId);
    } catch (err) {
      logger.warn({ err: errText(err), stackId }, 'apps: wakeForRequest failed');
    }
  },

  /** Settings section `apps` changed (hostingSettings.routes). Never throws. */
  settingsChanged(): void {
    try {
      appsWorker.settingsChanged();
    } catch { /* never throws */ }
  },

  // ── worker (workers/index.ts): reconcile loop, git poll, digest checks / auto-updates, sleep, retention ──
  start(): void {
    try { appsWorker.start(); } catch (err) { logger.error({ err: errText(err) }, 'apps worker failed to start'); }
  },
  stop(): void {
    try { appsWorker.stop(); } catch { /* never throws */ }
  },
};

