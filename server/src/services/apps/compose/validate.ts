import path from 'path';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Document } from 'yaml';
import type {
  ComposeIssue, ComposeIssueCode, ComposeIssueSeverity, ComposeValidationResult, EffectiveService, EffectiveStackConfig, EffectiveVolume,
} from '@oblimint/shared';
import { APP_CAP_ADD_ALLOWED } from '@oblimint/shared';
import { addressRange } from '../../usage/notifications/ssrf';
import { looksSecret } from './dotenv';
import { formatImageRef, imageDenied, parseImageRef, registryAllowed } from './image';
import { dockerfileImages } from './dockerfile';
import { interpolate, InterpolationError, type InterpolationProblem } from './interpolate';
import { MiB, parseCpus, parseDurationMs, parseSize, splitCommand } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// Compose VALIDATION + REWRITE (docs/P4b-PLAN.md §5.2 — normative). PURE (the
// only I/O is the injected SourceInspector, which lstat's paths of the stack
// tree without following any link). Invariant AP1: what reaches Docker is the
// ResolvedStack produced here, never the user's compose:
//   refusals   privileged, host / container / service network modes, pid,
//              ipc, uts, userns, cgroup*, devices, gpus, sysctls, runtime,
//              storage_opt, volumes_from, external_links, mac_address, the
//              Docker socket, absolute binds, binds outside the stack source,
//              symlinks in a bind path (R1), external volumes / networks /
//              secrets / configs, non-local volume drivers, extra_hosts to a
//              private address / host-gateway, cap_add outside the allow-list
//              (never NET_RAW / NET_ADMIN / SYS_* but SYS_CHROOT), images
//              outside the allowed registries or denied, build without right,
//              replicas > 1, include / extends, unknown keys;
//   rewrites   ports → exposedPorts (never published), container_name,
//              hostname, dns*, links, logging, security_opt, cap_drop,
//              oom_score_adj, platform ignored, restart always →
//              unless-stopped, stop_grace_period ≤ 120 s, tmpfs / shm ≤
//              256 MiB, ulimits.nofile ≤ 65536, oblimint.* / com.docker.*
//              labels removed, anonymous volumes → stack named volumes;
//   limits     per service (declared or settings defaults, capped by the node
//              and the plan), SUM over every stack of the account ≤ plan.
// Every issue carries the dotted path and the 1-based line of the YAML.
// ─────────────────────────────────────────────────────────────────────────────

export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const OBJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const COMPOSE_MAX_BYTES = 256 * 1024;
export const MAX_TMPFS_BYTES = 256 * MiB;
export const DEFAULT_TMPFS_BYTES = 64 * MiB;
export const MAX_SHM_BYTES = 256 * MiB;
export const MAX_NOFILE = 65536;
export const MAX_STOP_GRACE_SEC = 120;
export const MAX_PORTS_PER_SERVICE = 100;
/** Capabilities never granted whatever the settings say (SG3 + host escape). */
const NEVER_CAPS = new Set(['NET_RAW', 'NET_ADMIN', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_RAWIO', 'SYS_TIME', 'SYS_BOOT', 'SYS_RESOURCE',
  'SYS_NICE', 'SYS_PACCT', 'SYS_TTY_CONFIG', 'MKNOD', 'BPF', 'PERFMON', 'DAC_READ_SEARCH', 'LINUX_IMMUTABLE', 'IPC_LOCK', 'IPC_OWNER',
  'MAC_ADMIN', 'MAC_OVERRIDE', 'SYSLOG', 'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_CONTROL', 'AUDIT_READ', 'CHECKPOINT_RESTORE', 'LEASE', 'SETFCAP']);
const SOCKET_RE = /(?:docker|podman|containerd|crio|dockershim)\.sock/i;

export interface SourceInspector {
  /** What is at `rel` (POSIX, relative to the stack directory): every component lstat'ed, never followed. */
  kind(rel: string): 'file' | 'dir' | 'missing' | 'symlink';
  /** Text of a small regular file (env_file), null when missing / not a regular file / too large. */
  readText(rel: string): string | null;
}

export interface ComposeContext {
  /** .env of the stack (interpolation source + bare `environment: [KEY]` entries). */
  env: ReadonlyMap<string, string>;
  /** Directory relative paths resolve against, relative to the stack dir ('files', 'src', 'src/deploy'). */
  baseDir: string;
  /** Containment root of every relative path ('files' for an editor stack, 'src' otherwise). */
  rootDir: 'files' | 'src';
  /** null: paths are not checked on disk (preview without a tree): symlinks / missing files are judged at deploy. */
  inspector: SourceInspector | null;
  policy: {
    allowedRegistries: readonly string[];
    deniedImages: readonly string[];
    /** settings.allowBuild ∧ tenant policy ∧ plan.appsBuild. */
    allowBuild: boolean;
    /** settings capAddAllowed (⊂ APP_CAP_ADD_ALLOWED). */
    capAddAllowed: readonly string[];
  };
  maxServices: number;
  defaults: { memoryMb: number; cpus: number };
  /** Plan of the account (null = no total limit: the node ceiling still applies per container). */
  plan: { cpus: number | null; memoryMb: number | null; containers: number | null; pidsPerContainer: number };
  /** Node ceiling of one container. */
  node: { memoryMb: number; cpus: number };
  /** Resources of the account's OTHER stacks. */
  others: { cpus: number; memoryMb: number; containers: number };
}

export interface HealthSpec {
  test: string[];
  intervalMs: number | null;
  timeoutMs: number | null;
  retries: number | null;
  startPeriodMs: number | null;
  startIntervalMs: number | null;
}

/** Everything the spec builder needs for one service (values included: never persisted, never logged). */
export interface ResolvedService extends EffectiveService {
  /** Parsed image reference text (normalized), null when built. */
  imageRef: string | null;
  environment: Array<[string, string]>;
  health: HealthSpec | null;
  tmpfs: Array<{ target: string; sizeBytes: number; mode: string | null }>;
  shmSizeBytes: number | null;
  ulimits: Array<{ name: string; soft: number; hard: number }>;
  stopGraceSec: number | null;
  stopSignal: string | null;
  workingDir: string | null;
  labels: Record<string, string>;
  extraHosts: string[];
  init: boolean | null;
  tty: boolean;
  stdinOpen: boolean;
  groupAdd: string[];
  /** Extra aliases per private network (compose `networks.<n>.aliases`). */
  networkAliases: Record<string, string[]>;
  /** network_mode: none. */
  networkNone: boolean;
  buildSpec: { context: string; dockerfile: string; args: Record<string, string>; target: string | null } | null;
  restartMaxRetries: number | null;
}

export interface ResolvedStack {
  effective: EffectiveStackConfig;
  /** Services in dependency order (depends_on first). */
  services: ResolvedService[];
}

export interface ValidationOutput {
  result: ComposeValidationResult;
  /** null when the compose has errors. */
  resolved: ResolvedStack | null;
}

type Seg = string | number;
type Obj = Record<string, unknown>;

const ROOT_KEYS = new Set(['services', 'networks', 'volumes', 'configs', 'secrets', 'name', 'version']);

/** Service keys: value = how they are handled. */
const SERVICE_KEYS: Record<string, 'ok' | 'ignore' | 'refuse'> = {
  image: 'ok', build: 'ok', command: 'ok', entrypoint: 'ok', environment: 'ok', env_file: 'ok', expose: 'ok', ports: 'ok',
  volumes: 'ok', tmpfs: 'ok', networks: 'ok', depends_on: 'ok', healthcheck: 'ok', restart: 'ok', user: 'ok', working_dir: 'ok',
  read_only: 'ok', stop_signal: 'ok', stop_grace_period: 'ok', labels: 'ok', extra_hosts: 'ok', init: 'ok', tty: 'ok',
  stdin_open: 'ok', shm_size: 'ok', ulimits: 'ok', cap_add: 'ok', cap_drop: 'ok', deploy: 'ok', mem_limit: 'ok', cpus: 'ok',
  pids_limit: 'ok', configs: 'ok', secrets: 'ok', profiles: 'ok', group_add: 'ok', pull_policy: 'ok', network_mode: 'ok',
  privileged: 'ok', container_name: 'ignore', hostname: 'ignore', domainname: 'ignore', dns: 'ignore', dns_search: 'ignore',
  dns_opt: 'ignore', links: 'ignore', logging: 'ignore', security_opt: 'ignore', oom_score_adj: 'ignore', platform: 'ignore',
  mem_reservation: 'ignore', mem_swappiness: 'ignore', memswap_limit: 'ignore', cpu_shares: 'ignore', cpu_quota: 'ignore',
  cpu_period: 'ignore', cpuset: 'ignore', cpu_count: 'ignore', cpu_percent: 'ignore', annotations: 'ignore', develop: 'ignore',
  attach: 'ignore', scale: 'ok', mac_address: 'refuse', pid: 'ok', ipc: 'ok', uts: 'ok',
  userns_mode: 'ok', cgroup_parent: 'ok', cgroup: 'ok', devices: 'ok', device_cgroup_rules: 'ok', gpus: 'ok', sysctls: 'ok',
  runtime: 'refuse', storage_opt: 'refuse', volumes_from: 'refuse', external_links: 'refuse', isolation: 'refuse',
  credential_spec: 'refuse', oom_kill_disable: 'refuse', blkio_config: 'refuse', cpu_rt_runtime: 'refuse', cpu_rt_period: 'refuse',
  extends: 'ok', use_api_socket: 'ok', post_start: 'refuse', pre_stop: 'refuse', provider: 'refuse', models: 'refuse',
};

