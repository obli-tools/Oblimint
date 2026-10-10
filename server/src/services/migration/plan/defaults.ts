import type {
  CwpAccount, CwpCertificate, CwpCronEntry, CwpDomain, CwpDomainKind, CwpFtpUser, CwpInventory, CwpProxyTarget,
  MigrationAccountChoice, MigrationDomainChoice, MigrationGlobalChoices, MigrationPlanChoices,
} from '@oblimint/shared';
import type { PlanTargetContext } from './context';
import { normalizeSchedule } from './cron';
import { canonicalIp, isLoopback, lower, trimSlash } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// Defaults of the plan (docs/P5-PLAN.md §8.2). The SAME rules serve
// defaultChoices (explicit choices shown in the editor) and computePlan (a
// choice that is absent = its default), so both always agree.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_DB_ENGINE = 'mariadb' as const;
export const DEFAULT_DB_VERSION = '10.11';
export const DEFAULT_TENANT_ID = 1;

const KIND_ORDER: Record<CwpDomainKind, number> = { main: 0, addon: 1, parked: 2, subdomain: 3 };
const CWP_SERVICE_LABELS = new Set(['webmail', 'mail', 'cpanel']);

/** webmail. / mail. / cpanel. sub-vhosts of CWP (proxied to cwpsrv): never sites nor domains. */
export function isCwpServiceSubdomain(d: Pick<CwpDomain, 'fqdn' | 'kind'>): boolean {
  if (d.kind === 'main') return false;
  return CWP_SERVICE_LABELS.has(lower(d.fqdn).split('.')[0]);
}

/** Domains of an account in a stable order: main, addon, parked, subdomain, then by name. */
export function accountDomains(inventory: CwpInventory, username: string): CwpDomain[] {
  return inventory.domains
    .filter((d) => d.account === username)
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || lower(a.fqdn).localeCompare(lower(b.fqdn)));
}

/** Every address of the source machine (rewritten in the zones, recognised as a local proxy target). */
export function defaultSourceIps(inventory: CwpInventory): string[] {
  const out = new Set<string>();
  for (const ip of inventory.server.publicIps) { const c = canonicalIp(ip); if (c) out.add(c); }
  for (const a of inventory.accounts) { const c = canonicalIp(a.ipAddress); if (c) out.add(c); }
  return [...out].sort();
}

/** A proxy target served by the source itself (loopback / one of its addresses): a local service, not a proxy. */
export function isLocalServiceTarget(target: Pick<CwpProxyTarget, 'host'>, localIps: ReadonlySet<string>): boolean {
  if (isLoopback(target.host)) return true;
  const ip = canonicalIp(target.host);
  return !!ip && localIps.has(ip);
}

export function localAddresses(inventory: CwpInventory, sourceIps: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const ip of [...sourceIps, ...inventory.server.publicIps, ...inventory.server.privateIps]) {
    const c = canonicalIp(ip);
    if (c) out.add(c);
  }
  return out;
}

/** Default treatment of a domain (D-SITE / D-PROXY). */
export function defaultDomainAs(d: CwpDomain, main: CwpDomain | null, localIps: ReadonlySet<string>): NonNullable<MigrationDomainChoice['as']> {
  if (isCwpServiceSubdomain(d)) return 'skip';
  switch (d.serving) {
    case 'proxy':
      return d.proxy && !isLocalServiceTarget(d.proxy, localIps) ? 'proxy' : 'skip';
    case 'site':
      if (d.kind === 'parked' && main && main !== d && main.serving === 'site' && d.docroot && main.docroot
        && trimSlash(d.docroot) === trimSlash(main.docroot)) return 'alias';
      return 'site';
    case 'unknown':
      return d.docroot ? 'site' : 'skip';
    default:
      return 'skip';
  }
}

function dirDepth(p: string): number {
  return trimSlash(p).split('/').filter(Boolean).length;
}

/** D-FTP: the bcrypt virtual user of the account with the shallowest directory (then by login) is adopted. */
export function defaultFtpAdoption(users: readonly CwpFtpUser[]): string | null {
  const bcrypt = users.filter((u) => u.hashScheme === 'bcrypt')
    .sort((a, b) => (dirDepth(a.directory) - dirDepth(b.directory)) || a.login.localeCompare(b.login));
  return bcrypt[0]?.login ?? null;
}

