import {
  DB_ENGINE_VERSIONS, DEFAULT_PLAN_LIMITS, appProfileDef, normalizePathPrefix, normalizeRelPath, siteBaseDef,
  type AppProfileId, type CwpAccount, type CwpDatabase, type CwpDomain, type CwpDomainKind, type CwpInventory, type CwpPackage,
  type DataPathTemplate, type DomainKind, type MigrationAccountChoice, type MigrationAccountPlan, type MigrationDomainChoice,
  type MigrationFollowUp, type MigrationGlobalChoices, type MigrationPlanChoices, type MigrationPlanResult, type MigrationScope,
  type MigrationSecondaryRuntimeChoice, type MigrationSeverity, type MigrationWarning, type PlanLimits, type PlannedAlias,
  type PlannedCertificate, type PlannedCron, type PlannedDatabase, type PlannedDbInstance, type PlannedDbUser, type PlannedDkimKey,
  type PlannedDomain, type PlannedFtpCredential, type PlannedMailbox, type PlannedMailDomain, type PlannedPackage,
  type PlannedProxyHost, type PlannedSite, type PlannedZone, type SiteBaseId,
} from '@oblimint/shared';
import { isReservedName } from '../../databases/sql';
import { DOCKER_DEFAULT_RANGES, addressProblem } from '../../proxy/targets';
import { hostNameProblem } from '../../usage/notifications/ssrf';
import { ACCOUNT_USERNAME_RE, SITE_SLUG_RE, isReservedAccountUsername } from '../../hosting/hostingValidation.service';
import { catalogPlan, type PlanTargetContext, type TargetObjectMapFact } from './context';
import { executesFromData, minIntervalMinutes, normalizeSchedule, rewriteCronCommand, commandPaths, usedPaths } from './cron';
import { classifyPrivileges, definerUser, expandGrantPattern, isWildcardPattern, normalizePrivileges } from './dbGrants';
import {
  accountDomains, certificateUsable, defaultCronSelected, defaultDomainAs, defaultFtpAdoption, defaultPackagePlanName,
  effectiveGlobal, isCwpServiceSubdomain, isLocalServiceTarget, localAddresses,
} from './defaults';
import { rewriteZone, type MailManagedDomain } from './dns';
import { normalizePhpVersion, selectBase } from './php';
import {
  MIB, basename, canonicalIp, ceilMib, choicesHash, dirname, inZone, isCleanAbsolutePath, isPrivateAddress, lower, pathWithin,
  trimSlash, warning,
} from './util';

// ─────────────────────────────────────────────────────────────────────────────
// computePlan (docs/P5-PLAN.md §8): inventory × choices × target context →
// MigrationPlanResult = the dry-run. PURE and deterministic (no I/O, no clock:
// the reference time is target.now). The executors apply this result as is
// (they never re-derive anything), so every action is fully resolved here and
// everything a previous phase would refuse is reported as a BLOCKING warning
// instead (MG8). No secret ever enters the result (MG2: schemes / kinds only).
//
// Passes:
//   A. per account: selection, tenant, zones + mail domains of the plan
//      (cross-account facts: a domain's zone may live in another account);
//   B. per account: everything (sites, proxies, DB, DNS, mail, FTP, crons,
//      certificates) checked against the limits that are NOT raised;
//   C. packages → plans: created plans get the package mapping raised to the
//      largest account of the package (planLimitsRaised), then the overrides;
//   D. per account: enforced dimensions (blocking) and measured ones (warning)
//      against the final limits; blocked = any blocking warning.
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_KIND: Record<CwpDomainKind, DomainKind> = { main: 'primary', addon: 'addon', parked: 'alias', subdomain: 'subdomain' };
const PARENT_LAYOUT_DIRS = new Set(['public', 'web', 'www']);
/**
 * Markers found in the PARENT of a public/ web/ www/ docroot: discovery prefixes them with '../' only when the
 * parent holds an application (Laravel / Symfony…) whose suggested docroot is that directory.
 */
const PARENT_LAYOUT_MARKERS = /^\.\.\/[^/]/;
const DEFAULT_EXCLUDES = ['error_log', '.well-known/acme-challenge/'];
const EXCLUDE_RE = /^[A-Za-z0-9._*?/@+-]{1,255}$/;
const DEFAULT_INSTANCE_NAME = 'main';
const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const DB_USER_RE = /^[A-Za-z0-9_]{1,32}$/;
const MAX_SITE_NAME = 100;
const MAX_CRON_NAME = 100;

type Params = Record<string, string | number | boolean | null>;

interface AccountState {
  account: CwpAccount;
  choice: MigrationAccountChoice;
  selected: boolean;
  tenantId: number;
  /** cwp username of the account a zone / mail domain is attached to. */
  zones: string[];
  mailDomains: string[];
}

interface LimitSource {
  /** Limits checked by pass B (allowed bases, external proxies, DB engines): final for these dimensions. */
  limits: PlanLimits;
  existing: boolean;
  packageKey: string;
  planId: number | null;
  noPlan: boolean;
}

interface Usage {
  sites: number;
  domains: number;
  mailboxes: number;
  aliases: number;
  databases: number;
  instances: number;
  crons: number;
  proxyHosts: number;
  diskMb: number | null;
  mailQuotaMb: number;
  mailboxMaxMb: number;
  unlimitedMailbox: boolean;
  dbMaxMb: number;
  minCronInterval: number | null;
}

/** Index of the object map: kind|key → mapping. */
function objectIndex(target: PlanTargetContext): Map<string, TargetObjectMapFact> {
  const m = new Map<string, TargetObjectMapFact>();
  for (const o of target.objectMap) m.set(`${o.kind}|${o.sourceKey}`, o);
  return m;
}

/**
 * Target id of a mapping — with `user`, only when it was recorded for THAT CWP user: a source key moved
 * to another CWP account (domain sold / reassigned on CWP) is never "ours" for the new owner (tenant
 * isolation; the executors check the same, objectMap.resolveOwned).
 */
function mapped(idx: Map<string, TargetObjectMapFact>, kind: string, key: string, user?: string): number | null {
  const o = idx.get(`${kind}|${key}`);
  if (!o) return null;
  if (user !== undefined && o.cwpUsername !== user) return null;
  return o.targetId;
}

/** Plan limits mapped from a CWP package (§8.2); null quotas of CWP = unlimited. */
export function packageLimits(pkg: CwpPackage | null): PlanLimits {
  const l: PlanLimits = { ...DEFAULT_PLAN_LIMITS, maxSites: null, proxyExternalTargets: true, allowedBases: null };
  if (!pkg) return l;
  l.diskMb = pkg.diskQuotaMb;
  l.trafficMbPerMonth = pkg.bandwidthMbPerMonth;
  l.maxDomains = pkg.addonDomains === null || pkg.parkedDomains === null || pkg.subDomains === null
    ? null : 1 + pkg.addonDomains + pkg.parkedDomains + pkg.subDomains;
  l.maxMailboxes = pkg.emailAccounts;
  l.maxDatabases = pkg.databases;
  l.maxDbInstances = Math.max(1, DEFAULT_PLAN_LIMITS.maxDbInstances ?? 1);
  return l;
}