class Collector {
  issues: ComposeIssue[] = [];
  constructor(private readonly doc: Document | null, private readonly lc: LineCounter | null) {}

  add(severity: ComposeIssueSeverity, code: ComposeIssueCode, service: string | null, p: Seg[], message: string, params?: Record<string, string | number>): void {
    this.issues.push({ severity, code, service, path: pathText(p), message, ...(params ? { params } : {}), line: this.lineOf(p) });
  }
  error(code: ComposeIssueCode, service: string | null, p: Seg[], message: string, params?: Record<string, string | number>): void {
    this.add('error', code, service, p, message, params);
  }
  warn(code: ComposeIssueCode, service: string | null, p: Seg[], message: string, params?: Record<string, string | number>): void {
    this.add('warning', code, service, p, message, params);
  }
  get hasErrors(): boolean {
    return this.issues.some((i) => i.severity === 'error');
  }

  /** 1-based line of the deepest YAML node found on the path (best effort through aliases). */
  lineOf(p: Seg[]): number | null {
    if (!this.doc || !this.lc) return null;
    let cur: unknown = this.doc.contents;
    let best: { range?: [number, number, number] | null } | null = (cur as { range?: [number, number, number] }) ?? null;
    for (const seg of p) {
      if (isAlias(cur)) cur = cur.resolve(this.doc);
      if (isMap(cur)) {
        const pair = cur.items.find((it) => isScalar(it.key) && String(it.key.value) === String(seg));
        if (!pair) break;
        if (pair.key && (pair.key as { range?: unknown }).range) best = pair.key as typeof best;
        cur = pair.value;
        if (cur && (cur as { range?: unknown }).range && !isMap(cur) && !isSeq(cur)) best = cur as typeof best;
      } else if (isSeq(cur) && typeof seg === 'number') {
        cur = cur.items[seg];
        if (!cur) break;
        if ((cur as { range?: unknown }).range) best = cur as typeof best;
      } else break;
    }
    const offset = best?.range?.[0];
    return typeof offset === 'number' ? this.lc.linePos(offset).line : null;
  }
}

function pathText(p: Seg[]): string {
  let out = '';
  for (const s of p) out += typeof s === 'number' ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 'True' || v === 'yes' || v === 1;

/** Interpolates every string of the tree (x-* extension keys skipped). Errors → issues. */
function interpolateTree(value: unknown, env: ReadonlyMap<string, string>, c: Collector, p: Seg[], missing: Set<string>): unknown {
  if (typeof value === 'string') {
    const problems: InterpolationProblem[] = [];
    try {
      const out = interpolate(value, env, problems);
      for (const pr of problems) {
        if (pr.kind === 'missing' && !missing.has(pr.variable)) {
          missing.add(pr.variable);
          c.warn('missingVariable', serviceOf(p), p, pr.message, { variable: pr.variable });
        }
      }
      return out;
    } catch (err) {
      if (err instanceof InterpolationError) {
        if (err.problem.kind === 'required') c.error('missingVariable', serviceOf(p), p, err.problem.message, { variable: err.problem.variable });
        else c.error('interpolation', serviceOf(p), p, err.problem.message);
        return '';
      }
      throw err;
    }
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateTree(v, env, c, [...p, i], missing));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = k.startsWith('x-') ? v : interpolateTree(v, env, c, [...p, k], missing);
    return out;
  }
  return value;
}

function serviceOf(p: Seg[]): string | null {
  return p[0] === 'services' && typeof p[1] === 'string' ? p[1] : null;
}

/** Relative path (to the stack dir) of a compose-relative path, null when it escapes the root. */
function resolveRelative(ctx: ComposeContext, raw: string): string | null {
  const joined = path.posix.normalize(path.posix.join(ctx.baseDir, raw.replace(/\\/g, '/')));
  if (joined === ctx.rootDir || joined.startsWith(`${ctx.rootDir}/`)) return joined.replace(/\/$/, '');
  return null;
}

function isAbsoluteLike(s: string): boolean {
  return s.startsWith('/') || s.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

function isRelativeBind(s: string): boolean {
  return s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');
}

interface ParsedMount {
  type: 'volume' | 'bind' | 'tmpfs' | 'other';
  source: string | null;
  target: string | null;
  readOnly: boolean;
  explicitRw: boolean;
  tmpfsSize: number | null;
}

function parseMount(entry: unknown): ParsedMount | null {
  if (typeof entry === 'string') {
    const parts = entry.split(':');
    if (parts.length === 1) return { type: 'volume', source: null, target: parts[0], readOnly: false, explicitRw: false, tmpfsSize: null };
    const [source, target, mode = ''] = parts.length === 2 ? [parts[0], parts[1]] : [parts[0], parts[1], parts.slice(2).join(':')];
    const modes = mode.split(',').map((m) => m.trim());
    const type = isAbsoluteLike(source) || isRelativeBind(source) ? 'bind' : 'volume';
    return { type, source, target, readOnly: modes.includes('ro'), explicitRw: modes.includes('rw'), tmpfsSize: null };
  }
  if (isObj(entry)) {
    const t = asStr(entry.type) ?? 'volume';
    const type = t === 'volume' || t === 'bind' || t === 'tmpfs' ? t : 'other';
    const tmpfs = isObj(entry.tmpfs) ? parseSize(entry.tmpfs.size) : null;
    const ro = truthy(entry.read_only);
    return { type, source: asStr(entry.source), target: asStr(entry.target), readOnly: ro, explicitRw: entry.read_only === false, tmpfsSize: tmpfs };
  }
  return null;
}

function parsePortSpec(entry: unknown): { ports: Array<{ port: number; protocol: 'tcp' | 'udp' }>; published: boolean } | null {
  const proto = (s: string | null): 'tcp' | 'udp' | null => (s === null || s === 'tcp' ? 'tcp' : s === 'udp' ? 'udp' : null);
  const range = (s: string, protocol: 'tcp' | 'udp') => {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(s.trim());
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a || b - a >= MAX_PORTS_PER_SERVICE) return null;
    const out: Array<{ port: number; protocol: 'tcp' | 'udp' }> = [];
    for (let p = a; p <= b; p++) out.push({ port: p, protocol });
    return out;
  };
  if (typeof entry === 'number') return Number.isInteger(entry) && entry >= 1 && entry <= 65535 ? { ports: [{ port: entry, protocol: 'tcp' }], published: false } : null;
  if (typeof entry === 'string') {
    let s = entry.trim();
    let protocol: 'tcp' | 'udp' | null = 'tcp';
    const slash = s.lastIndexOf('/');
    if (slash >= 0) { protocol = proto(s.slice(slash + 1)); s = s.slice(0, slash); }
    if (!protocol) return null;
    s = s.replace(/^\[[^\]]*\]:/, 'ip:');
    const parts = s.split(':');
    const target = parts[parts.length - 1];
    const ports = range(target, protocol);
    return ports ? { ports, published: parts.length > 1 } : null;
  }
  if (isObj(entry)) {
    const protocol = proto(asStr(entry.protocol));
    const t = asStr(entry.target);
    if (!protocol || !t) return null;
    const ports = range(t, protocol);
    return ports ? { ports, published: entry.published !== undefined && entry.published !== null && entry.published !== '' } : null;
  }
  return null;
}

