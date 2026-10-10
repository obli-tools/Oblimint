import type {
  MigrationStepOutcome, MigrationStepContext,
} from '../../contracts/execution';
import type {
  PlannedCertificate, PlannedCron, PlannedProxyHost, PlannedSite, PlanLimits,
} from '@oblimint/shared';
import { normalizePathPrefix } from '@oblimint/shared';
import { AppError } from '../../../../middleware/errorHandler';
import { localPaths } from '../../../hosting/paths';
import { StepError } from '../errors';
import type { AccountState, ReleaseState, SiteState } from './deps';
import { domainsToCreate, joinRemote, limitsCover, normalizeDataPath, StepEnv } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Web steps of the provider 'web-db' (docs/P5-PLAN.md §9.3): plan, account,
// domains, verification, sites (create / data / files / publish), proxy
// hosts, certificates, crons, FTP credential, finalize. Each one is
// idempotent through the object map (MG5): resolve → reuse (only migrated
// attributes refreshed) → else create + put. Nothing is ever deleted.
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_WAIT_MS = 15 * 60_000;
const SITE_WAIT_MS = 10 * 60_000;
const PUBLISH_WAIT_MS = 2 * 3600_000;
const PUBLISH_POLL_MS = 30_000;
const POLL_MS = 3_000;
/** Message of the releases the migration publishes (how an interrupted run recognises its own release). */
export const MIGRATION_RELEASE_MESSAGE = 'Migration CWP';
const RELEASE_IN_FLIGHT: readonly string[] = ['queued', 'scanning', 'publishing'];

/** A release the migration queued: its message AND its author (the run's creator) — never the message alone. */
export function isMigrationRelease(r: Pick<ReleaseState, 'message' | 'authorUserId'>, runCreator: number | null): boolean {
  return r.message === MIGRATION_RELEASE_MESSAGE && runCreator !== null && r.authorUserId === runCreator;
}
/** rsync exclude characters accepted by the executor (contracts/source.ts). */
const EXCLUDE_RE = /^[A-Za-z0-9._*?/@+-]{1,512}$/;

// ── plan ─────────────────────────────────────────────────────────────────────

export async function planStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const { account } = ctx;
  const tenantId = ctx.run.targetTenantId;
  if (account.planId !== null && account.planId !== undefined) {
    if (!(await env.deps.plans.exists(account.planId, tenantId))) {
      throw new StepError(`Le plan cible #${account.planId} n'existe plus dans le tenant cible : recalculez le plan de migration`, 'noPlan');
    }
    return env.outcome({ planId: account.planId, created: false });
  }
  const pkg = ctx.plan.packages.find((p) => p.key === account.packageKey);
  if (!pkg) throw new StepError(`Paquet ${account.packageKey} absent du plan de migration`, 'noPlan');
  if (pkg.action === 'existing') {
    if (!pkg.planId || !(await env.deps.plans.exists(pkg.planId, tenantId))) {
      throw new StepError(`Le plan existant choisi pour le paquet « ${pkg.name} » est introuvable dans le tenant cible`, 'noPlan');
    }
    return env.outcome({ planId: pkg.planId, created: false });
  }
  const mapped = await env.resolve('plan', pkg.key);
  if (mapped) return env.outcome({ planId: mapped, created: false });
  // Same name already in the tenant (created by hand, or by a crash between create and put): reused only when its limits suffice.
  // Concurrent runs of accounts sharing the package (claim() starts several at once, 'plan' is their first
  // step) race here: the loser's create gets planNameTaken — it then adopts what the winner created (mapping
  // or same name with sufficient limits) or moves on to the next name, never failing the run.
  const candidates = [pkg.name, ...Array.from({ length: 8 }, (_, i) => `${pkg.name} (${i + 2})`)];
  for (const n of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await env.deps.plans.findByName(tenantId, n);
      if (existing) {
        if (!limitsCover(existing.limits, pkg.limits as PlanLimits)) break; // next name
        await env.put('plan', pkg.key, existing.id, { name: n, adopted: true });
        return env.outcome({ planId: existing.id, created: false, adopted: true });
      }
      try {
        const created = await env.deps.plans.create(ctx.req, ctx.actor, {
          name: n, limits: pkg.limits, description: `Créé par la migration CWP (paquet ${pkg.cwpPackageId})`,
        });
        await env.put('plan', pkg.key, created.id, { name: n });
        await ctx.log('info', 'planCreated', { name: n, planId: created.id });
        return env.outcome({ planId: created.id, created: true });
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'planNameTaken') throw err;
        const raced = await env.resolve('plan', pkg.key);
        if (raced) return env.outcome({ planId: raced, created: false });
        // Same name created meanwhile: looked up again (adopted when sufficient, else the next name).
      }
    }
  }
  throw new StepError(`Impossible de trouver un nom libre pour le plan « ${pkg.name} »`, 'planNameTaken');
}

