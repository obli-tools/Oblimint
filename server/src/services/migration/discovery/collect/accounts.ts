import type { CwpAccount, CwpPackage } from '@oblimint/shared';
import { cellInt, cellStr } from '../parsers/mysqlBatch';
import { baseName, isInteractiveShell, parsePasswd } from '../parsers/system';
import { DiscoveryContext, cwpLimit, normFqdn, stripSlash } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phases cwp-db + accounts (P5-PLAN §7.2, CWP-MAP §2–§5). root_cwp is the only
// registry of accounts / packages / addon + parked domains / subdomains: it is
// VITAL (failure = failed discovery). Linux facts come from getent passwd,
// suspension from /usr/local/cwp/users/suspended/<u>/, SSH keys are COUNTED
// (fs.lineCount, never read).
// ─────────────────────────────────────────────────────────────────────────────

export const SQL = {
  version: 'SELECT VERSION() AS version',
  users: 'SELECT id, username, domain, ip_address, email, setup_date, package, reseller FROM root_cwp.user ORDER BY id',
  packages: 'SELECT id, package_name, disk_quota, bandwidth, ftp_accounts, email_accounts, email_lists, `databases`, sub_domains, '
    + 'parked_domains, addons_domains, hourly_emails, reseller, accounts, nproc, inode FROM root_cwp.packages ORDER BY id',
  domains: 'SELECT id, domain, user, path FROM root_cwp.domains ORDER BY id',
  subdomains: 'SELECT id, subdomain, domain, user, path FROM root_cwp.subdomains ORDER BY id',
  nameservers: 'SELECT ns1_name, ns1_ip, ns2_name, ns2_ip FROM root_cwp.nameserver',
} as const;

export class VitalReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VitalReadError';
  }
}

export async function phaseCwpDb(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  try {
    const v = await ctx.query(SQL.version);
    st.server.mariadbVersion = cellStr(v[0]?.version) ?? null;
  } catch (err) {
    ctx.checkAbort();
    st.mysqlOk = false;
    ctx.warn('mysqlUnavailable', 'blocking', { kind: 'server', key: 'mysql' });
    throw new VitalReadError(`Base MySQL de CWP inaccessible (${err instanceof Error ? err.name : 'erreur'})`);
  }

  let users; let packages; let domains; let subs;
  try {
    users = await ctx.query(SQL.users);
    packages = await ctx.query(SQL.packages);
    domains = await ctx.query(SQL.domains);
    subs = await ctx.query(SQL.subdomains);
  } catch (err) {
    ctx.checkAbort();
    throw new VitalReadError(`Base root_cwp illisible : ${err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'erreur'}`);
  }
  try {
    const ns = await ctx.query(SQL.nameservers);
    for (const r of ns) {
      for (const k of ['ns1_name', 'ns2_name']) {
        const n = cellStr(r[k]);
        if (n && n.trim() && !st.server.nameservers.includes(normFqdn(n))) st.server.nameservers.push(normFqdn(n));
      }
    }
  } catch (err) {
    ctx.checkAbort();
    ctx.readFailed('root_cwp.nameserver', err);
  }

  st.packages = packages.map((r): CwpPackage => ({
    id: cellInt(r.id) ?? 0,
    name: cellStr(r.package_name) ?? '',
    diskQuotaMb: cwpLimit(r.disk_quota),
    bandwidthMbPerMonth: cwpLimit(r.bandwidth),
    ftpAccounts: cwpLimit(r.ftp_accounts),
    emailAccounts: cwpLimit(r.email_accounts),
    emailLists: cwpLimit(r.email_lists),
    databases: cwpLimit(r.databases),
    subDomains: cwpLimit(r.sub_domains),
    parkedDomains: cwpLimit(r.parked_domains),
    addonDomains: cwpLimit(r.addons_domains),
    hourlyEmails: cwpLimit(r.hourly_emails),
    isReseller: /^(1|on|yes|true)$/i.test((cellStr(r.reseller) ?? '').trim()),
    nproc: cwpLimit(r.nproc),
    inodes: cwpLimit(r.inode) || null,
    accountCount: 0,
  }));
  const pkgById = new Map(st.packages.map((p) => [p.id, p]));

  for (const r of users) {
    const username = (cellStr(r.username) ?? '').trim();
    if (!username) continue;
    const pkgText = (cellStr(r.package) ?? '').trim();
    const packageId = /^\d+$/.test(pkgText) ? Number(pkgText) : null;
    const pkg = packageId !== null ? pkgById.get(packageId) : undefined;
    if (pkg) pkg.accountCount += 1;
    const reseller = (cellStr(r.reseller) ?? '').trim();
    const setup = cellStr(r.setup_date);
    st.accounts.push({
      username,
      uid: null, gid: null,
      homeDir: `/home/${username}`,
      mainDomain: normFqdn(cellStr(r.domain) ?? ''),
      contactEmail: (cellStr(r.email) ?? '').trim() || null,
      packageId,
      packageName: pkg?.name ?? null,
      reseller: reseller || null,
      suspended: false,
      setupDate: setup && !setup.startsWith('0000') ? setup : null,
      ipAddress: (cellStr(r.ip_address) ?? '').trim() || null,
      shell: null, sshAccess: false, authorizedKeys: 0,
      homeBytes: null, mailBytes: null, dbBytes: null,
      fpmPools: [], phpIniFiles: [], extraDirs: [],
    });
    if (reseller) ctx.warn('resellerAccount', 'warning', { kind: 'account', key: username, account: username }, { reseller });
  }

  const accountNames = new Set(st.accounts.map((a) => a.username));
  for (const a of st.accounts) {
    if (a.mainDomain) st.domainRows.push({ fqdn: a.mainDomain, kind: 'main', account: a.username, parent: null, subLabel: null, dbPath: `${a.homeDir}/public_html` });
  }
  for (const r of domains) {
    const user = (cellStr(r.user) ?? '').trim();
    const fqdn = normFqdn(cellStr(r.domain) ?? '');
    if (!fqdn || !accountNames.has(user)) continue;
    const p = stripSlash((cellStr(r.path) ?? '').trim());
    st.domainRows.push({ fqdn, kind: p === `/home/${user}/public_html` ? 'parked' : 'addon', account: user, parent: null, subLabel: null, dbPath: p || null });
  }
  for (const r of subs) {
    const user = (cellStr(r.user) ?? '').trim();
    const label = (cellStr(r.subdomain) ?? '').trim().toLowerCase().replace(/\.$/, '');
    const parent = normFqdn(cellStr(r.domain) ?? '');
    if (!label || !parent || !accountNames.has(user)) continue;
    const p = stripSlash((cellStr(r.path) ?? '').trim());
    st.domainRows.push({ fqdn: `${label}.${parent}`, kind: 'subdomain', account: user, parent, subLabel: label, dbPath: p || null });
  }
}

