import type {
  CwpAccount, CwpCertificate, CwpCronEntry, CwpDatabase, CwpDbUser, CwpDkimKey, CwpDnsZone, CwpDomain, CwpFtpUser, CwpMailAlias,
  CwpMailbox, CwpMailDomain, CwpOutsideItem, CwpPackage, CwpServerInfo, MigrationScope, MigrationSeverity, MigrationWarning,
} from '@oblimint/shared';
import {
  SourceCommandError, SourceCommandRefusedError,
  type CommandResult, type CommandTemplateArgs, type CommandTemplateId, type RunOptions, type SourceSession,
} from '../../contracts/source';
import { parseMysqlBatch, type BatchCell } from '../parsers/mysqlBatch';
import { parseDu, parseFind, parseLineCount, parseStat, type FindEntry, type PasswdEntry, type StatEntry } from '../parsers/system';
import type { DomainWebConf, VhostSslEntry, WpAddon } from '../parsers/cwpConf';
import type { NginxServer } from '../parsers/nginx';
import type { ApacheVhost } from '../parsers/apache';
import type { UnitFacts } from '../parsers/systemd';

// ─────────────────────────────────────────────────────────────────────────────
// Shared state + guarded command helpers of one discovery run. Every helper
// goes through the SourceSession (closed templates, MG1); a non-vital failure
// becomes an inventory warning (readFailed…) instead of failing the run; an
// abort (cancel / panel stop) always propagates. Errors never carry command
// output (SourceCommandError messages hold no stdout; we add none).
// ─────────────────────────────────────────────────────────────────────────────

export const READ_TIMEOUT_MS = 60_000;
/** du on whole homes / maildirs can be slow on big trees. */
export const SIZE_TIMEOUT_MS = 30 * 60_000;
/** Max paths per fs.stat / fs.du / fs.lineCount call. */
export const PATH_BATCH = 100;

export class DiscoveryAbortedError extends Error {
  constructor() {
    super('Découverte annulée');
    this.name = 'DiscoveryAbortedError';
  }
}

export interface NginxFile {
  path: string;
  disabled: boolean;
  servers: NginxServer[];
}

export interface ApacheFile {
  path: string;
  disabled: boolean;
  vhosts: ApacheVhost[];
}

export interface RawDomainRow {
  fqdn: string;
  kind: CwpDomain['kind'];
  account: string;
  parent: string | null;
  subLabel: string | null;
  dbPath: string | null;
}

export interface PhpEvidence {
  /** Apache vhost SetHandler proxy:unix:/opt/alt/php-fpmXX. */
  apacheFpm: string | null;
  /** nginx fastcgi_pass unix:/opt/alt/php-fpmXX. */
  nginxFpm: string | null;
  /** Apache serves the PHP (Apache vhost, or nginx → Apache / Varnish). */
  apache: boolean;
  /** ~/.conf/webservers/<fqdn>.conf php-fpm_ver when php-fpm is on. */
  jsonFpm: string | null;
  /** At least one vhost of the domain could be read and parsed. */
  vhostKnown: boolean;
}

export interface SystemdUnit {
  path: string;
  name: string;
  facts: UnitFacts;
}

export interface DiscoveryState {
  now: Date;
  server: CwpServerInfo;
  /** Every address of the source (public, private, loopback) — proxy targets to these are local services. */
  sourceIps: Set<string>;
  suphp: Map<string, string>;
  vhostsSsl: Map<string, VhostSslEntry>;
  passwd: PasswdEntry[];
  packages: CwpPackage[];
  accounts: CwpAccount[];
  domainRows: RawDomainRow[];
  domains: CwpDomain[];
  nginx: Map<string, NginxFile[]>;
  apache: Map<string, ApacheFile[]>;
  varnish: Map<string, Array<{ name: string; host: string; port: number }>>;
  /** Per-domain ~/.conf/webservers JSON, keyed webConfKey(account, fqdn): only the owning account's file counts. */
  webConf: Map<string, DomainWebConf>;
  addonsWp: Map<string, WpAddon[]>;
  homeEntries: Map<string, FindEntry[]>;
  templates: { nginx: string[]; apache: string[]; varnish: string[] };
  dnsZones: CwpDnsZone[];
  databases: CwpDatabase[];
  dbUsers: CwpDbUser[];
  mailDomains: CwpMailDomain[];
  mailboxes: CwpMailbox[];
  mailAliases: CwpMailAlias[];
  dkimKeys: CwpDkimKey[];
  ftpUsers: CwpFtpUser[];
  crons: CwpCronEntry[];
  certificates: CwpCertificate[];
  outside: CwpOutsideItem[];
  units: SystemdUnit[];
  /** Per-fqdn PHP evidence gathered from the vhosts (resolved in the docroots phase). */
  phpEvidence: Map<string, PhpEvidence>;
  /** Proxies whose target is the source itself (resolved against the systemd units in the outside phase). */
  localProxies: Array<{ fqdn: string; account: string; host: string; port: number }>;
  mysqlOk: boolean;
}