export function defaultCronSelected(c: Pick<CwpCronEntry, 'system' | 'schedule'>): boolean {
  return !c.system && normalizeSchedule(c.schedule) !== null;
}

export function certificateUsable(c: Pick<CwpCertificate, 'expired' | 'selfSigned' | 'notAfter'>, now: string): boolean {
  if (c.expired || c.selfSigned) return false;
  return !c.notAfter || Date.parse(c.notAfter) > Date.parse(now);
}

export function defaultGlobal(inventory: CwpInventory, target: PlanTargetContext): MigrationGlobalChoices {
  return {
    defaultTenantId: DEFAULT_TENANT_ID,
    nodeId: null,
    sourceIps: defaultSourceIps(inventory),
    targetIpv4: target.catalog.platformIpv4,
    targetIpv6: target.catalog.platformIpv6,
    importTtl: null,
    dbEngine: DEFAULT_DB_ENGINE,
    dbVersion: DEFAULT_DB_VERSION,
    suspendedAccounts: 'keep-suspended',
    include: { files: true, databases: true, mail: true, dns: true, crons: true, certificates: true, proxies: true, ftp: true },
    scanOverride: false,
  };
}

/** Global choices with every member present (partial / older stored choices). */
export function effectiveGlobal(inventory: CwpInventory, target: PlanTargetContext, g: Partial<MigrationGlobalChoices> | undefined): MigrationGlobalChoices {
  const d = defaultGlobal(inventory, target);
  const out: MigrationGlobalChoices = { ...d };
  if (g) {
    for (const [k, v] of Object.entries(g) as Array<[keyof MigrationGlobalChoices, unknown]>) {
      if (v !== undefined && k !== 'include') (out as unknown as Record<string, unknown>)[k] = v;
    }
    out.include = { ...d.include, ...(g.include ?? {}) };
  }
  // A target IP left null (often frozen by defaultChoices before the platform IP was configured) follows the
  // platform's CURRENT public IP at each compute: never import the source address because of a stale null.
  out.targetIpv4 = out.targetIpv4 ?? d.targetIpv4;
  out.targetIpv6 = out.targetIpv6 ?? d.targetIpv6;
  return out;
}

function defaultAccountChoice(inventory: CwpInventory, account: CwpAccount, localIps: ReadonlySet<string>, now: string): MigrationAccountChoice {
  const domains = accountDomains(inventory, account.username);
  const main = domains.find((d) => d.kind === 'main') ?? null;
  const domainChoices: Record<string, MigrationDomainChoice> = {};
  for (const d of domains) domainChoices[lower(d.fqdn)] = { as: defaultDomainAs(d, main, localIps) };

  const ftp = inventory.ftpUsers.filter((u) => u.account === account.username);
  const adopted = defaultFtpAdoption(ftp);
  const ftpUsers: NonNullable<MigrationAccountChoice['ftpUsers']> = {};
  for (const u of ftp) ftpUsers[u.login] = { action: u.login === adopted ? 'adopt-password' : 'skip' };

  const crons: NonNullable<MigrationAccountChoice['crons']> = {};
  for (const c of inventory.crons.filter((x) => x.account === account.username && !x.system)) crons[c.key] = { selected: defaultCronSelected(c) };

  const certificates: NonNullable<MigrationAccountChoice['certificates']> = {};
  for (const c of inventory.certificates.filter((x) => x.account === account.username)) certificates[c.fqdn] = { selected: certificateUsable(c, now) };

  return { selected: true, domains: domainChoices, ftpUsers, crons, certificates };
}

/** Explicit default choices of a new plan (§8.2). */
export function defaultChoices(inventory: CwpInventory, target: PlanTargetContext): MigrationPlanChoices {
  const global = defaultGlobal(inventory, target);
  const localIps = localAddresses(inventory, global.sourceIps);
  const packages: MigrationPlanChoices['packages'] = {};
  for (const p of inventory.packages) packages[String(p.id)] = { action: 'create', name: defaultPackagePlanName(p.name) };
  const accounts: MigrationPlanChoices['accounts'] = {};
  for (const a of inventory.accounts) accounts[a.username] = defaultAccountChoice(inventory, a, localIps, target.now);
  return { global, packages, accounts, orphanZones: {} };
}

export function defaultPackagePlanName(name: string): string {
  return `CWP ${name}`.slice(0, 100);
}
