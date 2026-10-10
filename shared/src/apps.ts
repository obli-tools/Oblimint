import type { ContainerState } from './hosting';

// =============================================================================
// Oblimint — P4b Docker applications per hosting account (docs/P4b-PLAN.md
// §5, §6.1). ARCHITECT FILE (frozen during the phase). Module apps-core
// implements the server side, ui-apps the client.
//
// A "stack" = one compose project of ONE hosting account. The panel parses,
// VALIDATES and REWRITES the compose (no privileged, no host namespaces, no
// devices, no docker.sock, volumes under the account tree, cap_add allow-list,
// forced security_opt, plan limits, image policy, ports never published) and
// deploys it itself through the Docker API (no `docker compose` CLI).
// =============================================================================

export type AppSourceType = 'editor' | 'git' | 'zip' | 'catalog';

/**
 * draft      saved, never deployed;          deploying  an action is running;
 * running    every service up;               partial    some services down / unhealthy;
 * stopped    stopped on purpose;             sleeping   stopped by the idle policy (woken by a request);
 * error      last action failed;             deleting   teardown in progress.
 */
export type AppStackStatus = 'draft' | 'deploying' | 'running' | 'partial' | 'stopped' | 'sleeping' | 'error' | 'deleting';
export type AppDesiredState = 'running' | 'stopped';