function listOrMap(v: unknown): Array<[string, string | null]> | null {
  if (Array.isArray(v)) {
    const out: Array<[string, string | null]> = [];
    for (const e of v) {
      const s = asStr(e);
      if (s === null) return null;
      const eq = s.indexOf('=');
      out.push(eq < 0 ? [s, null] : [s.slice(0, eq), s.slice(eq + 1)]);
    }
    return out;
  }
  if (isObj(v)) return Object.entries(v).map(([k, val]) => [k, val === null || val === undefined ? null : asStr(val) ?? JSON.stringify(val)]);
  return null;
}

function toArgv(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return splitCommand(v);
  if (Array.isArray(v)) return v.map((x) => asStr(x) ?? '');
  return null;
}

/** Validates + rewrites a compose for one account / stack. Never throws on user input. */
export function validateCompose(yamlText: string, ctx: ComposeContext): ValidationOutput {
  const fail = (c: Collector): ValidationOutput => ({ result: { ok: false, issues: c.issues, effective: null, effectiveYaml: null }, resolved: null });
  if (typeof yamlText !== 'string' || !yamlText.trim()) {
    const c = new Collector(null, null);
    c.error('noServices', null, [], 'The compose file is empty');
    return fail(c);
  }
  if (Buffer.byteLength(yamlText, 'utf8') > COMPOSE_MAX_BYTES) {
    const c = new Collector(null, null);
    c.error('yamlSyntax', null, [], `The compose file is larger than ${COMPOSE_MAX_BYTES / 1024} KiB`);
    return fail(c);
  }
  const lc = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter: lc, merge: true, uniqueKeys: true, prettyErrors: false, strict: true });
  const c = new Collector(doc, lc);
  if (doc.errors.length) {
    for (const e of doc.errors.slice(0, 20)) {
      c.issues.push({ severity: 'error', code: 'yamlSyntax', service: null, path: '', message: e.message.split('\n')[0].slice(0, 300), line: e.linePos?.[0]?.line ?? (e.pos ? lc.linePos(e.pos[0]).line : null) });
    }
    return fail(c);
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    c.error('yamlSyntax', null, [], (err as Error).message.slice(0, 300));
    return fail(c);
  }
  if (!isObj(raw)) {
    c.error('notAnObject', null, [], 'The compose file must be a mapping');
    return fail(c);
  }
  for (const key of Object.keys(raw)) {
    if (key.startsWith('x-') || ROOT_KEYS.has(key)) continue;
    if (key === 'include') c.error('includeNotSupported', null, [key], '`include` is not supported: put every service in one file');
    else c.error('unknownKey', null, [key], `Unknown top-level key "${key}"`, { key });
  }
  const tree = interpolateTree(raw, ctx.env, c, [], new Set()) as Obj;

  const services = tree.services;
  if (!isObj(services) || Object.keys(services).length === 0) {
    c.error('noServices', null, ['services'], 'The compose file declares no service');
    return fail(c);
  }

  // ── top-level networks / volumes / secrets / configs ──
  const declaredNetworks = new Map<string, { internal: boolean }>();
  if (tree.networks !== undefined && tree.networks !== null) {
    if (!isObj(tree.networks)) c.error('notAnObject', null, ['networks'], '`networks` must be a mapping');
    else for (const [name, def] of Object.entries(tree.networks)) {
      const p: Seg[] = ['networks', name];
      if (!OBJECT_NAME_RE.test(name)) { c.error('invalidName', null, p, `Invalid network name "${name}" (lowercase letters, digits, - and _)`, { name }); continue; }
      const d = isObj(def) ? def : {};
      if (truthy(d.external) || isObj(d.external)) { c.error('externalNetwork', null, [...p, 'external'], `Network "${name}" is external: only the stack's own networks are allowed`, { name }); continue; }
      const driver = asStr(d.driver);
      if (driver && driver !== 'bridge') { c.error('networkMode', null, [...p, 'driver'], `Network driver "${driver}" is not allowed (bridge only)`, { driver }); continue; }
      if (d.ipam !== undefined || d.driver_opts !== undefined) c.warn('unsupportedKey', null, p, `IPAM / driver options of "${name}" are ignored: the panel allocates the subnet`, { key: 'ipam' });
      declaredNetworks.set(name, { internal: truthy(d.internal) });
    }
  }
  const declaredVolumes = new Set<string>();
  if (tree.volumes !== undefined && tree.volumes !== null) {
    if (!isObj(tree.volumes)) c.error('notAnObject', null, ['volumes'], '`volumes` must be a mapping');
    else for (const [name, def] of Object.entries(tree.volumes)) {
      const p: Seg[] = ['volumes', name];
      if (!OBJECT_NAME_RE.test(name)) { c.error('invalidName', null, p, `Invalid volume name "${name}" (lowercase letters, digits, - and _)`, { name }); continue; }
      const d = isObj(def) ? def : {};
      if (truthy(d.external) || isObj(d.external)) { c.error('externalVolume', null, [...p, 'external'], `Volume "${name}" is external: only the stack's own volumes are allowed`, { name }); continue; }
      const driver = asStr(d.driver);
      if (driver && driver !== 'local') { c.error('volumeDriver', null, [...p, 'driver'], `Volume driver "${driver}" is not allowed (local only)`, { driver }); continue; }
      if (d.driver_opts !== undefined) { c.error('volumeDriver', null, [...p, 'driver_opts'], `Volume "${name}": driver options are not allowed (the panel stores volumes under the account tree)`, { name }); continue; }
      declaredVolumes.add(name);
    }
  }
  const fileObjects = (kind: 'secrets' | 'configs') => {
    const out = new Map<string, string>();
    const top = tree[kind];
    if (top === undefined || top === null) return out;
    const outsideCode: ComposeIssueCode = kind === 'secrets' ? 'secretsFileOutsideStack' : 'configsFileOutsideStack';
    if (!isObj(top)) { c.error('notAnObject', null, [kind], `\`${kind}\` must be a mapping`); return out; }
    for (const [name, def] of Object.entries(top)) {
      const p: Seg[] = [kind, name];
      const d = isObj(def) ? def : {};
      if (truthy(d.external) || isObj(d.external)) { c.error('unsupportedKey', null, [...p, 'external'], `${kind} "${name}" is external: not supported`, { name }); continue; }
      const file = asStr(d.file);
      if (!file) { c.error('unsupportedKey', null, p, `${kind} "${name}": only \`file:\` (relative to the stack source) is supported`, { key: kind }); continue; }
      if (isAbsoluteLike(file)) { c.error(outsideCode, null, [...p, 'file'], `${kind} "${name}": absolute paths are not allowed`, { name }); continue; }
      const rel = resolveRelative(ctx, file);
      if (!rel) { c.error(outsideCode, null, [...p, 'file'], `${kind} "${name}": the file must be inside the stack source`, { name }); continue; }
      if (ctx.inspector) {
        const k = ctx.inspector.kind(rel);
        if (k === 'symlink') { c.error('symlinkInPath', null, [...p, 'file'], `${kind} "${name}": a symbolic link is in the path`, { name }); continue; }
        if (k !== 'file') { c.error(outsideCode, null, [...p, 'file'], `${kind} "${name}": file not found in the stack source`, { name }); continue; }
      }
      out.set(name, rel);
    }
    return out;
  };
  const secretFiles = fileObjects('secrets');
  const configFiles = fileObjects('configs');

  // ── services ──
  const names = Object.keys(services);
  const active = names.filter((n) => {
    const s = services[n];
    return !(isObj(s) && Array.isArray(s.profiles) && s.profiles.length > 0);
  });
  if (active.length === 0) c.error('noServices', null, ['services'], 'Every service has a profile: nothing would be deployed');
  if (active.length > ctx.maxServices) c.error('tooManyServices', null, ['services'], `At most ${ctx.maxServices} services per stack`, { max: ctx.maxServices });

  const capAllowed = new Set(ctx.policy.capAddAllowed.filter((cap) => (APP_CAP_ADD_ALLOWED as readonly string[]).includes(cap) && !NEVER_CAPS.has(cap)));
  const resolved: ResolvedService[] = [];
  const usedNetworks = new Set<string>();
  const usedVolumes = new Set<string>();
  const anonVolumes: string[] = [];
  const declared: Array<{ name: string; cpus: number | null; memoryMb: number | null; p: Seg[] }> = [];

  for (const name of active) {
    const p: Seg[] = ['services', name];
    const s = services[name];
    if (!SERVICE_NAME_RE.test(name)) { c.error('invalidServiceName', name, p, `Invalid service name "${name}" (lowercase letters, digits, - and _; 63 max)`, { name }); continue; }
    if (!isObj(s)) { c.error('notAnObject', name, p, `Service "${name}" must be a mapping`); continue; }

    for (const key of Object.keys(s)) {
      if (key.startsWith('x-')) continue;
      const how = SERVICE_KEYS[key];
      if (how === undefined) c.error('unknownKey', name, [...p, key], `Unknown key "${key}" in service "${name}"`, { key });
      else if (how === 'refuse') c.error('unsupportedKey', name, [...p, key], `"${key}" is not allowed in a hosted application`, { key });
    }
    if (s.extends !== undefined) c.error('extendsNotSupported', name, [...p, 'extends'], '`extends` is not supported: inline the configuration');
    if (truthy(s.privileged)) c.error('privileged', name, [...p, 'privileged'], 'Privileged containers are not allowed');
    if (s.use_api_socket !== undefined && truthy(s.use_api_socket)) c.error('dockerSocket', name, [...p, 'use_api_socket'], 'The Docker API socket is never given to an application');
    let networkNone = false;
    if (s.network_mode !== undefined && s.network_mode !== null) {
      const nm = asStr(s.network_mode) ?? '';
      if (nm === 'none') networkNone = true;
      else if (nm === 'host') c.error('hostNetwork', name, [...p, 'network_mode'], 'The host network is not allowed');
      else c.error('networkMode', name, [...p, 'network_mode'], `network_mode "${nm}" is not allowed (only "none")`, { mode: nm });
    }
    if (s.pid !== undefined && s.pid !== null) c.error('hostPid', name, [...p, 'pid'], 'Sharing a PID namespace is not allowed');
    if (s.ipc !== undefined && s.ipc !== null && asStr(s.ipc) !== 'private') c.error('hostIpc', name, [...p, 'ipc'], 'Sharing an IPC namespace is not allowed');
    if (s.uts !== undefined && s.uts !== null) c.error('hostUts', name, [...p, 'uts'], 'Sharing the UTS namespace is not allowed');
    if (s.userns_mode !== undefined && s.userns_mode !== null) c.error('userns', name, [...p, 'userns_mode'], 'userns_mode is not allowed');
    if (s.cgroup_parent !== undefined) c.error('cgroupParent', name, [...p, 'cgroup_parent'], 'cgroup_parent is not allowed');
    if (s.cgroup !== undefined) c.error('cgroupParent', name, [...p, 'cgroup'], 'cgroup is not allowed');
    if (s.devices !== undefined && !(Array.isArray(s.devices) && s.devices.length === 0)) c.error('devices', name, [...p, 'devices'], 'Host devices are not allowed');
    if (s.device_cgroup_rules !== undefined) c.error('deviceCgroupRules', name, [...p, 'device_cgroup_rules'], 'device_cgroup_rules is not allowed');
    if (s.gpus !== undefined) c.error('gpus', name, [...p, 'gpus'], 'GPUs are not available to hosted applications');
    if (s.sysctls !== undefined && !(isObj(s.sysctls) && Object.keys(s.sysctls).length === 0) && !(Array.isArray(s.sysctls) && s.sysctls.length === 0)) {
      c.error('sysctls', name, [...p, 'sysctls'], 'sysctls are not allowed');
    }

    // ignored keys (rewrite warnings)
    if (s.container_name !== undefined) c.warn('containerNameIgnored', name, [...p, 'container_name'], 'container_name is ignored: the panel names the containers');
    if (s.hostname !== undefined || s.domainname !== undefined) c.warn('hostnameIgnored', name, [...p, s.hostname !== undefined ? 'hostname' : 'domainname'], 'hostname is ignored');
    for (const k of ['dns', 'dns_search', 'dns_opt'] as const) if (s[k] !== undefined) c.warn('dnsIgnored', name, [...p, k], `${k} is ignored: containers use the Docker DNS`);
    if (s.links !== undefined) c.warn('linksIgnored', name, [...p, 'links'], 'links are ignored: services reach each other by name on the stack networks');
    if (s.logging !== undefined) c.warn('loggingIgnored', name, [...p, 'logging'], 'logging is ignored: the panel sets the log driver');
    if (s.security_opt !== undefined) c.warn('securityOptIgnored', name, [...p, 'security_opt'], 'security_opt is ignored: no-new-privileges and the platform seccomp profile are enforced');
    for (const k of ['oom_score_adj', 'platform', 'mem_reservation', 'mem_swappiness', 'memswap_limit', 'cpu_shares', 'cpu_quota', 'cpu_period', 'cpuset', 'cpu_count', 'cpu_percent'] as const) {
      if (s[k] !== undefined) c.warn('unsupportedKey', name, [...p, k], `${k} is ignored`, { key: k });
    }

    // replicas / scale
    const deploy = isObj(s.deploy) ? s.deploy : {};
    const replicas = deploy.replicas ?? s.scale;
    if (replicas !== undefined && replicas !== null && Number(replicas) > 1) {
      c.error('replicas', name, [...p, deploy.replicas !== undefined ? 'deploy' : 'scale'], 'Several replicas of a service are not supported (one container per service)', { replicas: Number(replicas) });
    }
    const reservations = isObj(deploy.resources) && isObj(deploy.resources.reservations) ? deploy.resources.reservations : null;
    if (reservations && reservations.devices !== undefined) c.error('devices', name, [...p, 'deploy', 'resources', 'reservations', 'devices'], 'Device reservations (GPUs…) are not allowed');

    // image / build
    let imageRef: string | null = null;
    let buildSpec: ResolvedService['buildSpec'] = null;
    if (s.build !== undefined && s.build !== null) {
      if (!ctx.policy.allowBuild) {
        c.error('buildNotAllowed', name, [...p, 'build'], 'Building images is not allowed for this account (platform, tenant or plan)');
      } else {
        const b = typeof s.build === 'string' ? { context: s.build } : isObj(s.build) ? s.build : null;
        const context = asStr(b?.context) ?? '.';
        if (b && (b.dockerfile_inline !== undefined || b.additional_contexts !== undefined || b.ssh !== undefined || b.secrets !== undefined)) {
          c.error('unsupportedKey', name, [...p, 'build'], 'build: only context, dockerfile, args and target are supported', { key: 'build' });
        }
        const rel = /^[a-z]+:\/\//i.test(context) || context.startsWith('git@') || isAbsoluteLike(context) ? null : resolveRelative(ctx, context);
        if (!rel) c.error('buildContextOutsideStack', name, [...p, 'build'], 'The build context must be a directory of the stack source', { context });
        else if (ctx.inspector && ctx.inspector.kind(rel) !== 'dir') {
          c.error('buildContextOutsideStack', name, [...p, 'build'], ctx.inspector.kind(rel) === 'symlink' ? 'A symbolic link is in the build context path' : 'Build context not found in the stack source', { context });
        } else {
          const dockerfile = asStr(b?.dockerfile) ?? 'Dockerfile';
          if (isAbsoluteLike(dockerfile) || path.posix.normalize(dockerfile).startsWith('..')) {
            c.error('buildContextOutsideStack', name, [...p, 'build', 'dockerfile'], 'The Dockerfile must be inside the build context', { context });
          } else {
            const args: Record<string, string> = {};
            for (const [k, v] of listOrMap(b?.args) ?? []) args[k] = v ?? ctx.env.get(k) ?? '';
            buildSpec = { context: rel, dockerfile: path.posix.normalize(dockerfile), args, target: asStr(b?.target) };
            // AP5: the images the builder pulls (FROM, COPY --from, RUN --mount from, # syntax) obey the
            // tenant's registry allow-list / deny list like service images. Judged when the tree is
            // inspectable (deploy time); the Dockerfile is read without following links.
            if (ctx.inspector) {
              const dfRel = path.posix.join(rel, path.posix.normalize(dockerfile));
              const dfText = ctx.inspector.kind(dfRel) === 'file' ? ctx.inspector.readText(dfRel) : null;
              if (dfText === null) {
                c.error('buildContextOutsideStack', name, [...p, 'build', 'dockerfile'], `Dockerfile "${dockerfile.slice(0, 120)}" not found in the build context (or a symbolic link, or too large)`, { context });
                buildSpec = null;
              } else {
                const used = dockerfileImages(dfText, args);
                for (const u of used.unresolved) {
                  c.error('imageNotAllowed', name, [...p, 'build'], `Dockerfile line ${u.line}: image "${u.text}" cannot be resolved (unknown build argument)`, { image: u.text.slice(0, 120), dockerfileLine: u.line });
                }
                for (const u of used.images) {
                  const ref = parseImageRef(u.ref);
                  if (!ref) c.error('imageNotAllowed', name, [...p, 'build'], `Dockerfile line ${u.line}: invalid image reference "${u.ref.slice(0, 120)}"`, { image: u.ref.slice(0, 120), dockerfileLine: u.line });
                  else if (!registryAllowed(ref.registry, ctx.policy.allowedRegistries)) {
                    c.error('registryNotAllowed', name, [...p, 'build'], `Dockerfile line ${u.line}: registry ${ref.registry} is not allowed`, { registry: ref.registry, dockerfileLine: u.line });
                  } else {
                    const denied = imageDenied(ref, ctx.policy.deniedImages);
                    if (denied) c.error('imageNotAllowed', name, [...p, 'build'], `Dockerfile line ${u.line}: image ${formatImageRef(ref)} is refused by the image policy`, { image: formatImageRef(ref), pattern: denied, dockerfileLine: u.line });
                  }
                }
              }
            }
          }
        }
      }
    } else {
      const img = asStr(s.image);
      if (!img) c.error('imageMissing', name, [...p, 'image'], `Service "${name}" has neither an image nor a build`);
      else {
        const ref = parseImageRef(img);
        if (!ref) c.error('imageNotAllowed', name, [...p, 'image'], `Invalid image reference "${img.slice(0, 120)}"`, { image: img.slice(0, 120) });
        else if (!registryAllowed(ref.registry, ctx.policy.allowedRegistries)) {
          c.error('registryNotAllowed', name, [...p, 'image'], `Registry ${ref.registry} is not allowed`, { registry: ref.registry });
        } else {
          const denied = imageDenied(ref, ctx.policy.deniedImages);
          if (denied) c.error('imageNotAllowed', name, [...p, 'image'], `Image ${formatImageRef(ref)} is refused by the image policy`, { image: formatImageRef(ref), pattern: denied });
          else imageRef = formatImageRef(ref);
        }
      }
    }

    // capabilities
    const capAdd: string[] = [];
    if (s.cap_add !== undefined) {
      if (!Array.isArray(s.cap_add)) c.error('capNotAllowed', name, [...p, 'cap_add'], 'cap_add must be a list');
      else s.cap_add.forEach((cap, i) => {
        const v = (asStr(cap) ?? '').toUpperCase().replace(/^CAP_/, '');
        if (v === 'ALL' || !capAllowed.has(v)) c.error('capNotAllowed', name, [...p, 'cap_add', i], `Capability ${v || '?'} is not allowed`, { capability: v });
        else if (!capAdd.includes(v)) capAdd.push(v);
      });
    }

    // ports / expose
    const exposed: Array<{ port: number; protocol: 'tcp' | 'udp' }> = [];
    const addPort = (pp: { port: number; protocol: 'tcp' | 'udp' }) => {
      if (!exposed.some((e) => e.port === pp.port && e.protocol === pp.protocol)) exposed.push(pp);
    };
    if (s.ports !== undefined) {
      if (!Array.isArray(s.ports)) c.error('notAnObject', name, [...p, 'ports'], 'ports must be a list');
      else {
        let warned = false;
        s.ports.forEach((entry, i) => {
          const parsed = parsePortSpec(entry);
          if (!parsed) { c.error('invalidName', name, [...p, 'ports', i], `Invalid port "${String(asStr(entry) ?? '?').slice(0, 40)}"`); return; }
          if (parsed.published) c.warn('hostPortIgnored', name, [...p, 'ports', i], 'The host port is ignored: nothing is published on the host; use a proxy host to expose the service');
          else if (!warned) { c.warn('portsNotPublished', name, [...p, 'ports'], 'Ports are never published on the host: they are reachable by proxy hosts and declared links only'); warned = true; }
          parsed.ports.forEach(addPort);
        });
      }
    }
    if (s.expose !== undefined) {
      if (!Array.isArray(s.expose)) c.error('notAnObject', name, [...p, 'expose'], 'expose must be a list');
      else s.expose.forEach((entry, i) => {
        const parsed = parsePortSpec(typeof entry === 'number' ? entry : asStr(entry));
        if (!parsed || parsed.published) { c.error('invalidName', name, [...p, 'expose', i], 'Invalid exposed port'); return; }
        parsed.ports.forEach(addPort);
      });
    }
    if (exposed.length > MAX_PORTS_PER_SERVICE) c.error('invalidName', name, [...p, 'ports'], `At most ${MAX_PORTS_PER_SERVICE} ports per service`);

    // networks
    const svcNetworks: string[] = [];
    const networkAliases: Record<string, string[]> = {};
    if (!networkNone) {
      if (s.networks === undefined || s.networks === null) svcNetworks.push('default');
      else {
        const entries: Array<[string, unknown]> = Array.isArray(s.networks)
          ? s.networks.map((n) => [asStr(n) ?? '', null])
          : isObj(s.networks) ? Object.entries(s.networks) : [];
        if (!Array.isArray(s.networks) && !isObj(s.networks)) c.error('notAnObject', name, [...p, 'networks'], 'networks must be a list or a mapping');
        for (const [n, cfg] of entries) {
          if (n !== 'default' && !declaredNetworks.has(n)) { c.error('externalNetwork', name, [...p, 'networks', n], `Network "${n}" is not declared in the stack`, { name: n }); continue; }
          svcNetworks.push(n);
          if (isObj(cfg)) {
            if (Array.isArray(cfg.aliases)) {
              const aliases = cfg.aliases.map((a) => asStr(a) ?? '').filter((a) => /^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(a));
              if (aliases.length) networkAliases[n] = aliases;
            }
            if (cfg.ipv4_address !== undefined || cfg.ipv6_address !== undefined || cfg.mac_address !== undefined) {
              c.warn('unsupportedKey', name, [...p, 'networks', n], 'Static addresses are ignored', { key: 'ipv4_address' });
            }
          }
        }
      }
    }
    svcNetworks.forEach((n) => usedNetworks.add(n));

    // volumes + tmpfs
    const volumes: EffectiveVolume[] = [];
    const tmpfs: ResolvedService['tmpfs'] = [];
    const addTmpfs = (target: string, size: number | null, mode: string | null, pp: Seg[]) => {
      let bytes = size ?? DEFAULT_TMPFS_BYTES;
      if (bytes > MAX_TMPFS_BYTES) { c.warn('tmpfsSize', name, pp, `tmpfs ${target} capped at 256 MiB`, { target }); bytes = MAX_TMPFS_BYTES; }
      if (!target.startsWith('/')) { c.error('invalidName', name, pp, `tmpfs target "${target}" must be an absolute path`); return; }
      tmpfs.push({ target, sizeBytes: bytes, mode });
    };
    if (s.volumes !== undefined) {
      if (!Array.isArray(s.volumes)) c.error('notAnObject', name, [...p, 'volumes'], 'volumes must be a list');
      else s.volumes.forEach((entry, i) => {
        const vp: Seg[] = [...p, 'volumes', i];
        const m = parseMount(entry);
        if (!m || !m.target) { c.error('invalidName', name, vp, 'Invalid volume entry'); return; }
        if (!m.target.startsWith('/') || path.posix.normalize(m.target) === '/') { c.error('invalidName', name, vp, `Mount target "${m.target}" must be an absolute path other than /`); return; }
        if (m.source && SOCKET_RE.test(m.source)) { c.error('dockerSocket', name, vp, 'Mounting a container engine socket is never allowed'); return; }
        if (m.type === 'other') { c.error('unsupportedKey', name, vp, 'Only volume, bind and tmpfs mounts are supported', { key: 'type' }); return; }
        if (m.type === 'tmpfs') { addTmpfs(m.target, m.tmpfsSize, null, vp); return; }
        if (m.type === 'bind' || (m.source && (isAbsoluteLike(m.source) || isRelativeBind(m.source)))) {
          const src = m.source ?? '';
          if (!src || isAbsoluteLike(src)) { c.error('absoluteBind', name, vp, `Host path "${src.slice(0, 120)}" is not allowed: use a named volume or a path relative to the stack source`, { source: src.slice(0, 120) }); return; }
          const rel = resolveRelative(ctx, src);
          if (!rel) { c.error('bindOutsideStack', name, vp, `"${src.slice(0, 120)}" is outside the stack source`, { source: src.slice(0, 120) }); return; }
          if (ctx.inspector && ctx.inspector.kind(rel) === 'symlink') { c.error('symlinkInPath', name, vp, `A symbolic link is in the path of "${src.slice(0, 120)}"`, { source: src.slice(0, 120) }); return; }
          // Never writable (security audit P4b, AP1/R1): a container able to write
          // into a tree that serves as a bind source or build context could swap
          // a component for a symbolic link, which Docker follows on the host at
          // every container start (and tar-fs while packing a build context).
          // Writable data belongs in named volumes (accounts/<id>/apps/<stackId>/volumes).
          if (m.explicitRw) { c.error('unsupportedKey', name, vp, `Bind mounts of the stack source are always read-only ("${src.slice(0, 120)}"): use a named volume for writable data`, { key: 'rw', source: src.slice(0, 120) }); return; }
          volumes.push({ kind: 'bind', source: rel, target: m.target, readOnly: true });
          return;
        }
        // named / anonymous volume
        let vol = m.source;
        if (!vol) {
          vol = `anon-${name}-${i}`.slice(0, 63);
          anonVolumes.push(vol);
        } else if (!declaredVolumes.has(vol)) {
          c.error('externalVolume', name, vp, `Volume "${vol}" is not declared in the stack`, { name: vol });
          return;
        }
        usedVolumes.add(vol);
        volumes.push({ kind: 'volume', source: vol, target: m.target, readOnly: m.readOnly });
      });
    }
    if (s.tmpfs !== undefined) {
      const list = typeof s.tmpfs === 'string' ? [s.tmpfs] : Array.isArray(s.tmpfs) ? s.tmpfs : null;
      if (!list) c.error('notAnObject', name, [...p, 'tmpfs'], 'tmpfs must be a string or a list');
      else list.forEach((entry, i) => {
        const str = asStr(entry) ?? '';
        const [target, opts = ''] = str.split(/:(.*)/s, 2);
        let size: number | null = null;
        let mode: string | null = null;
        for (const o of opts.split(',')) {
          const [k, v] = o.split('=');
          if (k === 'size') size = parseSize(v);
          if (k === 'mode' && /^[0-7]{3,4}$/.test(v ?? '')) mode = v;
        }
        addTmpfs(target, size, mode, [...p, 'tmpfs', ...(Array.isArray(s.tmpfs) ? [i] : [])]);
      });
    }

    // configs / secrets mounts
    const mountObjects = (kind: 'secrets' | 'configs', files: Map<string, string>) => {
      const list = s[kind];
      if (list === undefined) return;
      if (!Array.isArray(list)) { c.error('notAnObject', name, [...p, kind], `${kind} must be a list`); return; }
      list.forEach((entry, i) => {
        const src = isObj(entry) ? asStr(entry.source) : asStr(entry);
        if (!src || !files.has(src)) { c.error(kind === 'secrets' ? 'secretsFileOutsideStack' : 'configsFileOutsideStack', name, [...p, kind, i], `${kind} "${src ?? '?'}" is not declared (as a file) in the stack`, { name: src ?? '?' }); return; }
        let target = isObj(entry) ? asStr(entry.target) : null;
        if (kind === 'secrets') target = target ? (target.startsWith('/') ? target : `/run/secrets/${target}`) : `/run/secrets/${src}`;
        else target = target ?? `/${src}`;
        volumes.push({ kind: 'bind', source: files.get(src)!, target, readOnly: true });
      });
    };
    mountObjects('secrets', secretFiles);
    mountObjects('configs', configFiles);

    // environment (env_file first, then environment)
    const env = new Map<string, string>();
    if (s.env_file !== undefined) {
      const list = typeof s.env_file === 'string' ? [s.env_file] : Array.isArray(s.env_file) ? s.env_file : null;
      if (!list) c.error('notAnObject', name, [...p, 'env_file'], 'env_file must be a string or a list');
      else list.forEach((entry, i) => {
        const ep: Seg[] = [...p, 'env_file', ...(Array.isArray(s.env_file) ? [i] : [])];
        const file = isObj(entry) ? asStr(entry.path) : asStr(entry);
        const required = isObj(entry) ? entry.required !== false : true;
        if (!file || isAbsoluteLike(file)) { c.error('envFileOutsideStack', name, ep, 'env_file must be a path relative to the stack source'); return; }
        const rel = resolveRelative(ctx, file);
        if (!rel) { c.error('envFileOutsideStack', name, ep, `env_file "${file.slice(0, 120)}" is outside the stack source`); return; }
        if (!ctx.inspector) return;
        const k = ctx.inspector.kind(rel);
        if (k === 'symlink') { c.error('symlinkInPath', name, ep, `A symbolic link is in the path of env_file "${file.slice(0, 120)}"`, { source: file.slice(0, 120) }); return; }
        const text = k === 'file' ? ctx.inspector.readText(rel) : null;
        if (text === null) {
          if (required) c.error('envFileOutsideStack', name, ep, `env_file "${file.slice(0, 120)}" not found in the stack source`);
          return;
        }
        for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) continue;
          const body = t.startsWith('export ') ? t.slice(7) : t;
          const eq = body.indexOf('=');
          if (eq <= 0) continue;
          let v = body.slice(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          env.set(body.slice(0, eq).trim(), v);
        }
      });
    }
    if (s.environment !== undefined) {
      const entries = listOrMap(s.environment);
      if (!entries) c.error('notAnObject', name, [...p, 'environment'], 'environment must be a list or a mapping');
      else for (const [k, v] of entries) {
        if (!/^[^=\s]{1,256}$/.test(k)) { c.error('invalidName', name, [...p, 'environment'], `Invalid environment variable name "${k.slice(0, 64)}"`); continue; }
        if (v === null) { const fromEnv = ctx.env.get(k); if (fromEnv !== undefined) env.set(k, fromEnv); continue; }
        env.set(k, v);
      }
    }

    // labels
    const labels: Record<string, string> = {};
    if (s.labels !== undefined) {
      const entries = listOrMap(s.labels);
      if (!entries) c.error('notAnObject', name, [...p, 'labels'], 'labels must be a list or a mapping');
      else for (const [k, v] of entries) {
        if (/^(oblimint\.|com\.docker\.)/i.test(k)) { c.warn('labelReserved', name, [...p, 'labels'], `Label "${k}" is reserved and was removed`, { label: k }); continue; }
        labels[k] = v ?? '';
      }
    }

    // extra_hosts
    const extraHosts: string[] = [];
    if (s.extra_hosts !== undefined) {
      const entries: Array<[string, string]> = [];
      if (Array.isArray(s.extra_hosts)) {
        for (const e of s.extra_hosts) {
          const str = asStr(e) ?? '';
          const m = /^([^:=\s]+)[:=](.+)$/.exec(str);
          if (m) entries.push([m[1], m[2].replace(/^\[|\]$/g, '')]);
          else entries.push([str, '']);
        }
      } else if (isObj(s.extra_hosts)) {
        for (const [h, ip] of Object.entries(s.extra_hosts)) entries.push([h, (Array.isArray(ip) ? asStr(ip[0]) : asStr(ip)) ?? '']);
      }
      for (const [h, ip] of entries) {
        const range = addressRange(ip);
        if (ip === 'host-gateway' || range === null || range !== 'unicast') {
          c.error('extraHostsPrivate', name, [...p, 'extra_hosts'], `extra_hosts "${h}" → "${ip.slice(0, 64)}": only public addresses are allowed`, { host: h.slice(0, 64) });
        } else if (/^[a-z0-9.-]{1,253}$/i.test(h)) extraHosts.push(`${h}:${ip}`);
      }
    }

    // healthcheck
    let health: HealthSpec | null = null;
    let hasHealth = false;
    if (isObj(s.healthcheck)) {
      const h = s.healthcheck;
      const test = typeof h.test === 'string' ? ['CMD-SHELL', h.test] : Array.isArray(h.test) ? h.test.map((x) => asStr(x) ?? '') : null;
      if (truthy(h.disable) || (test && test[0] === 'NONE')) health = { test: ['NONE'], intervalMs: null, timeoutMs: null, retries: null, startPeriodMs: null, startIntervalMs: null };
      else if (test && (test[0] === 'CMD' || test[0] === 'CMD-SHELL') && test.length > 1) {
        hasHealth = true;
        health = {
          test,
          intervalMs: parseDurationMs(h.interval),
          timeoutMs: parseDurationMs(h.timeout),
          retries: Number.isInteger(Number(h.retries)) && h.retries !== undefined ? Number(h.retries) : null,
          startPeriodMs: parseDurationMs(h.start_period),
          startIntervalMs: parseDurationMs(h.start_interval),
        };
      } else if (h.test !== undefined) c.error('unsupportedKey', name, [...p, 'healthcheck', 'test'], 'healthcheck.test must be a string or ["CMD"|"CMD-SHELL", …]', { key: 'healthcheck' });
    }

    // restart
    let restart: EffectiveService['restart'] = 'no';
    let restartMaxRetries: number | null = null;
    const rs = asStr(s.restart) ?? (isObj(deploy.restart_policy) ? ({ none: 'no', 'on-failure': 'on-failure', any: 'unless-stopped' } as Record<string, string>)[asStr(deploy.restart_policy.condition) ?? 'any'] ?? 'unless-stopped' : null);
    if (rs !== null) {
      const m = /^(no|always|unless-stopped|on-failure)(?::(\d+))?$/.exec(rs);
      if (!m) c.error('restartPolicy', name, [...p, 'restart'], `Invalid restart policy "${rs.slice(0, 40)}"`);
      else if (m[1] === 'always') { restart = 'unless-stopped'; c.warn('restartPolicy', name, [...p, 'restart'], 'restart: always is applied as unless-stopped (a container stopped by the panel stays stopped)'); }
      else { restart = m[1] as EffectiveService['restart']; if (m[2]) restartMaxRetries = Number(m[2]); }
    }

    // stop grace / shm / ulimits
    let stopGraceSec: number | null = null;
    if (s.stop_grace_period !== undefined) {
      const ms = parseDurationMs(s.stop_grace_period);
      if (ms === null) c.error('invalidName', name, [...p, 'stop_grace_period'], 'Invalid duration');
      else {
        stopGraceSec = Math.ceil(ms / 1000);
        if (stopGraceSec > MAX_STOP_GRACE_SEC) { c.warn('stopGraceCapped', name, [...p, 'stop_grace_period'], 'stop_grace_period capped at 120 s', { max: MAX_STOP_GRACE_SEC }); stopGraceSec = MAX_STOP_GRACE_SEC; }
      }
    }
    let shmSizeBytes: number | null = null;
    if (s.shm_size !== undefined) {
      const b = parseSize(s.shm_size);
      if (b === null) c.error('invalidName', name, [...p, 'shm_size'], 'Invalid size');
      else if (b > MAX_SHM_BYTES) { c.warn('shmSize', name, [...p, 'shm_size'], 'shm_size capped at 256 MiB'); shmSizeBytes = MAX_SHM_BYTES; }
      else shmSizeBytes = b;
    }
    const ulimits: ResolvedService['ulimits'] = [];
    if (s.ulimits !== undefined) {
      if (!isObj(s.ulimits)) c.error('notAnObject', name, [...p, 'ulimits'], 'ulimits must be a mapping');
      else for (const [k, v] of Object.entries(s.ulimits)) {
        if (k !== 'nofile' && k !== 'nproc' && k !== 'core' && k !== 'stack') { c.warn('unsupportedKey', name, [...p, 'ulimits', k], `ulimit ${k} is ignored`, { key: k }); continue; }
        const soft = Number(isObj(v) ? v.soft : v);
        const hard = Number(isObj(v) ? v.hard : v);
        if (!Number.isInteger(soft) || !Number.isInteger(hard) || soft < 0 || hard < soft) { c.error('invalidName', name, [...p, 'ulimits', k], `Invalid ulimit ${k}`); continue; }
        if (k === 'nofile') {
          if (hard > MAX_NOFILE) c.warn('ulimitCapped', name, [...p, 'ulimits', k], `nofile capped at ${MAX_NOFILE}`, { max: MAX_NOFILE });
          ulimits.push({ name: k, soft: Math.min(soft, MAX_NOFILE), hard: Math.min(hard, MAX_NOFILE) });
        } else ulimits.push({ name: k, soft, hard });
      }
    }

    // user
    const user = s.user !== undefined && s.user !== null ? asStr(s.user) : null;
    if (user !== null && /^(root|0)(:(root|0))?$/.test(user)) c.warn('userRoot', name, [...p, 'user'], 'The service runs as root inside its container');

    // depends_on (checked once every service is known)
    const dependsOn: EffectiveService['dependsOn'] = [];
    if (s.depends_on !== undefined) {
      if (Array.isArray(s.depends_on)) for (const d of s.depends_on) dependsOn.push({ service: asStr(d) ?? '', condition: 'started' });
      else if (isObj(s.depends_on)) {
        for (const [d, cfg] of Object.entries(s.depends_on)) {
          const cond = isObj(cfg) ? asStr(cfg.condition) : null;
          dependsOn.push({ service: d, condition: cond === 'service_healthy' ? 'healthy' : cond === 'service_completed_successfully' ? 'completed' : 'started' });
        }
      } else c.error('notAnObject', name, [...p, 'depends_on'], 'depends_on must be a list or a mapping');
    }

    // limits (declared)
    const lim = isObj(deploy.resources) && isObj(deploy.resources.limits) ? deploy.resources.limits : {};
    const memDeclared = lim.memory !== undefined ? parseSize(lim.memory) : s.mem_limit !== undefined ? parseSize(s.mem_limit) : null;
    if ((lim.memory !== undefined || s.mem_limit !== undefined) && memDeclared === null) c.error('invalidName', name, [...p, lim.memory !== undefined ? 'deploy' : 'mem_limit'], 'Invalid memory limit');
    const cpusDeclared = lim.cpus !== undefined ? parseCpus(lim.cpus) : s.cpus !== undefined ? parseCpus(s.cpus) : null;
    if ((lim.cpus !== undefined || s.cpus !== undefined) && cpusDeclared === null) c.error('invalidName', name, [...p, lim.cpus !== undefined ? 'deploy' : 'cpus'], 'Invalid CPU limit');
    const pidsRaw = lim.pids ?? s.pids_limit;
    let pids = ctx.plan.pidsPerContainer;
    if (pidsRaw !== undefined && pidsRaw !== null) {
      const n = Number(pidsRaw);
      if (!Number.isInteger(n) || n === 0) c.error('invalidName', name, [...p, 'pids_limit'], 'Invalid pids limit');
      else if (n < 0 || n > ctx.plan.pidsPerContainer) c.warn('pidsCapped', name, [...p, 'pids_limit'], `pids limit capped at ${ctx.plan.pidsPerContainer} (plan)`, { max: ctx.plan.pidsPerContainer });
      else pids = n;
    }
    declared.push({ name, cpus: cpusDeclared, memoryMb: memDeclared === null ? null : Math.max(6, Math.ceil(memDeclared / MiB)), p });

    const readOnly = truthy(s.read_only);
    resolved.push({
      name,
      image: buildSpec ? null : imageRef,
      imageRef: buildSpec ? null : imageRef,
      build: !!buildSpec,
      command: toArgv(s.command),
      entrypoint: toArgv(s.entrypoint),
      exposedPorts: exposed,
      volumes,
      networks: svcNetworks,
      fabric: { front: exposed.length > 0 && !networkNone, back: false },
      capAdd,
      user,
      readOnlyRootfs: readOnly,
      limits: { cpus: 0, memoryMb: 0, pids },
      healthcheck: hasHealth,
      dependsOn,
      restart,
      envKeys: [...env.keys()],
      environment: [...env.entries()],
      health,
      tmpfs,
      shmSizeBytes,
      ulimits,
      stopGraceSec,
      stopSignal: asStr(s.stop_signal),
      workingDir: asStr(s.working_dir),
      labels,
      extraHosts,
      init: s.init === undefined ? null : truthy(s.init),
      tty: truthy(s.tty),
      stdinOpen: truthy(s.stdin_open),
      groupAdd: Array.isArray(s.group_add) ? s.group_add.map((g) => asStr(g) ?? '').filter((g) => /^[a-z0-9_-]{1,32}$/i.test(g)) : [],
      networkAliases,
      networkNone,
      buildSpec,
      restartMaxRetries,
    });
  }

  // depends_on: unknown services, cycles
  const byName = new Map(resolved.map((r) => [r.name, r]));
  for (const r of resolved) {
    for (const d of r.dependsOn) {
      if (!byName.has(d.service)) c.error('dependsUnknown', r.name, ['services', r.name, 'depends_on'], `Service "${r.name}" depends on unknown (or disabled) service "${d.service}"`, { dependency: d.service });
      else if (d.condition === 'healthy' && !byName.get(d.service)!.healthcheck) {
        c.warn('dependsUnknown', r.name, ['services', r.name, 'depends_on'], `"${d.service}" has no healthcheck: waiting for it to start only`, { dependency: d.service });
        d.condition = 'started';
      }
    }
  }
  const order: ResolvedService[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle = false;
  const visit = (r: ResolvedService, trail: string[]) => {
    const st = state.get(r.name);
    if (st === 'done') return;
    if (st === 'visiting') {
      if (!cycle) c.error('dependsCycle', r.name, ['services', r.name, 'depends_on'], `Dependency cycle: ${[...trail, r.name].join(' → ')}`);
      cycle = true;
      return;
    }
    state.set(r.name, 'visiting');
    for (const d of r.dependsOn) { const dep = byName.get(d.service); if (dep) visit(dep, [...trail, r.name]); }
    state.set(r.name, 'done');
    order.push(r);
  };
  for (const r of resolved) visit(r, []);

  // limits: declared capped by node / plan, defaults capped by what is left, sums ≤ plan
  const planMem = ctx.plan.memoryMb !== null && ctx.plan.memoryMb >= 0 ? ctx.plan.memoryMb : null;
  const planCpu = ctx.plan.cpus !== null && ctx.plan.cpus >= 0 ? ctx.plan.cpus : null;
  const capMem = Math.min(ctx.node.memoryMb > 0 ? ctx.node.memoryMb : Infinity, planMem ?? Infinity);
  const capCpu = Math.min(ctx.node.cpus > 0 ? ctx.node.cpus : Infinity, planCpu ?? Infinity);
  let declaredMem = 0;
  let declaredCpu = 0;
  for (const d of declared) {
    const r = byName.get(d.name)!;
    if (d.memoryMb !== null) {
      let v = d.memoryMb;
      if (v > capMem) { c.warn('resourceCapped', d.name, [...d.p, 'deploy'], `Memory limit capped at ${capMem} MiB`, { max: capMem }); v = capMem; }
      v = Math.max(6, v);
      r.limits.memoryMb = v;
      declaredMem += v;
    }
    if (d.cpus !== null) {
      let v = d.cpus;
      if (v > capCpu) { c.warn('resourceCapped', d.name, [...d.p, 'deploy'], `CPU limit capped at ${capCpu}`, { max: capCpu }); v = capCpu; }
      v = Math.max(0.01, v);
      r.limits.cpus = v;
      declaredCpu += v;
    }
  }
  const undeclaredMem = declared.filter((d) => d.memoryMb === null);
  const undeclaredCpu = declared.filter((d) => d.cpus === null);
  const leftMem = planMem === null ? Infinity : planMem - ctx.others.memoryMb - declaredMem;
  const leftCpu = planCpu === null ? Infinity : planCpu - ctx.others.cpus - declaredCpu;
  for (const d of undeclaredMem) {
    const r = byName.get(d.name)!;
    let v = Math.min(ctx.defaults.memoryMb, capMem);
    const share = Math.floor(leftMem / undeclaredMem.length);
    if (Number.isFinite(share) && share < v && share >= 32) { v = share; c.warn('resourceDefaulted', d.name, d.p, `No memory limit declared: ${v} MiB given (what is left of the plan)`, { memoryMb: v }); }
    r.limits.memoryMb = Math.max(6, v);
  }
  for (const d of undeclaredCpu) {
    const r = byName.get(d.name)!;
    let v = Math.min(ctx.defaults.cpus, capCpu);
    const share = Math.floor((leftCpu / undeclaredCpu.length) * 100) / 100;
    if (Number.isFinite(share) && share < v && share >= 0.05) { v = share; c.warn('resourceDefaulted', d.name, d.p, `No CPU limit declared: ${v} CPU given (what is left of the plan)`, { cpus: v }); }
    r.limits.cpus = Math.max(0.01, v);
  }
  const totals = {
    cpus: Math.round(resolved.reduce((a, r) => a + r.limits.cpus, 0) * 100) / 100,
    memoryMb: resolved.reduce((a, r) => a + r.limits.memoryMb, 0),
    containers: resolved.length,
  };
  if (planCpu !== null && ctx.others.cpus + totals.cpus > planCpu + 1e-9) {
    c.error('planCpuExceeded', null, ['services'], `The account's applications would use ${round2(ctx.others.cpus + totals.cpus)} CPU (plan: ${planCpu})`,
      { used: round2(ctx.others.cpus), requested: totals.cpus, limit: planCpu });
  }
  if (planMem !== null && ctx.others.memoryMb + totals.memoryMb > planMem) {
    c.error('planMemoryExceeded', null, ['services'], `The account's applications would use ${ctx.others.memoryMb + totals.memoryMb} MiB (plan: ${planMem} MiB)`,
      { used: ctx.others.memoryMb, requested: totals.memoryMb, limit: planMem });
  }
  if (ctx.plan.containers !== null && ctx.others.containers + totals.containers > ctx.plan.containers) {
    c.error('planContainersExceeded', null, ['services'], `The account's applications would run ${ctx.others.containers + totals.containers} containers (plan: ${ctx.plan.containers})`,
      { used: ctx.others.containers, requested: totals.containers, limit: ctx.plan.containers });
  }

  if (c.hasErrors) return fail(c);

  const effective: EffectiveStackConfig = {
    services: order.map(toEffectiveService),
    networks: [...usedNetworks].sort().map((n) => ({ name: n, internal: declaredNetworks.get(n)?.internal ?? false })),
    volumes: [...usedVolumes].sort(),
    totals,
  };
  const stack: ResolvedStack = { effective, services: order };
  return { result: { ok: true, issues: c.issues, effective, effectiveYaml: renderEffectiveYaml(stack, ctx.env) }, resolved: stack };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toEffectiveService(r: ResolvedService): EffectiveService {
  return {
    name: r.name, image: r.image, build: r.build, command: r.command, entrypoint: r.entrypoint, exposedPorts: r.exposedPorts,
    volumes: r.volumes, networks: r.networks, fabric: { ...r.fabric }, capAdd: r.capAdd, user: r.user, readOnlyRootfs: r.readOnlyRootfs,
    limits: { ...r.limits }, healthcheck: r.healthcheck, dependsOn: r.dependsOn, restart: r.restart, envKeys: r.envKeys,
  };
}

const MASK = '********';

/** Values of the stack .env whose key looks secret (masked wherever they appear). */
export function secretValues(env: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of env) if (v && v.length >= 4 && looksSecret(k)) out.push(v);
  return out;
}

