import {
  MIGRATION_PHASES, registerMigrationStepProvider,
  type MigrationStepContext, type MigrationStepOutcome, type MigrationStepPlanningInput, type MigrationStepProvider, type MigrationStepSpec,
} from '../../contracts/execution';
import { StepError } from '../errors';
import { dbGrantsStep, dbInstanceStep, dbUsersStep, databaseStep } from './databaseSteps';
import { domainsToCreate, keyPart, weightOf } from './helpers';
import {
  accountStep, certificateStep, cronStep, domainsStep, finalizeStep, ftpStep, planStep, plannedCopiedDataPaths, proxyStep, siteCreateStep,
  siteDataStep, siteFilesStep, sitePublishStep, verificationStep,
} from './webSteps';

// ─────────────────────────────────────────────────────────────────────────────
// Step provider 'web-db' (docs/P5-PLAN.md §9.3): plan, account, domains,
// verification, sites (create / data / files / publish), DB instance, DB users
// (native hashes BEFORE the import), databases (dump → spool → import with the
// DEFINER filter), grants, proxy hosts, certificates, crons, FTP credential,
// finalize (suspended state). OWNED BY MODULE `executor-web-db`.
//
// Step keys (stable across runs of an account):
//   plan · account · domains · verification · site:<key>:create · site:<key>:data · site:<key>:files ·
//   site:<key>:publish · db:instance · db:users · db:<name> · db:grants · proxy:<key> · cert:<fqdn> ·
//   cron:<key> · ftp · finalize
// (a plan key longer than 150 characters is replaced by a stable hash, keys ≤ 200).
// Labels: { code: 'steps.<name>', params } (client: t(`migration.steps.<name>`)).
// initial = every step the account plan needs; resync / final-sync = content only, by part:
//   data → site:*:data · files → site:*:files + site:*:publish · databases → db:users + db:<name>.
// ─────────────────────────────────────────────────────────────────────────────

type Exec = (ctx: MigrationStepContext) => Promise<MigrationStepOutcome>;

interface StepEntry {
  spec: MigrationStepSpec;
  exec: Exec;
}

const P = MIGRATION_PHASES;

function spec(key: string, phase: number, name: string, params: Record<string, string | number | boolean | null> = {}, weight = 1): MigrationStepSpec {
  return { key, provider: 'web-db', phase, label: { code: `steps.${name}`, params }, weight };
}

/** Every step of the run with its executor, in provider order (the engine sorts by phase). */
export function stepTable(input: MigrationStepPlanningInput): StepEntry[] {
  const { run, account } = input;
  const initial = run.kind === 'initial';
  const parts = new Set(run.parts);
  const want = (part: 'files' | 'data' | 'databases') => initial || parts.has(part);
  const out: StepEntry[] = [];
  const add = (s: MigrationStepSpec, exec: Exec) => out.push({ spec: s, exec });

  if (initial) {
    add(spec('plan', P.plan, 'plan', { package: account.packageKey }), planStep);
    add(spec('account', P.account, 'account', { username: account.targetUsername }), accountStep);
    // Served domains + the mail-only / zone-only ones (servedBy 'none') mail-dns attaches its objects to.
    const created = domainsToCreate(account);
    if (created.length) {
      add(spec('domains', P.domains, 'domains', { count: created.length }), domainsStep);
      add(spec('verification', P.verification, 'verification', { count: created.length }), verificationStep);
    }
  }

  for (const site of account.sites) {
    const k = keyPart(site.key);
    const params = { site: site.name };
    if (initial) add(spec(`site:${k}:create`, P.sites, 'siteCreate', params), (ctx) => siteCreateStep(ctx, site));
    if (want('data') && plannedCopiedDataPaths(site).length) {
      add(spec(`site:${k}:data`, P.siteData, 'siteData', params), (ctx) => siteDataStep(ctx, site));
    }
    if (want('files')) {
      add(spec(`site:${k}:files`, P.siteFiles, 'siteFiles', params, weightOf(site.estimatedBytes)), (ctx) => siteFilesStep(ctx, site));
      add(spec(`site:${k}:publish`, P.publish, 'sitePublish', params), (ctx) => sitePublishStep(ctx, site));
    }
  }

  if (account.dbInstance) {
    if (initial) add(spec('db:instance', P.dbInstance, 'dbInstance', { name: account.dbInstance.name }), dbInstanceStep);
    if (want('databases') && account.dbUsers.length) add(spec('db:users', P.dbUsers, 'dbUsers', { count: account.dbUsers.length }), dbUsersStep);
    if (want('databases')) {
      for (const d of account.databases) {
        // A database literally named instance / users / grants would collide with the fixed keys.
        const k = ['instance', 'users', 'grants'].includes(d.name) ? `database-${d.name}` : keyPart(d.name);
        add(spec(`db:${k}`, P.databases, 'database', { database: d.name }, weightOf(d.sizeBytes)), (ctx) => databaseStep(ctx, d));
      }
    }
    if (initial && account.dbUsers.some((u) => u.grants.length > 0)) add(spec('db:grants', P.dbGrants, 'dbGrants'), dbGrantsStep);
  }

  if (initial) {
    for (const proxy of account.proxies) {
      add(spec(`proxy:${keyPart(proxy.key)}`, P.proxies, 'proxy', { name: proxy.name }), (ctx) => proxyStep(ctx, proxy));
    }
    for (const cert of account.certificates) {
      add(spec(`cert:${keyPart(cert.fqdn)}`, P.certificates, 'certificate', { fqdn: cert.fqdn }), (ctx) => certificateStep(ctx, cert));
    }
    for (const cron of account.crons) {
      add(spec(`cron:${keyPart(cron.key)}`, P.crons, 'cron', { name: cron.name }), (ctx) => cronStep(ctx, cron));
    }
    if (account.ftp?.adopt) add(spec('ftp', P.ftp, 'ftp', { login: account.ftp.login }), ftpStep);
    add(spec('finalize', P.finalize, 'finalize', { suspended: account.suspended }), finalizeStep);
  }
  return out;
}

export const webDbProvider: MigrationStepProvider = {
  id: 'web-db',
  steps(input) {
    return stepTable(input).map((e) => e.spec);
  },
  async run(step, ctx) {
    const entry = stepTable(ctx).find((e) => e.spec.key === step.key);
    if (!entry) throw new StepError(`Étape ${step.key} inconnue pour ce compte (plan modifié ?)`, 'unknownStep');
    return entry.exec(ctx);
  },
};

registerMigrationStepProvider(webDbProvider);