// ── account ──────────────────────────────────────────────────────────────────

export async function accountStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const { account } = ctx;
  let accountId: number | null = null;
  let created = false;
  if (account.existingAccountId) {
    const st = await env.deps.accounts.state(account.existingAccountId);
    if (st && st.tenantId === ctx.run.targetTenantId) accountId = st.id;
  }
  accountId ??= await env.resolve('account', env.username);
  if (!accountId) {
    // Crash between the creation and the object map write: the account the planner saw as free, created since.
    const same = await env.deps.accounts.findByUsername(account.targetUsername);
    if (same && same.tenantId === ctx.run.targetTenantId && same.createdAt >= ctx.plan.computedAt) {
      accountId = same.id;
      await ctx.log('warn', 'accountAdopted', { username: account.targetUsername, accountId });
    }
  }
  if (!accountId) {
    const planId = account.planId ?? await env.resolve('plan', account.packageKey) ?? Number((await ctx.stepResult('plan'))?.planId ?? 0);
    if (!planId) throw new StepError("Aucun plan cible : l'étape « plan » doit réussir avant le compte", 'noPlan');
    const contact = ctx.inventory.accounts.find((a) => a.username === env.username)?.contactEmail ?? null;
    const displayName = `${env.username}${contact ? ` — ${contact}` : ''} (CWP)`.slice(0, 200);
    const res = await env.deps.accounts.create(ctx.req, ctx.actor, { username: account.targetUsername, displayName, planId });
    accountId = res.id;
    created = true;
  }
  await env.put('account', env.username, accountId, { username: account.targetUsername });
  await ctx.setTargetAccountId(accountId);
  // hostd ensureAccount (tree + quota) must have run before any rsync: the reconcile marks the account active.
  const state = await env.waitFor('le provisionnement du compte', async () => {
    const st = await env.deps.accounts.state(accountId!);
    if (!st) throw new StepError('Le compte cible a disparu pendant son provisionnement', 'targetAccountMissing');
    if (st.status === 'active' || st.status === 'suspended') return st;
    if (st.status === 'error') throw new StepError(`Provisionnement du compte en erreur : ${st.statusMessage ?? 'voir le compte'}`, 'accountProvisionFailed');
    if (st.status === 'deleting') throw new StepError('Le compte cible est en cours de suppression', 'accountDeleting');
    return undefined;
  }, { timeoutMs: ACCOUNT_WAIT_MS, pollMs: POLL_MS });
  return env.outcome({ accountId, username: state.username, created });
}

// ── domains + verification ───────────────────────────────────────────────────

export async function domainsStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const domainIds: Record<string, number> = {};
  // Mail-only domains (servedBy 'none') too: mail-dns hangs the mail domain / zone on their row.
  for (const d of domainsToCreate(ctx.account)) {
    await ctx.checkpoint();
    let id = await env.resolve('domain', d.fqdn);
    if (!id) {
      const existing = await env.deps.domains.findByName(d.fqdn);
      if (existing && existing.accountId !== acc.id) {
        throw new StepError(`Le domaine ${d.fqdn} existe déjà sur la plateforme dans un autre compte`, 'domainExists', { fqdn: d.fqdn });
      }
      if (existing) id = existing.id;
      else {
        id = (await env.deps.domains.create(ctx.req, ctx.actor, {
          accountId: acc.id, name: d.fqdn, kind: d.kind, includeWww: d.includeWww, tlsMode: 'letsencrypt',
          // Migrated / parent zones are created and attached by the mail-dns provider (D-DNS).
          dnsZone: d.dnsZone === 'external' ? 'external' : 'none',
        })).id;
      }
      await env.put('domain', d.fqdn, id, { name: d.fqdn });
    }
    domainIds[d.fqdn] = id;
  }
  return env.outcome({ domainIds, count: Object.keys(domainIds).length });
}

export async function verificationStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const forced: string[] = [];
  const pending: string[] = [];
  for (const d of domainsToCreate(ctx.account)) {
    await ctx.checkpoint();
    const id = await env.resolve('domain', d.fqdn);
    if (!id) throw new StepError(`Domaine ${d.fqdn} introuvable : l'étape « domaines » doit réussir avant`, 'domainMissing');
    const state = await env.deps.domains.get(id);
    if (state?.verified) continue;
    if (d.verification === 'force') {
      await env.deps.domains.forceVerified(ctx.req, ctx.actor, id);
      // D1: a forced ownership is a staff decision (default only with public DNS proof): always traced.
      await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.domain_verification_forced', {
        fqdn: d.fqdn, domainId: id, runId: ctx.run.id, source: 'migration-cwp',
      });
      await ctx.log('info', 'domainVerificationForced', { fqdn: d.fqdn, reason: 'migration CWP' });
      forced.push(d.fqdn);
    } else pending.push(d.fqdn);
  }
  return env.outcome({ forced, pending });
}

