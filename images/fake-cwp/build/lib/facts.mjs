// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — what the panel DISCOVERY must find on the fake server, derived
// from the dataset (docs/P5-PLAN.md §7). Written to dataset/expected-inventory.json
// by `node check/check-dataset.mjs --write-expected`, compared by the checker
// (drift = failure) and used by e2e/run-migration.mjs on the Linux test host.
//
// counts.hard  must equal CwpInventory.counts (no interpretation possible)
// counts.soft  depend on a counting convention of the discovery (printed, not fatal)
// ─────────────────────────────────────────────────────────────────────────────

const fpmVersion = (v) => `${v[0]}.${v.slice(1)}`;

/** Effective PHP of a domain, normative algorithm of P5-PLAN §7.3 applied to the dataset. */
export function expectedPhp(ds, d) {
  if (!d.web || d.web.serving === 'proxy') return null;
  const php = d.web.php;
  const overrides = Object.entries(d.web.htaccess?.subdirs ?? {}).map(([p, h]) => ({ path: p, version: fpmVersion(h.replace('php', '')) }));
  if (php.handler === 'php-fpm') return { version: fpmVersion(php.fpm), handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: overrides };
  if (php.handler === 'nginx-fpm') return { version: fpmVersion(php.fpm), handler: 'nginx-fpm', source: 'nginx-vhost', htaccessOverrides: overrides };
  if (d.web.htaccess?.root) {
    return { version: fpmVersion(d.web.htaccess.root.replace('php', '')), handler: 'suphp', source: 'htaccess', htaccessOverrides: overrides };
  }
  return { version: ds.SERVER.phpDefault, handler: 'suphp', source: 'default', htaccessOverrides: overrides };
}

/** D-PHP mapping of the planner (P5-PLAN §4). */
export function expectedBase(php) {
  if (!php) return null;
  const v = php.version;
  if (['8.4', '8.3', '8.2', '8.1'].includes(v)) return { base: `apache-php${v}`, codes: v === '8.1' ? ['phpUnmaintained'] : [] };
  if (v === '8.0') return { base: 'apache-php8.1', codes: ['phpUpgrade'] };
  if (v === '7.4') return { base: 'apache-php7.4', codes: ['phpUnmaintained'] };
  if (/^7\.[0-3]$/.test(v)) return { base: 'apache-php7.4', codes: ['phpUpgrade'] };
  return { base: 'apache-php7.4', codes: ['phpNoBase'] };
}

const isPrivate = (host) => /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
const isLoopback = (host) => /^127\./.test(host) || host === 'localhost';
/** Documentation ranges (RFC 5737): the platform refuses them as proxy targets whatever the flags (MG8, proxyTargetRefused). */
const isDocumentation = (host) => /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(host);

/**
 * Staff choices the e2e applies before running (P5-PLAN D-PROXY / MG8 / MG10), ONE entry per account: the
 * PUT /plans/:id/accounts/:username endpoint REPLACES the account choice, so per-domain choices are merged here.
 *  - docroot symlinked outside the home (MG10) → domain skipped (docrootMissing is blocking otherwise);
 *  - proxy target in a documentation range → domain skipped (proxyTargetRefused is blocking whatever the flags;
 *    the dataset only uses reserved addresses, so it cannot be retargeted to a public one);
 *  - proxy to a LAN / private target → proxyAllowPrivate (audited staff choice: proxyPrivateTarget is blocking
 *    without it) + verification 'force' (the P4b proxy service only binds a VERIFIED domain and the fake zones
 *    are not delegated to the source: proxyDomainUnverified is blocking otherwise);
 *  - any other non-loopback proxy → verification 'force' (same reason).
 * Loopback targets (proxyLocalService) are not planned as proxies by default: no choice needed.
 * Explicit extra choices (EXTRA_ADJUSTMENTS) exercise staff-only warning paths.
 */