function suggestUsername(raw: string, taken: (u: string) => boolean): string {
  let base = lower(raw).replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `u${base}`;
  if (base.length < 3) base = `${base}-cwp`.slice(0, 32);
  base = base.slice(0, 32).replace(/-+$/, '');
  if (ACCOUNT_USERNAME_RE.test(base) && !isReservedAccountUsername(base) && !taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const cand = `${base.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (ACCOUNT_USERNAME_RE.test(cand) && !isReservedAccountUsername(cand) && !taken(cand)) return cand;
  }
  return `cwp-${Date.now() % 100000}`;
}

export function slugFrom(text: string): string {
  let s = lower(text).replace(/\./g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 40).replace(/-+$/, '');
  return SITE_SLUG_RE.test(s) ? s : 'site';
}

function uniqueSlug(base: string, taken: Set<string>): string | null {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const cand = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (SITE_SLUG_RE.test(cand) && !taken.has(cand)) return cand;
  }
  return null;
}

function certCovers(names: readonly string[], fqdn: string): boolean {
  return names.some((n) => {
    const name = lower(n);
    if (name === fqdn) return true;
    if (name.startsWith('*.')) {
      const rest = name.slice(2);
      return fqdn.endsWith(`.${rest}`) && !fqdn.slice(0, -(rest.length + 1)).includes('.');
    }
    return false;
  });
}

function pick<T>(values: Array<T | null | undefined>): T | null {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return null;
}

/**
 * Why the P4b proxy service would refuse this external target host whatever allowPrivate (proxy/targets.ts
 * addressProblem with the static forbidden ranges; host names: the static name rules only — resolution happens
 * at execution). null = acceptable as far as the planner can tell.
 */
export function proxyTargetProblem(host: string): string | null {
  const raw = String(host ?? '').trim().toLowerCase().replace(/.$/, '');
  const ip = canonicalIp(raw.replace(/^[|]$/g, ''));
  if (ip) return addressProblem(ip, { allowPrivate: true, forbiddenCidrs: DOCKER_DEFAULT_RANGES });
  return hostNameProblem(raw);
}

export function computePlan(
  inventory: CwpInventory, choices: MigrationPlanChoices, target: PlanTargetContext, discoveryId: number,
): MigrationPlanResult {
  const g: MigrationGlobalChoices = effectiveGlobal(inventory, target, choices.global);
  const idx = objectIndex(target);
  const localIps = localAddresses(inventory, g.sourceIps);
  const dnsOn = g.include.dns && target.catalog.dnsEnabled;
  const mailEngine = target.catalog.mailEngine;
  const mailOn = g.include.mail && (mailEngine === 'postfix-dovecot' || mailEngine === 'stalwart');
  const serverWarnings: MigrationWarning[] = [];
  const serverFollowUps: MigrationFollowUp[] = [];
  const tenants = new Set(target.catalog.tenants.map((t) => t.id));
  // A node that no longer exists would only fail at execution (account step): blocking here (dry-run guarantee).
  if (g.nodeId !== null && g.nodeId !== undefined && !target.catalog.nodes.some((n) => n.id === g.nodeId)) {
    serverWarnings.push(warning('blocking', 'nodeMissing', { kind: 'server', key: 'node', account: null }, { nodeId: g.nodeId }));
  }

  // ── discovery warnings: account-scoped ones go to their account ──────────
  const inventoryWarnings = new Map<string, MigrationWarning[]>();
  for (const w of inventory.warnings ?? []) {
    const acct = w.scope?.account ?? null;
    if (acct) inventoryWarnings.set(acct, [...(inventoryWarnings.get(acct) ?? []), w]);
    else serverWarnings.push(w);
  }
  const globalBlocked = serverWarnings.some((w) => w.severity === 'blocking');

  // ── A. selection, tenant, zones, mail domains ───────────────────────────
  const states = new Map<string, AccountState>();
  for (const account of inventory.accounts) {
    const choice = choices.accounts?.[account.username] ?? {};
    const skipSuspended = account.suspended && g.suspendedAccounts === 'skip';
    const selected = (choice.selected ?? true) && !skipSuspended;
    const existingAccountId = mapped(idx, 'account', account.username, account.username);
    const existing = existingAccountId !== null ? target.accounts.find((a) => a.id === existingAccountId) ?? null : null;
    const tenantId = existing?.tenantId ?? choice.tenantId ?? g.defaultTenantId;
    states.set(account.username, { account, choice, selected, tenantId, zones: [], mailDomains: [] });
  }

  // Zones of the plan (selected accounts, DNS on): attached account, or orphanZones choice.
  const zoneOwner = new Map<string, string>();
  for (const z of inventory.dnsZones) {
    const name = lower(z.name);
    const owner = z.account ?? choices.orphanZones?.[z.name]?.account ?? choices.orphanZones?.[name]?.account ?? null;
    if (!owner) {
      serverWarnings.push(warning('warning', 'zoneOrphan', { kind: 'zone', key: name, account: null }, { zone: name }));
      continue;
    }
    const st = states.get(owner);
    if (!st) continue;
    if (!st.selected || !dnsOn) continue;
    const zc = st.choice.zones?.[name] ?? st.choice.zones?.[z.name];
    if (zc?.selected === false) continue;
    // A zone file present on disk but not declared in named.conf is NOT served by the source BIND (forgotten
    // leftover, often the child zone of a subdomain of a migrated parent zone): importing it by default would make
    // PowerDNS serve its stale records instead of the parent zone's. Left out unless the staff opts in.
    if (z.declared === false) {
      const w = warning('warning', 'zoneNotDeclared', { kind: 'zone', key: name, account: owner }, { zone: name, selected: zc?.selected === true });
      inventoryWarnings.set(owner, [...(inventoryWarnings.get(owner) ?? []), w]);
      if (zc?.selected !== true) continue;
    }
    zoneOwner.set(name, owner);
    st.zones.push(name);
  }
  const zoneNames = [...zoneOwner.keys()];
  const zoneStatus = (fqdn: string): PlannedDomain['dnsZone'] => {
    if (!dnsOn) return 'external';
    if (zoneOwner.has(fqdn)) return 'migrated';
    return zoneNames.some((z) => z !== fqdn && inZone(fqdn, z)) ? 'parent' : 'external';
  };

  // Mail domains of the plan + DKIM imports (the zones drop what the P4 contributor publishes).
  const mailManaged = new Map<string, MailManagedDomain>();
  const dkimImport = (key: { bits: number | null; algorithm: string }, wanted: boolean | undefined): boolean =>
    wanted !== false && key.algorithm === 'rsa' && key.bits !== null && key.bits >= 2048 && key.bits <= 4096;
  if (mailOn) {
    for (const md of inventory.mailDomains) {
      const owner = md.account;
      const st = owner ? states.get(owner) : undefined;
      if (!st || !st.selected || md.backupMx) continue;
      const name = lower(md.name);
      if (st.choice.mailDomains?.[name]?.selected === false || st.choice.mailDomains?.[md.name]?.selected === false) continue;
      st.mailDomains.push(name);
      const selectors = inventory.dkimKeys
        .filter((k) => lower(k.domain) === name && dkimImport(k, st.choice.dkim?.[name]?.import ?? st.choice.dkim?.[`${name}/${k.selector}`]?.import))
        .map((k) => k.selector);
      mailManaged.set(name, { name, dkimSelectors: selectors });
    }
  }

  // ── package / plan resolution (pre-raise limits for pass B) ─────────────
  const packagesById = new Map(inventory.packages.map((p) => [p.id, p]));
  const createdLimits = new Map<string, PlanLimits>();
  const limitSourceOf = (st: AccountState): LimitSource => {
    const pkgId = st.account.packageId;
    const pkg = pkgId !== null ? packagesById.get(pkgId) ?? null : null;
    const packageKey = `${pkg ? pkg.id : 'none'}@${st.tenantId}`;
    if (st.choice.planId) {
      const p = catalogPlan(target, st.choice.planId);
      if (p && p.tenantId === st.tenantId) return { limits: p.limits, existing: true, packageKey, planId: p.id, noPlan: false };
      return { limits: packageLimits(null), existing: true, packageKey, planId: null, noPlan: true };
    }
    if (!pkg) return { limits: packageLimits(null), existing: true, packageKey, planId: null, noPlan: true };
    const pc = choices.packages?.[String(pkg.id)] ?? { action: 'create' as const };
    if (pc.action === 'existing') {
      const planId = pc.planIds?.[String(st.tenantId)] ?? null;
      const p = planId ? catalogPlan(target, planId) : null;
      if (p && p.tenantId === st.tenantId) return { limits: p.limits, existing: true, packageKey, planId: p.id, noPlan: false };
      return { limits: packageLimits(pkg), existing: true, packageKey, planId: null, noPlan: true };
    }
    let limits = createdLimits.get(packageKey);
    if (!limits) {
      limits = { ...packageLimits(pkg), ...(pc.limits ?? {}) } as PlanLimits;
      createdLimits.set(packageKey, limits);
    }
    return { limits, existing: false, packageKey, planId: null, noPlan: false };
  };

  // Usernames claimed by the plan (unique across accounts) + the platform's.
  const claimed = new Set<string>();
  const platformUser = new Map(target.accounts.map((a) => [a.username, a.id]));

  const accountsOut: MigrationAccountPlan[] = [];
  const usages = new Map<string, Usage>();
  const limitSources = new Map<string, LimitSource>();

  // ── B. per account ───────────────────────────────────────────────────────
  for (const account of inventory.accounts) {
    const st = states.get(account.username)!;
    const user = account.username;
    const choice = st.choice;
    const warnings: MigrationWarning[] = [...(inventoryWarnings.get(user) ?? [])];
    const followUps: MigrationFollowUp[] = [];
    const scope = (kind: MigrationScope['kind'], key: string): MigrationScope => ({ kind, key, account: user });
    const warn = (severity: MigrationSeverity, code: string, s: MigrationScope, params?: Params) => warnings.push(warning(severity, code, s, params));
    const acctScope = scope('account', user);

    // Account, tenant, name, plan.
    const existingAccountId = (() => {
      const id = mapped(idx, 'account', user, user);
      return id !== null && target.accounts.some((a) => a.id === id) ? id : null;
    })();
    const existingAccount = existingAccountId !== null ? target.accounts.find((a) => a.id === existingAccountId)! : null;
    if (!tenants.has(st.tenantId)) warn('blocking', 'tenantMissing', acctScope, { tenantId: st.tenantId });
    if (account.reseller) warn('warning', 'resellerAccount', acctScope, { reseller: account.reseller });
    const suspended = st.account.suspended
      ? (choice.suspended ?? (g.suspendedAccounts === 'keep-suspended'))
      : (choice.suspended ?? false);
    if (account.suspended) {
      warn('info', 'accountSuspended', acctScope, { action: g.suspendedAccounts === 'skip' ? 'skip' : suspended ? 'keep-suspended' : 'activate' });
    }

    let targetUsername: string;
    if (existingAccount) {
      targetUsername = existingAccount.username;
    } else {
      targetUsername = lower(choice.targetUsername ?? user);
      const takenBy = (u: string) => claimed.has(u) || (platformUser.has(u) && platformUser.get(u) !== existingAccountId);
      if (!ACCOUNT_USERNAME_RE.test(targetUsername) || isReservedAccountUsername(targetUsername)) {
        warn('blocking', 'usernameInvalid', acctScope, { username: targetUsername, suggestion: suggestUsername(targetUsername, takenBy) });
      } else if (takenBy(targetUsername)) {
        warn('blocking', 'usernameTaken', acctScope, { username: targetUsername, suggestion: suggestUsername(targetUsername, takenBy) });
      }
    }
    if (st.selected) claimed.add(targetUsername);

    const ls = limitSourceOf(st);
    limitSources.set(user, ls);
    if (ls.noPlan) warn('blocking', 'noPlan', acctScope, { packageId: account.packageId, tenantId: st.tenantId });
    const L = ls.limits;

    // ── domains → sites / proxies ──
    const domains = accountDomains(inventory, user);
    const main = domains.find((d) => d.kind === 'main') ?? null;
    const domainChoice = (d: CwpDomain): MigrationDomainChoice => choice.domains?.[lower(d.fqdn)] ?? choice.domains?.[d.fqdn] ?? {};
    const asOf = new Map<string, NonNullable<MigrationDomainChoice['as']>>();
    for (const d of domains) {
      const fqdn = lower(d.fqdn);
      const c = domainChoice(d);
      if (isCwpServiceSubdomain(d)) {
        warn('info', 'cwpServiceSubdomain', scope('domain', fqdn), { fqdn });
        asOf.set(fqdn, 'skip');
        continue;
      }
      let as = c.selected === false ? 'skip' : (c.as ?? defaultDomainAs(d, main, localIps));
      if (as === 'proxy' && !g.include.proxies) as = 'skip';
      if ((as === 'site' || as === 'alias') && !g.include.files) as = 'skip';
      asOf.set(fqdn, as);
      if (d.duplicateOf) warn('info', 'domainDuplicate', scope('domain', fqdn), { fqdn, kind: d.kind, duplicateOf: d.duplicateOf });
      if (d.serving === 'redirect') {
        warn('warning', 'redirectDomain', scope('domain', fqdn), { fqdn, target: d.redirectTo });
        if (as === 'skip') followUps.push({ code: 'redirectDomain', params: { fqdn, target: d.redirectTo }, scope: scope('domain', fqdn), suggestion: 'proxy-host' });
      }
      if (d.serving === 'disabled') warn('info', 'disabledVhost', scope('domain', fqdn), { fqdn });
      if (d.customTemplate) warn('warning', 'customTemplate', scope('domain', fqdn), { fqdn, nginx: d.nginxTemplate, apache: d.apacheTemplate });
    }

    // Site groups (D-SITE): explicit siteKey, else the effective docroot; 'alias' joins the main domain's group.
    const groupOf = new Map<string, string>();
    const docrootGroup = (d: CwpDomain): string => (d.docroot ? `docroot:${trimSlash(d.docroot)}` : `fqdn:${lower(d.fqdn)}`);
    // An explicit site key joins the group of the domain it names (a planned site key is its first fqdn), else its own.
    const explicitKey = (d: CwpDomain): string | null => { const k = domainChoice(d).siteKey; return k ? lower(k) : null; };
    const mainGroup = main && asOf.get(lower(main.fqdn)) === 'site' && !explicitKey(main) ? docrootGroup(main) : null;
    for (const d of domains) {
      const fqdn = lower(d.fqdn);
      const as = asOf.get(fqdn);
      if (explicitKey(d)) continue;
      if (as === 'site') groupOf.set(fqdn, docrootGroup(d));
      else if (as === 'alias') groupOf.set(fqdn, mainGroup ?? docrootGroup(d));
    }
    for (const d of domains) {
      const fqdn = lower(d.fqdn);
      const as = asOf.get(fqdn);
      const k = explicitKey(d);
      if (k && (as === 'site' || as === 'alias')) groupOf.set(fqdn, groupOf.get(k) ?? `key:${k}`);
    }
    const groups = new Map<string, CwpDomain[]>();
    for (const d of domains) {
      const gid = groupOf.get(lower(d.fqdn));
      if (gid) groups.set(gid, [...(groups.get(gid) ?? []), d]);
    }

    // Slugs: existing slugs of the target account (except the ones of OUR sites, mapped).
    const ourSiteIds = new Set(target.objectMap.filter((o) => o.kind === 'site' && (o.cwpUsername === user || o.cwpUsername === null)).map((o) => o.targetId));
    const takenSlugs = new Set(target.sites.filter((s) => existingAccountId !== null && s.accountId === existingAccountId && !ourSiteIds.has(s.id)).map((s) => s.slug));

    const sites: PlannedSite[] = [];
    const siteOfFqdn = new Map<string, PlannedSite>();
    for (const [gid, members] of groups) {
      const keyDomain = gid.startsWith('key:') ? (members.find((m) => lower(m.fqdn) === gid.slice(4)) ?? members[0]) : members[0];
      const key = lower(keyDomain.fqdn);
      const ordered = [keyDomain, ...members.filter((m) => m !== keyDomain)];
      const cs = ordered.map(domainChoice);
      const sScope = scope('site', key);

      // Source root + docroot.
      const chosenRoot = pick(cs.map((c) => c.sourceRoot));
      const docrootAbs = pick(ordered.map((d) => d.docroot));
      let sourceRoot: string | null = null;
      let docroot = '';
      if (chosenRoot) {
        const root = trimSlash(chosenRoot);
        if (!isCleanAbsolutePath(root) || !pathWithin(root, account.homeDir) || trimSlash(root) === trimSlash(account.homeDir)) {
          warn('blocking', 'docrootMissing', sScope, { fqdn: key, path: chosenRoot, reason: 'outsideHome' });
        } else sourceRoot = root;
        const rel = pick(cs.map((c) => c.docroot));
        if (rel !== null) {
          const n = normalizeRelPath(rel, true);
          if (n === null) warn('blocking', 'docrootMissing', sScope, { fqdn: key, path: rel, reason: 'invalidDocroot' });
          else docroot = n;
        } else if (sourceRoot && docrootAbs && pathWithin(docrootAbs, sourceRoot)) {
          docroot = normalizeRelPath(trimSlash(docrootAbs).slice(sourceRoot.length), true) ?? '';
        }
      } else if (docrootAbs) {
        const abs = trimSlash(docrootAbs);
        const app = keyDomain.app;
        const parent = dirname(abs);
        // Only markers found in the parent (prefixed '../') make it the app root: a Laravel app whose root IS
        // the docroot (unprefixed markers) is copied as is.
        const parentLayout = PARENT_LAYOUT_DIRS.has(basename(abs))
          && (app?.markers ?? []).some((m) => PARENT_LAYOUT_MARKERS.test(m))
          && pathWithin(parent, account.homeDir) && trimSlash(parent) !== trimSlash(account.homeDir);
        sourceRoot = parentLayout ? parent : abs;
        docroot = parentLayout ? basename(abs) : '';
        const rel = pick(cs.map((c) => c.docroot));
        if (rel !== null) {
          const n = normalizeRelPath(rel, true);
          if (n === null) warn('blocking', 'docrootMissing', sScope, { fqdn: key, path: rel, reason: 'invalidDocroot' });
          else docroot = n;
        }
        if (!isCleanAbsolutePath(sourceRoot) || !pathWithin(sourceRoot, account.homeDir)) {
          warn('blocking', 'docrootMissing', sScope, { fqdn: key, path: sourceRoot, reason: 'outsideHome' });
        }
      } else {
        warn('blocking', 'docrootMissing', sScope, { fqdn: key, path: null, reason: 'noDocroot' });
      }
      if (ordered.some((d) => d.docrootNonStandard)) warn('info', 'docrootNonStandard', sScope, { fqdn: key, path: docrootAbs });

      // Base (D-PHP) + profile + data paths.
      const php = pick(ordered.map((d) => d.php));
      const app = pick(ordered.map((d) => d.app));
      const chosenBase = pick(cs.map((c) => c.base)) as SiteBaseId | null;
      const sel = selectBase(php, { choice: chosenBase, htaccess: !!app?.htaccess, allowedBases: L.allowedBases });
      for (const m of sel.warnings) warn(m.severity, m.code, sScope, { fqdn: key, ...m.params });
      const profile = (pick(cs.map((c) => c.profile)) ?? app?.profile ?? null) as AppProfileId | null;
      // Profile data paths are relative to the APP root (P1: release root). The profile is detected from markers
      // at the docroot ('../' = in its parent): when that directory is below the copied root (a sourceRoot /
      // docroot choice), the paths are re-based on it — else uploads would land in the release as code.
      let dataPrefix = '';
      if (profile && app?.profile === profile && docrootAbs && sourceRoot) {
        const abs = trimSlash(docrootAbs);
        const appDir = (app.markers ?? []).some((m) => PARENT_LAYOUT_MARKERS.test(m)) ? dirname(abs) : abs;
        if (pathWithin(appDir, sourceRoot) && trimSlash(appDir) !== trimSlash(sourceRoot)) {
          dataPrefix = normalizeRelPath(trimSlash(appDir).slice(trimSlash(sourceRoot).length), true) ?? '';
        }
      }
      if (dataPrefix) warn('info', 'dataPathsRebased', sScope, { fqdn: key, prefix: dataPrefix });
      const dataPaths: DataPathTemplate[] = profile
        ? appProfileDef(profile).dataPaths.map((d) => ({
          ...d, path: dataPrefix ? `${dataPrefix}/${d.path}` : d.path, allowedExtensions: d.allowedExtensions ? [...d.allowedExtensions] : undefined,
        }))
        : [];
      for (const dp of dataPaths) if (dp.allowedExtensions === undefined) delete dp.allowedExtensions;

      // Secondary runtimes (.htaccess of a sub-directory forcing another PHP version).
      let secondaryRuntimes: MigrationSecondaryRuntimeChoice[] = [];
      const chosenRuntimes = pick(cs.map((c) => c.secondaryRuntimes));
      if (chosenRuntimes) {
        for (const r of chosenRuntimes) {
          const prefix = normalizePathPrefix(r.pathPrefix);
          if (prefix && prefix !== '/') secondaryRuntimes.push({ pathPrefix: prefix, base: r.base });
        }
      } else if (!chosenBase) {
        for (const o of php?.htaccessOverrides ?? []) {
          let rel = o.path;
          if (rel.startsWith('/') && docrootAbs && pathWithin(rel, docrootAbs)) rel = trimSlash(rel).slice(trimSlash(docrootAbs).length);
          const prefix = normalizePathPrefix(rel);
          if (!prefix || prefix === '/') continue;
          const sub = selectBase({ version: o.version, handler: 'suphp', source: 'htaccess', htaccessOverrides: [] }, { allowedBases: L.allowedBases });
          warn('info', 'phpHtaccessOverride', sScope, { fqdn: key, path: prefix, version: normalizePhpVersion(o.version), base: sub.base });
          for (const m of sub.warnings) warn(m.severity, m.code, sScope, { fqdn: key, path: prefix, ...m.params });
          if (sub.base !== sel.base) secondaryRuntimes.push({ pathPrefix: prefix, base: sub.base });
        }
      }
      secondaryRuntimes = secondaryRuntimes.filter((r, i, arr) => arr.findIndex((x) => x.pathPrefix === r.pathPrefix) === i)
        .sort((a, b) => a.pathPrefix.localeCompare(b.pathPrefix));

      const excludes = [...new Set([...DEFAULT_EXCLUDES, ...(pick(cs.map((c) => c.excludes)) ?? []).filter((e) => EXCLUDE_RE.test(e) && !e.includes('..'))])];

      if (ordered.some((d) => d.varnish)) warn('info', 'varnishBackend', sScope, { fqdn: key });

      // Slug (unique per account, existing slugs included; our own earlier site keeps its slug).
      const mappedSiteId = mapped(idx, 'site', key, user);
      const mappedSlug = mappedSiteId !== null && existingAccountId !== null
        ? target.sites.find((s) => s.id === mappedSiteId && s.accountId === existingAccountId)?.slug ?? null : null;
      const slug = mappedSlug ?? uniqueSlug(slugFrom(key), takenSlugs);
      if (!slug) warn('blocking', 'siteSlugTaken', sScope, { fqdn: key, slug: slugFrom(key) });
      const finalSlug = slug ?? slugFrom(key);
      takenSlugs.add(finalSlug);

      const site: PlannedSite = {
        key,
        name: key.slice(0, MAX_SITE_NAME),
        slug: finalSlug,
        base: sel.base,
        unmaintained: sel.unmaintained,
        profile,
        sourceRoot: sourceRoot ?? '',
        docroot,
        routes: ordered.map((d) => ({ fqdn: lower(d.fqdn), pathPrefix: '/' })),
        dataPaths,
        secondaryRuntimes,
        excludes,
        php,
        estimatedBytes: pick(ordered.map((d) => d.docrootBytes)),
        scanOverride: g.scanOverride,
      };
      sites.push(site);
      for (const d of ordered) siteOfFqdn.set(lower(d.fqdn), site);
    }
    // Nested docroots: a site inside another site of the account is copied apart (its own subtree).
    // The outer site's copy EXCLUDES the nested tree: otherwise the nested site's uploads (data there, inert)
    // would also be served from the outer release as executable code (/blog/wp-content/uploads/x.php).
    for (const s of sites) {
      for (const outer of sites) {
        if (outer === s || !outer.sourceRoot || !s.sourceRoot || !pathWithin(s.sourceRoot, outer.sourceRoot)) continue;
        if (trimSlash(s.sourceRoot) === trimSlash(outer.sourceRoot)) continue;
        const rel = trimSlash(s.sourceRoot).slice(trimSlash(outer.sourceRoot).length).replace(/^\/+/, '');
        const pattern = `/${rel.replace(/[^A-Za-z0-9._@+/-]/g, '?')}/`;
        if (rel && EXCLUDE_RE.test(pattern) && !pattern.includes('..')) {
          if (!outer.excludes.includes(pattern)) outer.excludes.push(pattern);
        } else {
          warn('blocking', 'docrootNestedNotExcluded', scope('site', outer.key), { fqdn: outer.key, nested: s.key, path: s.sourceRoot });
        }
      }
      const outer = sites.filter((o) => o !== s && o.sourceRoot && s.sourceRoot && pathWithin(s.sourceRoot, o.sourceRoot) && trimSlash(s.sourceRoot) !== trimSlash(o.sourceRoot))
        .sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0];
      if (outer) warn('warning', 'docrootNested', scope('site', s.key), { fqdn: s.key, parent: outer.key, path: s.sourceRoot });
    }
    if (account.phpIniFiles.length && sites.length) warn('info', 'phpIni', acctScope, { files: account.phpIniFiles.length, sample: account.phpIniFiles[0] });

    // Proxies (D-PROXY): grouped by identical target.
    const proxies: PlannedProxyHost[] = [];
    const proxyOfFqdn = new Map<string, PlannedProxyHost>();
    const externalAllowed = L.proxyExternalTargets && target.externalTargetsByTenant[String(st.tenantId)] === true;
    let proxyRefused = { plan: false, tenant: false, count: 0 };
    for (const d of domains) {
      const fqdn = lower(d.fqdn);
      if (isCwpServiceSubdomain(d)) continue;
      const c = domainChoice(d);
      const t = c.proxy
        ? { host: lower(c.proxy.host), port: c.proxy.port, scheme: c.proxy.scheme, websocket: c.proxy.websocket, isPrivate: isPrivateAddress(c.proxy.host), via: d.proxy?.via ?? 'nginx-vhost' }
        : d.proxy ? { ...d.proxy, host: lower(d.proxy.host) } : null;
      const pScope = scope('proxy', fqdn);
      if (t && isLocalServiceTarget(t, localIps)) {
        warn('warning', 'proxyLocalService', pScope, { fqdn, host: t.host, port: t.port });
        followUps.push({ code: 'proxyLocalService', params: { fqdn, host: t.host, port: t.port }, scope: pScope, suggestion: 'docker-app' });
      }
      if (asOf.get(fqdn) !== 'proxy') continue;
      if (!t) { warn('blocking', 'proxyTargetMissing', pScope, { fqdn }); continue; }
      if (t.via === 'varnish') warn('warning', 'varnishBackend', pScope, { fqdn, host: t.host, port: t.port });
      if (!externalAllowed) {
        // PX2: plan limit AND tenant apps policy. A plan created by the migration allows it (§8.2), so with the
        // defaults the usual cause is the tenant policy (no tenant_app_policies row = refused).
        const tenantOk = target.externalTargetsByTenant[String(st.tenantId)] === true;
        warn('blocking', 'proxyExternalNotAllowed', pScope, {
          fqdn, plan: L.proxyExternalTargets, tenant: tenantOk, reason: !L.proxyExternalTargets ? 'plan' : 'tenantPolicy', tenantId: st.tenantId,
        });
        proxyRefused = { plan: proxyRefused.plan || !L.proxyExternalTargets, tenant: proxyRefused.tenant || !tenantOk, count: proxyRefused.count + 1 };
      }
      // PX2: a private target (RFC1918 / CGNAT / ULA…) comes from config the CWP CLIENT controls (vhost
      // proxy_pass, ~/.conf/webservers JSON). P4b only lets PLATFORM staff set allowPrivate: a default "allowed"
      // would be the CWP client setting it. Blocking until the staff confirms it for this domain (choice
      // proxyAllowPrivate, audited with the plan choices and at the proxy creation); P5-PLAN D-PROXY aligned.
      const allowPrivate = t.isPrivate && c.proxyAllowPrivate === true;
      if (t.isPrivate) {
        warn(allowPrivate ? 'warning' : 'blocking', 'proxyPrivateTarget', pScope, { fqdn, host: t.host, port: t.port, scheme: t.scheme, allowed: allowPrivate });
      }
      // MG8: what the P4b proxy service refuses whatever the flags (reserved / documentation / loopback / Docker
      // ranges, forbidden names…) is blocking here, not a failed step (the service re-checks with the live
      // Docker subnets and node addresses, and resolves names).
      const refused = proxyTargetProblem(t.host);
      if (refused) warn('blocking', 'proxyTargetRefused', pScope, { fqdn, host: t.host, port: t.port, reason: refused });
      if (t.websocket) warn('info', 'proxyWebsocket', pScope, { fqdn });
      const gk = `${t.scheme}://${t.host}:${t.port}`;
      let ph = proxies.find((p) => `${p.target.scheme}://${p.target.host}:${p.target.port}` === gk);
      if (!ph) {
        ph = { key: fqdn, name: fqdn.slice(0, 128), fqdns: [], target: { host: t.host, port: t.port, scheme: t.scheme, allowPrivate }, websocket: false, certificateFqdn: null };
        proxies.push(ph);
      } else {
        ph.target.allowPrivate = ph.target.allowPrivate && allowPrivate;
      }
      ph.fqdns.push(fqdn);
      ph.websocket = ph.websocket || t.websocket;
      proxyOfFqdn.set(fqdn, ph);
    }
    if (proxyRefused.count) {
      // One actionable follow-up per account: what to enable (tenant policy and / or the target plan).
      followUps.push({
        code: 'proxyExternalNotAllowed',
        params: { tenantId: st.tenantId, plan: !proxyRefused.plan, tenant: !proxyRefused.tenant, reason: proxyRefused.tenant ? 'tenantPolicy' : 'plan', domains: proxyRefused.count },
        scope: acctScope,
        suggestion: 'manual',
      });
    }

    // ── mail domains needing a domain row (servedBy none) ──
    const domainRows = new Map<string, PlannedDomain>();
    // D1: a zone on the CWP server proves nothing (any CWP client can add any domain). The default 'force'
    // verification needs the PUBLIC DNS to point at the source (A / AAAA = a source IP, or NS = the source's
    // name servers), seen at discovery; otherwise 'txt' — 'force' then is an explicit, audited staff choice.
    const sourceIpSet = new Set([...g.sourceIps, ...inventory.server.publicIps]);
    const sourceNs = new Set(inventory.server.nameservers.map((n) => lower(n).replace(/[.]$/, '')).filter(Boolean));
    const delegatedToSource = (fqdn: string): boolean => {
      const pd = domains.find((x) => lower(x.fqdn) === fqdn)?.publicDns;
      if (!pd || !pd.resolved) return false;
      if ([...pd.a, ...pd.aaaa].some((ip) => sourceIpSet.has(ip))) return true;
      return pd.ns.some((n) => sourceNs.has(lower(n).replace(/[.]$/, '')));
    };
    const addDomain = (fqdn: string, cwpKind: CwpDomainKind, wwwAlias: boolean, c: MigrationDomainChoice) => {
      const site = siteOfFqdn.get(fqdn) ?? null;
      const proxy = proxyOfFqdn.get(fqdn) ?? null;
      const dnsZone = zoneStatus(fqdn);
      const existing = target.domains.find((x) => x.name === fqdn) ?? null;
      const dScope = scope('domain', fqdn);
      if (existing) {
        // Ours only when an earlier run of THIS CWP user mapped it AND it is still a domain of this user's target
        // account: a mapping of another CWP user / account (domain reassigned on CWP) is a conflict, never reused.
        const mappedId = mapped(idx, 'domain', fqdn, user);
        const ours = mappedId === existing.id && existingAccountId !== null && existing.accountId === existingAccountId;
        if (!ours) warn('blocking', 'domainExists', dScope, { fqdn, tenantId: existing.tenantId });
      }
      if (!c.verification && dnsZone !== 'external' && !delegatedToSource(fqdn)) {
        warn('info', 'domainNotDelegated', dScope, { fqdn, zone: dnsZone });
      }
      const verification = c.verification ?? (dnsZone !== 'external' && delegatedToSource(fqdn) ? 'force' : 'txt');
      // MG8: the P4b proxy service only binds a VERIFIED domain (409 domainNotVerified) and the TXT token only
      // exists once the run created the domain: a proxy domain left to 'txt' would fail its proxy step. Blocking
      // here — the staff forces the verification (audited choice) or skips the domain.
      if (proxy && verification !== 'force') warn('blocking', 'proxyDomainUnverified', dScope, { fqdn, proxy: proxy.key, zone: dnsZone });
      domainRows.set(fqdn, {
        fqdn,
        cwpKind,
        kind: DOMAIN_KIND[cwpKind],
        includeWww: wwwAlias && !fqdn.startsWith('www.'),
        servedBy: site ? 'site' : proxy ? 'proxy' : 'none',
        siteKey: site?.key ?? null,
        proxyKey: proxy?.key ?? null,
        verification,
        dnsZone,
        existingDomainId: existing?.id ?? null,
      });
    };
    for (const d of domains) {
      const fqdn = lower(d.fqdn);
      if (siteOfFqdn.has(fqdn) || proxyOfFqdn.has(fqdn)) addDomain(fqdn, d.kind, d.wwwAlias, domainChoice(d));
    }
    for (const md of st.mailDomains) {
      if (domainRows.has(md)) continue;
      const d = domains.find((x) => lower(x.fqdn) === md);
      const parent = domains.some((x) => x.kind !== 'subdomain' && inZone(md, lower(x.fqdn)) && lower(x.fqdn) !== md);
      addDomain(md, d?.kind ?? (parent ? 'subdomain' : 'addon'), false, d ? domainChoice(d) : {});
    }
    // Zones whose name is no domain of this account and not below one (the zone of a disabled / skipped vhost, an
    // orphan zone given to the account by orphanZones…): the DNS service only creates a zone for a domain of the
    // account or a name below one (the zone step would fail). A domain row (servedBy 'none', created by the
    // domains step and attached to the zone) is planned for it — unless the name is a domain of ANOTHER account
    // (CWP or platform): the zone is then left out of the plan (zoneDomainElsewhere).
    const zonesLeftOut = new Set<string>();
    const accountTargetDomains = existingAccountId !== null ? target.domains.filter((x) => x.accountId === existingAccountId) : [];
    for (const zname of st.zones) {
      if (domainRows.has(zname)) continue;
      if ([...domainRows.keys()].some((f) => inZone(zname, f))) continue;
      // A domain of the target account at / above the zone: the zone hangs on it — except the row an earlier run of
      // this CWP user created for this very zone (mapped): it stays planned (recompute / re-run after a run), so a
      // staff choice made afterwards (verification 'force') still reaches the idempotent domains / verification steps.
      const sameTarget = accountTargetDomains.find((x) => x.name === zname) ?? null;
      const ownRow = sameTarget !== null && mapped(idx, 'domain', zname, user) === sameTarget.id;
      if (!ownRow && accountTargetDomains.some((x) => inZone(zname, x.name))) continue;
      const zScope = scope('zone', zname);
      const elsewhere = inventory.domains.find((x) => lower(x.fqdn) === zname && x.account !== user)?.account
        ?? (target.domains.some((x) => x.name === zname && x.accountId !== existingAccountId) ? 'platform' : null);
      if (elsewhere) {
        warn('warning', 'zoneDomainElsewhere', zScope, { zone: zname, owner: elsewhere });
        zonesLeftOut.add(zname);
        continue;
      }
      const own = domains.find((x) => lower(x.fqdn) === zname) ?? null;
      // The staff choice is keyed by the zone name (pruneChoices keeps it for the zones of the account), also for an
      // orphan zone with no CWP domain of that name: 'force' is the audited way to serve the migrated zone at once.
      addDomain(zname, own?.kind ?? 'addon', false, own ? domainChoice(own) : choice.domains?.[zname] ?? {});
      warn('info', 'zoneDomainCreated', zScope, { zone: zname, serving: own ? own.serving : 'none' });
    }
    const plannedDomains = [...domainRows.values()];

    // ── DNS zones (D-DNS) ──
    const zones: PlannedZone[] = [];
    if (!dnsOn && g.include.dns && inventory.dnsZones.some((z) => z.account === user)) {
      warn('warning', 'dnsDisabled', acctScope, { zones: inventory.dnsZones.filter((z) => z.account === user).length });
    }
    for (const zname of st.zones) {
      if (zonesLeftOut.has(zname)) continue;
      const z = inventory.dnsZones.find((x) => lower(x.name) === zname)!;
      const zc = choice.zones?.[zname] ?? choice.zones?.[z.name];
      const zScope = scope('zone', zname);
      const rz = rewriteZone(z, {
        sourceIps: g.sourceIps, targetIpv4: g.targetIpv4, targetIpv6: g.targetIpv6, rewriteIps: zc?.rewriteIps !== false,
        importTtl: g.importTtl, mailManaged: [...mailManaged.values()],
      });
      if (z.dynamic || z.journal) warn('info', 'zoneDynamic', zScope, { zone: zname, dynamic: z.dynamic, journal: z.journal, readVia: z.readVia });
      if (rz.rewritten) warn('info', 'zoneIpRewritten', zScope, { zone: zname, count: rz.rewritten });
      // Records of the CWP server with no platform IP of their family: dropped (never left pointing at the old
      // machine). IPv4 missing = the sites would vanish → blocking; IPv6 missing = the zone loses its AAAA.
      if (rz.missingTarget.v4) warn('blocking', 'zoneTargetIpMissing', zScope, { zone: zname, family: 4, count: rz.missingTarget.v4 });
      if (rz.missingTarget.v6) warn('warning', 'zoneTargetIpMissing', zScope, { zone: zname, family: 6, count: rz.missingTarget.v6 });
      if (rz.foreignIps.length) warn('info', 'zoneForeignIp', zScope, { zone: zname, count: rz.foreignIps.length, ips: rz.foreignIps.slice(0, 5).join(', ') });
      const managedDrops = rz.dropped.filter((x) => x.reason === 'mailManaged').length;
      if (managedDrops) warn('info', 'zoneMailManaged', zScope, { zone: zname, count: managedDrops });
      const otherDrops = rz.dropped.filter((x) => !['soa', 'apexNs', 'mailManaged', 'noTargetIp'].includes(x.reason));
      if (otherDrops.length) {
        warn('info', 'zoneRecordsDropped', zScope, {
          zone: zname, count: otherDrops.length, reasons: [...new Set(otherDrops.map((x) => x.reason))].sort().join(', '),
        });
      }
      zones.push({
        name: zname,
        domain: domainRows.has(zname) ? zname : null,
        defaultTtl: rz.defaultTtl,
        records: rz.records,
        dropped: rz.dropped,
        rewritten: rz.rewritten,
      });
    }

    // ── databases (D-DB) ──
    let dbInstance: PlannedDbInstance | null = null;
    const databases: PlannedDatabase[] = [];
    const dbUsers: PlannedDbUser[] = [];
    const acctDbs = g.include.databases ? inventory.databases.filter((d) => d.account === user) : [];
    const selectedDbs: CwpDatabase[] = acctDbs.filter((d) => choice.databases?.[d.name]?.selected !== false);
    if (selectedDbs.length) {
      const ic = choice.dbInstance ?? null;
      const mappedInstance = mapped(idx, 'dbInstance', user, user);
      const accountInstances = existingAccountId !== null ? target.dbInstances.filter((i) => i.accountId === existingAccountId) : [];
      const iScope = scope('database', `instance:${user}`);
      const existingId = ic?.mode === 'existing' ? ic.instanceId ?? null : ic?.mode === 'create' ? null : mappedInstance;
      if (existingId !== null) {
        // An existing instance must belong to THIS account (already on the platform) in ITS tenant: an account
        // that is created by the plan owns no instance yet (tenant isolation, MG8).
        const any = target.dbInstances.find((i) => i.id === existingId) ?? null;
        const inst = any && existingAccountId !== null && any.accountId === existingAccountId && any.tenantId === st.tenantId ? any : null;
        if (!inst) {
          warn('blocking', 'dbInstanceMissing', iScope, { instanceId: existingId, reason: any ? 'notOwned' : 'unknown' });
          dbInstance = { mode: 'existing', instanceId: existingId, name: DEFAULT_INSTANCE_NAME, engine: g.dbEngine, version: g.dbVersion };
        } else {
          dbInstance = { mode: 'existing', instanceId: inst.id, name: inst.name, engine: inst.engine as PlannedDbInstance['engine'], version: inst.version };
        }
      } else {
        const engine = ic?.engine ?? g.dbEngine;
        const version = ic?.version ?? g.dbVersion;
        let name = ic?.name && INSTANCE_NAME_RE.test(ic.name) ? ic.name : DEFAULT_INSTANCE_NAME;
        const names = new Set(accountInstances.map((i) => i.name));
        for (let i = 2; names.has(name) && i < 100; i++) name = `${DEFAULT_INSTANCE_NAME}-${i}`;
        dbInstance = { mode: 'create', instanceId: null, name, engine, version };
      }
      if (dbInstance.engine !== 'mariadb' || !DB_ENGINE_VERSIONS.some((v) => v.engine === dbInstance!.engine && v.version === dbInstance!.version)) {
        warn('blocking', 'dbEngineUnsupported', iScope, { engine: dbInstance.engine, version: dbInstance.version });
      }
      if (L.dbEngines && !L.dbEngines.includes(dbInstance.engine)) {
        warn('blocking', 'planLimitExceeded', iScope, { dimension: 'dbEngines', engine: dbInstance.engine });
      }
      const instFacts = dbInstance.instanceId !== null ? target.dbInstances.find((i) => i.id === dbInstance!.instanceId) ?? null : null;

      // Users first (the definer filter needs the migrated set).
      const acctUsers = inventory.dbUsers.filter((u) => u.account === user && !u.orphan);
      const userNames = [...new Set(acctUsers.map((u) => u.user))].sort();
      const migratedUsers = new Set<string>();
      for (const name of userNames) {
        if (choice.dbUsers?.[name]?.selected === false) continue;
        const rows = acctUsers.filter((u) => u.user === name);
        const uScope = scope('dbUser', name);
        let ok = true;
        if (name.length > 32) { warn('blocking', 'dbUserNameTooLong', uScope, { user: name, length: name.length }); ok = false; }
        else if (isReservedName(name)) { warn('blocking', 'dbReservedName', uScope, { user: name, kind: 'user' }); ok = false; }
        else if (!DB_USER_RE.test(name)) { warn('blocking', 'dbNameInvalid', uScope, { user: name, kind: 'user' }); ok = false; }
        const hosts = [...new Set(rows.map((r) => r.host))].sort();
        const remote = rows.filter((r) => r.remote).map((r) => r.host);
        if (remote.length) warn('warning', 'dbRemoteHost', uScope, { user: name, hosts: [...new Set(remote)].sort().join(', ') });
        if (hosts.length > 1) warn('info', 'dbHostHashMismatch', uScope, { user: name, hosts: hosts.join(', '), decidedAt: 'execution' });
        const primary = rows.find((r) => r.host === 'localhost') ?? rows[0];
        if (primary.hashKind !== 'native') warn('warning', 'dbNoHash', uScope, { user: name, hashKind: primary.hashKind });

        // Grants: each mysql.db pattern expanded on the SELECTED databases of the account.
        const perDb = new Map<string, Set<string>>();
        for (const r of rows) {
          for (const gr of r.grants) {
            const privs = normalizePrivileges(gr.privileges);
            if (!privs.length) continue;
            const wild = gr.wildcard || isWildcardPattern(gr.dbPattern);
            const matches = expandGrantPattern(gr.dbPattern, selectedDbs.map((d) => d.name));
            if (wild) warn('info', 'dbGrantWildcard', uScope, { user: name, pattern: gr.dbPattern, matches: matches.length });
            for (const m of matches) {
              const set = perDb.get(m) ?? new Set<string>();
              privs.forEach((p) => set.add(p));
              perDb.set(m, set);
            }
          }
        }
        const grants: PlannedDbUser['grants'] = [];
        for (const dbName of [...perDb.keys()].sort()) {
          const privileges = normalizePrivileges([...perDb.get(dbName)!]);
          const cls = classifyPrivileges(privileges);
          if (cls === 'custom') warn('info', 'dbGrantCustom', uScope, { user: name, database: dbName, privileges: privileges.join(', ') });
          grants.push({ database: dbName, privileges, level: cls === 'readonly' ? 'readonly' : 'all' });
        }
        dbUsers.push({ username: name, sourceHosts: hosts, targetHost: '%', grants, hashKind: primary.hashKind });
        if (ok) migratedUsers.add(name);
      }

      for (const d of selectedDbs) {
        const dScope = scope('database', d.name);
        if (isReservedName(d.name)) warn('blocking', 'dbReservedName', dScope, { database: d.name, kind: 'database' });
        else if (!DB_NAME_RE.test(d.name)) warn('blocking', 'dbNameInvalid', dScope, { database: d.name, kind: 'database' });
        if (instFacts) {
          const there = instFacts.databases.find((x) => x.name === d.name);
          if (there && mapped(idx, 'database', d.name, user) !== there.id) warn('blocking', 'dbNameTaken', dScope, { database: d.name, instance: instFacts.name });
        }
        if (d.latin1Tables > 0) warn('info', 'dbLatin1', dScope, { database: d.name, tables: d.latin1Tables });
        if (d.memoryTables.length) warn('info', 'dbMemoryTables', dScope, { database: d.name, tables: d.memoryTables.length });
        const foreign = d.objects.filter((o) => { const u = definerUser(o.definer); return !u || !migratedUsers.has(u); });
        if (foreign.length) {
          warn('warning', 'dbDefinerForeign', dScope, { database: d.name, count: foreign.length, definer: foreign[0].definer, object: foreign[0].name });
        }
        databases.push({
          name: d.name,
          charset: d.charset,
          collation: d.collation,
          dumpCharset: choice.databases?.[d.name]?.dumpCharset ?? 'utf8mb4',
          sizeBytes: d.sizeBytes,
          definerObjects: d.objects.length,
          memoryTables: [...d.memoryTables],
        });
      }
    }

    // ── mail (D-MAIL) ──
    const mailDomainsOut: PlannedMailDomain[] = [];
    const mailboxes: PlannedMailbox[] = [];
    const aliases: PlannedAlias[] = [];
    const dkim: PlannedDkimKey[] = [];
    const acctMailDomains = inventory.mailDomains.filter((m) => m.account === user);
    if (g.include.mail && acctMailDomains.length && st.selected) {
      if (!mailOn) warn('warning', 'mailEngineExternal', acctScope, { engine: mailEngine, domains: acctMailDomains.length });
      else if (mailEngine === 'stalwart') warn('warning', 'mailStalwartMaildir', acctScope, { domains: st.mailDomains.length });
    }
    const schemes = new Set(target.catalog.mailPasswordSchemes);
    const ownMail = new Set(st.mailDomains);
    for (const md of st.mailDomains) {
      mailDomainsOut.push({ name: md, domain: md });
      const mScope = scope('mailDomain', md);
      for (const mb of inventory.mailboxes.filter((x) => lower(x.domain) === md)) {
        const address = lower(mb.address);
        if (choice.mailboxes?.[address]?.selected === false || choice.mailboxes?.[mb.address]?.selected === false) continue;
        const bScope = scope('mailbox', address);
        let hashScheme = mb.hashScheme;
        if (!hashScheme) warn('warning', 'mailNoHash', bScope, { address });
        else if (!schemes.has(hashScheme)) { warn('warning', 'mailHashUnsupported', bScope, { address, scheme: hashScheme }); hashScheme = null; }
        if (!mb.active) warn('info', 'mailboxInactive', bScope, { address });
        if (mb.hasSieve) warn('info', 'mailSieve', bScope, { address });
        mailboxes.push({
          address, localPart: mb.localPart, domain: md, quotaMb: mb.quotaBytes ? ceilMib(mb.quotaBytes) : null,
          enabled: mb.active, hashScheme, maildirPath: mb.maildirPath, sizeBytes: mb.maildirBytes ?? mb.usedBytes,
        });
      }
      for (const al of inventory.mailAliases.filter((x) => lower(x.domain) === md)) {
        const address = lower(al.address);
        if (choice.aliases?.[address]?.selected === false || choice.aliases?.[al.address]?.selected === false) continue;
        const targets = al.targets.map(lower).filter(Boolean);
        if (al.kind === 'local' || (targets.length === 1 && targets[0] === address)) continue;
        const aScope = scope('alias', address);
        if (al.kind === 'catch-all') warn('info', 'catchAll', aScope, { domain: md, targets: targets.join(', ') });
        const external = targets.filter((t) => !ownMail.has(t.split('@')[1] ?? ''));
        if (external.length) warn('info', 'aliasExternalTargets', aScope, { address, targets: external.join(', ') });
        aliases.push({ address: al.kind === 'catch-all' ? `@${md}` : address, domain: md, targets, enabled: al.active });
      }
      const keys = inventory.dkimKeys.filter((k) => lower(k.domain) === md);
      if (!keys.length) warn('info', 'dkimMissing', mScope, { domain: md });
      for (const k of keys) {
        const imported = mailManaged.get(md)?.dkimSelectors.includes(k.selector) ?? false;
        const wanted = choice.dkim?.[md]?.import ?? choice.dkim?.[`${md}/${k.selector}`]?.import;
        if (!imported && wanted !== false) {
          warn('warning', 'dkimWeakKey', scope('dkim', `${md}/${k.selector}`), { domain: md, selector: k.selector, bits: k.bits, algorithm: k.algorithm });
        }
        dkim.push({ domain: md, selector: k.selector, import: imported, bits: k.bits });
      }
    }

    // ── FTP (D-FTP) ──
    let ftp: PlannedFtpCredential | null = null;
    const ftpUsers = g.include.ftp ? inventory.ftpUsers.filter((u) => u.account === user) : [];
    if (ftpUsers.length) {
      const chosen = ftpUsers.filter((u) => choice.ftpUsers?.[u.login]?.action === 'adopt-password');
      const explicit = ftpUsers.some((u) => choice.ftpUsers?.[u.login]?.action !== undefined);
      const candidates = explicit ? chosen : ftpUsers.filter((u) => u.login === defaultFtpAdoption(ftpUsers));
      for (const u of candidates.filter((x) => x.hashScheme !== 'bcrypt')) {
        warn('warning', 'ftpHashUnsupported', scope('ftpUser', u.login), { login: u.login, scheme: u.hashScheme });
      }
      const adopted = candidates.find((u) => u.hashScheme === 'bcrypt') ?? null;
      if (adopted) ftp = { login: adopted.login, adopt: true };
      const others = ftpUsers.filter((u) => u !== adopted).map((u) => u.login);
      warn('info', 'ftpVirtualUsers', acctScope, { adopted: adopted?.login ?? null, account: targetUsername, skipped: others.length, logins: others.slice(0, 5).join(', ') });
    }
    if (g.include.ftp) warn('info', 'ftpPlainProtocol', acctScope, { account: targetUsername });

    // ── crons (D-CRON) ──
    const crons: PlannedCron[] = [];
    let minCronInterval: number | null = null;
    if (g.include.crons) {
      const names = new Map<string, Set<string>>();
      for (const c of inventory.crons.filter((x) => x.account === user && !x.system)) {
        const cc = choice.crons?.[c.key] ?? {};
        const cScope = scope('cron', c.key);
        const schedule = cc.schedule ? normalizeSchedule(cc.schedule) : normalizeSchedule(c.schedule);
        if (!schedule) {
          warn('warning', 'cronSpecial', cScope, { schedule: c.schedule });
          continue;
        }
        if (!(cc.selected ?? defaultCronSelected(c))) continue;
        if (!sites.length) { warn('warning', 'cronUnmapped', cScope, { command: c.command.slice(0, 200), site: null }); continue; }
        let site = cc.siteKey ? sites.find((s) => s.key === cc.siteKey) ?? null : null;
        let unmapped = false;
        if (!site) {
          // The site of the paths the command USES (longest root first); redirection targets (log files) only
          // when nothing else matches — a log under another site's tree must not move the job there.
          const pick = (paths: string[]) => [...sites].filter((s) => s.sourceRoot && paths.some((p) => pathWithin(p, s.sourceRoot)))
            .sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0] ?? null;
          site = pick(usedPaths(c.command)) ?? pick(commandPaths(c.command));
          if (!site) {
            site = sites[0];
            unmapped = true;
            warn('warning', 'cronUnmapped', cScope, { command: c.command.slice(0, 200), site: site.key });
          }
        }
        let command: string;
        if (cc.command) command = cc.command;
        else {
          const rw = rewriteCronCommand(c, { sourceRoot: site.sourceRoot, dataPaths: site.dataPaths, php: siteBaseDef(site.base).php, homeDir: account.homeDir });
          command = rw.command;
          for (const m of rw.messages) warn(m.severity, m.code, cScope, m.params);
          // A path of the CWP home the command still uses after the rewrite (outside the chosen site's root:
          // another site, ~/app, ~/scripts…) does not exist in the site container: the job would fail.
          const stale = usedPaths(command).find((p) => pathWithin(p, account.homeDir));
          if (stale && !unmapped) warn('warning', 'cronPathUnmapped', cScope, { path: stale, site: site.key, command: c.command.slice(0, 200) });
        }
        const interval = minIntervalMinutes(schedule);
        minCronInterval = minCronInterval === null ? interval : Math.min(minCronInterval, interval);
        const used = names.get(site.key) ?? new Set<string>();
        names.set(site.key, used);
        const script = commandPaths(c.command).map(basename).find((b) => /\.(php|sh|py|pl)$/i.test(b));
        const label = (script ?? c.command.trim().split(/\s+/)[0]?.split('/').pop() ?? 'cron').slice(0, MAX_CRON_NAME - 6) || 'cron';
        let name = `CWP ${label}`.slice(0, MAX_CRON_NAME);
        for (let i = 2; used.has(name); i++) name = `CWP ${label} (${i})`.slice(0, MAX_CRON_NAME);
        used.add(name);
        // Code executed from a data path (writable, never executable — ARCHITECTURE §1): created DISABLED.
        const fromData = executesFromData(command);
        if (fromData) warn('warning', 'cronExecutesData', cScope, { path: fromData, command: command.slice(0, 200) });
        crons.push({ key: c.key, siteKey: site.key, name, schedule, command, originalCommand: c.command, enabled: !c.disabled && !fromData });
      }
    }

    // ── certificates (D-CERT) ──
    const certificates: PlannedCertificate[] = [];
    if (g.include.certificates) {
      const covered = new Set<string>();
      const certs = inventory.certificates.filter((c) => c.account === user)
        .sort((a, b) => (Date.parse(b.notAfter ?? '') || 0) - (Date.parse(a.notAfter ?? '') || 0) || a.fqdn.localeCompare(b.fqdn));
      for (const c of certs) {
        const cScope = scope('certificate', c.fqdn);
        const wanted = choice.certificates?.[c.fqdn]?.selected;
        if (c.expired || (c.notAfter && Date.parse(c.notAfter) <= Date.parse(target.now))) { warn('info', 'certExpired', cScope, { fqdn: c.fqdn, notAfter: c.notAfter }); continue; }
        if (c.selfSigned) { warn('info', 'certSelfSigned', cScope, { fqdn: c.fqdn }); continue; }
        if (wanted === false || !certificateUsable(c, target.now)) continue;
        const siteDomains = plannedDomains.filter((d) => d.servedBy === 'site' && !covered.has(d.fqdn) && certCovers(c.names, d.fqdn)).map((d) => d.fqdn);
        const proxyDomains = plannedDomains.filter((d) => d.servedBy === 'proxy' && !covered.has(d.fqdn) && certCovers(c.names, d.fqdn)).map((d) => d.fqdn);
        if (!siteDomains.length && !proxyDomains.length) { warn('info', 'certNamesMismatch', cScope, { fqdn: c.fqdn, names: c.names.slice(0, 5).join(', ') }); continue; }
        if (siteDomains.length) certificates.push({ fqdn: c.fqdn, names: [...c.names], notAfter: c.notAfter, target: 'site-domain', domains: siteDomains });
        if (proxyDomains.length) {
          certificates.push({ fqdn: c.fqdn, names: [...c.names], notAfter: c.notAfter, target: 'proxy-host', domains: proxyDomains });
          for (const ph of proxies) if (!ph.certificateFqdn && ph.fqdns.some((f) => proxyDomains.includes(f))) ph.certificateFqdn = c.fqdn;
        }
        [...siteDomains, ...proxyDomains].forEach((f) => covered.add(f));
      }
    }

    // ── follow-ups ──
    for (const o of inventory.outside.filter((x) => x.account === user)) {
      followUps.push({ code: o.code, params: o.params, scope: { kind: 'outside', key: o.key, account: user }, suggestion: o.suggestion });
    }
    followUps.push({ code: 'clientLogin', params: { email: account.contactEmail, username: targetUsername }, scope: acctScope, suggestion: 'client-login' });

    const dbBytes = databases.reduce((s, d) => s + (d.sizeBytes || 0), 0);
    const mailBytes = mailboxes.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
    const filesBytes = sites.reduce((s, x) => s + (x.estimatedBytes ?? 0), 0);

    usages.set(user, {
      sites: sites.length,
      domains: plannedDomains.length,
      mailboxes: mailboxes.length,
      aliases: aliases.filter((a) => !a.address.startsWith('@')).length,
      databases: databases.length,
      instances: (dbInstance?.mode === 'create' ? 1 : 0) + (existingAccountId !== null ? target.dbInstances.filter((i) => i.accountId === existingAccountId).length : 0),
      crons: crons.length,
      proxyHosts: proxies.length,
      diskMb: ceilMib(account.homeBytes),
      mailQuotaMb: mailboxes.reduce((s, m) => s + (m.quotaMb ?? 0), 0),
      mailboxMaxMb: mailboxes.reduce((s, m) => Math.max(s, m.quotaMb ?? 0), 0),
      unlimitedMailbox: mailboxes.some((m) => m.quotaMb === null),
      dbMaxMb: databases.reduce((s, d) => Math.max(s, ceilMib(d.sizeBytes) ?? 0), 0),
      minCronInterval,
    });

    accountsOut.push({
      cwpUsername: user,
      selected: st.selected,
      tenantId: st.tenantId,
      targetUsername,
      existingAccountId,
      packageKey: ls.packageKey,
      planId: ls.planId,
      suspended,
      domains: plannedDomains,
      sites,
      proxies,
      dbInstance,
      databases,
      dbUsers,
      zones,
      mailDomains: mailDomainsOut,
      mailboxes,
      aliases,
      dkim,
      crons,
      certificates,
      ftp,
      warnings,
      followUps,
      blocked: false,
      estimates: { filesBytes, dbBytes, mailBytes },
    });
  }

  // ── C. packages → plans (raised to the largest selected account) ─────────
  const packagesOut: PlannedPackage[] = [];
  const finalLimits = new Map<string, PlanLimits>();
  const raise = (l: PlanLimits, dim: keyof PlanLimits, to: number | null, info: Array<{ dimension: string; from: number | null; to: number | null }>) => {
    const from = l[dim] as number | null;
    if (to === null) {
      if (from !== null) { (l as unknown as Record<string, unknown>)[dim] = null; info.push({ dimension: dim, from, to: null }); }
      return;
    }
    if (from !== null && from < to) { (l as unknown as Record<string, unknown>)[dim] = to; info.push({ dimension: dim, from, to }); }
  };
  for (const acc of accountsOut) {
    if (!acc.selected) continue;
    const ls = limitSources.get(acc.cwpUsername)!;
    if (ls.planId !== null || ls.noPlan) continue;
    if (packagesOut.some((p) => p.key === ls.packageKey)) continue;
    const pkg = packagesById.get(states.get(acc.cwpUsername)!.account.packageId ?? -1)!;
    const pc = choices.packages?.[String(pkg.id)] ?? { action: 'create' as const };
    const overrides = (pc.limits ?? {}) as Partial<PlanLimits>;
    const l: PlanLimits = { ...packageLimits(pkg) };
    const members = accountsOut.filter((a) => a.selected && limitSources.get(a.cwpUsername)!.packageKey === ls.packageKey && limitSources.get(a.cwpUsername)!.planId === null);
    const info: Array<{ dimension: string; from: number | null; to: number | null }> = [];
    const max = (f: (u: Usage) => number) => members.reduce((s, a) => Math.max(s, f(usages.get(a.cwpUsername)!)), 0);
    const anyUnlimited = members.some((a) => usages.get(a.cwpUsername)!.unlimitedMailbox);
    const dims: Array<[keyof PlanLimits, number | null]> = [
      ['maxDomains', max((u) => u.domains)],
      ['maxMailboxes', max((u) => u.mailboxes)],
      ['maxMailAliases', max((u) => u.aliases)],
      ['maxDatabases', max((u) => u.databases)],
      ['maxDbInstances', Math.max(1, max((u) => u.instances))],
      ['maxCronJobs', max((u) => u.crons)],
      ['maxProxyHosts', max((u) => u.proxyHosts)],
      ['diskMb', max((u) => u.diskMb ?? 0)],
      ['dbMaxSizeMb', max((u) => u.dbMaxMb)],
      ['mailboxQuotaMaxMb', anyUnlimited ? null : max((u) => u.mailboxMaxMb)],
      ['mailQuotaMb', anyUnlimited ? null : max((u) => u.mailQuotaMb)],
    ];
    for (const [dim, to] of dims) if (!(dim in overrides)) raise(l, dim, to, info);
    if (!('cronMinIntervalMin' in overrides)) {
      const minInterval = members.reduce<number | null>((s, a) => {
        const v = usages.get(a.cwpUsername)!.minCronInterval;
        return v === null ? s : s === null ? v : Math.min(s, v);
      }, null);
      if (minInterval !== null && minInterval < l.cronMinIntervalMin) {
        info.push({ dimension: 'cronMinIntervalMin', from: l.cronMinIntervalMin, to: Math.max(1, minInterval) });
        l.cronMinIntervalMin = Math.max(1, minInterval);
      }
    }
    const final = { ...l, ...overrides } as PlanLimits;
    finalLimits.set(ls.packageKey, final);
    for (const r of info) {
      serverWarnings.push(warning('info', 'planLimitsRaised', { kind: 'package', key: ls.packageKey, account: null }, { package: pkg.name, ...r }));
    }
    const tenantId = Number(ls.packageKey.split('@')[1]);
    packagesOut.push({
      key: ls.packageKey,
      cwpPackageId: pkg.id,
      tenantId,
      action: 'create',
      planId: mapped(idx, 'plan', ls.packageKey),
      name: (pc.name?.trim() || defaultPackagePlanName(pkg.name)).slice(0, 100),
      limits: final,
    });
  }
  // Existing plans of the packages (choice 'existing'), for the record.
  for (const acc of accountsOut) {
    if (!acc.selected) continue;
    const ls = limitSources.get(acc.cwpUsername)!;
    const pkgId = states.get(acc.cwpUsername)!.account.packageId;
    const pkg = pkgId !== null ? packagesById.get(pkgId) : undefined;
    if (!pkg || ls.noPlan || ls.planId === null || choices.accounts?.[acc.cwpUsername]?.planId) continue;
    if (packagesOut.some((p) => p.key === ls.packageKey)) continue;
    const p = catalogPlan(target, ls.planId)!;
    packagesOut.push({ key: ls.packageKey, cwpPackageId: pkg.id, tenantId: p.tenantId, action: 'existing', planId: p.id, name: p.name, limits: p.limits });
  }
  packagesOut.sort((a, b) => a.key.localeCompare(b.key));

  // ── D. limits of the final plans ────────────────────────────────────────
  const ENFORCED: Array<[keyof PlanLimits, keyof Usage]> = [
    ['maxSites', 'sites'], ['maxDomains', 'domains'], ['maxMailboxes', 'mailboxes'], ['maxMailAliases', 'aliases'],
    ['maxDatabases', 'databases'], ['maxDbInstances', 'instances'], ['maxCronJobs', 'crons'], ['maxProxyHosts', 'proxyHosts'],
  ];
  for (const acc of accountsOut) {
    const ls = limitSources.get(acc.cwpUsername)!;
    if (ls.noPlan) { acc.blocked = true; continue; }
    const L = ls.planId !== null ? ls.limits : finalLimits.get(ls.packageKey) ?? ls.limits;
    const u = usages.get(acc.cwpUsername)!;
    const aScope: MigrationScope = { kind: 'account', key: acc.cwpUsername, account: acc.cwpUsername };
    const push = (w: MigrationWarning) => acc.warnings.push(w);
    for (const [dim, use] of ENFORCED) {
      const limit = L[dim] as number | null;
      const value = u[use] as number;
      if (limit !== null && value > limit) push(warning('blocking', 'planLimitExceeded', aScope, { dimension: dim, limit, value }));
    }
    if (L.diskMb !== null && u.diskMb !== null && u.diskMb > L.diskMb) push(warning('warning', 'planLimitExceeded', aScope, { dimension: 'diskMb', limit: L.diskMb, value: u.diskMb }));
    if (L.mailQuotaMb !== null && (u.unlimitedMailbox || u.mailQuotaMb > L.mailQuotaMb) && u.mailboxes) {
      push(warning('warning', 'planLimitExceeded', aScope, { dimension: 'mailQuotaMb', limit: L.mailQuotaMb, value: u.unlimitedMailbox ? null : u.mailQuotaMb }));
    }
    const pkgId = states.get(acc.cwpUsername)!.account.packageId;
    const pkg = pkgId !== null ? packagesById.get(pkgId) : undefined;
    if (pkg && L.trafficMbPerMonth !== null && (pkg.bandwidthMbPerMonth === null || pkg.bandwidthMbPerMonth > L.trafficMbPerMonth)) {
      push(warning('warning', 'planLimitExceeded', aScope, { dimension: 'trafficMbPerMonth', limit: L.trafficMbPerMonth, value: pkg.bandwidthMbPerMonth }));
    }
    for (const mb of acc.mailboxes) {
      if (L.mailboxQuotaMaxMb !== null && (mb.quotaMb === null || mb.quotaMb > L.mailboxQuotaMaxMb)) {
        push(warning('warning', 'mailQuotaOverPlan', { kind: 'mailbox', key: mb.address, account: acc.cwpUsername }, { address: mb.address, quotaMb: mb.quotaMb, limit: L.mailboxQuotaMaxMb }));
      }
    }
    for (const d of acc.databases) {
      if (L.dbMaxSizeMb !== null && d.sizeBytes > L.dbMaxSizeMb * MIB) {
        push(warning('warning', 'dbTooLarge', { kind: 'database', key: d.name, account: acc.cwpUsername }, { database: d.name, sizeMb: ceilMib(d.sizeBytes), limit: L.dbMaxSizeMb }));
      }
    }
    for (const c of acc.crons) {
      const interval = minIntervalMinutes(c.schedule);
      if (interval < L.cronMinIntervalMin) {
        push(warning(ls.existing ? 'blocking' : 'warning', 'cronInterval', { kind: 'cron', key: c.key, account: acc.cwpUsername }, { schedule: c.schedule, interval, minimum: L.cronMinIntervalMin }));
      }
    }
    acc.blocked = globalBlocked || acc.warnings.some((w) => w.severity === 'blocking');
  }

  // ── server-wide: orphans, system crons, outside items ───────────────────
  for (const d of inventory.databases.filter((x) => !x.account)) {
    serverWarnings.push(warning('warning', 'dbOrphan', { kind: 'database', key: d.name, account: null }, { database: d.name, sizeMb: ceilMib(d.sizeBytes) }));
  }
  for (const u of inventory.dbUsers.filter((x) => x.orphan)) {
    serverWarnings.push(warning('warning', 'dbUserOrphan', { kind: 'dbUser', key: `${u.user}@${u.host}`, account: null }, { user: u.user, host: u.host }));
  }
  for (const c of inventory.crons.filter((x) => x.system)) {
    serverFollowUps.push({ code: 'cronSystem', params: { owner: c.owner, schedule: c.schedule, command: c.command.slice(0, 200) }, scope: { kind: 'cron', key: c.key, account: c.account }, suggestion: 'manual' });
  }
  for (const o of inventory.outside.filter((x) => !x.account || !states.has(x.account))) {
    serverFollowUps.push({ code: o.code, params: o.params, scope: { kind: 'outside', key: o.key, account: o.account }, suggestion: o.suggestion });
  }

  const selectedAccounts = accountsOut.filter((a) => a.selected);
  return {
    computedAt: target.now,
    choicesHash: choicesHash(choices, discoveryId),
    discoveryId,
    packages: packagesOut,
    accounts: accountsOut,
    warnings: serverWarnings,
    followUps: serverFollowUps,
    totals: {
      accounts: accountsOut.length,
      selected: selectedAccounts.length,
      blocked: selectedAccounts.filter((a) => a.blocked).length,
      filesBytes: selectedAccounts.reduce((s, a) => s + a.estimates.filesBytes, 0),
      dbBytes: selectedAccounts.reduce((s, a) => s + a.estimates.dbBytes, 0),
      mailBytes: selectedAccounts.reduce((s, a) => s + a.estimates.mailBytes, 0),
    },
  };
}