// ── sites ────────────────────────────────────────────────────────────────────

async function siteOf(env: StepEnv, site: PlannedSite): Promise<SiteState> {
  const id = await env.resolve('site', site.key);
  const state = id ? await env.deps.sites.get(id) : null;
  if (!state) throw new StepError(`Site ${site.name} introuvable : l'étape de création du site doit réussir avant`, 'siteMissing');
  return state;
}

export async function siteCreateStep(ctx: MigrationStepContext, site: PlannedSite): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  let siteId = await env.resolve('site', site.key);
  let state = siteId ? await env.deps.sites.get(siteId) : null;
  if (!state) {
    state = await env.deps.sites.findBySlug(acc.id, site.slug);
    if (state) {
      // MG5: an unmapped site of the same slug is adopted ONLY as the leftover of a crash between its creation
      // and the object map write: created after the plan, never published, in an account the migration created.
      // Anything else (a site the client created since the plan) is never overwritten nor published over.
      const createdAfterPlan = !!state.createdAt && state.createdAt >= ctx.plan.computedAt;
      const neverPublished = state.currentReleaseId === null || state.currentReleaseId === undefined;
      if (ctx.account.existingAccountId || !createdAfterPlan || !neverPublished) {
        throw new StepError(`Un site « ${site.slug} » existe déjà dans le compte cible et n'a pas été créé par cette migration : il n'est pas écrasé (renommez-le, ou recalculez le plan)`,
          'siteSlugTaken', { slug: site.slug });
      }
      await ctx.log('warn', 'objectReused', { kind: 'site', key: site.key, id: state.id });
    }
    if (!state) {
      const created = await env.deps.sites.create(ctx.req, ctx.actor, {
        accountId: acc.id, name: site.name, slug: site.slug, base: site.base, appProfile: site.profile, docroot: site.docroot,
        applyProfileDataPaths: false,
      });
      state = await env.deps.sites.get(created.id);
      if (!state) throw new StepError(`Le site ${site.name} a disparu juste après sa création`, 'siteMissing');
    }
    siteId = state.id;
    await env.put('site', site.key, state.id, { name: site.name, slug: state.slug });
  }

  // Data paths of the plan (profile + discovery), added when missing.
  const existing = new Set((await env.deps.sites.dataPaths(state.id)).map((p) => p.path));
  for (const p of site.dataPaths) {
    if (existing.has(p.path)) continue;
    try {
      await env.deps.sites.addDataPath(ctx.req, ctx.actor, state.id, { path: p.path, policy: p.policy, allowedExtensions: p.allowedExtensions ?? null });
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
      env.warn('dataPathRejected', { kind: 'site', key: site.key }, { path: p.path, reason: err.code ?? 'refused' });
    }
  }

  // Secondary runtimes (subdirectory .htaccess forcing another PHP version).
  const runtimeIds = new Map<string, number>();
  const runtimes: Array<{ prefix: string; key: string; base: string }> = [];
  for (const rt of site.secondaryRuntimes) {
    const prefix = normalizePathPrefix(rt.pathPrefix);
    if (!prefix || prefix === '/') {
      env.warn('runtimePrefixInvalid', { kind: 'site', key: site.key }, { pathPrefix: rt.pathPrefix });
      continue;
    }
    runtimes.push({ prefix, key: `${site.key}:${prefix}`, base: rt.base });
  }
  const mappedRuntimes = new Set<number>();
  for (const rt of runtimes) {
    const id = await env.resolve('runtime', rt.key);
    if (id) { runtimeIds.set(rt.prefix, id); mappedRuntimes.add(id); }
  }
  let freeRuntimes: Array<{ id: number; base: string }> | null = null;
  for (const rt of site.secondaryRuntimes) {
    const prefix = normalizePathPrefix(rt.pathPrefix);
    const entry = runtimes.find((r) => r.prefix === prefix);
    if (!entry || runtimeIds.has(entry.prefix)) continue;
    // Crash between addRuntime and the object map write: an unmapped, unrouted runtime of the same base is ours (MG9).
    if (freeRuntimes === null) {
      const routed = new Set<number>();
      for (const r of site.routes) {
        const domainId = await env.resolve('domain', r.fqdn);
        if (!domainId) continue;
        for (const route of await env.deps.domains.routes(domainId)) if (route.runtimeId !== null) routed.add(route.runtimeId);
      }
      freeRuntimes = (await env.deps.sites.runtimes(state.id)).filter((r) => !mappedRuntimes.has(r.id) && !routed.has(r.id));
    }
    const idx = freeRuntimes.findIndex((r) => r.base === entry.base);
    let rtId: number;
    if (idx >= 0) {
      rtId = freeRuntimes.splice(idx, 1)[0].id;
      await ctx.log('info', 'objectReused', { kind: 'runtime', key: entry.key, id: rtId });
    } else {
      rtId = (await env.deps.sites.addRuntime(ctx.req, ctx.actor, state.id, rt.base)).id;
    }
    await env.put('runtime', entry.key, rtId, { base: rt.base, pathPrefix: entry.prefix });
    mappedRuntimes.add(rtId);
    runtimeIds.set(entry.prefix, rtId);
  }

  // Routes: each fqdn of the group → this site, and the secondary runtime prefixes on its root routes.
  const wanted: Array<{ fqdn: string; pathPrefix: string; runtimeId: number | null }> = [];
  for (const r of site.routes) {
    const prefix = normalizePathPrefix(r.pathPrefix) ?? '/';
    wanted.push({ fqdn: r.fqdn, pathPrefix: prefix, runtimeId: null });
    if (prefix === '/') for (const [rtPrefix, rtId] of runtimeIds) wanted.push({ fqdn: r.fqdn, pathPrefix: rtPrefix, runtimeId: rtId });
  }
  for (const w of wanted) {
    const domainId = await env.resolve('domain', w.fqdn);
    if (!domainId) throw new StepError(`Domaine ${w.fqdn} introuvable pour le site ${site.name}`, 'domainMissing');
    const routes = await env.deps.domains.routes(domainId);
    const taken = routes.find((r) => r.pathPrefix === w.pathPrefix);
    if (taken) {
      if (taken.siteId !== state.id) env.warn('routeConflict', { kind: 'site', key: site.key }, { fqdn: w.fqdn, pathPrefix: w.pathPrefix });
      continue;
    }
    await env.deps.domains.addRoute(ctx.req, ctx.actor, domainId, { pathPrefix: w.pathPrefix, siteId: state.id, runtimeId: w.runtimeId });
  }

  // The reconcile prepares the site (hostd ensureSite, storage, containers).
  const ready = await env.waitFor(`la préparation du site ${site.name}`, async () => {
    const s = await env.deps.sites.get(state!.id);
    if (!s) throw new StepError(`Le site ${site.name} a été supprimé pendant sa préparation`, 'siteMissing');
    return s.status === 'provisioning' ? undefined : s;
  }, { timeoutMs: SITE_WAIT_MS, pollMs: POLL_MS });
  if (ready.status === 'error') env.warn('siteProvisionError', { kind: 'site', key: site.key }, { message: (ready.statusMessage ?? '').slice(0, 300) });
  return env.outcome({ siteId: state.id, slug: state.slug });
}