export function emptyServer(): CwpServerInfo {
  return {
    hostname: null, osRelease: null, cwpVersion: null, cwpPro: false, webserverSetup: null, publicIps: [], privateIps: [],
    mariadbVersion: null, phpDefault: null, phpFpmVersions: [], packages: {}, nameservers: [], extraDbPrefixes: [],
  };
}

export function emptyState(now: Date): DiscoveryState {
  return {
    now, server: emptyServer(), sourceIps: new Set(['127.0.0.1', '::1']), suphp: new Map(), vhostsSsl: new Map(), passwd: [],
    packages: [], accounts: [], domainRows: [], domains: [], nginx: new Map(), apache: new Map(), varnish: new Map(),
    webConf: new Map(), addonsWp: new Map(), homeEntries: new Map(), templates: { nginx: [], apache: [], varnish: [] },
    dnsZones: [], databases: [], dbUsers: [], mailDomains: [], mailboxes: [], mailAliases: [], dkimKeys: [], ftpUsers: [],
    crons: [], certificates: [], outside: [], units: [], phpEvidence: new Map(), localProxies: [], mysqlOk: true,
  };
}

/** Short, output-free description of a failure (never the command output). */
export function errorText(err: unknown): string {
  if (err instanceof SourceCommandRefusedError) return `refusé : ${err.reason}`.slice(0, 300);
  if (err instanceof SourceCommandError) return `échec (code ${err.exitCode ?? '?'})`;
  if (err instanceof Error) return err.message.split('\n')[0].slice(0, 300);
  return 'erreur inconnue';
}

export class DiscoveryContext {
  readonly warnings: MigrationWarning[] = [];
  private readonly warned = new Set<string>();

  constructor(
    readonly session: SourceSession,
    readonly state: DiscoveryState,
    readonly signal?: AbortSignal,
  ) {}

  checkAbort(): void {
    if (this.signal?.aborted) throw new DiscoveryAbortedError();
  }

