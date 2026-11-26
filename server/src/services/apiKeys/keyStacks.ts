import type { Request } from 'express';
import type {
  ApiV1App, ApiV1AppChange, ApiV1AppDetail, ApiV1AppExecResult, ApiV1AppList, ApiV1AppLogs, ApiV1AppTemplate, AppContainerAction, AppDeployment, AppGitSourceInput,
  AppStack, AppStackDetail, AppStackStatus, AppStackUpdate, AppTemplate, AppTemplateCategory, AppTemplateDetail, PortBinding,
} from '@oblimint/shared';
import {
  APP_EXEC_ARGV_MAX, APP_EXEC_COMMAND_MAX, APP_EXEC_ENV_MAX, APP_EXEC_ENV_VALUE_MAX, APP_EXEC_OUTPUT_MAX, APP_EXEC_PER_APP, APP_EXEC_STDIN_MAX,
  APP_EXEC_TIMEOUT_DEFAULT, APP_EXEC_TIMEOUT_MAX,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { appContainer } from '../hosting/naming';
import { loadStack } from '../apps/access';
import { appDeleteParams, appsService } from '../apps/apps.service';
import { catalogService } from '../apps/catalog.service';
import { ENV_KEY_RE, stringifyDotenv } from '../apps/compose/dotenv';
import { secretValues } from '../apps/compose/validate';
import { assertConsoleAllowed } from '../apps/consoleAccess';
import { envMap, openEnv } from '../apps/context';
import { appsDeps } from '../apps/deps';
import { execOutputText, maskValues, runAppExec, type AppExecRaw } from '../apps/exec';
import { effectiveOf, envSecretKeysOf, type StackRow } from '../apps/rows';
import { registryCredentialService } from '../apps/registry.service';
import { assertNotContained } from '../containment/guard';
import { accountTarget, asKeyRequest, keyGated } from '../restrictions/targets';
import { requireScope, type ApiKeyContext } from './apiKeys.service';

// ─────────────────────────────────────────────────────────────────────────────
// Docker applications through an access key (scopes apps.read / apps.manage,
// opt-in: never in a preset): REST /api/v1/apps/stacks…, MCP list_apps,
// get_app, app_logs, list_app_catalog, deploy_app, update_app, redeploy_app,
// app_action, delete_app. No parallel path: every change goes through
// appsService (plan limits, apps disabled, tenant image / build policy,
// validation and rewrite of the compose, suspended account, segmentation,
// deploy jobs of the apps worker, socket events, audit) with the key's actor —
// a client-like actor holding apps.manage on the key's account only
// (SCOPE_CAP), so loadStack / loadAccount refuse anything else (404 for
// another account or tenant, no existence oracle); the creator must hold
// apps.manage himself (SCOPE_NEED) or the scope is inactive.
//
// Perimeter: the applications of the key's account, whatever its sites (an
// application belongs to the account, as its public ports: network.read).
// Gates, as the panel: a deploy that opens new public ports is
// app.port_publish (its ports, from a fresh validation, go to the job:
// anything else it would open is refused while protected); a deletion is
// app.delete (the key's owner confirms by default, migration 049). Never the
// interactive console (it stays in the panel), never ?force (the proxy hosts
// in front of an application are deleted first).
//
// Commands (scope apps.exec, opt-in on its own; exec(): REST POST
// /api/v1/apps/stacks/:id/exec, MCP exec_in_app): one command, not
// interactive, in a RUNNING container of the application (labels oblimint.*
// of the stack and the account checked, as the console does), as the image's
// user, bounded in time (≤ 300 s, the processes killed past it: apps/exec.ts)
// and in output (256 KiB per stream), 2 at once per application, the heavy
// operations' rate per key. The creator must hold apps.console (SCOPE_NEED;
// the key's actor gets apps.console only) and the panel's console conditions
// apply on every call (apps/consoleAccess.ts: platform, tenant policy, plan,
// suspended account; contained: 423). Gate app.exec (open by default): the
// argv, stdin and env are secretParams. Audited (apps.exec): the command with
// the .env secrets masked (≤ 1000 characters), service, duration, exit code;
// never the stdin nor an env value (their size and names only).
//
// Secrets: the .env values are sealed by the service and never returned
// (names only); the audit holds the names (service); no gate carries them; the
// container logs and the command output read by a key have the .env secret
// values masked.
// ─────────────────────────────────────────────────────────────────────────────

/** An application named by the caller: its id, or its name (slug). */
export type KeyAppRef = { id: number } | { name: string };

export type KeyAppSource = 'compose' | 'git' | 'catalog';

export interface KeyAppGit {
  repoUrl: string;
  branch?: string;
  composePath?: string;
  /** Access token of a private repository (sealed, never returned nor audited); null removes it. */
  token?: string | null;
  build?: boolean;
  autoDeploy?: boolean;
  pollIntervalSec?: number | null;
}

export interface KeyAppDeploy {
  name: string;
  displayName?: string;
  description?: string | null;
  source: KeyAppSource;
  /** source compose. */
  composeYaml?: string;
  /** Variables of the .env (sealed): name → value. */
  env?: Record<string, string>;
  git?: KeyAppGit;
  catalog?: { templateSlug: string; values?: Record<string, string | number | boolean> };
  registryCredentialIds?: number[];
  /** Deploy at once (default true). */
  deploy?: boolean;
}

export interface KeyAppUpdate {
  displayName?: string;
  description?: string | null;
  composeYaml?: string;
  /** The whole .env replaced (name → value). */
  env?: Record<string, string>;
  /** Variables set / replaced, the others kept (with envUnset; never with env). */
  envSet?: Record<string, string>;
  envUnset?: string[];
  git?: Partial<KeyAppGit>;
  catalogValues?: Record<string, string | number | boolean>;
  registryCredentialIds?: number[];
  /** Redeploy after the change (deploy when never deployed). */
  redeploy?: boolean;
}

export type KeyAppRedeployMode = 'redeploy' | 'recreate' | 'pull';

export const KEY_APP_LOG_TAIL_MAX = 500;
/** Largest compose a key sends (the panel's own bound, routes/apps.routes.ts). */
export const KEY_APP_COMPOSE_MAX = 256 * 1024;
export const KEY_APP_STATUSES = ['draft', 'deploying', 'running', 'partial', 'stopped', 'sleeping', 'error', 'deleting'] as const satisfies readonly AppStackStatus[];
const KEY_APP_LOG_LINE_MAX = 4000;
const KEY_APP_DEPLOYMENTS = 5;
const MASK = '********';

const notFound = () => new AppError(404, 'Application not found', 'notFound');

/** Reading the applications: apps.read, or apps.manage (who manages them sees them). */
function readable(ctx: ApiKeyContext): void {
  if (!ctx.scopes.has('apps.manage')) requireScope(ctx, 'apps.read');
}

/** A change of the account's applications: the scope, then nothing that opens a way in during a containment. */
async function writable(ctx: ApiKeyContext): Promise<void> {
  requireScope(ctx, 'apps.manage');
  await assertNotContained(ctx.accountId);
}

/** The id of an application of the key's account (404 elsewhere); the service checks it again with its own rule. */
export async function keyStackId(ctx: ApiKeyContext, ref: KeyAppRef): Promise<number> {
  const q = db('app_stacks').where({ account_id: ctx.accountId, tenant_id: ctx.tenantId });
  if ('id' in ref) {
    if (!Number.isInteger(ref.id) || ref.id <= 0) throw notFound();
    q.andWhere({ id: ref.id });
  } else {
    q.andWhere({ name: String(ref.name ?? '').trim().toLowerCase() });
  }
  const row = await q.first('id') as { id: number } | undefined;
  if (!row) throw notFound();
  return Number(row.id);
}

/** name → value of a caller's .env, as dotenv text (a name the .env cannot hold: 400). */
function envText(env: Record<string, string>): string {
  const entries = Object.entries(env);
  const bad = entries.find(([k]) => !ENV_KEY_RE.test(k));
  if (bad) throw new AppError(400, `Invalid variable name ${bad[0].slice(0, 64)}`, 'validation', { field: 'env' });
  const nonString = entries.find(([, v]) => typeof v !== 'string');
  if (nonString) throw new AppError(400, `The value of ${nonString[0]} must be a string`, 'validation', { field: 'env' });
  return stringifyDotenv(entries);
}

function gitInput(g: Partial<KeyAppGit>): AppGitSourceInput {
  return {
    ...(g.repoUrl !== undefined ? { repoUrl: g.repoUrl } : {}),
    ...(g.branch !== undefined ? { branch: g.branch } : {}),
    ...(g.composePath !== undefined ? { composePath: g.composePath } : {}),
    ...(g.token !== undefined ? { token: g.token } : {}),
    ...(g.build !== undefined ? { build: g.build } : {}),
    ...(g.autoDeploy !== undefined ? { autoDeploy: g.autoDeploy } : {}),
    ...(g.pollIntervalSec !== undefined ? { pollIntervalSec: g.pollIntervalSec } : {}),
  } as AppGitSourceInput;
}

function appView(s: AppStack): ApiV1App {
  return {
    id: s.id, name: s.name, displayName: s.displayName, description: s.description, sourceType: s.sourceType, status: s.status, statusMessage: s.statusMessage,
    desiredState: s.desiredState, serviceCount: s.serviceCount, runningCount: s.runningCount, updateAvailable: s.updateAvailable,
    catalog: s.catalog ? { slug: s.catalog.slug, name: s.catalog.name } : null, lastDeployedAt: s.lastDeployedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

function detailView(s: AppStackDetail, deployments: AppDeployment[], bindings: PortBinding[]): ApiV1AppDetail {
  const urls = [...new Set(s.proxyHosts.flatMap((h) => h.domains))].sort().map((d) => `https://${d}/`);
  return {
    ...appView(s),
    composeYaml: s.composeYaml,
    envKeys: s.envKeys,
    git: s.git,
    catalogSource: s.catalogSource,
    registryCredentialIds: s.registryCredentialIds,
    services: s.services.map((v) => ({
      name: v.name, image: v.image, state: v.state, health: v.health, exposedPorts: v.exposedPorts, updateAvailable: v.updateAvailable,
      startedAt: v.startedAt, restartCount: v.restartCount, limits: v.limits,
    })),
    validation: s.validation ? { ok: s.validation.ok, issues: s.validation.issues } : null,
    publishedPorts: bindings.map((b) => ({ service: b.service, address: b.address, protocol: b.protocol, publicPort: b.publicPort, containerPort: b.containerPort, status: b.status })),
    proxyHosts: s.proxyHosts,
    urls,
    deployments,
  };
}

async function detailOf(ctx: ApiKeyContext, id: number): Promise<ApiV1AppDetail> {
  const s = await appsService.get(ctx.actor, id);
  const deps = await appsService.listDeployments(ctx.actor, id, { limit: KEY_APP_DEPLOYMENTS, offset: 0 });
  let bindings: PortBinding[] = [];
  try { bindings = await appsService.bindings(ctx.actor, id); } catch { /* public ports unavailable: none shown */ }
  return detailView(s, deps.items, bindings);
}

function templateView(t: AppTemplate | AppTemplateDetail, withCompose: boolean): ApiV1AppTemplate {
  return {
    slug: t.slug, name: t.name, category: t.category, description: t.description, docsUrl: t.docsUrl, version: t.version, fields: t.fields,
    defaultProxy: t.defaultProxy, minMemoryMb: t.minMemoryMb,
    ...(withCompose && 'composeYaml' in t ? { composeYaml: t.composeYaml } : {}),
  };
}

/** Values of the application's .env that must never reach a key in a log (Secret flags and secret-looking names). */
async function logSecrets(id: number): Promise<string[]> {
  try {
    const row = await db('app_stacks').where({ id }).first('env_sealed', 'env_secret_keys') as { env_sealed: string | null; env_secret_keys?: unknown } | undefined;
    return secretValues(envMap(openEnv(row?.env_sealed ?? null)), new Set(envSecretKeysOf(row ?? {})));
  } catch {
    return [];
  }
}

function maskLine(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of secrets) if (out.includes(v)) out = out.split(v).join(MASK);
  return out.length > KEY_APP_LOG_LINE_MAX ? `${out.slice(0, KEY_APP_LOG_LINE_MAX)}…` : out;
}

/** A command run in a container by a key (exec_in_app, POST …/exec). */
export interface KeyAppExec {
  service?: string | null;
  /** argv (run as is), or a string run by sh -c. */
  command: string | string[];
  /** Text written to the command's stdin, then EOF (≤ APP_EXEC_STDIN_MAX bytes). Never audited. */
  stdin?: string | null;
  timeoutSeconds?: number;
  /** Absolute path in the container (default: the image's WORKDIR). */
  workdir?: string | null;
  /** Variables of the command only (names [A-Za-z_][A-Za-z0-9_]*, never OBLIMINT_*). Never audited (names only). */
  env?: Record<string, string>;
}

/** A checked command: argv, the stdin bytes, the env. */
export interface KeyExecInput {
  argv: string[];
  /** command was a string, run by sh -c (argv[2]). */
  shell: boolean;
  stdin: Buffer | null;
  env: Array<[string, string]>;
  workdir: string | null;
  timeoutSeconds: number;
}

/** The command in the audit and the decider's text: at most this many characters. */
export const KEY_EXEC_AUDIT_COMMAND_MAX = 1000;

const execInvalid = (field: string, message: string) => new AppError(400, message, 'validation', { field });
const hasNul = (v: string) => v.includes('\u0000');

/** Checks and normalizes a command (400 validation with details.field). Exported for tests. */
export function execInput(body: KeyAppExec): KeyExecInput {
  let argv: string[];
  let shell = false;
  if (typeof body.command === 'string') {
    if (!body.command.trim()) throw execInvalid('command', 'command is empty');
    if (body.command.length > APP_EXEC_COMMAND_MAX) throw execInvalid('command', `command: at most ${APP_EXEC_COMMAND_MAX} characters`);
    argv = ['sh', '-c', body.command];
    shell = true;
  } else if (Array.isArray(body.command)) {
    argv = [...body.command];
    if (!argv.length || argv.length > APP_EXEC_ARGV_MAX) throw execInvalid('command', `command: 1 to ${APP_EXEC_ARGV_MAX} arguments`);
    if (argv.some((a) => typeof a !== 'string')) throw execInvalid('command', 'command: every argument is a string');
    if (!argv[0].trim()) throw execInvalid('command', 'command: the program (first argument) is empty');
    if (argv.reduce((n, a) => n + a.length, 0) > APP_EXEC_COMMAND_MAX) throw execInvalid('command', `command: at most ${APP_EXEC_COMMAND_MAX} characters in all`);
  } else {
    throw execInvalid('command', 'command: an array of arguments, or a string run by sh -c');
  }
  if (argv.some(hasNul)) throw execInvalid('command', 'command: no NUL character');
  let stdin: Buffer | null = null;
  if (body.stdin !== undefined && body.stdin !== null) {
    if (typeof body.stdin !== 'string') throw execInvalid('stdin', 'stdin: text');
    stdin = Buffer.from(body.stdin, 'utf8');
    if (stdin.length > APP_EXEC_STDIN_MAX) throw execInvalid('stdin', `stdin: at most ${APP_EXEC_STDIN_MAX} bytes`);
  }
  const env = Object.entries(body.env ?? {});
  if (env.length > APP_EXEC_ENV_MAX) throw execInvalid('env', `env: at most ${APP_EXEC_ENV_MAX} variables`);
  for (const [k, v] of env) {
    if (!ENV_KEY_RE.test(k)) throw execInvalid('env', `Invalid variable name ${k.slice(0, 64)}`);
    if (/^OBLIMINT_/i.test(k)) throw execInvalid('env', `${k}: the OBLIMINT_ variables are the panel's`);
    if (typeof v !== 'string' || v.length > APP_EXEC_ENV_VALUE_MAX || hasNul(v)) {
      throw execInvalid('env', `The value of ${k}: a string of at most ${APP_EXEC_ENV_VALUE_MAX} characters, without NUL`);
    }
  }
  let workdir: string | null = null;
  if (body.workdir !== undefined && body.workdir !== null && body.workdir !== '') {
    if (typeof body.workdir !== 'string' || !body.workdir.startsWith('/') || body.workdir.length > 1024 || hasNul(body.workdir)) {
      throw execInvalid('workdir', 'workdir: an absolute path in the container');
    }
    workdir = body.workdir;
  }
  const t = body.timeoutSeconds ?? APP_EXEC_TIMEOUT_DEFAULT;
  if (!Number.isInteger(t) || t < 1 || t > APP_EXEC_TIMEOUT_MAX) throw execInvalid('timeoutSeconds', `timeout: 1 to ${APP_EXEC_TIMEOUT_MAX} seconds`);
  return { argv, shell, stdin, env, workdir, timeoutSeconds: t };
}

/** sh-like quoting of one argument (display only). */
const quoteArg = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.split("'").join("'\\''")}'`);

/**
 * The command as the audit and the decider read it: the string of sh -c, or the argv quoted; the values of the
 * .env secrets (and of the command's own env) masked; at most KEY_EXEC_AUDIT_COMMAND_MAX characters. Exported for tests.
 */
export function execCommandText(input: Pick<KeyExecInput, 'argv' | 'shell' | 'env'>, secrets: readonly string[]): string {
  const raw = input.shell ? input.argv[2] : input.argv.map(quoteArg).join(' ');
  const masked = maskValues(raw, [...secrets, ...input.env.map(([, v]) => v).filter((v) => v.length >= 4)]);
  return masked.length > KEY_EXEC_AUDIT_COMMAND_MAX ? `${masked.slice(0, KEY_EXEC_AUDIT_COMMAND_MAX - 1)}…` : masked;
}

/** Commands running now, by application (every key together; one panel process). */
const execsByStack = new Map<number, number>();

/** Tests: the commands running in an application. */
export function runningExecs(stackId: number): number {
  return execsByStack.get(stackId) ?? 0;
}

/** The service a command runs in: the one named, or the only one of the application. */
function execService(stack: StackRow, wanted: string | null | undefined): string {
  const names = (effectiveOf(stack)?.services ?? []).map((v) => v.name);
  const service = wanted?.trim() || null;
  if (!service) {
    if (names.length !== 1) throw new AppError(400, `Name the service (${names.join(', ') || 'none deployed yet'})`, 'serviceRequired', { services: names });
    return names[0];
  }
  if (!names.includes(service)) throw new AppError(404, 'Service not found', 'serviceNotFound', { services: names });
  return service;
}

const notRunning = (service: string) => new AppError(409, `The container of ${service} is not running: start the application first`, 'containerNotRunning', { service });

/**
 * A deploy-like action (deploy, redeploy, recreate, pull) as the panel's Deploy: the public ports it would newly
 * open (fresh validation) pass the gate app.port_publish, and only those are approved for the job.
 */
async function gatedDeploy(ctx: ApiKeyContext, req: Request, id: number, action: 'deploy' | KeyAppRedeployMode, build?: boolean): Promise<AppDeployment> {
  const { stack, ports, keys } = await appsService.newPublishedPorts(ctx.actor, id);
  const run = () => appsService.action(asKeyRequest(req, ctx), ctx.actor, id, { action, ...(build !== undefined ? { build } : {}) }, { approvedPorts: keys });
  if (!ports.length) return run();
  return keyGated(ctx, req, {
    action: 'app.port_publish', target: accountTarget({ tenant_id: stack.tenant_id, id: stack.account_id }), params: { stackId: id, ports },
  }, run);
}

/** The action of a stack never deployed is « deploy ». */
async function deployAction(id: number, wanted: 'deploy' | KeyAppRedeployMode): Promise<'deploy' | KeyAppRedeployMode> {
  const row = await db('app_stacks').where({ id }).first('status') as { status: AppStackStatus } | undefined;
  return row?.status === 'draft' ? 'deploy' : wanted;
}

export const keyStacks = {
  /** The applications of the account, the plan's limits and usage, the registry credentials (never a password). */
  async list(ctx: ApiKeyContext, q: { status?: AppStackStatus | null; search?: string | null } = {}): Promise<ApiV1AppList> {
    readable(ctx);
    const [apps, resources, registries] = await Promise.all([
      appsService.list(ctx.actor, { accountId: ctx.accountId, status: q.status ?? null, search: q.search?.trim() || null }),
      appsService.resources(ctx.actor, ctx.accountId),
      registryCredentialService.list(ctx.actor, { accountId: ctx.accountId }),
    ]);
    return {
      apps: apps.filter((a) => a.accountId === ctx.accountId).map(appView),
      resources,
      registries: registries.filter((r) => r.accountId === ctx.accountId).map((r) => ({ id: r.id, registry: r.registry, username: r.username })),
    };
  },

  async get(ctx: ApiKeyContext, ref: KeyAppRef): Promise<ApiV1AppDetail> {
    readable(ctx);
    return detailOf(ctx, await keyStackId(ctx, ref));
  },

  /** A service's container output (tail ≤ 500 lines), or a deployment's log; the .env secret values masked. */
  async logs(ctx: ApiKeyContext, ref: KeyAppRef, q: { service?: string | null; deploymentId?: number | null; tail?: number; since?: string | null } = {}): Promise<ApiV1AppLogs> {
    readable(ctx);
    const id = await keyStackId(ctx, ref);
    const tail = Math.min(KEY_APP_LOG_TAIL_MAX, Math.max(1, Math.trunc(q.tail ?? 200) || 200));
    const secrets = await logSecrets(id);
    if (q.deploymentId) {
      const d = await appsService.getDeployment(ctx.actor, id, q.deploymentId);
      const lines = d.log.slice(-tail);
      return {
        appId: id, service: null, deploymentId: d.id, deploymentStatus: d.status, truncated: d.log.length > lines.length,
        lines: lines.map((text) => ({ at: null, stream: null, text: maskLine(text, secrets) })),
      };
    }
    let service = q.service?.trim() || null;
    if (!service) {
      const names = (await appsService.get(ctx.actor, id)).services.map((s) => s.name);
      if (names.length !== 1) throw new AppError(400, `Name the service (${names.join(', ') || 'none deployed yet'})`, 'serviceRequired', { services: names });
      service = names[0];
    }
    const r = await appsService.containerLogs(ctx.actor, id, service, { tail, since: q.since ?? null });
    return {
      appId: id, service, deploymentId: null, deploymentStatus: null, truncated: r.truncated,
      lines: r.lines.map((l) => ({ at: l.at, stream: l.stream, text: maskLine(l.text, secrets) })),
    };
  },

  /** The application catalog of the tenant (enabled templates); one template by slug with its compose. */
  async catalog(ctx: ApiKeyContext, q: { slug?: string | null; search?: string | null; category?: AppTemplateCategory | null } = {}): Promise<ApiV1AppTemplate[]> {
    readable(ctx);
    if (q.slug) return [templateView(await catalogService.get(ctx.actor, q.slug), true)];
    return (await catalogService.list(ctx.actor, { category: q.category ?? null, search: q.search?.trim() || null })).filter((t) => t.enabled).map((t) => templateView(t, false));
  },

  /**
   * Creates an application (compose, git or catalog) through the apps service, then deploys it through the
   * gate of the panel's Deploy (app.port_publish when it opens public ports). A 428 there leaves the
   * application created (draft): once approved, app_action / redeploy_app deploys it with the same request.
   */
  async deploy(ctx: ApiKeyContext, req: Request, body: KeyAppDeploy): Promise<ApiV1AppChange> {
    await writable(ctx);
    if (body.source === 'compose' && !body.composeYaml?.trim()) throw new AppError(400, 'composeYaml is required for a compose source', 'validation', { field: 'composeYaml' });
    if (body.source === 'git' && !body.git) throw new AppError(400, 'git is required for a git source', 'validation', { field: 'git' });
    if (body.source === 'catalog' && !body.catalog) throw new AppError(400, 'catalog is required for a catalog source', 'validation', { field: 'catalog' });
    const created = await appsService.create(asKeyRequest(req, ctx), ctx.actor, {
      accountId: ctx.accountId,
      name: body.name,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      sourceType: body.source === 'compose' ? 'editor' : body.source,
      ...(body.source === 'compose' ? { composeYaml: body.composeYaml } : {}),
      ...(body.env !== undefined ? { env: envText(body.env) } : {}),
      ...(body.source === 'git' && body.git ? { git: gitInput(body.git) } : {}),
      ...(body.source === 'catalog' && body.catalog ? { catalog: { templateSlug: body.catalog.templateSlug, values: body.catalog.values ?? {} } } : {}),
      ...(body.registryCredentialIds !== undefined ? { registryCredentialIds: body.registryCredentialIds } : {}),
      deploy: false,
    });
    let deployment: AppDeployment | null = null;
    if (body.deploy !== false) {
      try {
        deployment = await gatedDeploy(ctx, req, created.id, 'deploy');
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 428 && err.details && typeof err.details === 'object') {
          const pid = (err.details as { pendingActionId?: number }).pendingActionId;
          throw new AppError(428, `${err.message}: the application ${created.name} (#${created.id}) was created, its deploy waits`, err.code, {
            ...(err.details as Record<string, unknown>), appId: created.id, appName: created.name,
            next: `call wait_for_pending_action(${pid}), then app_action with app_id=${created.id} and action "deploy" (or approval_id=${pid})`,
          });
        }
        throw err;
      }
    }
    return { app: await detailOf(ctx, created.id), deployment };
  },

  /** Changes an application (compose, .env, git, catalog values, registries); redeploys it when asked. */
  async update(ctx: ApiKeyContext, req: Request, ref: KeyAppRef, body: KeyAppUpdate): Promise<ApiV1AppChange> {
    await writable(ctx);
    const id = await keyStackId(ctx, ref);
    if (body.env !== undefined && (body.envSet !== undefined || body.envUnset !== undefined)) {
      throw new AppError(400, 'env replaces the whole .env: give it alone, or envSet / envUnset', 'validation', { field: 'env' });
    }
    const patch: AppStackUpdate = {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.composeYaml !== undefined ? { composeYaml: body.composeYaml } : {}),
      ...(body.git !== undefined ? { git: gitInput(body.git) } : {}),
      ...(body.catalogValues !== undefined ? { catalogValues: body.catalogValues } : {}),
      ...(body.registryCredentialIds !== undefined ? { registryCredentialIds: body.registryCredentialIds } : {}),
    };
    if (body.env !== undefined) patch.env = envText(body.env);
    else if (body.envSet !== undefined || body.envUnset !== undefined) {
      const row = await db('app_stacks').where({ id }).first('env_sealed') as { env_sealed: string | null };
      const current = envMap(openEnv(row.env_sealed));
      for (const k of body.envUnset ?? []) current.delete(k);
      envText(body.envSet ?? {}); // names and values checked
      for (const [k, v] of Object.entries(body.envSet ?? {})) current.set(k, v);
      patch.env = stringifyDotenv(current);
    }
    await appsService.update(asKeyRequest(req, ctx), ctx.actor, id, patch);
    const deployment = body.redeploy ? await gatedDeploy(ctx, req, id, await deployAction(id, 'redeploy')) : null;
    return { app: await detailOf(ctx, id), deployment };
  },

  /**
   * Deploys again: redeploy (the current compose and images), recreate (containers recreated), pull (newer images
   * of the same tags); gitPull first fetches the repository of a git source. A never-deployed application: deploy.
   */
  async redeploy(ctx: ApiKeyContext, req: Request, ref: KeyAppRef, body: { mode?: KeyAppRedeployMode; gitPull?: boolean; build?: boolean } = {}): Promise<ApiV1AppChange & { commit?: string | null }> {
    await writable(ctx);
    const id = await keyStackId(ctx, ref);
    let commit: string | null | undefined;
    if (body.gitPull) commit = (await appsService.gitPull(asKeyRequest(req, ctx), ctx.actor, id, { deploy: false })).commit;
    const deployment = await gatedDeploy(ctx, req, id, await deployAction(id, body.mode ?? 'redeploy'), body.build);
    return { app: await detailOf(ctx, id), deployment, ...(commit !== undefined ? { commit } : {}) };
  },

  /** start / stop / restart the whole application (a deployment), or one service's container. */
  async action(ctx: ApiKeyContext, req: Request, ref: KeyAppRef, body: { action: AppContainerAction | 'deploy'; service?: string | null }): Promise<ApiV1AppChange> {
    await writable(ctx);
    const id = await keyStackId(ctx, ref);
    if (body.action === 'deploy') {
      if (body.service) throw new AppError(400, 'deploy acts on the whole application', 'validation', { field: 'service' });
      return { app: await detailOf(ctx, id), deployment: await gatedDeploy(ctx, req, id, await deployAction(id, 'redeploy')) };
    }
    if (body.service) {
      await appsService.containerAction(asKeyRequest(req, ctx), ctx.actor, id, body.service, body.action);
      return { app: await detailOf(ctx, id), deployment: null };
    }
    const deployment = await appsService.action(asKeyRequest(req, ctx), ctx.actor, id, { action: body.action });
    return { app: await detailOf(ctx, id), deployment };
  },

  /**
   * Runs one command in a running container of the application (scope apps.exec): the console's conditions
   * (consoleAccess.ts), the container of THIS stack only (labels), the gate app.exec (argv, stdin and env secret), 2 at
   * once per application; stdout / stderr apart, capped, the .env secrets masked; audited without stdin nor env values.
   */
  async exec(ctx: ApiKeyContext, req: Request, ref: KeyAppRef, body: KeyAppExec): Promise<ApiV1AppExecResult> {
    requireScope(ctx, 'apps.exec');
    await assertNotContained(ctx.accountId);
    const input = execInput(body);
    const id = await keyStackId(ctx, ref);
    // apps.console on the account (the key's only capability from this scope): 404 elsewhere, 403 without it.
    const stack = await loadStack(ctx.actor, id, 'apps.console') as StackRow;
    await assertConsoleAllowed(stack);
    const service = execService(stack, body.service);
    const docker = await appsDeps().docker(stack.node_id);
    const name = appContainer(id, service);
    let info: Awaited<ReturnType<ReturnType<typeof docker.getContainer>['inspect']>>;
    try {
      info = await docker.getContainer(name).inspect();
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) throw notRunning(service);
      throw err;
    }
    // AP7: only a container of THIS stack and account (never a platform / other account container).
    const labels = info.Config?.Labels ?? {};
    if (labels['oblimint.app'] !== String(id) || labels['oblimint.role'] !== 'app' || labels['oblimint.account'] !== String(stack.account_id)) {
      throw new AppError(404, 'Service not found', 'serviceNotFound');
    }
    if (!info.State?.Running || info.State?.Paused) throw notRunning(service);

    const secrets = await logSecrets(id);
    const command = execCommandText(input, secrets);
    const envNames = input.env.map(([k]) => k);
    const shown = {
      name: stack.name, service, command, workdir: input.workdir, timeoutSeconds: input.timeoutSeconds, stdinBytes: input.stdin?.length ?? 0, envNames,
    };
    if ((execsByStack.get(id) ?? 0) >= APP_EXEC_PER_APP) {
      throw new AppError(429, `${APP_EXEC_PER_APP} commands already run in this application: wait for one to end`, 'execBusy', { max: APP_EXEC_PER_APP });
    }
    execsByStack.set(id, (execsByStack.get(id) ?? 0) + 1);
    try {
      return await keyGated(ctx, req, {
        action: 'app.exec', target: accountTarget({ tenant_id: stack.tenant_id, id: stack.account_id }),
        // The command shown masked; the exact argv, the stdin and the env enter the fingerprint only (never stored nor shown).
        params: shown,
        secretParams: { argv: input.argv, stdin: input.stdin ? input.stdin.toString('base64') : null, env: Object.fromEntries(input.env) },
        describe: () => `Exécuter une commande dans l’application Docker « ${stack.name} » (service ${service}) : ${command}`,
      }, async () => {
        const audit = (details: Record<string, unknown>) => auditService.logReqAs(asKeyRequest(req, ctx), stack.tenant_id, 'apps.exec', {
          resourceType: 'app_stack', resourcePath: String(id),
          details: {
            service, command, shell: input.shell, workdir: input.workdir, timeoutSeconds: input.timeoutSeconds, stdinBytes: shown.stdinBytes, envNames, ...details,
          },
        });
        let raw: AppExecRaw;
        try {
          raw = await runAppExec(docker, {
            container: name, argv: input.argv, stdin: input.stdin, env: input.env.map(([k, v]) => `${k}=${v}`), workdir: input.workdir,
            timeoutMs: input.timeoutSeconds * 1000, outputMax: APP_EXEC_OUTPUT_MAX,
          });
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          const gone = status === 404 || status === 409;
          await audit({ error: gone ? 'containerNotRunning' : 'execFailed' });
          if (gone) throw notRunning(service);
          throw new AppError(502, 'The command could not be started in the container', 'execFailed');
        }
        const stdout = execOutputText(raw.stdout, raw.stdoutTotal, APP_EXEC_OUTPUT_MAX, secrets);
        const stderr = execOutputText(raw.stderr, raw.stderrTotal, APP_EXEC_OUTPUT_MAX, secrets);
        await audit({
          exitCode: raw.exitCode, durationMs: raw.durationMs, timedOut: raw.timedOut, killed: raw.killed, stdoutBytes: raw.stdoutTotal, stderrBytes: raw.stderrTotal,
        });
        return {
          appId: id, service, exitCode: raw.exitCode, stdout: stdout.text, stderr: stderr.text,
          truncated: { stdout: stdout.truncated, stderr: stderr.truncated }, durationMs: raw.durationMs, timedOut: raw.timedOut, killed: raw.killed,
        };
      });
    } finally {
      const n = (execsByStack.get(id) ?? 1) - 1;
      if (n > 0) execsByStack.set(id, n); else execsByStack.delete(id);
    }
  },

  /**
   * Deletes an application: containers, networks, its volumes when removeVolumes (else kept 7 days). confirmName =
   * its name; never while a proxy host targets it (delete the hosts first). Gate app.delete: by default the key's
   * owner confirms it with his code (428).
   */
  async remove(ctx: ApiKeyContext, req: Request, ref: KeyAppRef, body: { confirmName: string; removeVolumes?: boolean }): Promise<{ deleted: true; id: number; name: string }> {
    await writable(ctx);
    const id = await keyStackId(ctx, ref);
    const del = { confirm: body.confirmName, removeVolumes: body.removeVolumes === true };
    const stack = await appsService.forDelete(ctx.actor, id, del);
    // Never ?force through a key: the request seen by the service carries no query.
    const kreq = Object.create(asKeyRequest(req, ctx)) as Request;
    Object.defineProperty(kreq, 'query', { value: {}, enumerable: true });
    await keyGated(ctx, req, {
      action: 'app.delete', target: accountTarget({ tenant_id: stack.tenant_id, id: stack.account_id }), params: appDeleteParams(stack, del),
    }, () => appsService.remove(kreq, ctx.actor, id, del));
    return { deleted: true, id, name: stack.name };
  },
};