/** Planned data paths whose content is copied (persistent / typed, relative, no '..'), normalized. */
export function plannedCopiedDataPaths(site: PlannedSite): string[] {
  return site.dataPaths
    .filter((p) => p.policy === 'persistent' || p.policy === 'typed')
    .map((p) => normalizeDataPath(p.path))
    .filter((p) => p !== '' && !p.split('/').includes('..'));
}

/** Data paths actually declared on the target site (a path the sites service refused is not one). */
async function declaredDataPaths(env: StepEnv, siteId: number): Promise<Set<string>> {
  return new Set((await env.deps.sites.dataPaths(siteId)).map((p) => normalizeDataPath(p.path)));
}

function dataPathsToCopy(site: PlannedSite, declared: ReadonlySet<string>): string[] {
  return plannedCopiedDataPaths(site).filter((p) => declared.has(p));
}

/** Directories of `paths` that exist on the source (fs.stat, MG10 enforced by the executor). */
async function remoteDirs(ctx: MigrationStepContext, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const session = await ctx.session();
  const res = await session.run('fs.stat', { paths }, { allowNonZeroExit: true, signal: ctx.signal });
  const out = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    const [name, type] = line.split('|');
    if (name && type === 'directory') out.add(name);
  }
  return out;
}

export async function siteDataStep(ctx: MigrationStepContext, site: PlannedSite): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const state = await siteOf(env, site);
  const paths = dataPathsToCopy(site, await declaredDataPaths(env, state.id));
  if (paths.length === 0) return env.skipped('noDataPath');
  await env.deps.sites.ensureTree(acc, state, paths);
  const remote = paths.map((p) => joinRemote(site.sourceRoot, p));
  const present = await remoteDirs(ctx, remote);
  const session = await ctx.session();
  const mirror = ctx.run.mirrorDeletes && !env.initial;
  let files = 0;
  let bytes = 0;
  let deleted = 0;
  let copied = 0;
  for (let i = 0; i < paths.length; i++) {
    await ctx.checkpoint();
    if (!present.has(remote[i])) continue;
    const res = await session.rsyncPull({
      remotePath: remote[i],
      localPath: `${localPaths.siteData(acc.id, state.slug)}/${paths[i]}`,
      binding: { kind: 'account', cwpUsername: env.username, targetAccountId: acc.id },
      uid: acc.uid, gid: acc.gid, preset: 'site-data',
      deleteExtraneous: mirror,
      bwLimitKbps: env.deps.config().rsyncBwLimitKbps || undefined,
      signal: ctx.signal,
      onProgress: (p) => ctx.progress({ bytes: bytes + p.bytes }),
    });
    copied++;
    files += res.files;
    bytes += res.bytes;
    deleted += res.deleted;
    if (res.unsafeLinks.length) env.warn('rsyncUnsafeLinks', { kind: 'site', key: site.key }, { path: paths[i], count: res.unsafeLinks.length, sample: res.unsafeLinks.slice(0, 5).join(', ') });
    if (res.partial) env.warn('rsyncPartial', { kind: 'site', key: site.key }, { path: paths[i] });
  }
  if (copied === 0) return env.skipped('dataPathsMissingOnSource', { paths: paths.length });
  return env.outcome({ siteId: state.id, paths: copied, files, bytes, deleted, mirror });
}