/** The rewritten compose shown in the preview (what the panel deploys), secrets masked. */
export function renderEffectiveYaml(stack: ResolvedStack, env: ReadonlyMap<string, string>): string {
  const secrets = new Set(secretValues(env));
  const services: Obj = {};
  for (const r of stack.services) {
    const environment: Obj = {};
    for (const [k, v] of r.environment) environment[k] = looksSecret(k) || secrets.has(v) ? MASK : v;
    const svc: Obj = {
      ...(r.image ? { image: r.image } : { build: r.buildSpec ? { context: r.buildSpec.context, dockerfile: r.buildSpec.dockerfile } : true }),
      ...(r.command ? { command: r.command } : {}),
      ...(r.entrypoint ? { entrypoint: r.entrypoint } : {}),
      ...(r.user ? { user: r.user } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(r.exposedPorts.length ? { expose: r.exposedPorts.map((p) => `${p.port}/${p.protocol}`) } : {}),
      ...(r.volumes.length ? { volumes: r.volumes.map((v) => `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`) } : {}),
      ...(r.tmpfs.length ? { tmpfs: r.tmpfs.map((t) => `${t.target}:size=${Math.round(t.sizeBytes / MiB)}m`) } : {}),
      ...(r.networkNone ? { network_mode: 'none' } : { networks: r.networks }),
      cap_drop: ['ALL'],
      ...(r.capAdd.length ? { cap_add: r.capAdd } : {}),
      security_opt: ['no-new-privileges:true', 'seccomp=oblimint-tenant'],
      ...(r.readOnlyRootfs ? { read_only: true } : {}),
      deploy: { resources: { limits: { cpus: String(r.limits.cpus), memory: `${r.limits.memoryMb}M`, pids: r.limits.pids } } },
      restart: r.restart,
      ...(r.dependsOn.length ? { depends_on: Object.fromEntries(r.dependsOn.map((d) => [d.service, { condition: d.condition === 'healthy' ? 'service_healthy' : d.condition === 'completed' ? 'service_completed_successfully' : 'service_started' }])) } : {}),
      ...(r.health && r.healthcheck ? { healthcheck: { test: r.health.test } } : {}),
    };
    services[r.name] = svc;
  }
  const doc: Obj = { services };
  if (stack.effective.networks.length) doc.networks = Object.fromEntries(stack.effective.networks.map((n) => [n.name, n.internal ? { internal: true } : {}]));
  if (stack.effective.volumes.length) doc.volumes = Object.fromEntries(stack.effective.volumes.map((v) => [v, { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: `volumes/${v}` } }]));
  let text = stringify(doc, { lineWidth: 0 });
  // Secret values may also sit in commands / healthchecks / labels: masked wherever they appear.
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(v).join(MASK);
  return text;
}