const EXTRA_ADJUSTMENTS = [
  // D-FTP: acct6's only FTP user is MD5-crypt, so the default adopts nobody (info ftpVirtualUsers). The staff
  // explicitly asking to adopt it is what raises ftpHashUnsupported (warning, not blocking; nothing adopted).
  { account: 'acct6', choice: { ftpUsers: { 'legacy@iota.example': { action: 'adopt-password' } } }, reason: 'legacy@iota.example: adoption asked for an MD5-crypt FTP user (ftpHashUnsupported, nothing adopted)' },
];

export function expectedPlanAdjustments(ds) {
  const byAccount = new Map();
  const entry = (account) => {
    if (!byAccount.has(account)) byAccount.set(account, { account, choice: {}, reasons: [] });
    return byAccount.get(account);
  };
  const addDomain = (account, fqdn, choice, reason) => {
    const adj = entry(account);
    adj.choice.domains = adj.choice.domains ?? {};
    adj.choice.domains[fqdn] = { ...(adj.choice.domains[fqdn] ?? {}), ...choice };
    adj.reasons.push(`${fqdn}: ${reason}`);
  };
  for (const d of ds.DOMAINS) {
    if (!d.web) continue;
    if (d.app?.type === 'symlink-docroot') {
      addDomain(d.account, d.fqdn, { as: 'skip' }, `docroot is a symlink to ${d.app.target} (MG10): docrootMissing is blocking until the domain is skipped`);
      continue;
    }
    if (d.web.serving !== 'proxy' || !d.web.proxy || isLoopback(d.web.proxy.host)) continue;
    const { host, port } = d.web.proxy;
    if (isDocumentation(host)) {
      addDomain(d.account, d.fqdn, { as: 'skip' }, `proxy target ${host}:${port} is a documentation address the platform refuses (proxyTargetRefused): skipped`);
    } else if (isPrivate(host)) {
      addDomain(d.account, d.fqdn, { proxyAllowPrivate: true, verification: 'force' }, `private proxy target ${host}:${port} allowed by the staff (proxyPrivateTarget) + forced verification (proxyDomainUnverified)`);
    } else {
      addDomain(d.account, d.fqdn, { verification: 'force' }, 'proxy needs a verified domain: forced verification (proxyDomainUnverified)');
    }
  }
  for (const x of EXTRA_ADJUSTMENTS) {
    const adj = entry(x.account);
    for (const [k, v] of Object.entries(x.choice)) adj.choice[k] = { ...(adj.choice[k] ?? {}), ...v };
    adj.reasons.push(x.reason);
  }
  return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account))
    .map(({ account, choice, reasons }) => ({ account, choice, reason: reasons.join('; ') }));
}