/**
 * rsync excludes of a site copy: the plan excludes + every data path declared on the site (anchored,
 * copied by the data step / ephemeral). A planned path the site refused stays in the release instead
 * of being lost. `declared` absent = every planned data path.
 */
export function siteExcludes(site: PlannedSite, declared?: ReadonlySet<string>): { excludes: string[]; rejected: string[] } {
  const dataPaths = site.dataPaths.map((p) => normalizeDataPath(p.path)).filter((p) => p !== '' && (!declared || declared.has(p)));
  const all = [...site.excludes, ...dataPaths.map((p) => `/${p}/`)];
  const excludes: string[] = [];
  const rejected: string[] = [];
  for (const e of all) {
    if (EXCLUDE_RE.test(e) && !e.split('/').includes('..')) {
      if (!excludes.includes(e)) excludes.push(e);
    } else rejected.push(e);
  }
  return { excludes, rejected };
}

export async function siteFilesStep(ctx: MigrationStepContext, site: PlannedSite): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const state = await siteOf(env, site);
  await env.deps.sites.ensureTree(acc, state, []);
  const { excludes, rejected } = siteExcludes(site, await declaredDataPaths(env, state.id));
  for (const r of rejected) env.warn('rsyncExcludeRejected', { kind: 'site', key: site.key }, { pattern: r.slice(0, 200) });
  const session = await ctx.session();
  const mirror = ctx.run.mirrorDeletes && !env.initial;
  const res = await session.rsyncPull({
    remotePath: site.sourceRoot.replace(/\/+$/, ''),
    localPath: localPaths.siteStaging(acc.id, state.slug),
    binding: { kind: 'account', cwpUsername: env.username, targetAccountId: acc.id },
    uid: acc.uid, gid: acc.gid, preset: 'site-files',
    excludes,
    deleteExtraneous: mirror,
    bwLimitKbps: env.deps.config().rsyncBwLimitKbps || undefined,
    signal: ctx.signal,
    onProgress: (p) => ctx.progress({ bytes: p.bytes, done: p.files }),
  });
  if (res.unsafeLinks.length) {
    env.warn('rsyncUnsafeLinks', { kind: 'site', key: site.key }, { count: res.unsafeLinks.length, sample: res.unsafeLinks.slice(0, 5).join(', ') });
  }
  if (res.partial) env.warn('rsyncPartial', { kind: 'site', key: site.key }, {});
  return env.outcome({ siteId: state.id, files: res.files, bytes: res.bytes, deleted: res.deleted, unsafeLinks: res.unsafeLinks.length, partial: res.partial, mirror });
}