export async function phaseAccounts(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const pw = await ctx.tryRun('getent passwd', 'sys.passwd', {});
  st.passwd = pw ? parsePasswd(pw.stdout) : [];
  const byName = new Map(st.passwd.map((p) => [p.name, p]));

  const suspendedDirs = await ctx.find('suspended accounts', '/usr/local/cwp/users/suspended', 1, 'd');
  const suspended = new Set(suspendedDirs.map((e) => baseName(e.path)));

  const keyFiles = st.accounts.map((a) => `${a.homeDir}/.ssh/authorized_keys`);
  const keys = await ctx.lineCount('authorized_keys', keyFiles);

  // PHP-FPM pools: /opt/alt/php-fpmXX/usr/etc/php-fpm.d/users/<user>.conf
  const pools = new Map<string, string[]>();
  for (const v of st.server.phpFpmVersions) {
    const digits = v.replace('.', '');
    const files = await ctx.find(`php-fpm ${v} pools`, `/opt/alt/php-fpm${digits}/usr/etc/php-fpm.d/users`, 1, 'f', '*.conf');
    for (const f of files) {
      const user = baseName(f.path).replace(/\.conf$/, '');
      pools.set(user, [...(pools.get(user) ?? []), v]);
    }
  }

  for (const a of st.accounts) {
    ctx.checkAbort();
    const p = byName.get(a.username);
    if (p) {
      a.uid = p.uid;
      a.gid = p.gid;
      a.shell = p.shell;
      a.sshAccess = isInteractiveShell(p.shell);
      if (p.home && p.home !== '/') a.homeDir = stripSlash(p.home);
    }
    a.suspended = suspended.has(a.username);
    a.authorizedKeys = keys.get(`${a.homeDir}/.ssh/authorized_keys`) ?? keys.get(`/home/${a.username}/.ssh/authorized_keys`) ?? 0;
    a.fpmPools = (pools.get(a.username) ?? []).sort();
    st.homeEntries.set(a.username, await ctx.find(`home of ${a.username}`, a.homeDir, 1));
    const inis = await ctx.find(`php.ini of ${a.username}`, a.homeDir, 4, 'f', '*.ini');
    a.phpIniFiles = inis
      .filter((e) => ['php.ini', '.user.ini'].includes(baseName(e.path)) && e.path.startsWith(`${a.homeDir}/`))
      .map((e) => e.path.slice(a.homeDir.length + 1))
      .sort();
    if (a.sshAccess) {
      ctx.addOutside({
        kind: 'ssh-access', key: a.username, account: a.username, code: 'sshAccess', suggestion: 'manual',
        params: { user: a.username, keys: a.authorizedKeys },
        details: { user: a.username, shell: a.shell, authorizedKeys: a.authorizedKeys, cwpAccount: true },
      });
    }
  }

  // Linux users outside CWP (uid ≥ 1000, not nobody).
  const accountNames = new Set(st.accounts.map((a) => a.username));
  for (const p of st.passwd) {
    if (p.uid < 1000 || p.uid >= 65534 || accountNames.has(p.name)) continue;
    const interactive = isInteractiveShell(p.shell);
    ctx.addOutside({
      kind: 'linux-user', key: p.name, account: null, code: 'linuxUserOutsideCwp', suggestion: 'manual',
      params: { user: p.name, uid: p.uid },
      details: { user: p.name, uid: p.uid, gid: p.gid, home: p.home, shell: p.shell, interactive },
    });
    if (interactive) {
      const k = await ctx.lineCount('authorized_keys', p.home.startsWith('/home/') ? [`${stripSlash(p.home)}/.ssh/authorized_keys`] : []);
      const n = [...k.values()][0] ?? 0;
      ctx.addOutside({
        kind: 'ssh-access', key: p.name, account: null, code: 'sshAccess', suggestion: 'manual',
        params: { user: p.name, keys: n },
        details: { user: p.name, shell: p.shell, authorizedKeys: n, cwpAccount: false },
      });
    }
  }
}

