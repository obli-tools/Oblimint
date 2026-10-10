import type {
  CwpAccount, CwpCertificate, CwpCronEntry, CwpDatabase, CwpDbUser, CwpDkimKey, CwpDnsRecord, CwpDnsZone, CwpDomain,
  CwpFtpUser, CwpInventory, CwpMailAlias, CwpMailbox, CwpMailDomain, CwpPackage, PlanLimits,
} from '@oblimint/shared';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import { emptyTargetContext, type PlanTargetContext } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Anonymized CWP inventory builders for the planner tests (acct1,
// example.tld, 203.0.113.10 — formats of docs/cwp). Test support only.
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE_IP = '203.0.113.10';
export const TARGET_IP = '198.51.100.50';
export const NOW = '2026-10-10T12:00:00.000Z';

export function pkg(id: number, name: string, over: Partial<CwpPackage> = {}): CwpPackage {
  return {
    id, name, diskQuotaMb: 20000, bandwidthMbPerMonth: 100000, ftpAccounts: 10, emailAccounts: 10, emailLists: 10, databases: 10,
    subDomains: 10, parkedDomains: 10, addonDomains: 10, hourlyEmails: 100, isReseller: false, nproc: null, inodes: null, accountCount: 1,
    ...over,
  };
}

export function account(username: string, over: Partial<CwpAccount> = {}): CwpAccount {
  return {
    username, uid: 1000, gid: 1000, homeDir: `/home/${username}`, mainDomain: `${username}.tld`, contactEmail: `owner@${username}.example.net`,
    packageId: 2, packageName: 'UNLIMITED', reseller: null, suspended: false, setupDate: null, ipAddress: SOURCE_IP, shell: '/sbin/nologin',
    sshAccess: false, authorizedKeys: 0, homeBytes: 50 * 1024 * 1024, mailBytes: 0, dbBytes: 0, fpmPools: [], phpIniFiles: [], extraDirs: [],
    ...over,
  };
}

export function domain(fqdn: string, acct: string, over: Partial<CwpDomain> = {}): CwpDomain {
  return {
    fqdn, kind: 'main', account: acct, parent: null, subLabel: null, docroot: `/home/${acct}/public_html`, docrootFromDb: null,
    docrootNonStandard: false, serving: 'site', proxy: null, redirectTo: null,
    php: { version: '8.3', handler: 'suphp', source: 'default', htaccessOverrides: [] },
    varnish: false, nginxTemplate: 'default', apacheTemplate: 'default', customTemplate: false, wwwAlias: true, ssl: true,
    certificate: null, dnsZone: null, app: null, docrootBytes: 1024 * 1024, vhostFiles: [], duplicateOf: null,
    ...over,
  };
}

export function rec(name: string, type: string, content: string, over: Partial<CwpDnsRecord> = {}): CwpDnsRecord {
  return { name, type, ttl: 14400, content, priority: null, ...over };
}

export function zone(name: string, acct: string | null, records: CwpDnsRecord[], over: Partial<CwpDnsZone> = {}): CwpDnsZone {
  return {
    name, file: `/var/named/${name}.db`, dynamic: false, journal: false, readVia: 'checkzone', serial: 2026100901, defaultTtl: 14400,
    records, account: acct, nameservers: ['ns3.srv.tld', 'ns4.srv.tld'], declared: true, ...over,
  };
}

export function database(name: string, acct: string | null, over: Partial<CwpDatabase> = {}): CwpDatabase {
  return {
    name, account: acct, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', sizeBytes: 10 * 1024 * 1024, tables: 10, engines: { InnoDB: 10 },
    memoryTables: [], tableCollations: {}, latin1Tables: 0, objects: [], ...over,
  };
}

export const ALL_PRIVS = ['Select', 'Insert', 'Update', 'Delete', 'Create', 'Drop', 'References', 'Index', 'Alter', 'Create_tmp_table',
  'Lock_tables', 'Create_view', 'Show_view', 'Create_routine', 'Alter_routine', 'Execute', 'Event', 'Trigger', 'Delete_history'];

export function dbUser(user: string, host: string, acct: string | null, grants: Array<{ pattern: string; privileges: string[] }>, over: Partial<CwpDbUser> = {}): CwpDbUser {
  return {
    user, host, account: acct, plugin: '', hashKind: 'native', remote: !['localhost', '127.0.0.1', '::1'].includes(host),
    grants: grants.map((g) => ({ dbPattern: g.pattern, wildcard: /(^|[^\\])[%_]/.test(g.pattern), privileges: g.privileges, withGrantOption: false, matches: [] })),
    orphan: false, maxUserConnections: null, ...over,
  };
}

export function mailDomain(name: string, acct: string, over: Partial<CwpMailDomain> = {}): CwpMailDomain {
  return { name, account: acct, active: true, backupMx: false, mailboxes: 0, aliases: 0, hasDkim: true, ...over };
}

export function mailbox(address: string, acct: string, over: Partial<CwpMailbox> = {}): CwpMailbox {
  const [local, dom] = address.split('@');
  return {
    address, localPart: local, domain: dom, account: acct, active: true, quotaBytes: 1024 * 1024 * 1024, usedBytes: 1000, messages: 3,
    maildir: `${dom}/${local}/`, maildirPath: `/var/vmail/${dom}/${local}/`, uid: 1000, hashScheme: 'SHA512-CRYPT', hashPrefixed: true,
    hasSieve: false, displayName: null, maildirBytes: 2000, ...over,
  };
}

export function alias(address: string, targets: string[], acct: string, over: Partial<CwpMailAlias> = {}): CwpMailAlias {
  return { address, domain: address.split('@')[1] || address.replace(/^@/, ''), targets, active: true, account: acct, kind: 'forward', ...over };
}

export function dkimKey(dom: string, acct: string, over: Partial<CwpDkimKey> = {}): CwpDkimKey {
  return {
    domain: dom, selector: 'default', account: acct, keyPath: `/etc/opendkim/userkeys/${dom}/default.private`, bits: 2048, algorithm: 'rsa',
    inSigningTable: true, publicKey: 'MIIBIjANBg', ...over,
  };
}

export function ftpUser(login: string, acct: string, directory: string, hashScheme: CwpFtpUser['hashScheme'] = 'bcrypt'): CwpFtpUser {
  return { login, account: acct, uid: 1000, gid: 1000, directory, chroot: true, hashScheme };
}

export function cron(owner: string, line: number, schedule: string, command: string, over: Partial<CwpCronEntry> = {}): CwpCronEntry {
  return {
    key: `${owner}:${line}`, owner, account: owner === 'root' ? null : owner, schedule, command, phpBinary: null, phpVersion: null,
    disabled: false, system: owner === 'root', lineNo: line, ...over,
  };
}

export function cert(fqdn: string, names: string[], acct: string, over: Partial<CwpCertificate> = {}): CwpCertificate {
  return {
    fqdn, certPath: `/etc/pki/tls/certs/${fqdn}.cert`, keyPath: `/etc/pki/tls/private/${fqdn}.key`, bundlePath: null, names,
    notBefore: '2026-09-01T00:00:00.000Z', notAfter: '2026-12-01T00:00:00.000Z', issuer: "Let's Encrypt R11", selfSigned: false,
    expired: false, autossl: true, account: acct, keyType: 'rsa', ...over,
  };
}

export function inventory(over: Partial<CwpInventory> = {}): CwpInventory {
  return {
    schemaVersion: 1,
    collectedAt: NOW,
    server: {
      hostname: 'rin.srv.tld', osRelease: 'Rocky Linux 8.10', cwpVersion: '1.18', cwpPro: true, webserverSetup: 'nginx-varnish-apache',
      publicIps: [SOURCE_IP], privateIps: ['10.99.0.2'], mariadbVersion: '10.3.39', phpDefault: '8.3', phpFpmVersions: ['5.6', '7.3', '7.4', '8.1'],
      packages: {}, nameservers: ['ns3.srv.tld', 'ns4.srv.tld'], extraDbPrefixes: [],
    },
    packages: [pkg(1, 'default'), pkg(2, 'UNLIMITED', {
      diskQuotaMb: null, bandwidthMbPerMonth: null, ftpAccounts: null, emailAccounts: null, emailLists: null, databases: null,
      subDomains: null, parkedDomains: null, addonDomains: null,
    })],
    accounts: [],
    domains: [],
    dnsZones: [],
    databases: [],
    dbUsers: [],
    mailDomains: [],
    mailboxes: [],
    mailAliases: [],
    dkimKeys: [],
    ftpUsers: [],
    crons: [],
    certificates: [],
    outside: [],
    warnings: [],
    counts: {
      accounts: 0, suspendedAccounts: 0, packages: 0, domains: 0, mainDomains: 0, addonDomains: 0, parkedDomains: 0, subDomains: 0,
      proxyDomains: 0, dnsZones: 0, databases: 0, dbUsers: 0, mailDomains: 0, mailboxes: 0, mailAliases: 0, dkimKeys: 0, ftpUsers: 0,
      crons: 0, certificates: 0, outside: 0, filesBytes: 0, dbBytes: 0, mailBytes: 0,
    },
    ...over,
  };
}

/** Target with a platform IPv4, postfix-dovecot (every scheme but SSHA*), external targets allowed in tenant 1. */
export function target(over: Partial<PlanTargetContext> = {}): PlanTargetContext {
  const base = emptyTargetContext({ now: NOW });
  return {
    ...base,
    catalog: {
      ...base.catalog,
      platformIpv4: TARGET_IP,
      mailEngine: 'postfix-dovecot',
      mailPasswordSchemes: ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT'],
      ...(over.catalog ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'catalog')),
  };
}

export function limits(over: Partial<PlanLimits> = {}): PlanLimits {
  return { ...DEFAULT_PLAN_LIMITS, ...over };
}

/**
 * The reference account `acct1` (UNLIMITED package): WordPress main + parked alias (same docroot), nested
 * blog subdomain on PHP 5.6, Laravel addon, a 7.3 subdomain with a .htaccess override, a LAN proxy with
 * websocket, a local-service proxy, the CWP webmail sub-vhost; its zone, databases, users, mail, DKIM, FTP,
 * crons and certificates.
 */
export function referenceInventory(): CwpInventory {
  const a = 'acct1';
  return inventory({
    accounts: [account(a, { mainDomain: 'example.tld', phpIniFiles: ['public_html/php.ini'] })],
    domains: [
      domain('example.tld', a, { app: { profile: 'wordpress', markers: ['wp-config.php'], wordpress: null, hasGit: false, hasPackageJson: false, hasComposerJson: false, htaccess: true, userIni: false }, dnsZone: 'example.tld',
        // Public DNS seen at discovery: served by the source (A = source IP) → default forced verification.
        publicDns: { a: [SOURCE_IP], aaaa: [], ns: ['ns3.srv.tld', 'ns4.srv.tld'], resolved: true } }),
      domain('alias.tld', a, { kind: 'parked', wwwAlias: false }),
      domain('blog.example.tld', a, { kind: 'subdomain', parent: 'example.tld', subLabel: 'blog', docroot: '/home/acct1/public_html/blog', php: { version: '5.6', handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: [] }, dnsZone: 'example.tld',
        publicDns: { a: [], aaaa: [], ns: ['ns3.srv.tld'], resolved: true } }),
      domain('shop.tld', a, {
        kind: 'addon', docroot: '/home/acct1/shop.tld/public', php: { version: '8.2', handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: [] },
        app: { profile: 'laravel', markers: ['../artisan', '../bootstrap/app.php'], wordpress: null, hasGit: true, hasPackageJson: false, hasComposerJson: true, htaccess: true, userIni: false },
      }),
      domain('old.example.tld', a, {
        kind: 'subdomain', parent: 'example.tld', subLabel: 'old', docroot: '/home/acct1/old.example.tld', docrootNonStandard: false,
        php: { version: '7.3', handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: [{ path: 'legacy', version: '7.4' }, { path: '/home/acct1/old.example.tld/new', version: '8.1' }] },
      }),
      domain('app.example.tld', a, { kind: 'subdomain', parent: 'example.tld', subLabel: 'app', docroot: null, serving: 'proxy', php: null, proxy: { scheme: 'http', host: '192.168.1.20', port: 8123, websocket: true, via: 'nginx-vhost', isPrivate: true } }),
      domain('api.example.tld', a, { kind: 'subdomain', parent: 'example.tld', subLabel: 'api', docroot: null, serving: 'proxy', php: null, proxy: { scheme: 'http', host: '192.168.1.20', port: 8123, websocket: false, via: 'webservers-json', isPrivate: true } }),
      domain('local.example.tld', a, { kind: 'subdomain', parent: 'example.tld', subLabel: 'local', docroot: null, serving: 'proxy', php: null, proxy: { scheme: 'http', host: '127.0.0.1', port: 3001, websocket: false, via: 'nginx-vhost', isPrivate: true } }),
      domain('webmail.example.tld', a, { kind: 'subdomain', parent: 'example.tld', subLabel: 'webmail', docroot: null, serving: 'proxy', php: null }),
    ],
    dnsZones: [zone('example.tld', a, [
      rec('example.tld', 'SOA', 'ns3.srv.tld. postmaster.example.tld. 2026100901 3600 1800 1209600 86400'),
      rec('example.tld', 'NS', 'ns3.srv.tld.'),
      rec('example.tld', 'NS', 'ns4.srv.tld.'),
      rec('sub.example.tld', 'NS', 'ns1.other.tld.'),
      rec('example.tld', 'A', SOURCE_IP),
      rec('www.example.tld', 'CNAME', 'example.tld.'),
      rec('other.example.tld', 'A', '198.51.100.7'),
      rec('mail.example.tld', 'CNAME', 'example.tld.'),
      rec('example.tld', 'MX', 'example.tld.', { priority: 0 }),
      rec('example.tld', 'TXT', `"v=spf1 +a +mx +ip4:${SOURCE_IP} ip4:198.51.100.7 ~all"`),
      rec('_dmarc.example.tld', 'TXT', '"v=DMARC1; p=none"'),
      rec('default._domainkey.example.tld', 'TXT', '"v=DKIM1; k=rsa; p=MIIBIjANBg"'),
      rec('cpanel.example.tld', 'A', SOURCE_IP),
      rec('example.tld', 'PTR', 'x.example.tld.'),
      rec('_sip._tcp.example.tld', 'SRV', '10 5 5060 sip.example.tld.', { priority: null }),
      rec('example.tld', 'CAA', '0 issue "letsencrypt.org"'),
      rec('short.example.tld', 'A', SOURCE_IP, { ttl: 10 }),
    ])],
    databases: [
      database('acct1_wp', a, { objects: [
        { schema: 'acct1_wp', name: 'trg_ok', kind: 'trigger', definer: 'acct1_wp@localhost', securityType: null },
        { schema: 'acct1_wp', name: 'v_foreign', kind: 'view', definer: 'someone@%', securityType: 'DEFINER' },
      ] }),
      database('acct1_shop', a, { latin1Tables: 3, memoryTables: ['sessions'], sizeBytes: 2048 * 1024 * 1024 }),
      database('acct1x', a),
      database('lost_db', null),
    ],
    dbUsers: [
      dbUser('acct1', 'localhost', a, [{ pattern: 'acct1\\_%', privileges: ALL_PRIVS.filter((p) => p !== 'Delete_history') }]),
      dbUser('acct1_wp', 'localhost', a, [{ pattern: 'acct1\\_wp', privileges: ALL_PRIVS }]),
      dbUser('acct1_wp', '10.0.0.5', a, [{ pattern: 'acct1\\_wp', privileges: ALL_PRIVS }]),
      dbUser('acct1_ro', 'localhost', a, [{ pattern: 'acct1\\_shop', privileges: ['Select'] }]),
      dbUser('acct1_cu', 'localhost', a, [{ pattern: 'acct1_shop', privileges: ['Select', 'Insert', 'Update', 'Delete'] }]),
      dbUser('acct1_this_user_name_is_way_too_long', 'localhost', a, []),
      dbUser('acct1_nohash', 'localhost', a, [], { hashKind: 'none' }),
      dbUser('ghost_user', 'localhost', null, [], { orphan: true }),
    ],
    mailDomains: [mailDomain('example.tld', a)],
    mailboxes: [
      mailbox('info@example.tld', a),
      mailbox('legacy@example.tld', a, { hashScheme: 'SSHA', quotaBytes: null, active: false, hasSieve: true }),
      mailbox('empty@example.tld', a, { hashScheme: null }),
    ],
    mailAliases: [
      alias('sales@example.tld', ['someone@gmail.example', 'info@example.tld'], a),
      alias('@example.tld', ['info@example.tld'], a, { kind: 'catch-all', domain: 'example.tld' }),
      alias('info@example.tld', ['info@example.tld'], a, { kind: 'local' }),
    ],
    dkimKeys: [dkimKey('example.tld', a)],
    ftpUsers: [
      ftpUser('deep@example.tld', a, '/home/acct1/public_html/sub'),
      ftpUser('top@example.tld', a, '/home/acct1'),
      ftpUser('sha@example.tld', a, '/home/acct1', 'sha512-crypt'),
    ],
    crons: [
      cron(a, 1, '*/5 * * * *', '/usr/local/bin/php /home/acct1/public_html/wp-cron.php >> /home/acct1/public_html/cron.log 2>&1', { phpBinary: '/usr/local/bin/php', phpVersion: '8.3' }),
      cron(a, 2, '@reboot', '/home/acct1/node/start.sh'),
      cron(a, 3, '@daily', '/opt/alt/php73/usr/bin/php /home/acct1/shop.tld/artisan schedule:run', { phpBinary: '/opt/alt/php73/usr/bin/php', phpVersion: '7.3' }),
      cron('root', 1, '0 * * * *', '/usr/local/cwp/php71/bin/php /usr/local/cwp/cron.php', { system: true }),
    ],
    certificates: [
      cert('example.tld', ['example.tld', 'www.example.tld', 'alias.tld'], a),
      cert('old.example.tld', ['old.example.tld'], a, { expired: true, notAfter: '2026-01-01T00:00:00.000Z' }),
      cert('app.example.tld', ['app.example.tld'], a),
      cert('self.example.tld', ['self.example.tld'], a, { selfSigned: true }),
      cert('elsewhere.tld', ['elsewhere.tld'], a),
    ],
    outside: [
      { kind: 'node-app', key: 'svc-node', account: a, code: 'nodeApp', suggestion: 'docker-app', details: { unit: 'app.service' } },
      { kind: 'root-cron', key: 'root-cron', account: null, code: 'rootCron', suggestion: 'manual', details: {} },
    ],
  });
}