  warn(code: string, severity: MigrationSeverity, scope: MigrationScope, params?: MigrationWarning['params']): void {
    const key = `${code}|${scope.kind}|${scope.key}|${JSON.stringify(params ?? {})}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push({ code, severity, scope: { ...scope, account: scope.account ?? null }, ...(params ? { params } : {}) });
  }

  /** readFailed warning for a non-vital read. */
  readFailed(what: string, err: unknown, scope: MigrationScope = { kind: 'server', key: 'source' }): void {
    this.warn('readFailed', 'warning', scope, { what, error: errorText(err) });
  }

  private rethrowAbort(err: unknown): void {
    if (err instanceof DiscoveryAbortedError) throw err;
    if (this.signal?.aborted) throw new DiscoveryAbortedError();
  }

  async run<T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T], opts: RunOptions = {}): Promise<CommandResult> {
    this.checkAbort();
    try {
      return await this.session.run(template, args, { timeoutMs: READ_TIMEOUT_MS, ...opts, signal: this.signal });
    } catch (err) {
      this.rethrowAbort(err);
      throw err;
    }
  }

  /** run() that turns a failure into a readFailed warning (null). */
  async tryRun<T extends CommandTemplateId>(what: string, template: T, args: CommandTemplateArgs[T], opts: RunOptions = {}, scope?: MigrationScope): Promise<CommandResult | null> {
    try {
      return await this.run(template, args, opts);
    } catch (err) {
      this.rethrowAbort(err);
      this.readFailed(what, err, scope);
      return null;
    }
  }

  /** mysql.query with a header → row objects (throws: callers decide what is vital). */
  async query(sql: string): Promise<Array<Record<string, BatchCell>>> {
    const r = await this.run('mysql.query', { sql, header: true });
    return parseMysqlBatch(r.stdout, { header: true });
  }

  /** readFiles; a failing batch yields nulls + one readFailed warning. */
  async readFiles(what: string, paths: string[], maxBytesPerFile?: number): Promise<Map<string, string | null>> {
    const uniq = [...new Set(paths)];
    if (uniq.length === 0) return new Map();
    this.checkAbort();
    try {
      return await this.session.readFiles(uniq, maxBytesPerFile ? { maxBytesPerFile } : undefined);
    } catch (err) {
      this.rethrowAbort(err);
      this.readFailed(what, err);
      return new Map(uniq.map((p) => [p, null]));
    }
  }

  /** fs.find (a missing start directory is an empty result, not an error). */
  async find(what: string, path: string, maxDepth: number, type?: 'f' | 'd' | 'l', name?: string): Promise<FindEntry[]> {
    if (!isCleanPath(path)) return [];
    const args: CommandTemplateArgs['fs.find'] = { path, maxDepth, ...(type ? { type } : {}), ...(name ? { name } : {}) };
    const r = await this.tryRun(what, 'fs.find', args, { allowNonZeroExit: true });
    if (!r) return [];
    return parseFind(r.stdout).filter((e) => e.path !== path || maxDepth === 0);
  }

  private async batched<T>(paths: string[], fn: (chunk: string[]) => Promise<Map<string, T>>): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    // A path the executor would refuse (glob character, control character…) would refuse the whole batch.
    const uniq = [...new Set(paths)].filter(isCleanPath);
    for (let i = 0; i < uniq.length; i += PATH_BATCH) {
      const part = await fn(uniq.slice(i, i + PATH_BATCH));
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  }

  async stat(what: string, paths: string[]): Promise<Map<string, StatEntry>> {
    return this.batched(paths, async (chunk) => {
      const r = await this.tryRun(what, 'fs.stat', { paths: chunk }, { allowNonZeroExit: true });
      return r ? parseStat(r.stdout) : new Map();
    });
  }

  async du(what: string, paths: string[]): Promise<Map<string, number>> {
    return this.batched(paths, async (chunk) => {
      const r = await this.tryRun(what, 'fs.du', { paths: chunk }, { allowNonZeroExit: true, timeoutMs: SIZE_TIMEOUT_MS });
      return r ? parseDu(r.stdout) : new Map();
    });
  }

  async lineCount(what: string, paths: string[]): Promise<Map<string, number>> {
    return this.batched(paths, async (chunk) => {
      const r = await this.tryRun(what, 'fs.lineCount', { paths: chunk }, { allowNonZeroExit: true });
      return r ? parseLineCount(r.stdout) : new Map();
    });
  }

  addOutside(item: CwpOutsideItem): void {
    if (this.state.outside.some((o) => o.kind === item.kind && o.key === item.key)) return;
    this.state.outside.push(item);
  }
}

// ── small shared helpers ─────────────────────────────────────────────────────

/** Syntax accepted by the executor for a path argument (§5.3): absolute, normalised, no glob / control character. */
export function isCleanPath(p: string): boolean {
  if (!p.startsWith('/') || p === '/' || p.endsWith('/') || p.includes('//') || Buffer.byteLength(p) > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f*?[\]\\]/.test(p)) return false;
  return !p.split('/').slice(1).some((s) => s === '.' || s === '..');
}

/** -1 / ≥ 999999 / '' / non-numeric → null (unlimited). */
export function cwpLimit(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (n < 0 || n >= 999999) return null;
  return n;
}

export function normFqdn(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '');
}

export function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** p is d or inside d. */
export function isUnder(p: string, d: string): boolean {
  const a = stripSlash(p);
  const b = stripSlash(d);
  return a === b || a.startsWith(`${b}/`);
}

/** CWP account owning a /home/<u>/… path. */
export function homeOwner(p: string): string | null {
  const m = /^\/home\/([^/]+)(?:\/|$)/.exec(p);
  return m ? m[1] : null;
}