export async function sitePublishStep(ctx: MigrationStepContext, site: PlannedSite): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const state = await siteOf(env, site);
  if (acc.status === 'suspended') {
    env.warn('accountSuspendedPublishSkipped', { kind: 'site', key: site.key }, { site: site.name });
    return env.skipped('accountSuspended');
  }
  const settle = async (releaseId: number): Promise<ReleaseState> => {
    const deadline = Date.now() + PUBLISH_WAIT_MS;
    for (;;) {
      await ctx.checkpoint();
      const r = await env.deps.releases.wait(state.id, releaseId, PUBLISH_POLL_MS);
      if (!RELEASE_IN_FLIGHT.includes(r.status)) return r;
      if (Date.now() >= deadline) throw new StepError(`La publication du site ${site.name} n'est pas terminée après 2 h`, 'publishTimeout');
    }
  };
  /** Records the release this run queued BEFORE waiting on it: a pause / restart follows it instead of publishing again (MG9). */
  const remember = (r: ReleaseState) => env.put('release', site.key, r.id, { number: r.number, runId: ctx.run.id, pending: true });

  // Resume: the release this run already queued (still in flight, awaiting approval or published) is followed.
  let release: ReleaseState | null = null;
  const entry = await env.deps.objectMap.get(env.sourceId, 'release', site.key);
  if (entry?.meta?.pending === true && entry.meta.runId === ctx.run.id) {
    let current: ReleaseState | null = null;
    try { current = await env.deps.releases.wait(state.id, entry.targetId, 0); } catch (err) {
      if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
    }
    // failed / rejected: interrupted by a panel restart (recoverInterrupted) or refused → published again below.
    if (current && current.status !== 'failed' && current.status !== 'rejected') {
      release = current;
      await ctx.log('info', 'objectReused', { kind: 'release', key: site.key, id: current.id, number: current.number, status: current.status });
    }
  }
  if (!release) {
    try {
      for (let attempt = 0; !release; attempt++) {
        try {
          release = await env.deps.releases.publish(state.id, { userId: env.createdBy, message: MIGRATION_RELEASE_MESSAGE });
        } catch (err) {
          if (!(err instanceof AppError) || err.code !== 'publishInProgress' || attempt >= 3) throw err;
          // A publication already runs on the site: ours (queued just before an interruption) is adopted,
          // another one (the client's) is waited for before ours is queued. "Ours" = queued by the run's
          // creator with our message: the message alone is client-settable (POST /releases), the author is not —
          // a client release is never adopted, nor approved with the staff scan override.
          const open = await env.deps.releases.inFlight(state.id);
          if (open && isMigrationRelease(open, env.createdBy)) release = open;
          else if (open) await settle(open.id);
          else await env.deps.sleep(POLL_MS);
        }
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'noChanges') return env.outcome({ siteId: state.id, unchanged: true });
      if (err instanceof AppError && err.code === 'stagingEmpty') {
        env.warn('siteStagingEmpty', { kind: 'site', key: site.key }, { site: site.name });
        return env.skipped('stagingEmpty');
      }
      throw err;
    }
    await remember(release);
    await ctx.log('info', 'releaseQueued', { site: site.name, releaseId: release.id, number: release.number });
  }
  if (RELEASE_IN_FLIGHT.includes(release.status)) release = await settle(release.id);
  if (release.status === 'awaiting_approval') {
    if (site.scanOverride && env.createdBy) {
      const reason = 'Migration CWP (dérogation staff)';
      const blocked = !!release.scan?.blocked;
      const approved = await env.deps.releases.approve(state.id, release.id, env.createdBy, { reason });
      // What the releases route audits for a staff approval (M5): the override of a blocked scan never goes untraced.
      const details = { siteId: state.id, releaseId: release.id, number: release.number, source: 'migration-cwp', runId: ctx.run.id };
      await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'release.approve', details);
      if (blocked || approved.scan?.override) {
        await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'release.approve.override', {
          ...details, risk: approved.scan?.risk ?? release.scan?.risk ?? null, reason,
        });
      }
      await ctx.log('warn', 'releaseApprovedOverride', { site: site.name, releaseId: release.id, blocked });
      release = await settle(release.id);
    } else {
      env.warn('publishAwaitingApproval', { kind: 'site', key: site.key }, { site: site.name, releaseId: release.id, blocked: !!release.scan?.blocked });
      return env.outcome({ siteId: state.id, releaseId: release.id, number: release.number, awaitingApproval: true });
    }
  }
  if (release.status !== 'ready') {
    throw new StepError(`Publication du site ${site.name} échouée (release n° ${release.number}) : ${release.error ?? release.status}`, 'publishFailed');
  }
  await env.put('release', site.key, release.id, { number: release.number, runId: ctx.run.id });
  return env.outcome({ siteId: state.id, releaseId: release.id, number: release.number });
}

// ── proxy hosts ──────────────────────────────────────────────────────────────