/**
 * Drops the keys of the choices that the inventory does not know (accounts, domains, databases… of an older
 * discovery): never an error (rebase, PUT /choices).
 */
export function pruneChoices(inventory: CwpInventory, choices: MigrationPlanChoices): MigrationPlanChoices {
  const keep = <T>(rec: Record<string, T> | undefined, known: Set<string>): Record<string, T> | undefined => {
    if (!rec) return undefined;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec)) if (known.has(k)) out[k] = v;
    return out;
  };
  const packages = new Set(inventory.packages.map((p) => String(p.id)));
  const zoneNames = new Set(inventory.dnsZones.flatMap((z) => [z.name, lower(z.name)]));
  const accounts: MigrationPlanChoices['accounts'] = {};
  for (const [user, c] of Object.entries(choices.accounts ?? {})) {
    if (!inventory.accounts.some((a) => a.username === user)) continue;
    const of = <T extends { account: string | null }>(list: T[], key: (x: T) => string[]) => new Set(list.filter((x) => x.account === user).flatMap(key));
    const mailDomainNames = of(inventory.mailDomains, (m) => [m.name, lower(m.name)]);
    const dkimKeys = new Set(inventory.dkimKeys.filter((k) => k.account === user || mailDomainNames.has(lower(k.domain)))
      .flatMap((k) => [lower(k.domain), `${lower(k.domain)}/${k.selector}`]));
    const out: MigrationAccountChoice = { ...c };
    const set = <K extends keyof MigrationAccountChoice>(k: K, v: MigrationAccountChoice[K] | undefined) => {
      if (v === undefined) delete out[k]; else out[k] = v;
    };
    // Domain choices: the CWP domains of the account + the zones attached to it (own zone or orphanZones): a zone
    // with no served domain gets a domain row (zoneDomainCreated) whose verification the staff must be able to set.
    const ownZones = inventory.dnsZones.filter((z) => {
      const owner = z.account ?? choices.orphanZones?.[z.name]?.account ?? choices.orphanZones?.[lower(z.name)]?.account ?? null;
      return owner === user;
    }).flatMap((z) => [z.name, lower(z.name)]);
    set('domains', keep(c.domains, new Set([...of(inventory.domains, (d) => [d.fqdn, lower(d.fqdn)]), ...ownZones])));
    set('databases', keep(c.databases, of(inventory.databases, (d) => [d.name])));
    set('dbUsers', keep(c.dbUsers, of(inventory.dbUsers, (u) => [u.user])));
    set('zones', keep(c.zones, zoneNames));
    set('mailDomains', keep(c.mailDomains, mailDomainNames));
    set('mailboxes', keep(c.mailboxes, new Set(inventory.mailboxes.filter((m) => mailDomainNames.has(lower(m.domain))).flatMap((m) => [m.address, lower(m.address)]))));
    set('aliases', keep(c.aliases, new Set(inventory.mailAliases.filter((m) => mailDomainNames.has(lower(m.domain))).flatMap((m) => [m.address, lower(m.address)]))));
    set('dkim', keep(c.dkim, dkimKeys));
    set('ftpUsers', keep(c.ftpUsers, of(inventory.ftpUsers, (u) => [u.login])));
    set('crons', keep(c.crons, of(inventory.crons, (x) => [x.key])));
    set('certificates', keep(c.certificates, of(inventory.certificates, (x) => [x.fqdn])));
    accounts[user] = out;
  }
  const result: MigrationPlanChoices = {
    global: choices.global,
    packages: keep(choices.packages, packages) ?? {},
    accounts,
  };
  if (choices.orphanZones) {
    const oz: NonNullable<MigrationPlanChoices['orphanZones']> = {};
    for (const [z, v] of Object.entries(choices.orphanZones)) {
      if (!zoneNames.has(z)) continue;
      oz[z] = { account: v.account && inventory.accounts.some((a) => a.username === v.account) ? v.account : null };
    }
    result.orphanZones = oz;
  }
  return result;
}

