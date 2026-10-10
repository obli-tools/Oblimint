import crypto from 'crypto';
import type {
  MigrationAccountPlan, MigrationObjectKind, MigrationScopeKind, MigrationSeverity, MigrationWarning, PlanLimits, PlannedDomain,
} from '@oblimint/shared';
import type { MigrationStepContext, MigrationStepOutcome } from '../../contracts/execution';
import { StepError } from '../errors';
import { webDbDeps, type AccountState, type WebDbDeps } from './deps';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers shared by the web-db steps: step key encoding, object map access
// (MG5: resolve first, create + put otherwise), warnings, bounded waits that
// honour pause / cancel.
// ─────────────────────────────────────────────────────────────────────────────

export const MIB = 1024 * 1024;

/** Part of a step key from a plan key (fqdn, cron key…): kept when short, else a stable hash (keys ≤ 200 chars). */
export function keyPart(raw: string): string {
  return raw.length <= 150 ? raw : `h${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

/** Progress weight of a step moving `bytes` (MiB, ≥ 1). */
export function weightOf(bytes: number | null | undefined): number {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return 1;
  return Math.min(1_000_000, Math.max(1, Math.round(bytes / MIB)));
}

const TARGET_TABLE: Record<MigrationObjectKind, string> = {
  plan: 'plans',
  account: 'hosting_accounts',
  domain: 'domains',
  site: 'sites',
  dataPath: 'site_data_paths',
  runtime: 'site_runtimes',
  dbInstance: 'db_instances',
  database: 'db_databases',
  dbUser: 'db_users',
  zone: 'dns_zones',
  dnsRecord: 'dns_records',
  mailDomain: 'mail_domains',
  mailbox: 'mailboxes',
  alias: 'mail_aliases',
  dkimKey: 'mail_dkim_keys',
  proxyHost: 'proxy_hosts',
  cron: 'cron_jobs',
  certificate: 'certificates',
  importedCertificate: 'imported_certificates',
  ftpCredential: 'hosting_accounts',
  release: 'releases',
};

/** Everything a web-db step works with. */
export class StepEnv {
  readonly deps: WebDbDeps = webDbDeps();
  readonly warnings: MigrationWarning[] = [];

  constructor(readonly ctx: MigrationStepContext) {}

  get sourceId(): number { return this.ctx.run.sourceId; }
  get username(): string { return this.ctx.run.cwpUsername; }
  get initial(): boolean { return this.ctx.run.kind === 'initial'; }
  get createdBy(): number | null { return this.ctx.run.createdBy; }

  /**
   * Mapped target of (kind, key), only when it belongs to THIS run: recorded for this CWP user and, once the
   * account step ran, a row of the run's target account ('plan': a plan of the target tenant). A mapping of
   * another CWP user / account (source key reassigned on CWP) is NOT reused: the step's unmapped path checks
   * the owner of any same-name object (domainExists…) instead (tenant isolation).
   */
  resolve(kind: MigrationObjectKind, key: string): Promise<number | null> {
    if (kind === 'plan') return this.deps.objectMap.resolve(this.sourceId, kind, key, { tenantId: this.ctx.run.targetTenantId });
    if (kind === 'account') return this.deps.objectMap.resolve(this.sourceId, kind, key, { cwpUsername: this.username, tenantId: this.ctx.run.targetTenantId });
    return this.deps.objectMap.resolve(this.sourceId, kind, key, { cwpUsername: this.username, accountId: this.ctx.targetAccountId() });
  }

  async put(kind: MigrationObjectKind, key: string, targetId: number, meta: Record<string, unknown> | null = null): Promise<void> {
    await this.deps.objectMap.put({
      sourceId: this.sourceId, cwpUsername: this.username, kind, sourceKey: key, targetTable: TARGET_TABLE[kind], targetId, meta, runId: this.ctx.run.id,
    });
  }

  warn(code: string, scope: { kind: MigrationScopeKind; key: string }, params: Record<string, string | number | boolean | null> = {}, severity: MigrationSeverity = 'warning'): void {
    this.warnings.push({ code, params, severity, scope: { ...scope, account: this.username } });
  }

  /** Outcome: 'warning' as soon as a warning was raised. */
  outcome(result: Record<string, unknown>, status: 'done' | 'skipped' = 'done'): MigrationStepOutcome {
    const s = status === 'skipped' ? 'skipped' : this.warnings.some((w) => w.severity !== 'info') ? 'warning' : 'done';
    return { status: s, result, warnings: this.warnings.length ? this.warnings : undefined };
  }

  skipped(reason: string, params: Record<string, string | number | boolean | null> = {}): MigrationStepOutcome {
    return { status: 'skipped', result: { reason, ...params }, warnings: this.warnings.length ? this.warnings : undefined };
  }

  /** Target account of the run (account step done), else a French failure. */
  async account(): Promise<AccountState> {
    const id = this.ctx.targetAccountId() ?? await this.resolve('account', this.username);
    const state = id ? await this.deps.accounts.state(id) : null;
    if (!state || state.status === 'deleting') {
      throw new StepError("Le compte cible n'existe pas (ou est en cours de suppression) : relancez la migration initiale du compte", 'targetAccountMissing');
    }
    return state;
  }

  /** Polls `check` until it returns a value (not undefined), honouring pause / cancel. */
  async waitFor<T>(what: string, check: () => Promise<T | undefined>, opts: { timeoutMs: number; pollMs: number }): Promise<T> {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      await this.ctx.checkpoint();
      const v = await check();
      if (v !== undefined) return v;
      if (Date.now() >= deadline) throw new StepError(`Délai dépassé en attendant ${what} (${Math.round(opts.timeoutMs / 60_000)} min)`, 'waitTimeout');
      await this.deps.sleep(opts.pollMs);
    }
  }
}

/** Does an existing plan allow at least what the package needs (null = unlimited)? */
export function limitsCover(existing: PlanLimits, required: PlanLimits): boolean {
  const counts: Array<keyof PlanLimits> = [
    'diskMb', 'trafficMbPerMonth', 'maxSites', 'maxDomains', 'maxMailboxes', 'maxDatabases', 'maxDbInstances', 'dbMaxSizeMb',
    'maxCronJobs', 'mailQuotaMb', 'mailboxQuotaMaxMb', 'maxMailAliases', 'maxProxyHosts', 'maxRedirections',
  ];
  for (const k of counts) {
    const have = existing[k] as number | null | undefined;
    const need = required[k] as number | null | undefined;
    if (have === null || have === undefined) continue;
    if (need === null || need === undefined || need > have) return false;
  }
  if (required.proxyExternalTargets && !existing.proxyExternalTargets) return false;
  if (existing.allowedBases && (!required.allowedBases || !required.allowedBases.every((b) => existing.allowedBases!.includes(b)))) return false;
  if (existing.dbEngines && required.dbEngines !== undefined && (!required.dbEngines || !required.dbEngines.every((e) => existing.dbEngines!.includes(e)))) return false;
  if (existing.dbEngines && !existing.dbEngines.includes('mariadb')) return false;
  return true;
}

/** POSIX join of a source directory and a relative path (no '..', no double slash). */
export function joinRemote(root: string, rel: string): string {
  const r = root.replace(/\/+$/, '');
  const p = rel.replace(/^\/+|\/+$/g, '');
  return p ? `${r}/${p}` : r;
}

/**
 * Planned domains that get a domain row on the target: the ones a site / proxy host serves, and the
 * 'none' ones a migrated mail domain or zone hangs on (mail-only domains, docs/P5-PLAN.md D-MAIL / D-DNS).
 */
export function domainsToCreate(account: Pick<MigrationAccountPlan, 'domains' | 'mailDomains' | 'zones'>): PlannedDomain[] {
  const needed = new Set<string>();
  for (const m of account.mailDomains ?? []) {
    needed.add(m.name.toLowerCase());
    if (m.domain) needed.add(m.domain.toLowerCase());
  }
  for (const z of account.zones ?? []) if (z.domain) needed.add(z.domain.toLowerCase());
  return account.domains.filter((d) => d.servedBy !== 'none' || needed.has(d.fqdn.toLowerCase()));
}

/** Data path as stored by the sites service (no leading / trailing slash). */
export function normalizeDataPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}