export async function proxyStep(ctx: MigrationStepContext, proxy: PlannedProxyHost): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const domainIds: number[] = [];
  for (const fqdn of proxy.fqdns) {
    const id = await env.resolve('domain', fqdn);
    if (!id) throw new StepError(`Domaine ${fqdn} introuvable pour l'hôte proxy ${proxy.name}`, 'domainMissing');
    domainIds.push(id);
  }
  const target = { kind: 'external' as const, host: proxy.target.host, port: proxy.target.port, scheme: proxy.target.scheme, allowPrivate: proxy.target.allowPrivate === true };
  if (target.allowPrivate) {
    // PX2: a private target only with the staff's explicit per-domain confirmation (plan choice): traced here too.
    await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.proxy_private_target', {
      proxy: proxy.name, host: target.host, port: target.port, account: acc.username, runId: ctx.run.id,
    });
  }
  let hostId = await env.resolve('proxyHost', proxy.key);
  if (!hostId) {
    // Crash between create and the object map write: the host of this account already bound to one of the domains is ours (MG9).
    for (const domainId of domainIds) {
      const bound = await env.deps.proxies.findByDomain(domainId);
      if (bound && bound.accountId === acc.id) {
        hostId = bound.id;
        await env.put('proxyHost', proxy.key, hostId, { name: proxy.name, adopted: true });
        await ctx.log('info', 'objectReused', { kind: 'proxyHost', key: proxy.key, id: hostId });
        break;
      }
    }
  }
  if (hostId) {
    await env.deps.proxies.update(ctx.req, ctx.actor, hostId, { domainIds, target, options: { websocket: proxy.websocket } });
  } else {
    hostId = (await env.deps.proxies.create(ctx.req, ctx.actor, {
      accountId: acc.id, name: proxy.name, domainIds, target, options: { websocket: proxy.websocket }, ssl: { mode: 'auto' },
    })).id;
    await env.put('proxyHost', proxy.key, hostId, { name: proxy.name });
  }
  return env.outcome({ proxyHostId: hostId, domainIds });
}

// ── certificates ─────────────────────────────────────────────────────────────

export async function certificateStep(ctx: MigrationStepContext, cert: PlannedCertificate): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  const scope = { kind: 'certificate' as const, key: cert.fqdn };
  const session = await ctx.session();
  // MG2: the bundle (private key) lives in this frame only, straight into its target.
  let bundle = await env.deps.secrets.certificateBundle(session, cert.fqdn);
  if (!bundle) {
    env.warn('certBundleMissing', scope, { fqdn: cert.fqdn });
    return env.skipped('bundleMissing');
  }
  try {
    if (cert.target === 'site-domain') {
      const installed: string[] = [];
      for (const fqdn of cert.domains) {
        const domainId = await env.resolve('domain', fqdn);
        if (!domainId) { env.warn('certImportSkipped', scope, { fqdn, reason: 'domainMissing' }); continue; }
        const r = await env.deps.certificates.installSiteCertificate(domainId, {
          certificatePem: bundle.certificatePem, chainPem: bundle.chainPem, privateKeyPem: bundle.privateKeyPem,
        });
        if (r.installed && r.certificateId) {
          await env.put('certificate', fqdn, r.certificateId, { notAfter: r.notAfter, source: cert.fqdn });
          installed.push(fqdn);
        } else {
          env.warn('certImportSkipped', scope, { fqdn, reason: r.reason ?? 'refused' }, r.reason === 'letsencryptValid' ? 'info' : 'warning');
        }
      }
      if (installed.length === 0) return env.skipped('notInstalled');
      await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'certificate', fqdn: cert.fqdn, domains: installed, account: acc.username });
      return env.outcome({ installed });
    }
    // Proxy host: imported_certificates + SSL 'imported' (back to 'auto' at the cutover).
    let importedId = await env.resolve('importedCertificate', cert.fqdn);
    const certName = `CWP ${cert.fqdn}`.slice(0, 100);
    if (!importedId) {
      // Crash between the import and the object map write: the account's certificate of the same name is ours (MG9).
      const existing = await env.deps.proxies.findImportedCertificate(acc.id, certName);
      if (existing) {
        importedId = existing;
        await ctx.log('info', 'objectReused', { kind: 'importedCertificate', key: cert.fqdn, id: existing });
      } else {
        try {
          importedId = (await env.deps.proxies.importCertificate(ctx.req, ctx.actor, {
            accountId: acc.id, name: certName, certificatePem: bundle.certificatePem,
            privateKeyPem: bundle.privateKeyPem, chainPem: bundle.chainPem,
          })).id;
        } catch (err) {
          if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
          env.warn('certImportSkipped', scope, { fqdn: cert.fqdn, reason: err.code ?? 'refused' });
          return env.skipped('importRefused', { code: err.code ?? null });
        }
      }
      await env.put('importedCertificate', cert.fqdn, importedId, { name: certName });
      await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'proxyCertificate', fqdn: cert.fqdn, account: acc.username });
    }
    const proxy = ctx.account.proxies.find((p) => p.certificateFqdn === cert.fqdn) ?? ctx.account.proxies.find((p) => p.fqdns.some((f) => cert.domains.includes(f)));
    const hostId = proxy ? await env.resolve('proxyHost', proxy.key) : null;
    if (!hostId) {
      env.warn('certImportSkipped', scope, { fqdn: cert.fqdn, reason: 'proxyHostMissing' });
      return env.outcome({ importedCertificateId: importedId });
    }
    await env.deps.proxies.update(ctx.req, ctx.actor, hostId, { ssl: { mode: 'imported', importedCertificateId: importedId } });
    return env.outcome({ importedCertificateId: importedId, proxyHostId: hostId });
  } finally {
    bundle = null;
  }
}