export function computeExpected(ds, { vhostFiles = {} } = {}) {
  const rows = ds.DOMAINS;
  const unique = new Map();
  for (const d of rows) if (!unique.has(d.fqdn)) unique.set(d.fqdn, d);
  const kinds = [...unique.values()].map((d) => d.kind);
  const web = rows.filter((d) => d.web);
  const proxies = web.filter((d) => d.web.serving === 'proxy');
  const declaredZones = ds.ZONES.length;
  const orphanZones = ds.ZONE_FILES_EXTRA.filter((z) => z.kind === 'orphan').length;
  const cronEntries = ds.CRONTABS.reduce((n, t) => n + t.lines.length, 0);

  const domains = web.map((d) => {
    const php = expectedPhp(ds, d);
    const dup = rows.find((r) => r !== d && r.fqdn === d.fqdn);
    return {
      fqdn: d.fqdn,
      kind: d.kind,
      account: d.account,
      parent: d.parent ?? null,
      subLabel: d.sub ?? null,
      docroot: d.web.docroot,
      docrootFromDb: d.kind === 'main' ? `/home/${d.account}/public_html` : d.path,
      serving: d.web.serving,
      php,
      expectedBase: expectedBase(php),
      proxy: d.web.proxy
        ? { scheme: d.web.proxy.scheme, host: d.web.proxy.host, port: d.web.proxy.port, websocket: d.web.proxy.websocket, via: d.web.proxy.via, isPrivate: isPrivate(d.web.proxy.host) }
        : null,
      varnish: Boolean(d.web.varnish),
      customTemplate: Boolean(d.web.template && ds.VHOST_TEMPLATES.custom.nginx.includes(d.web.template)),
      nginxTemplate: d.web.json?.['nginx_template-name'] ?? null,
      wwwAlias: Boolean(d.web.www),
      ssl: Boolean(d.web.ssl),
      certificate: d.web.ssl ?? null,
      app: d.app?.type ?? null,
      duplicateOf: dup ? dup.kind : null,
      vhostFiles: vhostFiles[d.fqdn] ?? [],
      symlinkDocroot: d.app?.type === 'symlink-docroot',
    };
  });

  const outsideMin = [
    ...ds.SYSTEMD_UNITS.map((u) => ({ kind: 'systemd-service', key: u.name, note: `${u.kind} (User=${u.user})` })),
    ...ds.LINUX_USERS.map((u) => ({ kind: 'linux-user', key: u.username, note: `uid ${u.uid}, home ${u.home}` })),
    ...ds.VHOST_TEMPLATES.custom.nginx.map((t) => ({ kind: 'nginx-template', key: t, note: 'custom CWP nginx template' })),
    ...web.filter((d) => d.web.varnish).map((d) => ({ kind: 'varnish-backend', key: d.fqdn, note: `${d.web.varnish.backendHost}:${d.web.varnish.backendPort}` })),
    { kind: 'root-cron', key: 'root', note: `${ds.CRONTABS.find((t) => t.owner === 'root').lines.length} lines` },
    ...ds.DB_USERS.filter((u) => !['localhost', '127.0.0.1', '::1'].includes(u.host)).map((u) => ({ kind: 'mysql-remote-user', key: `${u.user}@${u.host}`, note: 'remote MySQL client' })),
    ...ds.DB_USERS.filter((u) => u.account === null).map((u) => ({ kind: 'mysql-orphan', key: `${u.user}@${u.host}`, note: 'prefix without CWP account' })),
    ...web.filter((d) => d.app?.type === 'git-static').map((d) => ({ kind: 'git-repo', key: `${d.web.docroot}/.git`, note: 'repository in a docroot' })),
    ...ds.ZONE_FILES_EXTRA.filter((z) => z.kind === 'orphan').map((z) => ({ kind: 'dns-orphan-zone', key: z.zone, note: z.file })),
    ...ds.ZONES.filter((z) => z.dynamic).map((z) => ({ kind: 'dns-dynamic-zone', key: z.name, note: 'allow-update + .jnl' })),
    ...[...ds.ACCOUNTS.filter((a) => a.shell === '/bin/bash').map((a) => a.username), ...ds.LINUX_USERS.filter((u) => u.shell === '/bin/bash').map((u) => u.username)]
      .map((u) => ({ kind: 'ssh-access', key: u, note: 'interactive shell' })),
  ];

  return {
    $comment: 'GENERATED by `node images/fake-cwp/check/check-dataset.mjs --write-expected` from dataset/dataset.mjs — do not edit by hand.',
    schemaVersion: 1,
    server: {
      hostname: ds.SERVER.hostname,
      cwpVersion: ds.SERVER.cwpVersion,
      cwpPro: ds.SERVER.cwpPro,
      webserverSetup: ds.SERVER.webserverSetup,
      phpDefault: ds.SERVER.phpDefault,
      phpFpmVersions: ds.SERVER.phpFpm.map(fpmVersion),
      nameservers: ds.SERVER.nameservers.map((n) => n.name),
      sourceIps: [ds.SERVER.publicIp],
      mariadbMajor: '10.3',
    },
    counts: {
      hard: {
        accounts: ds.ACCOUNTS.length,
        suspendedAccounts: ds.ACCOUNTS.filter((a) => a.suspended).length,
        packages: ds.PACKAGES.length,
        domains: unique.size,
        mainDomains: kinds.filter((k) => k === 'main').length,
        addonDomains: kinds.filter((k) => k === 'addon').length,
        parkedDomains: kinds.filter((k) => k === 'parked').length,
        subDomains: kinds.filter((k) => k === 'subdomain').length,
        proxyDomains: proxies.length,
        databases: ds.DATABASES.length,
        mailDomains: ds.MAIL_DOMAINS.length,
        mailboxes: ds.MAILBOXES.length,
        mailAliases: ds.ALIASES.length,
        dkimKeys: ds.DKIM.length,
        ftpUsers: ds.FTP_USERS.length,
        certificates: ds.CERTIFICATES.length,
      },
      soft: {
        dnsZones: { expected: declaredZones + orphanZones, note: `${declaredZones} declared in named.conf + ${orphanZones} orphan .db (the .restore copy is not a zone)` },
        dbUsers: { expected: ds.DB_USERS.length, note: `(user, host) rows of client users; ${new Set(ds.DB_USERS.map((u) => u.user)).size} distinct names; root / postfix / roundcube excluded` },
        crons: { expected: cronEntries, note: `${cronEntries - ds.CRONTABS.find((t) => t.owner === 'root').lines.length} user lines (1 commented) + ${ds.CRONTABS.find((t) => t.owner === 'root').lines.length} root lines; ~/cron of acct1 is a COPY (not counted twice)` },
        outside: { expected: outsideMin.length, note: 'minimum: one item per entry of outsideMin (a discovery may report more, e.g. domlogs)' },
      },
      rootCwpRows: { user: ds.ACCOUNTS.length, domains: rows.filter((d) => d.kind === 'addon' || d.kind === 'parked').length, subdomains: rows.filter((d) => d.kind === 'subdomain').length },
    },
    suspended: ds.ACCOUNTS.filter((a) => a.suspended).map((a) => a.username),
    accounts: ds.ACCOUNTS.map((a) => ({
      username: a.username, uid: a.uid, packageId: Number(a.package), mainDomain: a.mainDomain, suspended: a.suspended,
      shell: a.shell, sshAccess: a.shell === '/bin/bash', authorizedKeys: a.authorizedKeys,
    })),
    domains,
    zones: [
      ...ds.ZONES.map((z) => ({
        name: z.name, account: z.account, declared: true, dynamic: Boolean(z.dynamic), journal: Boolean(z.dynamic),
        readVia: z.dynamic ? 'checkzone' : null,
        journalOnlyRecords: (z.dynamicRecords ?? []).map(([n, ttl, type, content]) => ({ name: `${n}.${z.name}`, type, ttl, content })),
      })),
      ...ds.ZONE_FILES_EXTRA.filter((z) => z.kind === 'orphan').map((z) => ({ name: z.zone, account: null, declared: false, dynamic: false, journal: false, readVia: null, journalOnlyRecords: [] })),
    ],
    databases: ds.DATABASES.map((db) => ({
      name: db.name, account: db.account, charset: db.charset, collation: db.collation,
      memoryTables: [...db.sql.matchAll(/CREATE TABLE (\w+) [^;]*ENGINE=MEMORY/g)].map((m) => m[1]),
      definers: [...db.sql.matchAll(/DEFINER=`([^`]+)`@`([^`]+)`/g)].map((m) => `${m[1]}@${m[2]}`),
    })),
    dbUsers: ds.DB_USERS.map((u) => ({
      user: u.user, host: u.host, account: u.account, hashKind: 'native', plugin: u.auth === 'plugin' ? 'mysql_native_password' : '',
      remote: !['localhost', '127.0.0.1', '::1'].includes(u.host), orphan: u.account === null, grants: u.grants.map((g) => g.db),
    })),
    mailboxes: ds.MAILBOXES.map((m) => ({
      address: m.address, account: ds.MAIL_DOMAINS.find((d) => d.domain === m.address.split('@')[1]).account,
      hashScheme: m.scheme === 'SHA512-CRYPT' ? 'SHA512-CRYPT' : 'MD5-CRYPT', hashPrefixed: m.scheme === 'SHA512-CRYPT',
      active: m.active === 1, hasSieve: m.sieve, quotaBytes: m.quota === 0 ? null : m.quota, inboxUidValidity: m.uidValidity,
    })),
    aliases: ds.ALIASES.map((a) => ({ address: a.address, kind: a.address.startsWith('@') ? 'catch-all' : 'forward', targets: a.goto.split(',') })),
    dkim: ds.DKIM.map((k) => ({ domain: k.domain, selector: 'default', bits: k.bits, hasMailDomain: ds.MAIL_DOMAINS.some((m) => m.domain === k.domain) })),
    ftpUsers: ds.FTP_USERS.map((f) => ({ login: f.login, account: f.account, directory: f.dir, chroot: true, hashScheme: f.scheme === 'bcrypt' ? 'bcrypt' : 'md5-crypt' })),
    crons: ds.CRONTABS.map((t) => ({ owner: t.owner, system: t.owner === 'root', lines: t.lines.length, disabled: t.lines.filter((l) => l.startsWith('#')).length })),
    certificates: ds.CERTIFICATES.map((c) => ({ fqdn: c.name, names: c.names, expired: c.validity === 'expired', selfSigned: c.issuer === 'self', keyType: c.key, account: c.account })),
    outsideMin,
    /** Staff choices the scenario applies before running (a blocking case is EXPECTED there). */
    planAdjustments: expectedPlanAdjustments(ds),
    /**
     * Warning codes the plan should raise per account (P5-PLAN §8.4), WITH planAdjustments applied — informative,
     * compared softly. Not listed on purpose:
     *  - cronInterval (acct1 `* * * * *`): a plan CREATED by the migration lowers cronMinIntervalMin to the source's
     *    shortest interval (server-wide info planLimitsRaised, see expectedServerWarnings); cronInterval only
     *    concerns an EXISTING target plan;
     *  - cwpServiceSubdomain: the webmail. / mail. / cpanel. sub-servers of CWP vhosts are dropped by the discovery
     *    (never domains); the code is for a root_cwp sub-domain ROW named like that, which the dataset has none of.
     */
    expectedWarnings: {
      acct1: ['phpHtaccessOverride', 'docrootNested', 'proxyLocalService', 'dbHostHashMismatch', 'dbRemoteHost', 'dbMemoryTables', 'cronWritesToCode', 'cronSpecial', 'cronPhpVersion', 'aliasExternalTargets', 'catchAll', 'mailboxInactive', 'certExpired', 'mailSieve', 'phpUnmaintained'],
      acct2: ['proxyPrivateTarget', 'proxyWebsocket', 'phpNoBase', 'varnishBackend', 'docrootNonStandard', 'dbRemoteHost', 'certSelfSigned'],
      acct3: ['phpNoBase', 'customTemplate', 'disabledVhost', 'dbGrantCustom', 'dbLatin1', 'dbDefinerForeign', 'dbRemoteHost', 'aliasExternalTargets'],
      acct4: ['accountSuspended', 'domainDuplicate'],
      acct5: ['docrootNonStandard', 'docrootMissing', 'dbMemoryTables'],
      acct6: ['dkimWeakKey', 'ftpHashUnsupported', 'dbLatin1'],
    },
    /** Server-wide plan warning codes (result.warnings), compared softly — planLimitsRaised: acct1's `* * * * *` cron. */
    expectedServerWarnings: ['planLimitsRaised'],
    /** Values that must NEVER appear in the inventory, the plan, the run events or the command log output (MG2). */
    canaries: ['must-never-be-read', 'must-be-redacted', '{SHA512-CRYPT}', '$6$', '$1$', '$2a$10$', 'PRIVATE KEY', ds.SERVER.mysql.rootPassword],
  };
}