export interface AppGitSource {
  /** https:// URL only (no credentials inside: the token is stored sealed apart). */
  repoUrl: string;
  branch: string;
  /** Path of the compose file inside the repository (default docker-compose.yml). */
  composePath: string;
  hasToken: boolean;
  /** Build the services that declare `build:` (plan appsBuild + tenant policy). */
  build: boolean;
  /** Poll interval (s, ≥ settings apps.gitPollMinSec); null = no polling (manual pull only). */
  pollIntervalSec: number | null;
  /** Redeploy automatically when a new commit is seen (respects the stack maintenance window). */
  autoDeploy: boolean;
  lastCommit: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface AppGitSourceInput {
  repoUrl: string;
  branch?: string;
  composePath?: string;
  /** undefined = keep, null = remove, string = replace (sealed, never returned). */
  token?: string | null;
  build?: boolean;
  pollIntervalSec?: number | null;
  autoDeploy?: boolean;
}

export interface AppCatalogSource {
  templateSlug: string;
  templateVersion: string;
  /** Non-secret values only (secret fields live in the sealed .env). */
  values: Record<string, string | number | boolean>;
}

export interface AppUpdatePolicy {
  /** Apply image updates automatically (inside the maintenance window when one is set). */
  autoUpdate: boolean;
  /** Digest check interval (minutes, ≥ settings apps.updateCheckMinMinutes). */
  checkIntervalMin: number;
  /** maintenance_windows.id (module monitoring-automation); null = the account / platform default window, or any time. */
  maintenanceWindowId: number | null;
  notify: boolean;
}

export interface AppSleepPolicy {
  enabled: boolean;
  /** Idle time (no proxied request) before sleeping. */
  idleMinutes: number;
  mode: 'stop' | 'pause';
  /** Max wait shown by the waking page before an error. */
  wakeTimeoutSec: number;
  /** HTTP path probed on the proxied service before the stack counts as awake (null = TCP connect). */
  readyPath: string | null;
  /** custom_pages.id of the waking page (null = platform default). */
  wakingPageId: number | null;
}

export const DEFAULT_APP_UPDATE_POLICY: AppUpdatePolicy = { autoUpdate: false, checkIntervalMin: 360, maintenanceWindowId: null, notify: true };
export const DEFAULT_APP_SLEEP_POLICY: AppSleepPolicy = {
  enabled: false, idleMinutes: 30, mode: 'stop', wakeTimeoutSec: 120, readyPath: null, wakingPageId: null,
};

export interface AppStack {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  nodeId: number;
  /** Slug, unique per account: [a-z0-9][a-z0-9-]{0,30}. Docker names derive from the id, never from it. */
  name: string;
  displayName: string;
  description: string | null;
  sourceType: AppSourceType;
  status: AppStackStatus;
  /** Last error / warning, French label for a client (A6). */
  statusMessage: string | null;
  desiredState: AppDesiredState;
  serviceCount: number;
  runningCount: number;
  updateAvailable: boolean;
  catalog: { slug: string; name: string; icon: string } | null;
  lastDeployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppStackDetail extends AppStack {
  /** Compose as written by the user (or rendered from the catalog template / read from git). */
  composeYaml: string;
  /** Names of the .env variables (values are sealed: GET /apps/stacks/:id/env). */
  envKeys: string[];
  git: AppGitSource | null;
  catalogSource: AppCatalogSource | null;
  registryCredentialIds: number[];
  updatePolicy: AppUpdatePolicy;
  sleepPolicy: AppSleepPolicy;
  services: AppServiceInfo[];
  /** Validation of the current compose (null until first validated). */
  validation: ComposeValidationResult | null;
  /** Proxy hosts targeting this stack (module proxy-hosts, read). */
  proxyHosts: Array<{ id: number; name: string; domains: string[]; service: string; port: number }>;
}

export interface AppStackCreate {
  accountId: number;
  name: string;
  displayName?: string;
  description?: string | null;
  sourceType: AppSourceType;
  /** editor */
  composeYaml?: string;
  /** dotenv text (KEY=value lines), sealed. */
  env?: string;
  /** git */
  git?: AppGitSourceInput;
  /** catalog: values of the template fields (secret ones go to the sealed .env). */
  catalog?: { templateSlug: string; values: Record<string, string | number | boolean> };
  /** zip: create with sourceType 'zip' then POST /apps/stacks/:id/source/zip (application/zip body). */
  registryCredentialIds?: number[];
  updatePolicy?: Partial<AppUpdatePolicy>;
  sleepPolicy?: Partial<AppSleepPolicy>;
  /** Deploy right after creation (default true; ignored for 'zip' until the archive is uploaded). */
  deploy?: boolean;
}

export interface AppStackUpdate {
  displayName?: string;
  description?: string | null;
  /** editor / zip sources: new compose (git: read from the repository, refused here). */
  composeYaml?: string;
  /** Full replacement of the .env (dotenv text). */
  env?: string;
  git?: AppGitSourceInput;
  /** catalog: new values (secret fields: empty string = keep). */
  catalogValues?: Record<string, string | number | boolean>;
  registryCredentialIds?: number[];
  updatePolicy?: Partial<AppUpdatePolicy>;
  sleepPolicy?: Partial<AppSleepPolicy>;
}

/** GET /apps/stacks/:id/env (apps.manage, audited). */
export interface AppEnvResponse {
  env: string;
}

// ─── Compose validation / rewrite ────────────────────────────────────────────

export type ComposeIssueSeverity = 'error' | 'warning';

export type ComposeIssueCode =
  | 'yamlSyntax' | 'notAnObject' | 'noServices' | 'tooManyServices' | 'invalidServiceName' | 'invalidName'
  | 'privileged' | 'hostNetwork' | 'networkMode' | 'hostPid' | 'hostIpc' | 'hostUts' | 'userns' | 'cgroupParent'
  | 'devices' | 'dockerSocket' | 'absoluteBind' | 'bindOutsideStack' | 'symlinkInPath' | 'volumeDriver' | 'externalVolume'
  | 'externalNetwork' | 'capNotAllowed' | 'securityOptIgnored' | 'sysctls' | 'deviceCgroupRules' | 'gpus'
  | 'imageMissing' | 'imageNotAllowed' | 'registryNotAllowed' | 'buildNotAllowed' | 'buildContextOutsideStack'
  | 'portsNotPublished' | 'hostPortIgnored' | 'resourceDefaulted' | 'resourceCapped' | 'planCpuExceeded' | 'planMemoryExceeded'
  | 'planContainersExceeded' | 'pidsCapped' | 'ulimitCapped' | 'tmpfsSize' | 'shmSize' | 'replicas' | 'containerNameIgnored'
  | 'hostnameIgnored' | 'linksIgnored' | 'extraHostsPrivate' | 'dnsIgnored' | 'extendsNotSupported' | 'includeNotSupported'
  | 'envFileOutsideStack' | 'secretsFileOutsideStack' | 'configsFileOutsideStack' | 'unknownKey' | 'unsupportedKey'
  | 'interpolation' | 'missingVariable' | 'dependsCycle' | 'dependsUnknown' | 'restartPolicy' | 'loggingIgnored'
  | 'labelReserved' | 'stopGraceCapped' | 'readOnlyForced' | 'userRoot';

export interface ComposeIssue {
  severity: ComposeIssueSeverity;
  code: ComposeIssueCode;
  /** Service concerned (null = top level). */
  service: string | null;
  /** Dotted path in the compose, e.g. services.web.volumes[0]. */
  path: string;
  /** English fallback; the UI translates `apps.compose.issues.<code>` with `params`. */
  message: string;
  params?: Record<string, string | number>;
  /** 1-based line in the submitted YAML when known. */
  line?: number | null;
}

export interface EffectiveVolume {
  kind: 'volume' | 'bind' | 'tmpfs';
  /** volume: compose volume name; bind: path relative to the stack directory; tmpfs: ''. */
  source: string;
  target: string;
  readOnly: boolean;
}

export interface EffectiveService {
  name: string;
  /** Final image reference (null when built from source). */
  image: string | null;
  build: boolean;
  command: string[] | null;
  entrypoint: string[] | null;
  /** Ports the service listens on (from `ports:` / `expose:`): targets of proxy hosts / links, NEVER published on the host. */
  exposedPorts: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  volumes: EffectiveVolume[];
  /** Private networks of the stack the service joins (compose names). */
  networks: string[];
  /** Account fabrics joined: front = reachable by the edge (exposed ports), back = declared links (docs §4). */
  fabric: { front: boolean; back: boolean };
  capAdd: string[];
  user: string | null;
  readOnlyRootfs: boolean;
  limits: { cpus: number; memoryMb: number; pids: number };
  healthcheck: boolean;
  dependsOn: Array<{ service: string; condition: 'started' | 'healthy' | 'completed' }>;
  restart: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  envKeys: string[];
}

export interface EffectiveStackConfig {
  services: EffectiveService[];
  networks: Array<{ name: string; internal: boolean }>;
  volumes: string[];
  totals: { cpus: number; memoryMb: number; containers: number };
}

export interface ComposeValidationResult {
  /** No issue of severity 'error'. */
  ok: boolean;
  issues: ComposeIssue[];
  effective: EffectiveStackConfig | null;
  /** The rewritten compose (what the panel deploys), for the preview. Secrets masked. */
  effectiveYaml: string | null;
}

/** POST /apps/validate */
export interface ComposeValidateRequest {
  accountId: number;
  composeYaml: string;
  env?: string;
  /** Existing stack (its sealed .env is used when env is absent, its own resources are excluded from the account sum). */
  stackId?: number | null;
}

// ─── Services / containers ───────────────────────────────────────────────────

export interface AppServiceInfo {
  name: string;
  image: string | null;
  containerName: string;
  state: ContainerState;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  exposedPorts: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  currentDigest: string | null;
  latestDigest: string | null;
  updateAvailable: boolean;
  excludedFromUpdates: boolean;
  /** Digest before the last update (rollback target), null = none. */
  previousDigest: string | null;
  startedAt: string | null;
  restartCount: number;
  limits: { cpus: number; memoryMb: number; pids: number } | null;
}

export interface AppServiceUpdate {
  excludedFromUpdates?: boolean;
}

export type AppContainerAction = 'start' | 'stop' | 'restart';

export interface AppContainerInspect {
  name: string;
  service: string;
  image: string | null;
  imageDigest: string | null;
  state: ContainerState;
  createdAt: string | null;
  startedAt: string | null;
  restartCount: number;
  /** Values of variables whose name looks secret (PASSWORD, SECRET, TOKEN, KEY…) are null. */
  env: Array<{ key: string; value: string | null }>;
  mounts: Array<{ kind: 'volume' | 'bind' | 'tmpfs'; source: string; target: string; readOnly: boolean }>;
  networks: Array<{ name: string; ip: string | null; aliases: string[] }>;
  labels: Record<string, string>;
  limits: { cpus: number | null; memoryMb: number | null; pids: number | null };
  capAdd: string[];
  healthLog: Array<{ at: string; exitCode: number; output: string }>;
}

/** GET /apps/stacks/:id/containers/:service/logs */
export interface AppLogsResponse {
  lines: Array<{ at: string | null; stream: 'stdout' | 'stderr'; text: string }>;
  truncated: boolean;
}

// ─── Deployments ─────────────────────────────────────────────────────────────

export type AppDeploymentAction =
  | 'deploy' | 'redeploy' | 'recreate' | 'pull' | 'start' | 'stop' | 'restart' | 'down'
  | 'update' | 'rollback' | 'sleep' | 'wake' | 'delete';
export type AppDeploymentTrigger = 'user' | 'git' | 'auto-update' | 'rollback' | 'workflow' | 'wake' | 'sleep' | 'catalog' | 'system';
export type AppDeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Actions of POST /apps/stacks/:id/actions. */
export type AppUserAction = 'deploy' | 'redeploy' | 'recreate' | 'pull' | 'start' | 'stop' | 'restart' | 'down';

export interface AppActionRequest {
  action: AppUserAction;
  /** redeploy / deploy of a git source: rebuild the `build:` services. */
  build?: boolean;
}

export interface AppDeployment {
  id: number;
  stackId: number;
  action: AppDeploymentAction;
  trigger: AppDeploymentTrigger;
  status: AppDeploymentStatus;
  commitSha: string | null;
  userName: string | null;
  /** service → image digest deployed. */
  images: Record<string, string>;
  /** A rollback to this deployment is possible (its compose snapshot + images are known). */
  canRollback: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AppDeploymentDetail extends AppDeployment {
  /** Live / final output (capped, secrets never written). */
  log: string[];
  effectiveYaml: string | null;
}

export interface AppRollbackRequest {
  deploymentId: number;
}

export interface AppStackDeleteRequest {
  confirm: string;
  /** Also delete the volume directories (data). Default false: volumes are kept 7 days (tombstone) then purged. */
  removeVolumes?: boolean;
}

// ─── Updates (digest) ────────────────────────────────────────────────────────

export interface AppUpdateCheck {
  stackId: number;
  checkedAt: string;
  services: Array<{
    service: string;
    image: string | null;
    currentDigest: string | null;
    latestDigest: string | null;
    updateAvailable: boolean;
    error: string | null;
  }>;
}

export interface AppUpdateApplyRequest {
  /** Services to update (default: every service with an update, not excluded). */
  services?: string[];
}

export interface AppImageRollbackRequest {
  service: string;
}

// ─── Registry credentials ────────────────────────────────────────────────────

export interface AppRegistryCredential {
  id: number;
  tenantId: number;
  accountId: number;
  /** Registry host (docker.io, ghcr.io, registry.example.com:5000). */
  registry: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRegistryCredentialInput {
  accountId: number;
  registry: string;
  username: string;
  /** Password / token, sealed (secretBox 'apps'), never returned. */
  password: string;
}

export interface AppRegistryCredentialUpdate {
  username?: string;
  password?: string;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const APP_TEMPLATE_CATEGORIES = ['cms', 'productivity', 'devtools', 'security', 'monitoring', 'automation', 'database', 'media', 'obli', 'other'] as const;
export type AppTemplateCategory = typeof APP_TEMPLATE_CATEGORIES[number];

export type AppTemplateFieldType = 'string' | 'password' | 'number' | 'boolean' | 'select' | 'email' | 'url' | 'domain';

export interface AppTemplateField {
  /** Variable name in the template compose (${KEY}) and in the .env. */
  key: string;
  /** i18n key (ui) + English fallback. */
  labelKey: string | null;
  label: string;
  description: string | null;
  type: AppTemplateFieldType;
  required: boolean;
  default: string | number | boolean | null;
  options: string[] | null;
  /** Generated at creation when empty. */
  generate: 'password' | 'hex32' | 'base64-32' | 'uuid' | null;
  /** Goes to the sealed .env, never shown back. */
  secret: boolean;
  pattern: string | null;
}

export interface AppTemplate {
  id: number;
  slug: string;
  name: string;
  /** lucide icon name or an /api/apps/catalog/:slug/icon URL. */
  icon: string;
  category: AppTemplateCategory;
  description: string;
  docsUrl: string | null;
  version: string;
  builtin: boolean;
  /** null = platform template (visible to every tenant), else tenant-only. */
  tenantId: number | null;
  enabled: boolean;
  fields: AppTemplateField[];
  /** Suggested proxy target (quick setup). */
  defaultProxy: { service: string; port: number } | null;
  /** Indicative minimum memory (MiB) shown before deploying. */
  minMemoryMb: number | null;
}

export interface AppTemplateDetail extends AppTemplate {
  composeYaml: string;
}

export interface AppTemplateInput {
  slug: string;
  name: string;
  icon?: string;
  category: AppTemplateCategory;
  description: string;
  docsUrl?: string | null;
  version: string;
  composeYaml: string;
  fields: AppTemplateField[];
  defaultProxy?: { service: string; port: number } | null;
  minMemoryMb?: number | null;
  enabled?: boolean;
  /** Platform admin only: null = platform template. Tenant staff: forced to its tenant. */
  tenantId?: number | null;
}

// ─── Resources / policy ──────────────────────────────────────────────────────

export interface AppResourceSummary {
  accountId: number;
  limits: { stacks: number | null; containers: number | null; cpus: number | null; memoryMb: number | null; pidsPerContainer: number };
  used: { stacks: number; containers: number; cpus: number; memoryMb: number };
  build: boolean;
  console: boolean;
}

export interface TenantAppPolicy {
  tenantId: number;
  /** null = platform default (settings apps.allowedRegistries). */
  allowedRegistries: string[] | null;
  /** Image patterns refused for this tenant (glob: docker.io/library/foo*, *:latest…), added to the platform deny list. */
  deniedImages: string[];
  /** null = platform default. */
  allowBuild: boolean | null;
  allowConsole: boolean | null;
  /** Proxy hosts towards external targets (P5 CWP migration needs it). null = false. */
  allowExternalProxyTargets: boolean | null;
  updatedAt: string | null;
}

export type TenantAppPolicyUpdate = Partial<Omit<TenantAppPolicy, 'tenantId' | 'updatedAt'>>;

// ─── Socket.io (payloads: ids only, clients refetch) ─────────────────────────

/** HostingSocketEvents.APP_UPDATED */
export interface AppUpdatedPayload {
  entity: 'stack' | 'deployment' | 'service' | 'template';
  id: number;
  stackId: number | null;
  accountId: number | null;
  action: 'created' | 'updated' | 'deleted';
}

/** HostingSocketEvents.APP_DEPLOY_OUTPUT (room `app-deploy:<deploymentId>`, joined with 'apps:deploy:subscribe'). */
export interface AppDeployOutputPayload {
  deploymentId: number;
  stackId: number;
  lines: string[];
  status: AppDeploymentStatus;
}

/**
 * Socket.io client → server events of the apps module (registered by
 * services/apps/socketHandlers.ts). Every handler re-checks access (read for
 * logs / deploy output, apps.console + platform / tenant / plan console flags
 * for the console) and acks `{ ok: false, code }` on refusal.
 */
export const AppSocketClientEvents = {
  /** { deploymentId } → joins the output room; ack { ok, lines } (backlog). */
  DEPLOY_SUBSCRIBE: 'apps:deploy:subscribe',
  DEPLOY_UNSUBSCRIBE: 'apps:deploy:unsubscribe',
  /** { stackId, service, tail } → 'apps:logs:line' { stackId, service, at, stream, text }. */
  LOGS_SUBSCRIBE: 'apps:logs:subscribe',
  LOGS_UNSUBSCRIBE: 'apps:logs:unsubscribe',
  /** { stackId, service, cols, rows } → ack { ok, sessionId }; then 'apps:console:data' { sessionId, data }. */
  CONSOLE_OPEN: 'apps:console:open',
  /** { sessionId, data } */
  CONSOLE_INPUT: 'apps:console:input',
  /** { sessionId, cols, rows } */
  CONSOLE_RESIZE: 'apps:console:resize',
  /** { sessionId } — server also emits 'apps:console:closed' { sessionId, reason }. */
  CONSOLE_CLOSE: 'apps:console:close',
} as const;

export const AppSocketServerEvents = {
  LOGS_LINE: 'apps:logs:line',
  CONSOLE_DATA: 'apps:console:data',
  CONSOLE_CLOSED: 'apps:console:closed',
} as const;