// ── crons ────────────────────────────────────────────────────────────────────

export async function cronStep(ctx: MigrationStepContext, cron: PlannedCron): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const siteId = await env.resolve('site', cron.siteKey);
  if (!siteId) throw new StepError(`Site ${cron.siteKey} introuvable pour la tâche planifiée ${cron.name}`, 'siteMissing');
  const input = { schedule: cron.schedule, command: cron.command, enabled: cron.enabled };
  try {
    const mapped = await env.resolve('cron', cron.key);
    if (mapped && await env.deps.crons.exists(siteId, mapped)) {
      await env.deps.crons.update(ctx.req, ctx.actor, siteId, mapped, input);
      return env.outcome({ cronJobId: mapped, siteId });
    }
    // Crash between create and the object map write: the site's job of the same name (unique per site) is ours —
    // never a second job running the CWP cron twice (MG9).
    const same = await env.deps.crons.findByName(siteId, cron.name);
    if (same) {
      await env.deps.crons.update(ctx.req, ctx.actor, siteId, same, input);
      await env.put('cron', cron.key, same, { name: cron.name, adopted: true });
      await ctx.log('info', 'objectReused', { kind: 'cron', key: cron.key, id: same });
      return env.outcome({ cronJobId: same, siteId });
    }
    const created = await env.deps.crons.create(ctx.req, ctx.actor, siteId, { name: cron.name, ...input });
    await env.put('cron', cron.key, created.id, { name: cron.name });
    return env.outcome({ cronJobId: created.id, siteId });
  } catch (err) {
    // A schedule / command refused by the plan rules is reported, the rest of the account still migrates.
    if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
    env.warn('cronRejected', { kind: 'cron', key: cron.key }, { name: cron.name, reason: err.code ?? 'refused', message: err.message.slice(0, 200) });
    return env.skipped('rejected', { code: err.code ?? null });
  }
}

// ── FTP credential ───────────────────────────────────────────────────────────

/** bcrypt hash as written by Pure-FTPd ($2a$ / $2b$ / $2y$, accepted as is by bcryptjs). */
export const BCRYPT_HASH_RE = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

export async function ftpStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const ftp = ctx.account.ftp;
  if (!ftp || !ftp.adopt) return env.skipped('notAdopted');
  const acc: AccountState = await env.account();
  const session = await ctx.session();
  let hash = await env.deps.secrets.ftpUserHash(session, ftp.login);
  try {
    if (!hash || !BCRYPT_HASH_RE.test(hash.trim())) {
      env.warn('ftpHashUnsupported', { kind: 'ftpUser', key: ftp.login }, { login: ftp.login, reason: hash ? 'notBcrypt' : 'missing' });
      return env.skipped('hashUnsupported');
    }
    await env.deps.files.setFileServerHash(ctx.req, acc, hash.trim());
    await env.put('ftpCredential', ftp.login, acc.id, { login: ftp.login });
    await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'ftp', login: ftp.login, account: acc.username });
    return env.outcome({ adopted: true, login: ftp.login, accountId: acc.id });
  } finally {
    hash = null;
  }
}

// ── finalize ─────────────────────────────────────────────────────────────────

export async function finalizeStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const acc = await env.account();
  let suspended = acc.status === 'suspended';
  if (ctx.account.suspended && !suspended) {
    // D-SUSPEND: last step, after the publications.
    await env.deps.accounts.setSuspended(ctx.req, ctx.actor, acc.id, true);
    suspended = true;
    await ctx.log('info', 'accountSuspended', { username: acc.username });
  }
  return env.outcome({
    accountId: acc.id, username: acc.username, suspended,
    sites: ctx.account.sites.length, databases: ctx.account.databases.length, proxies: ctx.account.proxies.length,
  });
}
